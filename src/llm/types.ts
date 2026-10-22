// Provider-neutral shapes for the agent loop. Each provider keeps its conversation in its own
// native format (thinking blocks, compaction blocks and reasoning details must be sent back
// exactly as received), so a session object owns the history and the agent only sees turns.

import type { Effort } from '../config';

export interface ToolDef {
    name: string;
    description: string;
    /** JSON Schema for the tool input. */
    input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export interface ToolCall {
    id: string;
    name: string;
    input: unknown;
}

export interface ToolResult {
    id: string;
    text: string;
    isError: boolean;
}

export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

export interface TurnResult {
    /** 'tool_use' = run toolCalls and continue; 'end_turn' = the model is done with this session. */
    stop: 'tool_use' | 'end_turn' | 'max_tokens' | 'refusal' | 'pause';
    toolCalls: ToolCall[];
    text: string[];
    thinking: string[];
    /** Provider events worth logging (compaction, fallback model used, ...). */
    notes: string[];
    refusalDetail?: string;
    /** Model that actually answered (routers and fallbacks can differ from the one requested). */
    model: string;
    costUsd: number;
    usage: Usage;
}

export interface SystemBlock {
    text: string;
    /** Mark the end of the stable prefix for prompt caching. */
    cache?: boolean;
    /** Shorter stand-in a provider may use for models with small context windows. */
    compact?: string;
}

export interface SessionOptions {
    system: SystemBlock[];
    tools: ToolDef[];
    kickoff: string;
    model: string;
    effort: Effort;
    onDelta: (kind: 'text' | 'thinking', delta: string) => void;
}

export interface ChatSession {
    /** One model call. Throws LlmError on API failures; an aborted signal rejects with the abort reason. */
    next(signal: AbortSignal): Promise<TurnResult>;
    /** Answer the last turn's tool calls, plus any extra text (operator messages, reminders). */
    addToolResults(results: ToolResult[], extraText: string[]): void;
}

export interface Provider {
    readonly id: 'anthropic' | 'openrouter';
    /** Short reason the provider can't run (no key), or null when it can. */
    unavailableReason(): string | null;
    startSession(options: SessionOptions): ChatSession;
}

/**
 * 'config' = the request can't be served with the current settings (privacy settings exclude every
 * provider, price caps too low, model gone): retrying won't help until someone changes something.
 */
export type LlmErrorKind = 'auth' | 'credits' | 'rate_limit' | 'overloaded' | 'bad_request' | 'moderation' | 'config' | 'other';

/** API failure in a form the agent loop can act on without knowing the provider. */
export class LlmError extends Error {
    constructor(
        readonly kind: LlmErrorKind,
        message: string,
        /** When the provider says how long to wait. */
        readonly retryAfterMs?: number,
    ) {
        super(message);
        this.name = 'LlmError';
    }
}
