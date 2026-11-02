import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { databaseEndpoint, isLocalDatabase } from '../../config/src/database.ts';
import * as schema from './schema.ts';
export type Db = { pool:Pick<pg.Pool,'query'>; orm:NodePgDatabase<typeof schema>; transaction<T>(fn:(tx:pg.PoolClient)=>Promise<T>):Promise<T>; close():Promise<void> };
export type Transaction = pg.PoolClient;
export function createDatabase(url: string, options: { max?: number } = {}):Db {
  const endpoint=databaseEndpoint(url);
  // Verify both CA and host, including when a provider supplies the weaker "require" spelling.
  if(!isLocalDatabase(endpoint))endpoint.searchParams.set('sslmode','verify-full');
  const max=options.max??10;
  if(!Number.isInteger(max)||max<1||max>20)throw new Error('Database pool size must be between 1 and 20.');
  const pool = new pg.Pool({ connectionString: endpoint.href, max, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000, keepAlive: true });
  // A suspended compute can close an idle connection. pg discards it and creates a new one
  // on demand. Never print the driver error, which may include connection or query details.
  pool.on('error',()=>process.stderr.write('{"event":"database_idle_connection_closed"}\n'));
  return { pool, orm: drizzle(pool,{schema}), async transaction<T>(fn: (tx: pg.PoolClient)=>Promise<T>): Promise<T> {
    const tx=await pool.connect();let broken=false;
    try {await tx.query('BEGIN');const value=await fn(tx);await tx.query('COMMIT');return value;}
    catch(error){try{await tx.query('ROLLBACK');}catch{broken=true;}throw error;}
    finally{tx.release(broken);}
  }, close: ()=>pool.end() };
}
/** Joins an existing transaction; the owner controls commit/rollback and connection lifetime. */
export function transactionDatabase(tx:Transaction):Db { return {pool:tx,orm:drizzle(tx,{schema}),transaction:fn=>fn(tx),close:async()=>{}}; }
export async function migrationFiles() {
  const dir=fileURLToPath(new URL('../migrations/',import.meta.url));
  return Promise.all((await readdir(dir)).filter(name=>/^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort().map(async name=>{
    const sql=await readFile(`${dir}/${name}`,'utf8');
    return {name,sql,sha256:createHash('sha256').update(sql).digest('hex')};
  }));
}

/** Read-only check: never creates a migration ledger or changes application data. */
export async function verifyMigrations(db:Db) {
  const expected=await migrationFiles();
  const exists=(await db.pool.query<{name:string|null}>("SELECT to_regclass('schema_migrations')::text AS name")).rows[0]?.name;
  const applied=exists?(await db.pool.query<{name:string;sha256:string}>('SELECT name,sha256 FROM schema_migrations ORDER BY name')).rows:[];
  const hashes=new Map(applied.map(row=>[row.name,row.sha256]));
  for(const file of expected){if(hashes.has(file.name)&&hashes.get(file.name)!==file.sha256)throw new Error(`Migration checksum mismatch: ${file.name}`);}
  return {applied:applied.map(row=>row.name),pending:expected.filter(file=>!hashes.has(file.name)).map(file=>file.name)};
}

export async function requireMigrations(db:Db) {
  const state=await verifyMigrations(db);
  if(state.pending.length)throw new Error('Database migrations are pending. Apply reviewed migrations to the selected development database before starting the application.');
}

/** Suitable for authenticated health routes; callers receive no infrastructure details. */
export async function verifyDatabase(db:Db):Promise<{status:'ok'|'unavailable'}> {
  try{await db.pool.query('SELECT 1');return {status:'ok'};}catch{return {status:'unavailable'};}
}

export async function migrate(db: Db) {
  await db.transaction(async tx=>{
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('careloop-migrations'))");
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for(const {name,sql,sha256:hash} of await migrationFiles()){
      const existing=await tx.query<{sha256:string}>('SELECT sha256 FROM schema_migrations WHERE name=$1',[name]);
      if(existing.rows[0]){if(existing.rows[0].sha256!==hash)throw new Error(`Migration checksum mismatch: ${name}`);continue;}
      await tx.query(sql);await tx.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[name,hash]);
    }
  });
}
