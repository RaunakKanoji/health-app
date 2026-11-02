import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
export type Db = { pool:Pick<pg.Pool,'query'>; orm:NodePgDatabase<Record<string,never>>; transaction<T>(fn:(tx:pg.PoolClient)=>Promise<T>):Promise<T>; close():Promise<void> };
export type Transaction = pg.PoolClient;
export function createDatabase(url: string):Db {
  const pool = new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 });
  return { pool, orm: drizzle(pool), async transaction<T>(fn: (tx: pg.PoolClient)=>Promise<T>): Promise<T> { const tx=await pool.connect();try {await tx.query('BEGIN');const value=await fn(tx);await tx.query('COMMIT');return value;}catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}}, close: ()=>pool.end() };
}
/** Joins an existing transaction; the owner controls commit/rollback and connection lifetime. */
export function transactionDatabase(tx:Transaction):Db { return {pool:tx,orm:drizzle(tx),transaction:fn=>fn(tx),close:async()=>{}}; }
export async function migrate(db: Db) {
  await db.transaction(async tx=>{
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('careloop-migrations'))");
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const dir=fileURLToPath(new URL('../migrations/',import.meta.url));
    for(const name of (await readdir(dir)).filter(n=>n.endsWith('.sql')).sort()){
      const sql=await readFile(`${dir}/${name}`,'utf8');const hash=createHash('sha256').update(sql).digest('hex');
      const existing=await tx.query<{sha256:string}>('SELECT sha256 FROM schema_migrations WHERE name=$1',[name]);
      if(existing.rows[0]){if(existing.rows[0].sha256!==hash)throw new Error(`Migration checksum mismatch: ${name}`);continue;}
      await tx.query(sql);await tx.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[name,hash]);
    }
  });
}
