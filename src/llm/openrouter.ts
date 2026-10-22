// OpenRouter provider: any model on openrouter.ai through its OpenAI-compatible chat completions API.
//
// - Streams responses (text, reasoning and tool-call deltas) and reads the exact cost OpenRouter
//   reports per request, so the daily budget is accurate (free models cost 0).
// - Sends reasoning effort only to models that support it, clamped to the efforts they accept.
// - Optional fallback models, provider sorting, price caps and data-collection policy come from
//   Settings; providers that can't do tool calling are skipped (require_parameters).
// - Free and small models have small context windows, so old tool output is trimmed before a
//   request would overflow, and OpenRouter's context-compression plugin is the backstop.

import { settings } from '../config';
import { authHeaders, clampEffort, freeQuotaExhausted, keyInfo, modelInfo, openrouterKey, OPENROUTER_API, type ModelInfo } from '../openrouter';
import { LlmError, type ChatSession, type Provider, type SessionOptions, type ToolCall, type ToolResult, type TurnResult } from './types';

type Role = 'system' | 'user' | 'assistant' | 'tool';
interface ChatMessage {
    role: Role;
    content: string | null | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[];
    tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
    tool_call_id?: string;
    /** Reasoning state some models need back on the next request to continue a tool-calling chain. */
    reasoning_details?: unknown[];
    reasoning?: string;
}

/** Model families whose prompt caching needs explicit cache_control breakpoints. */
function needsCacheControl(model: string): boolean {
    return /^(anthropic|google)\//.test(model);
}

const KEEP_RECENT_TOOL_RESULTS = 6;
const CHARS_PER_TOKEN = 3.5;

const PRIVACY_URL = 'https://openrouter.ai/settings/privacy';

/** Milliseconds until the next UTC midnight, when the daily free-model quota resets. */
function untilUtcMidnight(): number {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime() + 60_000;
}

/** Map an HTTP error from OpenRouter to something the agent loop can act on. */
async function errorFrom(res: Response, model: string): Promise<LlmError> {
    const body = await res.json().catch(() => null) as { error?: { message?: string; metadata?: Record<string, unknown> } } | null;
    const meta = body?.error?.metadata ?? {};
    const raw = meta.raw;
    let message = body?.error?.message || res.statusText || `HTTP ${res.status}`;
    if (typeof raw === 'string' && raw.length < 400) message += ` (${meta.provider_name ? meta.provider_name + ': ' : ''}${raw})`;
    const retry = Number(res.headers.get('retry-after'));
    let retryAfterMs = Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined;
    switch (res.status) {
        case 401:
            return new LlmError('auth', `OpenRouter rejected the API key: ${message}`);
        case 402:
            // A short-lived "too much in flight" budget clears by itself; the others need credits or a raised key limit.
            if (meta.limit_source === 'openrouter_in_flight_budget') return new LlmError('rate_limit', message, retryAfterMs ?? 30_000);
            return new LlmError('credits', `OpenRouter: ${meta.limit_source === 'openrouter_key_limit' ? "this key's spending limit is reached" : 'not enough credits'} (${message})`);
        case 403:
            if (typeof meta.limit_source === 'string') return new LlmError('credits', `OpenRouter budget reached: ${message}${meta.remedy_hint ? ` (${meta.remedy_hint})` : ''}`);
            return new LlmError('moderation', `OpenRouter moderation flagged the request: ${message}`);
        case 429: {
            // Platform limits say when the window resets (epoch ms).
            const reset = Number(res.headers.get('x-ratelimit-reset'));
            if (!retryAfterMs && Number.isFinite(reset) && reset > Date.now()) retryAfterMs = reset - Date.now() + 1_000;
            // The daily free-model quota resets at midnight UTC; say so plainly instead of retrying all day.
            const free = model.endsWith(':free') || model === 'openrouter/free';
            if (free) {
                const info = await keyInfo(true);
                if (freeQuotaExhausted(info)) {
                    return new LlmError('rate_limit', `Daily free-model quota used (${info!.freeDaily!.used}/${info!.freeDaily!.limit} requests today; resets at midnight UTC)`, untilUtcMidnight());
                }
            }
            return new LlmError('rate_limit', message, retryAfterMs);
        }
        case 404:
            if (/data policy|no endpoints found/i.test(message)) {
                return new LlmError('config', `No provider for ${model} is allowed by your OpenRouter privacy settings. Free models usually need "free endpoints that may train on inputs" enabled at ${PRIVACY_URL}, or pick another model`);
            }
            return new LlmError('config', `OpenRouter can't serve ${model}: ${message}`);
        case 503:
            return /routing|requirements|no provider/i.test(message)
                ? new LlmError('config', `No provider for ${model} meets the routing settings (price caps, data collection, tool support): ${message}`)
                : new LlmError('overloaded', message, retryAfterMs);
        case 400: case 413: case 422:
            return new LlmError('bad_request', message);
        case 408: case 500: case 502: case 504: case 524: case 529:
            return new LlmError('overloaded', message, retryAfterMs);
        default:
            return new LlmError('other', `HTTP ${res.status}: ${message}`, retryAfterMs);
    }
}

class OpenRouterSession implements ChatSession {
    private messages: ChatMessage[];
    private tools: { type: 'function'; function: { name: string; description: string; parameters: unknown } }[];
    private model: ModelInfo | null | undefined;

    constructor(private opts: SessionOptions) {
        this.messages = [];
        this.tools = opts.tools.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    }

    /** Built on the first call, once the model's context window is known. */
    private buildPrompt(): void {
        const opts = this.opts;
        // Under ~100k tokens of context, the long API reference would crowd out the actual work.
        const small = !!this.model?.contextLength && this.model.contextLength < 100_000;
        const blocks = opts.system.map(b => ({ ...b, text: small && b.compact ? b.compact : b.text }));
        const system: ChatMessage = needsCacheControl(opts.model)
            ? { role: 'system', content: blocks.map(b => ({ type: 'text' as const, text: b.text, ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {}) })) }
            : { role: 'system', content: blocks.map(b => b.text).join('\n\n') };
        this.messages = [system, { role: 'user', content: opts.kickoff }];
    }

    /** `:exacto` routes to the providers with the best tool-calling quality (not for routers or other variants). */
    private withVariant(id: string): string {
        return settings.providerSort === 'exacto' && !id.startsWith('openrouter/') && !/:[a-z]+$/.test(id) ? `${id}:exacto` : id;
    }

    private requestBody(): Record<string, unknown> {
        const s = settings;
        const params = this.model?.params ?? [];
        // With require_parameters, a parameter the model doesn't list would exclude every provider,
        // so send only what it supports. Unknown model (catalog unreachable): keep to the basics.
        const supports = (p: string) => !this.model || params.includes(p);
        const effort = supports('reasoning') ? clampEffort(this.opts.effort, this.model ?? null) : null;
        const provider: Record<string, unknown> = {
            // Only route to providers that support every parameter sent, tools in particular.
            require_parameters: true,
        };
        if (s.providerSort && s.providerSort !== 'exacto') provider.sort = s.providerSort;
        if (s.dataCollection !== 'account') provider.data_collection = s.dataCollection;
        if (s.maxPromptPrice > 0 || s.maxCompletionPrice > 0) {
            provider.max_price = {
                ...(s.maxPromptPrice > 0 ? { prompt: s.maxPromptPrice } : {}),
                ...(s.maxCompletionPrice > 0 ? { completion: s.maxCompletionPrice } : {}),
            };
        }
        const maxOutput = this.model?.maxOutput ? Math.min(s.maxOutputTokens, this.model.maxOutput) : s.maxOutputTokens;
        const maxParam = params.includes('max_completion_tokens') && !params.includes('max_tokens') ? 'max_completion_tokens' : 'max_tokens';
        const model = this.withVariant(this.opts.model);
        return {
            model,
            ...(s.openrouterFallbacks.length ? { models: [model, ...s.openrouterFallbacks.map(m => this.withVariant(m))] } : {}),
            messages: this.messages,
            tools: this.tools,
            ...(supports(maxParam) ? { [maxParam]: maxOutput } : {}),
            stream: true,
            ...(effort ? { reasoning: { effort } } : {}),
            // Anthropic models: also cache the growing conversation (automatic breakpoint).
            ...(/^anthropic\//.test(this.opts.model) ? { cache_control: { type: 'ephemeral' } } : {}),
            // Same session id = same provider while it stays warm, which keeps prompt caches hitting.
            session_id: this.sessionId,
            provider,
            // Backstop for small context windows: squeeze the middle of the conversation rather than fail.
            plugins: [{ id: 'context-compression' }],
        };
    }

    private sessionId = `osrsbot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    /** Keep the request inside the model's context window by shortening the oldest tool outputs. */
    private trimContext(): void {
        const limit = this.model?.contextLength || 128_000;
        const budgetChars = (limit - (this.model?.maxOutput ? Math.min(settings.maxOutputTokens, this.model.maxOutput) : settings.maxOutputTokens)) * CHARS_PER_TOKEN * 0.85;
        const size = () => JSON.stringify(this.messages).length;
        if (size() <= budgetChars) return;
        const toolIdx = this.messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter(i => i >= 0);
        for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_RECENT_TOOL_RESULTS))) {
            const m = this.messages[i]!;
            if (typeof m.content === 'string' && m.content.length > 400) {
                m.content = `${m.content.slice(0, 300)}\n[older output trimmed to fit the context window]`;
                if (size() <= budgetChars) return;
            }
        }
    }

    async next(signal: AbortSignal): Promise<TurnResult> {
        this.model ??= await modelInfo(this.opts.model);
        if (!this.messages.length) this.buildPrompt();
        this.trimContext();

        let res: Response;
        try {
            res = await fetch(`${OPENROUTER_API}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify(this.requestBody()),
                signal,
            });
        } catch (error) {
            if (signal.aborted) throw signal.reason;
            throw new LlmError('overloaded', `Could not reach OpenRouter: ${error instanceof Error ? error.message : error}`);
        }
        if (!res.ok || !res.body) throw await errorFrom(res, this.opts.model);

        let text = '';
        let reasoning = '';
        const reasoningDetails: unknown[] = [];
        const calls: { id: string; name: string; args: string }[] = [];
        let finish: string | null = null;
        let usage: any = null;
        let answeredBy = '';

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let nl: number;
                while ((nl = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, nl).trim();
                    buffer = buffer.slice(nl + 1);
                    // ": OPENROUTER PROCESSING" keepalives are SSE comments.
                    if (!line.startsWith('data:')) continue;
                    const data = line.slice(5).trim();
                    if (data === '[DONE]') continue;
                    let chunk: any;
                    try { chunk = JSON.parse(data); } catch { continue; }
                    if (chunk.error) {
                        // Errors after the stream started arrive as an event; code may be a number or a string.
                        const code = String(chunk.error.code ?? '');
                        const type = String(chunk.error.metadata?.error_type ?? '');
                        const kind = code === '429' || /rate_limit/.test(type) ? 'rate_limit' : code === '402' ? 'credits' : code === '401' ? 'auth' : 'overloaded';
                        throw new LlmError(kind, `OpenRouter stream error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
                    }
                    if (chunk.model) answeredBy = chunk.model;
                    if (chunk.usage) usage = chunk.usage;
                    const choice = chunk.choices?.[0];
                    if (!choice) continue;
                    const delta = choice.delta ?? {};
                    if (typeof delta.content === 'string' && delta.content) {
                        text += delta.content;
                        this.opts.onDelta('text', delta.content);
                    }
                    if (typeof delta.reasoning === 'string' && delta.reasoning) {
                        reasoning += delta.reasoning;
                        this.opts.onDelta('thinking', delta.reasoning);
                    }
                    if (Array.isArray(delta.reasoning_details)) reasoningDetails.push(...delta.reasoning_details);
                    for (const tc of delta.tool_calls ?? []) {
                        const i = typeof tc.index === 'number' ? tc.index : calls.length;
                        const call = (calls[i] ??= { id: '', name: '', args: '' });
                        if (tc.id) call.id = tc.id;
                        if (tc.function?.name) call.name += tc.function.name;
                        if (tc.function?.arguments) call.args += tc.function.arguments;
                    }
                    if (choice.finish_reason) finish = choice.finish_reason;
                }
            }
        } catch (error) {
            if (signal.aborted) throw signal.reason;
            if (error instanceof LlmError) throw error;
            throw new LlmError('overloaded', `OpenRouter stream broke off: ${error instanceof Error ? error.message : error}`);
        }

        const toolCalls: ToolCall[] = calls.filter(Boolean).map((c, i) => {
            const id = c.id || `call_${Date.now().toString(36)}_${i}`;
            let input: unknown;
            try { input = c.args.trim() ? JSON.parse(c.args) : {}; } catch { input = { __invalidJson: c.args }; }
            return { id, name: c.name, input };
        });

        const assistant: ChatMessage = { role: 'assistant', content: text || null };
        if (toolCalls.length) {
            assistant.tool_calls = toolCalls.map((t, i) => ({
                id: t.id, type: 'function' as const,
                function: { name: t.name, arguments: calls.filter(Boolean)[i]!.args || '{}' },
            }));
        }
        // Pass reasoning back unchanged so models that rely on it keep their chain across tool calls.
        if (reasoningDetails.length) assistant.reasoning_details = reasoningDetails;
        else if (reasoning) assistant.reasoning = reasoning;
        this.messages.push(assistant);

        const result: TurnResult = {
            stop: 'end_turn', toolCalls, text: text.trim() ? [text] : [], thinking: reasoning.trim() ? [reasoning] : [], notes: [],
            model: answeredBy || this.opts.model,
            costUsd: Number(usage?.cost ?? 0) || 0,
            usage: {
                input: Number(usage?.prompt_tokens ?? 0),
                output: Number(usage?.completion_tokens ?? 0),
                cacheRead: Number(usage?.prompt_tokens_details?.cached_tokens ?? 0),
                cacheWrite: Number(usage?.prompt_tokens_details?.cache_write_tokens ?? 0),
            },
        };
        if (finish === 'length') result.stop = 'max_tokens';
        else if (finish === 'content_filter') { result.stop = 'refusal'; result.refusalDetail = 'content filter'; }
        else if (finish === 'error') throw new LlmError('overloaded', 'The provider ended the response with an error');
        else if (toolCalls.length) result.stop = 'tool_use';
        return result;
    }

    addToolResults(results: ToolResult[], extraText: string[]): void {
        for (const r of results) {
            this.messages.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `ERROR: ${r.text}` : r.text });
        }
        if (extraText.length) this.messages.push({ role: 'user', content: extraText.join('\n\n') });
    }
}

export class OpenRouterProvider implements Provider {
    readonly id = 'openrouter' as const;

    unavailableReason(): string | null {
        return openrouterKey() ? null : 'Add an OpenRouter API key in Settings (or click Connect OpenRouter)';
    }

    startSession(options: SessionOptions): ChatSession {
        return new OpenRouterSession(options);
    }
}
