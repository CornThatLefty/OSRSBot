// Event log shared by the agent, the game client supervisor and the dashboard.
// Recent events stay in memory for new dashboard tabs; every event is appended to data/logs/<day>.jsonl.

import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from './config';

export type EventKind =
    | 'session_start' | 'session_end'
    | 'thinking' | 'text' | 'tool_call' | 'tool_result'
    | 'operator' | 'agent' | 'client' | 'bench' | 'error';

export interface BotEvent {
    id: number;
    ts: number;
    kind: EventKind;
    text: string;
    /** Extra structured fields: tool name, code, durations, usage... */
    data?: Record<string, unknown>;
}

/** Live-only messages (not stored): streaming text deltas, status ticks. */
export interface LiveMessage {
    type: string;
    [key: string]: unknown;
}

const RECENT_MAX = 600;
const recent: BotEvent[] = [];
const subscribers = new Set<(msg: LiveMessage) => void>();
let nextId = 1;

export function emit(kind: EventKind, text: string, data?: Record<string, unknown>): BotEvent {
    const event: BotEvent = { id: nextId++, ts: Date.now(), kind, text, ...(data ? { data } : {}) };
    recent.push(event);
    if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
    const day = new Date(event.ts).toISOString().slice(0, 10);
    void appendFile(join(env.dataDir, 'logs', `${day}.jsonl`), JSON.stringify(event) + '\n').catch(() => {});
    broadcast({ type: 'event', event });
    return event;
}

export function broadcast(msg: LiveMessage): void {
    for (const fn of subscribers) {
        try { fn(msg); } catch { /* a dead subscriber removes itself */ }
    }
}

export function subscribe(fn: (msg: LiveMessage) => void): () => void {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
}

export function recentEvents(limit = RECENT_MAX): BotEvent[] {
    return recent.slice(-limit);
}
