// One-time setup: clone rs-sdk into vendor/ and install its dependencies.
//   bun run setup            clone if missing, then install
//   bun run setup --update   also pull the latest rs-sdk (needed when the server moves to a new game revision)

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const rsSdk = join(root, 'vendor', 'rs-sdk');
const REPO = 'https://github.com/MaxBittker/rs-sdk.git';

async function run(cmd: string[], cwd: string): Promise<void> {
    console.log(`$ ${cmd.join(' ')}  (in ${cwd})`);
    const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
    if ((await proc.exited) !== 0) throw new Error(`${cmd[0]} failed`);
}

if (!existsSync(join(rsSdk, '.git'))) {
    await run(['git', 'clone', '--depth', '1', REPO, rsSdk], root);
} else if (process.argv.includes('--update')) {
    await run(['git', 'pull', '--ff-only'], rsSdk);
}

// rs-sdk's root deps (SDK, MCP execute_code) and the lite client's deps.
// Puppeteer's Chrome download is ours to manage (CHROME_PATH or our own puppeteer), so skip theirs.
process.env.PUPPETEER_SKIP_DOWNLOAD = 'true';
await run([process.execPath, 'install'], rsSdk);
await run([process.execPath, 'install'], join(rsSdk, 'server', 'webclient'));

console.log('\nrs-sdk is ready. Next: copy .env.example to .env, then `bun start`.');
