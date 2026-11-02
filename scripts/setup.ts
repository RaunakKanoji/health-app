import { copyFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
if (!existsSync(resolve(root, '.env'))) copyFileSync(resolve(root, '.env.example'), resolve(root, '.env'));
for (const command of ['db:start', 'db:migrate', 'db:seed']) {
  const result = spawnSync('pnpm', [command], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('Synthetic demonstration ready. Start with pnpm dev; open http://localhost:3000.');
