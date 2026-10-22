// Dashboard server: static page, JSON API, a server-sent-event stream for live updates, and a
// WebSocket that carries 3D client frames in browser mode.
//
// Auth: with DASHBOARD_PASSWORD unset it only listens on 127.0.0.1 (use an SSH tunnel). With a
// password it listens on all interfaces and a login sets an HttpOnly cookie. Put it behind HTTPS
// (Caddy, Cloudflare Tunnel...) if it's reachable from the internet: anyone logged in can make
// the agent run code on the server.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { agent, providers } from './agent';
import { botLink } from './bot';
import { gameClient } from './client';
import { activeModel, env, settings, updateSettings, type Settings } from './config';
import { ANTHROPIC_MODELS } from './llm/anthropic';
import { endpoints, finishOAuth, keyInfo, keySource, models, modelsForKey, openrouterKey, saveKey, startOAuth, validateKey } from './openrouter';
import { emit, recentEvents, subscribe } from './events';
import { metrics } from './metrics';
import { readNotes, writeNotes } from './tools';

const publicDir = join(import.meta.dir, '..', 'public');
const COOKIE = 'osrsbot_session';

function secret(): string {
    const path = join(env.dataDir, 'secret');
    if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600 });
    return readFileSync(path, 'utf-8').trim();
}

// Stable across restarts, and changes when the password does.
const sessionToken = env.password ? createHash('sha256').update(secret() + '\0' + env.password).digest('hex') : '';

function authed(req: Request): boolean {
    if (!env.password) return true;
    const cookie = req.headers.get('cookie') ?? '';
    const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
    if (!match) return false;
    return timingSafeEqual(Buffer.from(match[1]!), Buffer.from(sessionToken));
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function fail(message: string, status = 400): Response {
    return json({ error: message }, status);
}

async function body<T>(req: Request): Promise<T> {
    if (!req.headers.get('content-type')?.includes('application/json')) throw new Error('Expected a JSON body');
    return (await req.json()) as T;
}

/** World state trimmed to what the dashboard draws. */
function worldForDashboard() {
    const sdk = botLink.sdk;
    const s = sdk?.getState();
    if (!sdk || !s) return null;
    return {
        tick: s.tick,
        ageMs: sdk.getStateAge(),
        inGame: s.inGame,
        player: s.player && {
            name: s.player.name, combatLevel: s.player.combatLevel, hp: s.player.hp, maxHp: s.player.maxHp,
            x: s.player.worldX, z: s.player.worldZ, level: s.player.level, animId: s.player.animId, isDead: s.player.isDead,
        },
        skills: s.skills.filter(k => !/^Stat\d+$/i.test(k.name)).map(k => ({ name: k.name, level: k.level, baseLevel: k.baseLevel, xp: k.experience })),
        inventory: s.inventory.map(i => ({ slot: i.slot, name: i.name, count: i.count })),
        equipment: s.equipment.map(i => ({ slot: i.slot, name: i.name, count: i.count })),
        npcs: s.nearbyNpcs.slice(0, 80).map(n => ({ name: n.name, x: n.x, z: n.z, combatLevel: n.combatLevel })),
        players: s.nearbyPlayers.slice(0, 50).map(p => ({ name: p.name, x: p.x, z: p.z })),
        locs: s.nearbyLocs.slice(0, 150).map(l => ({ name: l.name, x: l.x, z: l.z })),
        groundItems: s.groundItems.slice(0, 60).map(g => ({ name: g.name, x: g.x, z: g.z, count: g.count })),
        messages: s.gameMessages.slice(-12).map(m => ({ text: m.text, sender: m.sender, type: m.type })),
        dialog: s.dialog?.isOpen ? { text: s.dialog.text, options: s.dialog.options.map(o => o.text) } : null,
    };
}

export function statusSnapshot() {
    return {
        settings,
        agent: {
            status: agent.status,
            detail: agent.detail,
            session: agent.sessionNumber,
            sessionTurns: agent.sessionTurns,
            sessionStartedAt: agent.sessionStartedAt,
            sessionCostUsd: agent.sessionCostUsd,
            currentTool: agent.currentTool,
        },
        client: {
            status: gameClient.status,
            mode: gameClient.mode,
            startedAt: gameClient.startedAt,
            restarts: gameClient.restarts,
            gateway: botLink.sdk?.getConnectionState() ?? 'disconnected',
            stateAgeMs: botLink.sdk?.getState() ? botLink.sdk.getStateAge() : null,
            inGame: botLink.isLive(),
        },
        metrics: metrics.snapshot(),
        llm: {
            provider: settings.provider,
            model: activeModel(),
            sessionModel: agent.sessionModel,
            unavailable: providers[settings.provider].unavailableReason(),
            waitingUntil: agent.waitingUntil || null,
        },
        auth: !!env.password,
    };
}

/** This dashboard's public origin, as the browser sees it (behind a proxy too). */
function originOf(req: Request): string {
    const url = new URL(req.url);
    const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host;
    return `${proto}://${host}`;
}

async function openrouterAccount() {
    const key = openrouterKey();
    const info = key ? await keyInfo() : null;
    return {
        hasKey: !!key,
        keySource: keySource(),
        keyHint: key ? `…${key.slice(-4)}` : null,
        info,
        freeRequestsToday: metrics.freeRequestsToday(),
    };
}

type Handler = (req: Request, url: URL) => Promise<Response> | Response;

const post: Record<string, Handler> = {
    '/api/agent/start': () => { agent.start(); return json({ ok: true }); },
    '/api/agent/pause': () => { agent.pause(); return json({ ok: true }); },
    '/api/agent/stop': async () => { await agent.stop(); return json({ ok: true }); },
    '/api/agent/new-session': () => { agent.newSession(); return json({ ok: true }); },
    '/api/agent/interrupt': () => { agent.interruptTool(); return json({ ok: true }); },
    '/api/agent/message': async req => {
        const { text } = await body<{ text: string }>(req);
        if (typeof text !== 'string' || !text.trim()) return fail('Message is empty');
        agent.sendOperatorMessage(text.trim().slice(0, 4000));
        return json({ ok: true });
    },
    '/api/client/start': async () => { await gameClient.start(); void botLink.connect().catch(e => emit('error', `SDK connect: ${e.message}`)); return json({ ok: true }); },
    '/api/client/stop': async () => { await gameClient.stop(); return json({ ok: true }); },
    '/api/client/restart': async () => { await gameClient.restart(); return json({ ok: true }); },
    '/api/settings': async req => json({ settings: updateSettings(await body<Partial<Settings>>(req)) }),
    '/api/notes': async req => {
        const { notes } = await body<{ notes: string }>(req);
        if (typeof notes !== 'string') return fail('notes must be a string');
        writeNotes(notes);
        emit('operator', 'Operator edited the agent notes');
        return json({ ok: true });
    },
    '/api/bench/start': async req => {
        const { label, minutes, goal } = await body<{ label?: string; minutes?: number; goal?: string }>(req);
        const mins = Math.max(1, Math.min(24 * 60, Math.round(Number(minutes) || 15)));
        const run = metrics.startRun(String(label ?? '').slice(0, 80), mins, String(goal ?? '').trim().slice(0, 2000));
        agent.newSession();
        agent.start();
        return json({ run });
    },
    '/api/bench/stop': () => json({ run: metrics.endRun('stopped') }),
    '/api/openrouter/key': async req => {
        const { key } = await body<{ key: string }>(req);
        if (typeof key !== 'string') return fail('key must be a string');
        const trimmed = key.trim();
        if (trimmed) await validateKey(trimmed);
        saveKey(trimmed);
        emit('operator', trimmed ? 'OpenRouter API key saved' : 'OpenRouter API key removed');
        return json(await openrouterAccount());
    },
    '/api/openrouter/connect': req => json(startOAuth(`${originOf(req)}/`)),
    '/api/openrouter/exchange': async req => {
        const { code, state } = await body<{ code: string; state: string }>(req);
        if (typeof code !== 'string' || typeof state !== 'string') return fail('code and state are required');
        await finishOAuth(code, state);
        emit('operator', 'Connected to OpenRouter: API key created and saved');
        return json(await openrouterAccount());
    },
};

const get: Record<string, Handler> = {
    '/api/status': () => json(statusSnapshot()),
    '/api/world': () => json(worldForDashboard()),
    '/api/events': () => json(recentEvents()),
    '/api/runs': () => json(metrics.runs.slice().reverse()),
    '/api/series': (_req, url) => json(metrics.series(Math.max(1, Math.min(24, Number(url.searchParams.get('hours')) || 6)))),
    '/api/client-log': () => json(gameClient.log.slice(-200)),
    '/api/notes': () => json({ notes: readNotes() }),
    '/api/stream': req => sse(req),
    '/api/openrouter/models': async (_req, url) => {
        const force = url.searchParams.get('refresh') === '1';
        const [list, available] = await Promise.all([models(force), modelsForKey(force)]);
        return json({ models: list, availableIds: available ? [...available] : null });
    },
    '/api/openrouter/account': async (_req, url) => {
        if (url.searchParams.get('refresh') === '1') await keyInfo(true);
        return json(await openrouterAccount());
    },
    '/api/openrouter/endpoints': async (_req, url) => json(await endpoints(url.searchParams.get('model') ?? '')),
    '/api/anthropic/models': () => json(ANTHROPIC_MODELS),
};

function sse(req: Request): Response {
    let unsubscribe = () => {};
    let keepalive: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<string>({
        start(controller) {
            const send = (msg: unknown) => controller.enqueue(`data: ${JSON.stringify(msg)}\n\n`);
            send({ type: 'hello', status: statusSnapshot() });
            unsubscribe = subscribe(send);
            keepalive = setInterval(() => controller.enqueue(': keepalive\n\n'), 15_000);
            req.signal.addEventListener('abort', () => {
                unsubscribe();
                clearInterval(keepalive);
                try { controller.close(); } catch { /* already closed */ }
            });
        },
        cancel() {
            unsubscribe();
            clearInterval(keepalive);
        },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' } });
}

const STATIC: Record<string, string> = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/app.js': 'app.js',
    '/style.css': 'style.css',
};

interface ViewSocket { stop?: () => void }

export function startServer(): void {
    const hostname = env.host;
    Bun.serve<ViewSocket, never>({
        port: env.port,
        hostname,
        idleTimeout: 0, // SSE and long execute_code-driven requests
        async fetch(req, server) {
            const url = new URL(req.url);
            if (req.method === 'GET' && STATIC[url.pathname]) {
                return new Response(Bun.file(join(publicDir, STATIC[url.pathname]!)), { headers: { 'Cache-Control': 'no-cache' } });
            }
            if (req.method === 'POST' && url.pathname === '/api/login') {
                if (!env.password) return json({ ok: true });
                const { password } = await body<{ password: string }>(req).catch(() => ({ password: '' }));
                const given = createHash('sha256').update(String(password)).digest();
                const want = createHash('sha256').update(env.password).digest();
                if (!timingSafeEqual(given, want)) {
                    await Bun.sleep(1_000);
                    return fail('Wrong password', 401);
                }
                const secure = req.headers.get('x-forwarded-proto') === 'https' || url.protocol === 'https:';
                return new Response(JSON.stringify({ ok: true }), {
                    headers: {
                        'Content-Type': 'application/json',
                        'Set-Cookie': `${COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`,
                    },
                });
            }
            if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
            if (!authed(req)) return fail('Login required', 401);

            if (url.pathname === '/api/view') {
                return server.upgrade(req, { data: {} }) ? undefined : fail('WebSocket upgrade failed');
            }
            const handler = (req.method === 'POST' ? post : req.method === 'GET' ? get : {})[url.pathname];
            if (!handler) return fail('Not found', 404);
            try {
                return await handler(req, url);
            } catch (error) {
                return fail(error instanceof Error ? error.message : String(error));
            }
        },
        websocket: {
            open(ws: ServerWebSocket<ViewSocket>) {
                ws.data.stop = gameClient.watch(frame => {
                    // Drop frames for slow viewers instead of queueing them.
                    if (ws.getBufferedAmount() < 512 * 1024) ws.send(frame);
                });
            },
            message(_ws, raw) {
                try {
                    const msg = JSON.parse(String(raw)) as { key?: string; down?: boolean };
                    if (typeof msg.key === 'string') void gameClient.cameraKey(msg.key, !!msg.down);
                } catch { /* ignore junk */ }
            },
            close(ws) {
                ws.data.stop?.();
            },
        },
    });
    const local = hostname === '127.0.0.1' || hostname === 'localhost';
    console.log(`[osrsbot] Dashboard on http://${local ? hostname : 'localhost'}:${env.port}${env.password ? '' : local ? ' (local only: set DASHBOARD_PASSWORD to listen on all interfaces)' : ' WITHOUT a password'}`);
}
