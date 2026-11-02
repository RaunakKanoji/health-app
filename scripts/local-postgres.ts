import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const data = resolve(root, '.local/postgres');
const socket = resolve(root, '.local/socket');
const env = { ...process.env, PGPASSWORD: 'careloop' };
function run(command: string, args: string[], quiet = false) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.error) throw new Error(`${command} is unavailable. Install PostgreSQL 17+ or run docker compose up -d postgres.`);
  return result;
}
mkdirSync(socket, { recursive: true });
if (process.argv[2] === 'stop') {
  if (existsSync(resolve(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'fast', 'stop']);
} else {
  if (!existsSync(resolve(data, 'PG_VERSION'))) {
    const passwordFile = resolve(root, '.local/.postgres-password');
    writeFileSync(passwordFile, 'careloop', { mode: 0o600 });
    try {
      const init = run('initdb', ['-D', data, '-U', 'careloop', '--pwfile', passwordFile, '--auth-local=trust', '--auth-host=scram-sha-256', '--encoding=UTF8', '--locale=C']);
      if (init.status !== 0) throw new Error('PostgreSQL initialization failed.');
    } finally { unlinkSync(passwordFile); }
  }
  const running = run('pg_ctl', ['-D', data, 'status'], true);
  if (running.status !== 0) {
    const started = run('pg_ctl', ['-D', data, '-l', resolve(root, '.local/postgres.log'), '-o', `-p 54329 -h 127.0.0.1 -k ${socket}`, '-w', 'start']);
    if (started.status !== 0) throw new Error('PostgreSQL failed to start; inspect .local/postgres.log.');
  }
  const check = run('psql', ['-h', '127.0.0.1', '-p', '54329', '-U', 'careloop', '-d', 'postgres', '-tAc', "SELECT 1 FROM pg_database WHERE datname = 'careloop'"], true);
  if (check.status !== 0) throw new Error('Could not connect to local PostgreSQL.');
  if (!check.stdout.trim()) {
    const created = run('createdb', ['-h', '127.0.0.1', '-p', '54329', '-U', 'careloop', 'careloop']);
    if (created.status !== 0) throw new Error('Database creation failed.');
  }
  console.log('Local synthetic PostgreSQL ready on 127.0.0.1:54329.');
}
