import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from 'dotenv';
const root = resolve(import.meta.dirname, '..');
config({ path: resolve(root, '.env'), quiet: true });
if (process.env.DEMO_MODE !== 'true') throw new Error('Set DEMO_MODE=true in .env after running pnpm demo:setup.');
const commands = [
  ['exec', 'tsx', 'watch', 'apps/api/src/index.ts'],
  ['exec', 'tsx', 'watch', 'apps/worker/src/index.ts'],
  ['--filter', '@careloop/web', 'dev'],
];
const children = commands.map(args => spawn('pnpm', args, { cwd: root, env: process.env, stdio: 'inherit' }));
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 400).unref();
}
for (const child of children) child.on('exit', code => { if (!stopping) stop(code ?? 1); });
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
