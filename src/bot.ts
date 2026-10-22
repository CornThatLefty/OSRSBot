// Bot account credentials and the SDK control connection.
//
// The game account is created by the server on first login, so the generated password in
// data/credentials.json IS the account: back up the data directory. bot.env inside the rs-sdk
// checkout is rewritten from it on every start, because the lite runner reads credentials there.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BotSDK, deriveGatewayUrl, forgetDirectGateway } from '../vendor/rs-sdk/sdk/index';
import { BotActions } from '../vendor/rs-sdk/sdk/actions';
import type { BotConnection } from '../vendor/rs-sdk/mcp/api/index';
import { env, isLocalServer, settings } from './config';
import { emit } from './events';

const credentialsPath = join(env.dataDir, 'credentials.json');

function loadCredentials(): Record<string, string> {
    if (!existsSync(credentialsPath)) return {};
    return JSON.parse(readFileSync(credentialsPath, 'utf-8'));
}

function randomPassword(length = 16): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, b => chars[b % chars.length]).join('');
}

/** Password for a bot name, generating and saving one the first time. */
export function passwordFor(name: string): string {
    const creds = loadCredentials();
    const key = name.toLowerCase();
    if (!creds[key]) {
        creds[key] = randomPassword();
        writeFileSync(credentialsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
    }
    return creds[key]!;
}

export function gatewayUrl(): string {
    return isLocalServer() ? `ws://${settings.server.split(':')[0]}:7780` : deriveGatewayUrl(settings.server);
}

/** Write vendor/rs-sdk/bots/<name>/bot.env in the format rs-sdk's tools expect. */
export function writeBotEnv(): void {
    const name = settings.botName;
    const dir = join(env.rsSdkDir, 'bots', name);
    mkdirSync(dir, { recursive: true });
    const lines = [
        `BOT_USERNAME=${name}`,
        `PASSWORD=${passwordFor(name)}`,
        // The lite runner builds its cache origin from SERVER, so a local server needs the web port spelled out.
        `SERVER=${isLocalServer() && !settings.server.includes(':') ? settings.server + ':8888' : settings.server}`,
        ...(isLocalServer() ? [`GATEWAY_URL=${gatewayUrl()}`] : []),
        `SHOW_CHAT=${settings.showChat}`,
        'TELEMETRY=false',
    ];
    writeFileSync(join(dir, 'bot.env'), lines.join('\n') + '\n', { mode: 0o600 });
}

/** The single control connection this process holds to the bot (through the gateway, to whichever client is attached). */
class BotLink {
    connection: BotConnection | null = null;
    private connecting: Promise<BotConnection> | null = null;

    get sdk(): BotSDK | null {
        return this.connection?.sdk ?? null;
    }

    /**
     * True when a client is logged in and publishing state right now. The gateway replays the
     * last state it cached (inGame included) to a new SDK connection, so a client that is still
     * starting, or has died, can look in game. The browser client takes about a minute to log in.
     */
    isLive(): boolean {
        const sdk = this.sdk;
        // A replayed state never advances, so require a tick change seen recently (as rs-sdk's runner does).
        return !!sdk?.getState()?.inGame && Date.now() - this.lastTickAdvanceAt < 10_000;
    }

    private lastTick: number | null = null;
    private lastTickAdvanceAt = 0;

    private trackTicks(sdk: BotSDK): void {
        this.lastTick = null;
        this.lastTickAdvanceAt = 0;
        sdk.onStateUpdate(state => {
            if (this.sdk !== sdk) return;
            if (this.lastTick !== null && state.tick !== this.lastTick) this.lastTickAdvanceAt = Date.now();
            this.lastTick = state.tick;
        });
    }

    /** Set when another controller took the bot over; the watchdog then leaves it alone until an explicit connect. */
    preempted = false;

    /** Watchdog entry point: reconnect after a failed or dropped connection, but never fight another controller. */
    async reconnectIfIdle(): Promise<void> {
        if (this.connection || this.connecting || this.preempted || !settings.botName) return;
        await this.connect().catch(error => emit('client', `SDK reconnect failed: ${error instanceof Error ? error.message : error}; retrying`));
    }

    async connect(): Promise<BotConnection> {
        this.preempted = false;
        if (this.connection) return this.connection;
        if (this.connecting) return this.connecting;
        this.connecting = this.open().finally(() => { this.connecting = null; });
        return this.connecting;
    }

    private newSdk(name: string, connectTimeout?: number): BotSDK {
        return new BotSDK({
            botUsername: name,
            password: passwordFor(name),
            gatewayUrl: gatewayUrl(),
            connectionMode: 'control',
            autoReconnect: true,
            // The supervisor in client.ts owns the game client; never pop a desktop browser.
            autoLaunchBrowser: false,
            showChat: settings.showChat,
            ...(connectTimeout ? { connectTimeout } : {}),
        });
    }

    private async open(): Promise<BotConnection> {
        const name = settings.botName;
        if (!name) throw new Error('Set a bot name in Settings first');
        let sdk = this.newSdk(name, 15_000);
        try {
            await sdk.connect();
        } catch (error) {
            await sdk.disconnect().catch(() => {});
            // The SDK prefers the demo server's direct gateway port when it answers HTTP, but some
            // networks pass that HTTP probe and then stall the WebSocket. The relayed /gateway URL is
            // slower but works everywhere, so fall back to it for the rest of the process.
            if (process.env.GATEWAY_DIRECT === 'false') throw error;
            process.env.GATEWAY_DIRECT = 'false';
            forgetDirectGateway(gatewayUrl());
            emit('client', `Direct gateway port failed (${error instanceof Error ? error.message : error}); using the relayed gateway`);
            sdk = this.newSdk(name);
            await sdk.connect();
        }
        const connection: BotConnection = {
            name,
            sdk,
            bot: new BotActions(sdk),
            username: name,
            connected: true,
            lastShownMessageTick: -1,
        };
        connection.unsubscribeConnectionState = sdk.onConnectionStateChange(state => {
            const was = connection.connected;
            connection.connected = state === 'connected';
            if (was !== connection.connected) emit('client', `SDK gateway connection: ${state}`);
            // 'disconnected' (rather than 'reconnecting') means the SDK gave up: usually another
            // controller (rs-sdk's CLI, a script) took the bot over. Drop this connection so the next
            // client start or agent step opens a fresh one instead of using a dead one forever.
            if (state === 'disconnected' && this.connection === connection) {
                this.connection = null;
                this.preempted = true;
                connection.unsubscribeConnectionState?.();
                emit('client', 'SDK connection closed (another controller may have taken over the bot); it reconnects on the next client start or agent step');
            }
        });
        this.connection = connection;
        this.trackTicks(sdk);
        for (const fn of this.readyListeners) fn(sdk);
        emit('client', `SDK connected to gateway as ${name}`);
        return connection;
    }

    private readyListeners = new Set<(sdk: BotSDK) => void>();

    /** Called each time a new SDK connection opens (metrics hooks its state listener here). */
    onReady(fn: (sdk: BotSDK) => void): void {
        this.readyListeners.add(fn);
        if (this.connection) fn(this.connection.sdk);
    }

    async disconnect(): Promise<void> {
        const c = this.connection;
        this.connection = null;
        if (!c) return;
        c.unsubscribeConnectionState?.();
        await c.sdk.disconnect().catch(() => {});
    }

    /** Adapter for rs-sdk's executeCode(), which expects the MCP BotManager shape. */
    readonly manager = {
        get: (_name: string) => this.connection ?? undefined,
        connect: (_name: string) => this.connect(),
    };
}

export const botLink = new BotLink();
