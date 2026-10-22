// Claude API provider (Anthropic SDK). Streams with adaptive thinking, prompt caching on the
// frozen system prompt and the conversation, server-side compaction for long sessions, and
// server-side fallbacks when a safety classifier declines.

import Anthropic from '@anthropic-ai/sdk';
import { LlmError, type ChatSession, type Provider, type SessionOptions, type ToolResult, type TurnResult } from './types';

type MessageParam = Anthropic.Beta.BetaMessageParam;

/** $ per million tokens: input, output, cache read. Cache writes bill at 1.25x input (5-minute TTL). */
const PRICES: Record<string, [number, number, number]> = {
    'claude-fable-5-1': [10, 50, 0.25],
    'claude-opus-5-5': [4, 20, 0.2],
    'claude-sonnet-5-5': [2, 10, 0.2],
    'claude-haiku-5-5': [0.1, 0.5, 0.01],
};

/** Models that accept `fallbacks: "default"` (server-side retry on another model if a safety classifier declines). */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5']);

export const ANTHROPIC_MODELS = Object.keys(PRICES);

function priceOf(model: string, usage: Anthropic.Beta.BetaUsage): number {
    const [input, output, cacheRead] = PRICES[model] ?? PRICES['claude-opus-5-5']!;
    return (
        (usage.input_tokens * input +
            (usage.cache_creation_input_tokens ?? 0) * input * 1.25 +
            (usage.cache_read_input_tokens ?? 0) * cacheRead +
            usage.output_tokens * output) / 1_000_000
    );
}

function toLlmError(error: unknown): unknown {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        return new LlmError('auth', `Claude API rejected the credentials: ${error.message}`);
    }
    if (error instanceof Anthropic.RateLimitError) {
        const retry = Number(error.headers?.get?.('retry-after'));
        return new LlmError('rate_limit', error.message, Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined);
    }
    if (error instanceof Anthropic.BadRequestError) return new LlmError('bad_request', error.message);
    if (error instanceof Anthropic.InternalServerError) return new LlmError('overloaded', error.message);
    return error;
}

class AnthropicSession implements ChatSession {
    private messages: MessageParam[];
    private system: Anthropic.Beta.BetaTextBlockParam[];
    private tools: Anthropic.Beta.BetaTool[];

    constructor(private client: Anthropic, private opts: SessionOptions) {
        this.messages = [{ role: 'user', content: opts.kickoff }];
        this.system = opts.system.map(b => ({ type: 'text' as const, text: b.text, ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {}) }));
        this.tools = opts.tools.map(t => ({ ...t, eager_input_streaming: true }));
    }

    async next(signal: AbortSignal): Promise<TurnResult> {
        const { model, effort } = this.opts;
        const betas: Anthropic.Beta.AnthropicBeta[] = ['compact-2026-01-12'];
        if (FALLBACK_MODELS.has(model)) betas.push('server-side-fallback-2026-07-01');
        const stream = this.client.beta.messages.stream(
            {
                model,
                max_tokens: 32_000,
                system: this.system,
                tools: this.tools,
                messages: this.messages,
                thinking: { type: 'adaptive', display: 'summarized' },
                output_config: { effort },
                // Cache the growing conversation too, not just the system prompt.
                cache_control: { type: 'ephemeral' },
                context_management: { edits: [{ type: 'compact_20260112' }] },
                betas,
                ...(FALLBACK_MODELS.has(model) ? { fallbacks: 'default' as const } : {}),
            },
            { signal },
        );
        stream.on('text', delta => this.opts.onDelta('text', delta));
        stream.on('thinking', delta => this.opts.onDelta('thinking', delta));

        let message: Anthropic.Beta.BetaMessage;
        try {
            message = await stream.finalMessage();
        } catch (error) {
            if (signal.aborted) throw signal.reason;
            throw toLlmError(error);
        }
        // Append the full content: thinking and compaction blocks must go back unchanged.
        this.messages.push({ role: 'assistant', content: message.content });

        const result: TurnResult = {
            stop: 'end_turn', toolCalls: [], text: [], thinking: [], notes: [],
            model: message.model || model,
            costUsd: priceOf(message.model || model, message.usage),
            usage: {
                input: message.usage.input_tokens,
                output: message.usage.output_tokens,
                cacheRead: message.usage.cache_read_input_tokens ?? 0,
                cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
            },
        };
        for (const block of message.content) {
            if (block.type === 'thinking' && block.thinking.trim()) result.thinking.push(block.thinking);
            else if (block.type === 'text' && block.text.trim()) result.text.push(block.text);
            else if (block.type === 'tool_use') result.toolCalls.push({ id: block.id, name: block.name, input: block.input });
            else if (block.type === 'compaction') result.notes.push('Context compacted by the API');
            else if (block.type === 'fallback') result.notes.push(`${block.from.model} declined; ${block.to.model} continued`);
        }
        if (message.stop_reason === 'refusal') {
            result.stop = 'refusal';
            result.refusalDetail = message.stop_details?.category ?? undefined;
        } else if (message.stop_reason === 'pause_turn') result.stop = 'pause';
        else if (message.stop_reason === 'max_tokens') result.stop = 'max_tokens';
        else if (result.toolCalls.length) result.stop = 'tool_use';
        return result;
    }

    addToolResults(results: ToolResult[], extraText: string[]): void {
        this.messages.push({
            role: 'user',
            content: [
                ...results.map(r => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.text, ...(r.isError ? { is_error: true } : {}) })),
                ...extraText.map(text => ({ type: 'text' as const, text })),
            ],
        });
    }
}

export class AnthropicProvider implements Provider {
    readonly id = 'anthropic' as const;
    private client: Anthropic | null = null;

    unavailableReason(): string | null {
        // The SDK also finds credentials from `ant auth login` profiles on disk, so missing env vars
        // aren't proof there are none: let the first request decide (an auth error stops the agent).
        return null;
    }

    startSession(options: SessionOptions): ChatSession {
        this.client ??= new Anthropic();
        return new AnthropicSession(this.client, options);
    }
}
