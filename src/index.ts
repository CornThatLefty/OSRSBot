// Entry point: dashboard server + game client supervisor + Claude agent.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env, onSettingsChange, settings } from './config';

if (!existsSync(join(env.rsSdkDir, 'sdk', 'index.ts')) || !existsSync(join(env.rsSdkDir, 'server', 'webclient', 'node_modules'))) {
    console.error('rs-sdk is not set up. Run `bun run setup` first.');
    process.exit(1);
}

// Imported after the check: these modules load the rs-sdk SDK.
const { agent } = await import('./agent');
const { botLink } = await import('./bot');
const { gameClient } = await import('./client');
const { emit, broadcast } = await import('./events');
const { metrics } = await import('./metrics');
const { startServer, statusSnapshot } = await import('./server');

async function bringUpClient(): Promise<void> {
    await gameClient.start();
    await botLink.connect().catch(e => emit('error', `SDK connect failed: ${e instanceof Error ? e.message : e}`));
}

// Changing the account, server or client type needs a fresh client and SDK connection.
onSettingsChange(changed => {
    const clientKeys = ['botName', 'server', 'clientMode', 'showChat'] as const;
    if (clientKeys.some(k => k in changed)) {
        emit('client', `Settings changed (${Object.keys(changed).join(', ')}): reconnecting`);
        const wasRunning = gameClient.status !== 'stopped';
        void (async () => {
            await botLink.disconnect();
            if (wasRunning) {
                await gameClient.restart();
                await botLink.connect().catch(e => emit('error', `SDK connect failed: ${e instanceof Error ? e.message : e}`));
            }
            void metrics.pollHiscore();
        })();
    }
    if ('goal' in changed) emit('operator', 'Goal updated; it applies from the next session (use "New session" to apply now)');
});

// At the end of a benchmark run, pause so the agent doesn't keep spending outside the measured window.
metrics.setRunEndHandler(() => agent.pause());

setInterval(() => broadcast({ type: 'status', status: statusSnapshot() }), 2_000);

startServer();

if (settings.autoStart && settings.botName) {
    await bringUpClient();
    agent.start();
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[osrsbot] Shutting down');
    await Promise.race([
        (async () => {
            await agent.stop();
            await gameClient.stop();
            await botLink.disconnect();
        })(),
        Bun.sleep(10_000),
    ]);
    process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
