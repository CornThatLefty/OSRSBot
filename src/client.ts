// Game client supervisor. The SDK can't talk to the game server directly: some client has to be
// logged in as the bot and attached to the gateway. Two choices:
//
//   lite     rs-sdk's headless client (server/webclient/src/lite/runner.ts) as a child process.
//            ~15 MB and well under 1% CPU, but it renders nothing.
//   browser  rs-sdk's real 3D web client (/bot?bot=...) in headless Chrome. Heavier (a few hundred MB,
//            a good share of a core), but the dashboard can stream exactly what it draws.
//
// Either way it is restarted with backoff if it dies.

import { join } from 'node:path';
import type { Subprocess } from 'bun';
import type { Browser, CDPSession, Page } from 'puppeteer';
import { env, serverOrigin, settings, type ClientMode } from './config';
import { passwordFor, writeBotEnv } from './bot';
import { emit } from './events';

export type ClientStatus = 'stopped' | 'starting' | 'running' | 'backoff' | 'outdated' | 'error';

const LOG_MAX = 400;
const NOTABLE = /logged into|session ended|gateway connected|error|outdated|revision|exit|fail|denied|invalid/i;

class GameClient {
    status: ClientStatus = 'stopped';
    mode: ClientMode = settings.clientMode;
    startedAt = 0;
    restarts = 0;
    lastError = '';
    readonly log: string[] = [];

    private wanted = false;
    private proc: Subprocess | null = null;
    private browser: Browser | null = null;
    private page: Page | null = null;
    private cdp: CDPSession | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private backoffMs = 5_000;
    /** Bumped on every start/stop so callbacks from a previous run can tell they are stale. */
    private generation = 0;

    // Live view (browser mode)
    private viewers = new Set<(jpeg: Uint8Array) => void>();
    private screencasting = false;
    latestFrame: Uint8Array | null = null;

    async start(): Promise<void> {
        if (!settings.botName) throw new Error('Set a bot name in Settings first');
        this.wanted = true;
        if (this.status === 'running' || this.status === 'starting') return;
        await this.launch();
    }

    async stop(): Promise<void> {
        this.wanted = false;
        this.generation++;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        await this.kill();
        this.setStatus('stopped');
    }

    async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }

    private async kill(): Promise<void> {
        const proc = this.proc;
        this.proc = null;
        if (proc) {
            proc.kill('SIGINT');
            await Promise.race([proc.exited, Bun.sleep(5_000)]);
            if (proc.exitCode === null) proc.kill('SIGKILL');
        }
        const browser = this.browser;
        this.browser = null;
        this.page = null;
        this.cdp = null;
        this.screencasting = false;
        this.latestFrame = null;
        if (browser) await browser.close().catch(() => {});
    }

    private setStatus(status: ClientStatus, why = ''): void {
        if (status === this.status && !why) return;
        this.status = status;
        emit('client', `Game client (${this.mode}): ${status}${why ? ` - ${why}` : ''}`);
    }

    private lastLine = '';
    private repeats = 0;

    private appendLog(line: string): void {
        const clean = line.replace(/password=[^&\s]+/gi, 'password=[REDACTED]').trimEnd();
        if (!clean) return;
        // Collapse runs of the same line (browser clients can log one warning per frame).
        if (clean === this.lastLine) {
            this.repeats++;
            this.log[this.log.length - 1] = this.log[this.log.length - 1]!.replace(/ \(x\d+\)$/, '') + ` (x${this.repeats + 1})`;
            return;
        }
        this.lastLine = clean;
        this.repeats = 0;
        this.log.push(`${new Date().toISOString().slice(11, 19)} ${clean}`);
        if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
        if (NOTABLE.test(clean)) emit('client', clean.slice(0, 300));
    }

    private async launch(): Promise<void> {
        const gen = ++this.generation;
        this.mode = settings.clientMode;
        this.setStatus('starting');
        this.startedAt = Date.now();
        try {
            writeBotEnv();
            if (this.mode === 'lite') this.launchLite(gen);
            else await this.launchBrowser(gen);
        } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
            this.appendLog(`launch failed: ${this.lastError}`);
            this.died(gen, 1);
        }
    }

    private launchLite(gen: number): void {
        const proc = Bun.spawn([process.execPath, 'src/lite/runner.ts', settings.botName], {
            cwd: join(env.rsSdkDir, 'server', 'webclient'),
            stdout: 'pipe',
            stderr: 'pipe',
        });
        this.proc = proc;
        void this.pump(proc.stdout as ReadableStream<Uint8Array>);
        void this.pump(proc.stderr as ReadableStream<Uint8Array>);
        // The runner logs in before it reports anything, so count it as running once it is up.
        setTimeout(() => { if (this.generation === gen && this.proc === proc) this.markRunning(); }, 3_000);
        void proc.exited.then(code => {
            if (this.generation !== gen) return;
            this.proc = null;
            this.appendLog(`lite runner exited with code ${code}`);
            this.died(gen, code ?? 1);
        });
    }

    private async launchBrowser(gen: number): Promise<void> {
        const puppeteer = (await import('puppeteer')).default;
        const browser = await puppeteer.launch({
            headless: true,
            executablePath: env.chromePath || undefined,
            args: [
                '--no-sandbox', '--disable-dev-shm-usage', '--mute-audio',
                // The game creates an AudioContext every frame and logs a warning each time it's blocked.
                '--autoplay-policy=no-user-gesture-required',
                '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
            ],
            defaultViewport: { width: 1024, height: 700 },
        });
        if (this.generation !== gen) { await browser.close(); return; }
        this.browser = browser;
        browser.on('disconnected', () => {
            if (this.generation !== gen || this.browser !== browser) return;
            this.browser = null;
            this.appendLog('browser disconnected');
            this.died(gen, 1);
        });

        const page = await browser.newPage();
        this.page = page;
        page.on('console', msg => this.appendLog(`[page] ${msg.text()}`));
        page.on('pageerror', err => this.appendLog(`[page error] ${err instanceof Error ? err.message : String(err)}`));
        page.on('error', err => { this.appendLog(`[page crashed] ${err.message}`); void browser.close(); });

        const url = new URL('/bot', serverOrigin());
        url.searchParams.set('bot', settings.botName);
        url.searchParams.set('password', passwordFor(settings.botName));
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
        this.cdp = await page.createCDPSession();
        this.cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
            void this.cdp?.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
            const frame = Buffer.from(data, 'base64');
            this.latestFrame = frame;
            for (const fn of this.viewers) fn(frame);
        });
        this.markRunning();
        await this.updateScreencast();
    }

    private markRunning(): void {
        this.setStatus('running');
        // A run that stayed up for a while resets the backoff.
        const startedAt = this.startedAt;
        setTimeout(() => { if (this.startedAt === startedAt && this.status === 'running') this.backoffMs = 5_000; }, 300_000);
    }

    private died(gen: number, code: number): void {
        if (this.generation !== gen) return;
        void this.kill();
        if (code === 3) {
            // rs-sdk's documented "client out of date" exit: restarting won't help until rs-sdk is updated.
            this.setStatus('outdated', 'the server runs a newer game revision. Run `bun run setup --update` and restart.');
            return;
        }
        if (!this.wanted) { this.setStatus('stopped'); return; }
        this.restarts++;
        this.setStatus('backoff', `restarting in ${Math.round(this.backoffMs / 1000)}s`);
        this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.wanted) void this.launch(); }, this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 120_000);
    }

    private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
        const decoder = new TextDecoder();
        let buffer = '';
        const reader = stream.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                this.appendLog(buffer.slice(0, nl));
                buffer = buffer.slice(nl + 1);
            }
        }
        if (buffer) this.appendLog(buffer);
    }

    // ---- live view -------------------------------------------------------------------------

    /** Subscribe to JPEG frames. Screencasting only runs while someone is watching. */
    watch(fn: (jpeg: Uint8Array) => void): () => void {
        this.viewers.add(fn);
        if (this.latestFrame) fn(this.latestFrame);
        void this.updateScreencast();
        return () => {
            this.viewers.delete(fn);
            void this.updateScreencast();
        };
    }

    private async updateScreencast(): Promise<void> {
        const want = this.viewers.size > 0 && !!this.cdp;
        if (want === this.screencasting || !this.cdp) return;
        this.screencasting = want;
        try {
            if (want) await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1024, maxHeight: 700, everyNthFrame: 2 });
            else await this.cdp.send('Page.stopScreencast');
        } catch (error) {
            this.screencasting = false;
            this.appendLog(`screencast: ${error instanceof Error ? error.message : error}`);
        }
    }

    /**
     * Arrow keys rotate and tilt the game camera, which changes nothing in game, so viewers may
     * send them. Everything else is ignored so a viewer can't fight the agent for control.
     */
    async cameraKey(key: string, down: boolean): Promise<void> {
        if (!this.page || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return;
        const k = key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';
        await (down ? this.page.keyboard.down(k) : this.page.keyboard.up(k)).catch(() => {});
    }
}

export const gameClient = new GameClient();
