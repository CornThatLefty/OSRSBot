// OpenRouter account and catalog: the API key, the model list, key limits and credits, and the
// OAuth (PKCE) "Connect OpenRouter" flow that creates a key without copy-pasting one.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EFFORTS, env, type Effort } from './config';

/** Overridable for proxies and tests. */
export const OPENROUTER_API = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');

/** App attribution, shown in the user's OpenRouter activity log. */
export const ATTRIBUTION_HEADERS = {
    'HTTP-Referer': 'https://github.com/CornThatLefty/OSRSBot',
    'X-OpenRouter-Title': 'OSRSBot',
};

// ---- API key ------------------------------------------------------------------------------

const secretsPath = join(env.dataDir, 'secrets.json');

function readSecrets(): { openrouterKey?: string } {
    try { return existsSync(secretsPath) ? JSON.parse(readFileSync(secretsPath, 'utf-8')) : {}; } catch { return {}; }
}

/** A key saved from the dashboard wins over OPENROUTER_API_KEY in .env. */
export function openrouterKey(): string {
    return readSecrets().openrouterKey || process.env.OPENROUTER_API_KEY || '';
}

export function keySource(): 'dashboard' | 'env' | null {
    if (readSecrets().openrouterKey) return 'dashboard';
    return process.env.OPENROUTER_API_KEY ? 'env' : null;
}

export function saveKey(key: string): void {
    const secrets = readSecrets();
    if (key) secrets.openrouterKey = key;
    else delete secrets.openrouterKey;
    writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    keyInfoCache = null;
}

export function authHeaders(key = openrouterKey()): Record<string, string> {
    return { Authorization: `Bearer ${key}`, ...ATTRIBUTION_HEADERS };
}

// ---- key limits and credits ---------------------------------------------------------------

export interface KeyInfo {
    label: string;
    /** Credits used by this key (USD). */
    usage: number;
    usageDaily?: number;
    usageMonthly?: number;
    /** Spending cap on the key, null = none. */
    limit: number | null;
    limitRemaining: number | null;
    limitReset?: string | null;
    isFreeTier: boolean;
    /** Today's (UTC) quota of requests to :free models: 50/day until the account has bought 10+ credits, then 1000. */
    freeDaily?: { used: number; limit: number; remaining: number };
    checkedAt: number;
    error?: string;
}

let keyInfoCache: KeyInfo | null = null;

export async function keyInfo(force = false): Promise<KeyInfo | null> {
    const key = openrouterKey();
    if (!key) return null;
    if (!force && keyInfoCache && Date.now() - keyInfoCache.checkedAt < 60_000) return keyInfoCache;
    try {
        const res = await fetch(`${OPENROUTER_API}/key`, { headers: authHeaders(key), signal: AbortSignal.timeout(15_000) });
        if (!res.ok) {
            keyInfoCache = { label: '', usage: 0, limit: null, limitRemaining: null, isFreeTier: true, checkedAt: Date.now(), error: res.status === 401 ? 'Key rejected (401)' : `HTTP ${res.status}` };
            return keyInfoCache;
        }
        const d = (await res.json()).data ?? {};
        const free = d.free_model_daily_requests;
        const info: KeyInfo = {
            label: d.label ?? '',
            usage: Number(d.usage ?? 0),
            usageDaily: d.usage_daily != null ? Number(d.usage_daily) : undefined,
            usageMonthly: d.usage_monthly != null ? Number(d.usage_monthly) : undefined,
            limit: d.limit == null ? null : Number(d.limit),
            limitRemaining: d.limit_remaining == null ? null : Number(d.limit_remaining),
            limitReset: d.limit_reset ?? null,
            isFreeTier: !!d.is_free_tier,
            freeDaily: free && typeof free.limit === 'number'
                ? { used: Number(free.used ?? 0), limit: Number(free.limit), remaining: Number(free.remaining ?? 0) }
                : undefined,
            checkedAt: Date.now(),
        };
        keyInfoCache = info;
        return info;
    } catch (error) {
        return keyInfoCache ?? { label: '', usage: 0, limit: null, limitRemaining: null, isFreeTier: true, checkedAt: Date.now(), error: error instanceof Error ? error.message : String(error) };
    }
}

/** True when today's free-model quota is used up (it resets at midnight UTC). */
export function freeQuotaExhausted(info: KeyInfo | null): boolean {
    return !!info?.freeDaily && info.freeDaily.remaining <= 0;
}

// ---- model catalog ------------------------------------------------------------------------

export interface ModelInfo {
    id: string;
    name: string;
    description: string;
    created: number;
    contextLength: number;
    maxOutput: number | null;
    /** USD per million tokens. -1 = variable (routers). */
    promptPrice: number;
    completionPrice: number;
    cacheReadPrice: number | null;
    free: boolean;
    tools: boolean;
    reasoning: boolean;
    efforts: Effort[];
    defaultEffort: Effort | null;
    reasoningMandatory: boolean;
    inputModalities: string[];
    expires: string | null;
    /** Request parameters the model's providers accept (we only send these: see require_parameters). */
    params: string[];
}

let catalog: { models: ModelInfo[]; fetchedAt: number } | null = null;
let catalogLoading: Promise<ModelInfo[]> | null = null;

function perMillion(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? -1 : Math.round(n * 1_000_000 * 1e6) / 1e6;
}

function toModelInfo(m: any): ModelInfo {
    const params: string[] = m.supported_parameters ?? [];
    const promptPrice = perMillion(m.pricing?.prompt);
    const completionPrice = perMillion(m.pricing?.completion);
    const efforts = (m.reasoning?.supported_efforts ?? []).filter((e: string): e is Effort => (EFFORTS as string[]).includes(e));
    return {
        id: m.id,
        name: m.name ?? m.id,
        description: String(m.description ?? '').slice(0, 400),
        created: Number(m.created ?? 0),
        contextLength: Number(m.context_length ?? m.top_provider?.context_length ?? 0),
        maxOutput: m.top_provider?.max_completion_tokens ?? null,
        promptPrice,
        completionPrice,
        cacheReadPrice: m.pricing?.input_cache_read != null ? perMillion(m.pricing.input_cache_read) : null,
        free: m.id.endsWith(':free') || (promptPrice === 0 && completionPrice === 0),
        tools: params.includes('tools'),
        reasoning: params.includes('reasoning') || !!m.reasoning,
        efforts,
        defaultEffort: (EFFORTS as string[]).includes(m.reasoning?.default_effort) ? m.reasoning.default_effort : null,
        reasoningMandatory: !!m.reasoning?.mandatory,
        inputModalities: m.architecture?.input_modalities ?? [],
        expires: m.expiration_date ?? null,
        params,
    };
}

let userModels: { ids: Set<string>; key: string; fetchedAt: number } | null = null;

/**
 * Model ids this key can actually use, after the account's privacy settings and guardrails
 * (free models in particular are often excluded until their privacy toggles are enabled).
 * Null when there's no key or the list couldn't be fetched.
 */
export async function modelsForKey(force = false): Promise<Set<string> | null> {
    const key = openrouterKey();
    if (!key) return null;
    if (!force && userModels && userModels.key === key && Date.now() - userModels.fetchedAt < 600_000) return userModels.ids;
    try {
        const res = await fetch(`${OPENROUTER_API}/models/user`, { headers: authHeaders(key), signal: AbortSignal.timeout(30_000) });
        if (!res.ok) return userModels?.ids ?? null;
        const ids = new Set<string>(((await res.json()).data ?? []).map((m: { id: string }) => m.id));
        userModels = { ids, key, fetchedAt: Date.now() };
        return ids;
    } catch {
        return userModels?.ids ?? null;
    }
}

export interface EndpointInfo {
    provider: string;
    tag: string;
    contextLength: number;
    maxOutput: number | null;
    quantization: string | null;
    promptPrice: number;
    completionPrice: number;
    tools: boolean;
    uptime30m: number | null;
    latencyP50: number | null;
    throughputP50: number | null;
    status: number | null;
}

/** The providers serving one model, with prices and recent uptime/latency (shown for the selected model). */
export async function endpoints(modelId: string): Promise<EndpointInfo[]> {
    const id = modelId.replace(/:(nitro|floor|exacto)$/, '');
    if (!/^[a-zA-Z0-9._~-]+\/[a-zA-Z0-9._~:-]+$/.test(id)) throw new Error('Not a model id');
    const key = openrouterKey();
    const res = await fetch(`${OPENROUTER_API}/models/${id}/endpoints`, {
        headers: key ? authHeaders(key) : ATTRIBUTION_HEADERS,
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`OpenRouter endpoints: HTTP ${res.status}`);
    const list: any[] = (await res.json()).data?.endpoints ?? [];
    return list.map(e => ({
        provider: e.provider_name ?? e.name ?? '?',
        tag: e.tag ?? '',
        contextLength: Number(e.context_length ?? 0),
        maxOutput: e.max_completion_tokens ?? null,
        quantization: e.quantization ?? null,
        promptPrice: perMillion(e.pricing?.prompt),
        completionPrice: perMillion(e.pricing?.completion),
        tools: (e.supported_parameters ?? []).includes('tools'),
        uptime30m: e.uptime_last_30m ?? null,
        latencyP50: e.latency_last_30m?.p50 ?? null,
        throughputP50: e.throughput_last_30m?.p50 ?? null,
        status: e.status ?? null,
    }));
}

/** All OpenRouter models (cached for an hour). Public endpoint: works before a key is set. */
export async function models(force = false): Promise<ModelInfo[]> {
    if (!force && catalog && Date.now() - catalog.fetchedAt < 3600_000) return catalog.models;
    catalogLoading ??= (async () => {
        try {
            const res = await fetch(`${OPENROUTER_API}/models`, { headers: ATTRIBUTION_HEADERS, signal: AbortSignal.timeout(30_000) });
            if (!res.ok) throw new Error(`OpenRouter models: HTTP ${res.status}`);
            const list = ((await res.json()).data ?? []).map(toModelInfo) as ModelInfo[];
            catalog = { models: list, fetchedAt: Date.now() };
            return list;
        } finally {
            catalogLoading = null;
        }
    })();
    try {
        return await catalogLoading;
    } catch (error) {
        if (catalog) return catalog.models; // stale beats nothing
        throw error;
    }
}

export async function modelInfo(id: string): Promise<ModelInfo | null> {
    const base = id.replace(/:(nitro|floor|online|exacto|thinking)$/, '');
    try {
        const list = await models();
        return list.find(m => m.id === id) ?? list.find(m => m.id === base) ?? null;
    } catch {
        return null;
    }
}

/** The requested effort, or the nearest one the model supports. */
export function clampEffort(effort: Effort, model: ModelInfo | null): Effort | null {
    if (!model?.reasoning) return null;
    if (!model.efforts.length) return effort;
    if (model.efforts.includes(effort)) return effort;
    const want = EFFORTS.indexOf(effort);
    return [...model.efforts].sort((a, b) => Math.abs(EFFORTS.indexOf(a) - want) - Math.abs(EFFORTS.indexOf(b) - want))[0] ?? null;
}

// ---- OAuth PKCE ---------------------------------------------------------------------------

const pendingLogins = new Map<string, { verifier: string; createdAt: number }>();

/** Start "Connect OpenRouter": returns the URL to send the browser to. */
export function startOAuth(callbackUrl: string): { url: string; state: string } {
    for (const [state, p] of pendingLogins) if (Date.now() - p.createdAt > 15 * 60_000) pendingLogins.delete(state);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(12).toString('base64url');
    pendingLogins.set(state, { verifier, createdAt: Date.now() });
    const callback = new URL(callbackUrl);
    callback.searchParams.set('or_state', state);
    const url = new URL('https://openrouter.ai/auth');
    url.searchParams.set('callback_url', callback.toString());
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('key_label', 'OSRSBot');
    return { url: url.toString(), state };
}

/** Finish "Connect OpenRouter": trade the code from the callback for a key and save it. */
export async function finishOAuth(code: string, state: string): Promise<void> {
    const pending = pendingLogins.get(state);
    if (!pending) throw new Error('This OpenRouter login expired or was already used. Click Connect again.');
    pendingLogins.delete(state);
    const res = await fetch(`${OPENROUTER_API}/auth/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ATTRIBUTION_HEADERS },
        body: JSON.stringify({ code, code_verifier: pending.verifier, code_challenge_method: 'S256' }),
        signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || typeof body.key !== 'string') throw new Error(`OpenRouter did not return a key (HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ''})`);
    saveKey(body.key);
}

/** Check a pasted key before saving it. */
export async function validateKey(key: string): Promise<void> {
    const res = await fetch(`${OPENROUTER_API}/key`, { headers: authHeaders(key), signal: AbortSignal.timeout(15_000) });
    if (res.status === 401) throw new Error('OpenRouter rejected that key');
    if (!res.ok) throw new Error(`Could not check the key (HTTP ${res.status})`);
}
