// Process configuration (env) and the settings the dashboard can change (data/settings.json).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const env = {
    port: Number(process.env.DASHBOARD_PORT || 8080),
    password: process.env.DASHBOARD_PASSWORD || '',
    /** Listen address. Defaults to all interfaces with a password, loopback without one. */
    host: process.env.DASHBOARD_HOST || (process.env.DASHBOARD_PASSWORD ? '0.0.0.0' : '127.0.0.1'),
    /** rs-sdk checkout (scripts/setup.ts). Fixed path: src/ imports the SDK from it. */
    rsSdkDir: resolve(import.meta.dir, '../vendor/rs-sdk'),
    dataDir: resolve(process.env.DATA_DIR || './data'),
    chromePath: process.env.CHROME_PATH || '',
};

mkdirSync(join(env.dataDir, 'logs'), { recursive: true });

export type ClientMode = 'lite' | 'browser';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface Settings {
    /** In-game username, max 12 alphanumeric characters. */
    botName: string;
    /** Game server host. rs-sdk-demo.fly.dev is the public server with the leaderboard. */
    server: string;
    /** 'lite' = headless client (cheap). 'browser' = real 3D client in headless Chrome, streamable to the dashboard. */
    clientMode: ClientMode;
    /** Let the agent see other players' chat. Off by default: chat is a prompt-injection channel. */
    showChat: boolean;
    model: string;
    effort: Effort;
    /** What the agent works toward. */
    goal: string;
    /** Tool calls per agent session before it starts fresh from its notes. */
    maxTurnsPerSession: number;
    /** Longest single execute_code run the agent may ask for. */
    maxCodeSeconds: number;
    /** Agent pauses itself once today's estimated API spend reaches this. 0 = no limit. */
    dailyBudgetUsd: number;
    /** Start the game client and agent when the process starts. */
    autoStart: boolean;
}

export const defaultSettings: Settings = {
    botName: '',
    server: 'rs-sdk-demo.fly.dev',
    clientMode: 'lite',
    showChat: false,
    model: 'claude-opus-5-5',
    effort: 'high',
    goal: 'Get the highest total level you can in the least playtime. Skip the tutorial first if needed. Prefer fast, reliable XP methods, and save what you learn to your notes.',
    maxTurnsPerSession: 40,
    maxCodeSeconds: 600,
    dailyBudgetUsd: 20,
    autoStart: false,
};

const settingsPath = join(env.dataDir, 'settings.json');

function load(): Settings {
    if (!existsSync(settingsPath)) return { ...defaultSettings };
    try {
        return { ...defaultSettings, ...JSON.parse(readFileSync(settingsPath, 'utf-8')) };
    } catch {
        return { ...defaultSettings };
    }
}

export const settings: Settings = load();

const listeners = new Set<(changed: Partial<Settings>) => void>();

export function onSettingsChange(fn: (changed: Partial<Settings>) => void): void {
    listeners.add(fn);
}

/** Validate and apply a partial update from the dashboard. Throws with a readable message on bad input. */
export function updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...settings };
    for (const [key, value] of Object.entries(patch) as [keyof Settings, unknown][]) {
        if (!(key in defaultSettings)) throw new Error(`Unknown setting: ${key}`);
        const expected = typeof defaultSettings[key];
        if (typeof value !== expected) throw new Error(`${key} must be a ${expected}`);
        (next as Record<string, unknown>)[key] = value;
    }
    if (next.botName && !/^[a-zA-Z0-9]{1,12}$/.test(next.botName)) throw new Error('Bot name must be 1-12 letters or digits');
    if (!['lite', 'browser'].includes(next.clientMode)) throw new Error('clientMode must be lite or browser');
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(next.effort)) throw new Error('Unknown effort level');
    if (!/^[a-zA-Z0-9.:-]+$/.test(next.server)) throw new Error('Server must be a host name, optionally with :port');
    next.maxTurnsPerSession = Math.max(5, Math.min(200, Math.round(next.maxTurnsPerSession)));
    next.maxCodeSeconds = Math.max(10, Math.min(1800, Math.round(next.maxCodeSeconds)));
    next.dailyBudgetUsd = Math.max(0, next.dailyBudgetUsd);

    const changed: Partial<Settings> = {};
    for (const key of Object.keys(next) as (keyof Settings)[]) {
        if (next[key] !== settings[key]) (changed as Record<string, unknown>)[key] = next[key];
    }
    Object.assign(settings, next);
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    if (Object.keys(changed).length) for (const fn of listeners) fn(changed);
    return settings;
}

export function isLocalServer(server = settings.server): boolean {
    return server.startsWith('localhost') || server.startsWith('127.');
}

/** Public web origin of the game server (hiscores, /bot client page). */
export function serverOrigin(server = settings.server): string {
    if (isLocalServer(server)) return `http://${server.includes(':') ? server : server + ':8888'}`;
    return `https://${server}`;
}
