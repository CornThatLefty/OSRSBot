// Tools the agent can call. execute_code is the workhorse: it runs a TypeScript snippet against the
// bot with rs-sdk's own execute_code implementation (cancellation, console capture, world-state footer).

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ToolDef } from './llm/types';
import { executeCode } from '../vendor/rs-sdk/mcp/execute-code';
import { formatWorldState } from '../vendor/rs-sdk/sdk/formatter';
import { botLink } from './bot';
import { env, settings } from './config';
import { metrics } from './metrics';

export const TOOLS: ToolDef[] = [
    {
        name: 'execute_code',
        description:
            'Run a TypeScript snippet on the bot. `bot` (BotActions, high-level actions) and `sdk` (BotSDK, state queries and low-level sends) ' +
            'are in scope, top-level await works, and `return` a value to see it. console.log output is captured. The result always ends with a ' +
            'brief world-state snapshot. Only one snippet runs at a time. Start with short runs (10-60s) for new logic; use longer loops only for proven grinding.',
        input_schema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'TypeScript body to run, e.g. `const t = sdk.findNearbyLoc(/^tree$/i); return await bot.chopTree(t);`' },
                timeout_seconds: { type: 'integer', description: 'Hard time limit for this run. Default 120.' },
                purpose: { type: 'string', description: 'One short line shown on the monitoring dashboard: what this run is for.' },
            },
            required: ['code', 'purpose'],
        },
    },
    {
        name: 'get_world_state',
        description: 'Full current world state: position, skills, inventory, equipment, nearby NPCs/objects/items/players, dialogs, recent messages, plus XP-rate and leaderboard stats.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'search_knowledge',
        description:
            'Search the rs-sdk knowledge base: learnings/ (tested SDK snippets and tips), wiki/ (items, NPCs, shops, skills, quests with locations), ' +
            'sdk/API.md and sdk/MARKET.md. Case-insensitive; returns matching lines with file paths. Use read_knowledge to open a file.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Text or regular expression, e.g. "copper ore" or "fishing.*lumbridge".' },
                max_results: { type: 'integer', description: 'Default 40.' },
            },
            required: ['query'],
        },
    },
    {
        name: 'read_knowledge',
        description: 'Read a knowledge-base file returned by search_knowledge (path relative to the rs-sdk root, e.g. "learnings/mining.md").',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                offset: { type: 'integer', description: 'First line to return (1-based). Default 1.' },
                limit: { type: 'integer', description: 'Lines to return. Default 300.' },
            },
            required: ['path'],
        },
    },
    {
        name: 'update_notes',
        description:
            'Replace your persistent notes. They are given back to you at the start of every session (each session starts with a fresh context), ' +
            'so keep what future-you needs: current plan, working code patterns, locations, failures to avoid. Max 12000 characters.',
        input_schema: {
            type: 'object',
            properties: { notes: { type: 'string' } },
            required: ['notes'],
        },
    },
];

// ---- notes ------------------------------------------------------------------------------

const notesPath = join(env.dataDir, 'notes.md');
export const NOTES_MAX = 12_000;

export function readNotes(): string {
    return existsSync(notesPath) ? readFileSync(notesPath, 'utf-8') : '';
}

export function writeNotes(text: string): void {
    writeFileSync(notesPath, text.slice(0, NOTES_MAX));
}

// ---- knowledge base ---------------------------------------------------------------------

const KNOWLEDGE_ROOTS = ['learnings', 'wiki', 'sdk/API.md', 'sdk/MARKET.md', 'sdk/README.md', 'CLAUDE.md'];
let corpus: { path: string; lines: string[] }[] | null = null;

function loadCorpus(): { path: string; lines: string[] }[] {
    if (corpus) return corpus;
    const files: { path: string; lines: string[] }[] = [];
    const visit = (abs: string) => {
        if (!existsSync(abs)) return;
        if (statSync(abs).isDirectory()) {
            for (const entry of readdirSync(abs)) visit(join(abs, entry));
        } else if (/\.(md|txt|json)$/i.test(abs)) {
            files.push({ path: relative(env.rsSdkDir, abs).split(sep).join('/'), lines: readFileSync(abs, 'utf-8').split('\n') });
        }
    };
    for (const root of KNOWLEDGE_ROOTS) visit(join(env.rsSdkDir, root));
    corpus = files;
    return files;
}

function searchKnowledge(query: string, maxResults: number): string {
    let pattern: RegExp;
    try { pattern = new RegExp(query, 'i'); } catch { pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    const out: string[] = [];
    let total = 0;
    // Hand-written learnings first: they are the most reliable source.
    const files = [...loadCorpus()].sort((a, b) => Number(b.path.startsWith('learnings/')) - Number(a.path.startsWith('learnings/')));
    for (const file of files) {
        const fileHit = pattern.test(file.path);
        file.lines.forEach((line, i) => {
            if (!pattern.test(line)) return;
            total++;
            if (out.length < maxResults) out.push(`${file.path}:${i + 1}: ${line.trim().slice(0, 240)}`);
        });
        if (fileHit && !file.lines.some(l => pattern.test(l))) {
            total++;
            if (out.length < maxResults) out.push(`${file.path} (file name matches)`);
        }
    }
    if (!out.length) return `No matches for /${query}/i. Try a shorter or different term.`;
    return out.join('\n') + (total > out.length ? `\n... ${total - out.length} more matches; narrow the query.` : '');
}

function readKnowledge(path: string, offset = 1, limit = 300): string {
    const root = resolve(env.rsSdkDir);
    const target = resolve(root, path);
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) return 'Error: path is outside the rs-sdk folder.';
    const allowed = KNOWLEDGE_ROOTS.some(r => rel.split(sep).join('/') === r || rel.split(sep).join('/').startsWith(r + '/'));
    if (!allowed) return `Error: only ${KNOWLEDGE_ROOTS.join(', ')} can be read.`;
    if (!existsSync(target) || statSync(target).isDirectory()) {
        if (existsSync(target)) return readdirSync(target).map(f => `${rel.split(sep).join('/')}/${f}`).join('\n');
        return 'Error: no such file.';
    }
    const lines = readFileSync(target, 'utf-8').split('\n');
    const start = Math.max(1, offset);
    const slice = lines.slice(start - 1, start - 1 + Math.max(1, Math.min(limit, 1000)));
    const more = start - 1 + slice.length < lines.length ? `\n[lines ${start}-${start + slice.length - 1} of ${lines.length}]` : '';
    return slice.map((l, i) => `${start + i}\t${l}`).join('\n') + more;
}

// ---- dispatch ---------------------------------------------------------------------------

const OUTPUT_MAX = 16_000;

function clip(text: string): string {
    if (text.length <= OUTPUT_MAX) return text;
    const head = text.slice(0, OUTPUT_MAX * 0.6);
    const tail = text.slice(-OUTPUT_MAX * 0.35);
    return `${head}\n\n[... ${text.length - head.length - tail.length} characters cut ...]\n\n${tail}`;
}

export interface ToolOutcome {
    text: string;
    isError: boolean;
}

/** Validate a tool input (eager input streaming means the API no longer does it) and run it. */
export async function runTool(name: string, input: unknown, signal: AbortSignal): Promise<ToolOutcome> {
    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (typeof args.__invalidJson === 'string') {
        return { text: `Error: your arguments for ${name} were not valid JSON, so nothing ran. Received: ${args.__invalidJson.slice(0, 500)}`, isError: true };
    }
    switch (name) {
        case 'execute_code': {
            if (typeof args.code !== 'string' || !args.code.trim()) return { text: 'Error: `code` must be a non-empty string.', isError: true };
            const requested = typeof args.timeout_seconds === 'number' ? args.timeout_seconds : 120;
            const seconds = Math.max(5, Math.min(settings.maxCodeSeconds, requested));
            const result = await executeCode(botLink.manager, settings.botName, args.code, seconds * 1000, signal);
            const text = result.content.map(c => c.text).join('\n');
            const note = requested > seconds ? `\n(Requested ${requested}s; capped at ${seconds}s by the operator's settings.)` : '';
            return { text: clip(text + note), isError: !!result.isError };
        }
        case 'get_world_state': {
            const sdk = botLink.sdk;
            const state = sdk?.getState();
            if (!sdk || !state) return { text: 'No world state yet: the game client is not attached or still logging in.', isError: true };
            return { text: clip(formatWorldState(state, sdk.getStateAge()) + '\n\n' + metrics.describe()), isError: false };
        }
        case 'search_knowledge': {
            if (typeof args.query !== 'string' || !args.query.trim()) return { text: 'Error: `query` must be a non-empty string.', isError: true };
            const max = typeof args.max_results === 'number' ? Math.max(1, Math.min(200, args.max_results)) : 40;
            return { text: searchKnowledge(args.query, max), isError: false };
        }
        case 'read_knowledge': {
            if (typeof args.path !== 'string') return { text: 'Error: `path` must be a string.', isError: true };
            return {
                text: clip(readKnowledge(args.path, typeof args.offset === 'number' ? args.offset : 1, typeof args.limit === 'number' ? args.limit : 300)),
                isError: false,
            };
        }
        case 'update_notes': {
            if (typeof args.notes !== 'string') return { text: 'Error: `notes` must be a string.', isError: true };
            writeNotes(args.notes);
            const cut = args.notes.length > NOTES_MAX ? ` (cut to ${NOTES_MAX} characters)` : '';
            return { text: `Notes saved${cut}.`, isError: false };
        }
        default:
            return { text: `Error: unknown tool ${name}`, isError: true };
    }
}
