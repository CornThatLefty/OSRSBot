// Progress and benchmark numbers.
//
// - XP samples from the live world state: XP/hour, and rs-bench's headline metric, peak XP/min
//   over any 15-second window (https://github.com/MaxBittker/rs-bench).
// - The demo server's leaderboard (total level, ties broken by lowest playtime), scraped from the
//   public hiscores page, since there is no JSON API.
// - Timed benchmark runs: snapshot at start, score at the end, kept in data/runs.json.
// - Estimated Claude API spend per day, for the budget cap.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BotSDK, BotWorldState } from '../vendor/rs-sdk/sdk/index';
import { botLink } from './bot';
import { activeModel, env, serverOrigin, settings } from './config';
import { broadcast, emit } from './events';

interface Sample {
    t: number;
    xp: number;
    level: number;
    skills: Record<string, number>;
    coins: number;
}

export interface Hiscore {
    rank: string;
    level: string;
    playtime: string;
    checkedAt: number;
    error?: string;
}

export interface BenchRun {
    id: string;
    label: string;
    goal: string;
    model: string;
    effort: string;
    status: 'running' | 'finished' | 'stopped';
    startedAt: number;
    endsAt: number;
    endedAt?: number;
    start: { xp: number; level: number; skills: Record<string, number>; coins: number; spendUsd: number };
    result?: {
        xpGained: number;
        levelsGained: number;
        coinsGained: number;
        peakXpPerMin: number;
        avgXpPerHour: number;
        skillGains: Record<string, number>;
        costUsd: number;
    };
}

interface DayUsage {
    usd: number; input: number; output: number; cacheRead: number; cacheWrite: number; requests: number;
    /** Requests to free OpenRouter models (they count against a daily quota). */
    freeRequests?: number;
    byModel?: Record<string, { requests: number; usd: number; input: number; output: number }>;
}

const PEAK_WINDOW_MS = 15_000;
const KEEP_MS = 24 * 3600_000;
const runsPath = join(env.dataDir, 'runs.json');
const usagePath = join(env.dataDir, 'usage.json');

function readJson<T>(path: string, fallback: T): T {
    try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : fallback; } catch { return fallback; }
}

function today(): string {
    return new Date().toISOString().slice(0, 10);
}

class Metrics {
    samples: Sample[] = [];
    /** Peak 15s XP/min since process start, and during the active benchmark run. */
    peakXpPerMin = 0;
    hiscore: Hiscore | null = null;
    runs: BenchRun[] = readJson<BenchRun[]>(runsPath, []);
    usage: Record<string, DayUsage> = readJson<Record<string, DayUsage>>(usagePath, {});
    private lastSampleAt = 0;
    private lastPersistMinute = 0;
    private runTimer: ReturnType<typeof setTimeout> | null = null;
    private onRunEnd: ((run: BenchRun) => void) | null = null;

    constructor() {
        botLink.onReady(sdk => this.attach(sdk));
        setInterval(() => void this.pollHiscore(), 5 * 60_000);
        setTimeout(() => void this.pollHiscore(), 10_000);
        // A run that was going when the process stopped can't be scored fairly; close it.
        for (const run of this.runs) if (run.status === 'running') { run.status = 'stopped'; run.endedAt = run.endedAt ?? Date.now(); }
        this.saveRuns();
    }

    private attach(sdk: BotSDK): void {
        sdk.onStateUpdate(state => this.sample(state));
    }

    private sample(state: BotWorldState): void {
        const now = Date.now();
        if (now - this.lastSampleAt < 1_000 || !state.inGame || !state.skills?.length) return;
        this.lastSampleAt = now;
        const skills: Record<string, number> = {};
        let xp = 0;
        let level = 0;
        for (const s of state.skills) {
            if (/^Stat\d+$/i.test(s.name)) continue; // unused placeholder slots, as in rs-sdk's formatter
            skills[s.name] = s.experience;
            xp += s.experience;
            level += s.baseLevel;
        }
        const coins = (state.inventory ?? []).filter(i => /^coins$/i.test(i.name)).reduce((sum, i) => sum + i.count, 0);
        const sample: Sample = { t: now, xp, level, skills, coins };

        // Compare against the newest sample at least 15s old.
        for (let i = this.samples.length - 1; i >= 0; i--) {
            const prev = this.samples[i]!;
            if (now - prev.t >= PEAK_WINDOW_MS) {
                if (now - prev.t <= PEAK_WINDOW_MS * 3) {
                    const rate = ((xp - prev.xp) / (now - prev.t)) * 60_000;
                    if (rate > this.peakXpPerMin) this.peakXpPerMin = rate;
                    const run = this.activeRun();
                    if (run && prev.t >= run.startedAt) run.result = { ...this.score(run, sample), peakXpPerMin: Math.max(run.result?.peakXpPerMin ?? 0, rate) };
                }
                break;
            }
        }

        this.samples.push(sample);
        while (this.samples.length && now - this.samples[0]!.t > KEEP_MS) this.samples.shift();

        const minute = Math.floor(now / 60_000);
        if (minute !== this.lastPersistMinute) {
            this.lastPersistMinute = minute;
            const day = new Date(now).toISOString().slice(0, 10);
            void appendFile(join(env.dataDir, 'logs', `xp-${day}.jsonl`), JSON.stringify({ t: now, xp, level, coins }) + '\n').catch(() => {});
        }
    }

    latest(): Sample | null {
        return this.samples[this.samples.length - 1] ?? null;
    }

    /** XP gained per hour over the trailing window. */
    xpPerHour(windowMs: number): number {
        const last = this.latest();
        if (!last) return 0;
        const first = this.samples.find(s => last.t - s.t <= windowMs);
        if (!first || last.t - first.t < 30_000) return 0;
        return ((last.xp - first.xp) / (last.t - first.t)) * 3600_000;
    }

    /** One XP point per minute for the dashboard chart. */
    series(hours = 6): { t: number; xp: number; level: number }[] {
        const since = Date.now() - hours * 3600_000;
        const out: { t: number; xp: number; level: number }[] = [];
        let lastMinute = -1;
        for (const s of this.samples) {
            if (s.t < since) continue;
            const minute = Math.floor(s.t / 60_000);
            if (minute === lastMinute) out[out.length - 1] = { t: s.t, xp: s.xp, level: s.level };
            else out.push({ t: s.t, xp: s.xp, level: s.level });
            lastMinute = minute;
        }
        return out;
    }

    async pollHiscore(): Promise<void> {
        if (!settings.botName) return;
        try {
            const res = await fetch(`${serverOrigin()}/hiscores/player/${encodeURIComponent(settings.botName)}`, { signal: AbortSignal.timeout(15_000) });
            if (res.status === 404) { this.hiscore = { rank: '-', level: '-', playtime: '-', checkedAt: Date.now(), error: 'Not on the hiscores yet' }; return; }
            const html = await res.text();
            // The Overall row's cells: name, rank, level, playtime. Cells may hold markup (playtime is a <span>).
            const row = html.match(/>Overall<\/a><\/td>([\s\S]*?)<\/tr>/)?.[1] ?? '';
            const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]!.replace(/<[^>]+>/g, '').trim());
            this.hiscore = cells.length >= 3
                ? { rank: cells[0]!, level: cells[1]!, playtime: cells[2]!, checkedAt: Date.now() }
                : { rank: '-', level: '-', playtime: '-', checkedAt: Date.now(), error: 'Could not read the hiscores page' };
        } catch (error) {
            this.hiscore = { rank: '-', level: '-', playtime: '-', checkedAt: Date.now(), error: error instanceof Error ? error.message : String(error) };
        }
        broadcast({ type: 'hiscore', hiscore: this.hiscore });
    }

    // ---- benchmark runs --------------------------------------------------------------------

    activeRun(): BenchRun | null {
        return this.runs.find(r => r.status === 'running') ?? null;
    }

    setRunEndHandler(fn: (run: BenchRun) => void): void {
        this.onRunEnd = fn;
    }

    startRun(label: string, minutes: number, goal: string): BenchRun {
        if (this.activeRun()) throw new Error('A benchmark run is already going');
        const s = this.latest();
        if (!s) throw new Error('No game state yet: start the game client and wait for the bot to log in');
        const now = Date.now();
        const run: BenchRun = {
            id: now.toString(36),
            label: label || `Run ${this.runs.length + 1}`,
            goal,
            model: `${settings.provider}:${activeModel()}`,
            effort: settings.effort,
            status: 'running',
            startedAt: now,
            endsAt: now + minutes * 60_000,
            start: { xp: s.xp, level: s.level, skills: { ...s.skills }, coins: s.coins, spendUsd: this.spendToday() },
        };
        this.runs.push(run);
        this.saveRuns();
        this.runTimer = setTimeout(() => this.endRun('finished'), minutes * 60_000);
        emit('bench', `Benchmark "${run.label}" started: ${minutes} min`, { runId: run.id });
        return run;
    }

    endRun(status: 'finished' | 'stopped'): BenchRun | null {
        const run = this.activeRun();
        if (!run) return null;
        if (this.runTimer) clearTimeout(this.runTimer);
        this.runTimer = null;
        run.status = status;
        run.endedAt = Date.now();
        const last = this.latest();
        if (last) run.result = { ...this.score(run, last), peakXpPerMin: run.result?.peakXpPerMin ?? 0 };
        this.saveRuns();
        const r = run.result;
        emit('bench', `Benchmark "${run.label}" ${status}: +${r?.xpGained ?? 0} XP, +${r?.levelsGained ?? 0} levels, peak ${Math.round(r?.peakXpPerMin ?? 0)} XP/min, ~$${(r?.costUsd ?? 0).toFixed(2)}`, { runId: run.id });
        this.onRunEnd?.(run);
        return run;
    }

    private score(run: BenchRun, s: Sample): Omit<NonNullable<BenchRun['result']>, 'peakXpPerMin'> {
        const skillGains: Record<string, number> = {};
        for (const [name, xp] of Object.entries(s.skills)) {
            const gain = xp - (run.start.skills[name] ?? xp);
            if (gain > 0) skillGains[name] = gain;
        }
        const elapsed = Math.max(1, s.t - run.startedAt);
        return {
            xpGained: s.xp - run.start.xp,
            levelsGained: s.level - run.start.level,
            coinsGained: s.coins - run.start.coins,
            avgXpPerHour: ((s.xp - run.start.xp) / elapsed) * 3600_000,
            skillGains,
            // Spend is tracked per UTC day; a run crossing midnight under-reports.
            costUsd: Math.max(0, this.spendToday() - run.start.spendUsd),
        };
    }

    private saveRuns(): void {
        writeFileSync(runsPath, JSON.stringify(this.runs.slice(-200), null, 2));
    }

    // ---- API spend -------------------------------------------------------------------------

    addUsage(usd: number, u: { input: number; output: number; cacheRead: number; cacheWrite: number }, by: { provider: string; model: string }): void {
        const day = (this.usage[today()] ??= { usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 });
        day.usd += usd;
        day.input += u.input;
        day.output += u.output;
        day.cacheRead += u.cacheRead;
        day.cacheWrite += u.cacheWrite;
        day.requests++;
        // OpenRouter's daily free-model quota counts requests to free models (cost 0).
        if (by.provider === 'openrouter' && usd === 0) day.freeRequests = (day.freeRequests ?? 0) + 1;
        const m = ((day.byModel ??= {})[by.model || 'unknown'] ??= { requests: 0, usd: 0, input: 0, output: 0 });
        m.requests++;
        m.usd += usd;
        m.input += u.input;
        m.output += u.output;
        writeFileSync(usagePath, JSON.stringify(this.usage, null, 2));
    }

    freeRequestsToday(): number {
        return this.usage[today()]?.freeRequests ?? 0;
    }

    spendToday(): number {
        return this.usage[today()]?.usd ?? 0;
    }

    // ---- summaries -------------------------------------------------------------------------

    /** Short text for the agent. */
    describe(): string {
        const s = this.latest();
        if (!s) return '';
        const lines = [
            '# Progress',
            `Total level ${s.level}, total XP ${s.xp.toLocaleString()}`,
            `XP/hour: last 10 min ${Math.round(this.xpPerHour(600_000)).toLocaleString()}, last hour ${Math.round(this.xpPerHour(3600_000)).toLocaleString()}`,
        ];
        if (this.hiscore && !this.hiscore.error) lines.push(`Leaderboard: rank ${this.hiscore.rank}, level ${this.hiscore.level}, playtime ${this.hiscore.playtime}`);
        const run = this.activeRun();
        if (run) {
            const left = Math.max(0, Math.round((run.endsAt - Date.now()) / 60_000));
            lines.push(`Benchmark run "${run.label}" in progress: ${left} min left, +${run.result?.xpGained ?? 0} XP so far, peak ${Math.round(run.result?.peakXpPerMin ?? 0)} XP/min (best 15-second window).`);
        }
        return lines.join('\n');
    }

    /** Numbers for the dashboard. */
    snapshot() {
        const s = this.latest();
        return {
            totalLevel: s?.level ?? null,
            totalXp: s?.xp ?? null,
            coins: s?.coins ?? null,
            xpPerHour10m: this.xpPerHour(600_000),
            xpPerHour60m: this.xpPerHour(3600_000),
            peakXpPerMin: this.peakXpPerMin,
            hiscore: this.hiscore,
            activeRun: this.activeRun(),
            spendToday: this.spendToday(),
            usageToday: this.usage[today()] ?? null,
        };
    }
}

export const metrics = new Metrics();
