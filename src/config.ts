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
export type LlmProvider = 'openrouter' | 'anthropic';
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface Settings {
    /** In-game username, max 12 alphanumeric characters. */
    botName: string;
    /** Game server host. rs-sdk-demo.fly.dev is the public server with the leaderboard. */
    server: string;
    /** 'lite' = headless client (cheap). 'browser' = real 3D client in headless Chrome, streamable to the dashboard. */
    clientMode: ClientMode;
    /** Let the agent see other players' chat. Off by default: chat is a prompt-injection channel. */
    showChat: boolean;
    /** Which API the agent calls. */
    provider: LlmProvider;
    /** Claude API model id (provider 'anthropic'). */
    anthropicModel: string;
    /** OpenRouter model id (provider 'openrouter'), e.g. 'openrouter/free' or 'anthropic/claude-opus-5.5'. */
    openrouterModel: string;
    /** OpenRouter: models to try in order when the main one errors, is rate-limited or is down. */
    openrouterFallbacks: string[];
    /** OpenRouter: how to pick between providers serving the model. '' = OpenRouter's default balancing; 'exacto' = best tool-calling quality. */
    providerSort: '' | 'price' | 'throughput' | 'latency' | 'exacto';
    /** OpenRouter: 'account' = your privacy settings; 'deny' = only providers that don't store or train on prompts. */
    dataCollection: 'account' | 'allow' | 'deny';
    /** OpenRouter: skip providers above these prices, in $ per million tokens. 0 = no cap. */
    maxPromptPrice: number;
    maxCompletionPrice: number;
    /** Output token cap per model call. */
    maxOutputTokens: number;
    /** Reasoning effort; clamped to what the chosen model supports. */
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
    provider: 'openrouter',
    anthropicModel: 'claude-opus-5-5',
    // OpenRouter's free router: picks a free, tool-capable model per request. Costs nothing.
    openrouterModel: 'openrouter/free',
    openrouterFallbacks: [],
    providerSort: '',
    dataCollection: 'account',
    maxPromptPrice: 0,
    maxCompletionPrice: 0,
    maxOutputTokens: 16_000,
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
        const saved = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        // Before OpenRouter support there was a single `model` (always a Claude API id).
        if (typeof saved.model === 'string' && !saved.anthropicModel) saved.anthropicModel = saved.model;
        delete saved.model;
        return { ...defaultSettings, ...saved };
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
        if (typeof value !== expected) throw new Error(`${key} must be a ${Array.isArray(defaultSettings[key]) ? 'list' : expected}`);
        if (Array.isArray(defaultSettings[key]) && !(Array.isArray(value) && value.every(v => typeof v === 'string'))) throw new Error(`${key} must be a list of strings`);
        (next as Record<string, unknown>)[key] = value;
    }
    if (next.botName && !/^[a-zA-Z0-9]{1,12}$/.test(next.botName)) throw new Error('Bot name must be 1-12 letters or digits');
    if (!['lite', 'browser'].includes(next.clientMode)) throw new Error('clientMode must be lite or browser');
    if (!EFFORTS.includes(next.effort)) throw new Error('Unknown effort level');
    if (!['openrouter', 'anthropic'].includes(next.provider)) throw new Error('provider must be openrouter or anthropic');
    if (!['', 'price', 'throughput', 'latency', 'exacto'].includes(next.providerSort)) throw new Error('providerSort must be price, throughput, latency, exacto or empty');
    if (!['account', 'allow', 'deny'].includes(next.dataCollection)) throw new Error('dataCollection must be account, allow or deny');
    if (!/^[a-zA-Z0-9.:-]+$/.test(next.server)) throw new Error('Server must be a host name, optionally with :port');
    const modelId = /^[a-zA-Z0-9._~:/-]{1,120}$/;
    if (!modelId.test(next.openrouterModel)) throw new Error('OpenRouter model must be a model id like openrouter/free');
    next.openrouterFallbacks = [...new Set(next.openrouterFallbacks.map(m => m.trim()).filter(Boolean))].slice(0, 3);
    if (!next.openrouterFallbacks.every(m => modelId.test(m))) throw new Error('Fallback models must be model ids');
    next.maxTurnsPerSession = Math.max(5, Math.min(200, Math.round(next.maxTurnsPerSession)));
    next.maxCodeSeconds = Math.max(10, Math.min(1800, Math.round(next.maxCodeSeconds)));
    next.maxOutputTokens = Math.max(1_000, Math.min(128_000, Math.round(next.maxOutputTokens)));
    next.dailyBudgetUsd = Math.max(0, next.dailyBudgetUsd);
    next.maxPromptPrice = Math.max(0, next.maxPromptPrice);
    next.maxCompletionPrice = Math.max(0, next.maxCompletionPrice);

    const changed: Partial<Settings> = {};
    for (const key of Object.keys(next) as (keyof Settings)[]) {
        const same = Array.isArray(next[key]) ? JSON.stringify(next[key]) === JSON.stringify(settings[key]) : next[key] === settings[key];
        if (!same) (changed as Record<string, unknown>)[key] = next[key];
    }
    Object.assign(settings, next);
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    if (Object.keys(changed).length) for (const fn of listeners) fn(changed);
    return settings;
}

/** Model id the agent uses with the current provider. */
export function activeModel(): string {
    return settings.provider === 'openrouter' ? settings.openrouterModel : settings.anthropicModel;
}

export function isLocalServer(server = settings.server): boolean {
    return server.startsWith('localhost') || server.startsWith('127.');
}

/** Public web origin of the game server (hiscores, /bot client page). */
export function serverOrigin(server = settings.server): string {
    if (isLocalServer(server)) return `http://${server.includes(':') ? server : server + ':8888'}`;
    return `https://${server}`;
}
