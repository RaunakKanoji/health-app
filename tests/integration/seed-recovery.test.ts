import 'dotenv/config';
import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {createDatabase,migrate,type Db} from '../../packages/db/src/index.ts';
import {seedDatabase} from '../../scripts/seed/index.ts';

describe('atomic synthetic seed recovery',()=>{
 let db:Db,admin:pg.Pool,schema:string;
 beforeAll(async()=>{
  process.env.DEMO_MODE='true';
  const url=new URL(process.env.TEST_DATABASE_URL??'postgresql://careloop:careloop@127.0.0.1:54329/careloop');
  admin=new pg.Pool({connectionString:url.href});schema=`careloop_seed_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema}`);db=createDatabase(url.href);await migrate(db);
 });
 afterAll(async()=>{await db?.close();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
 it('rolls back an interrupted first seed, then concurrent retries create one complete seed',async()=>{
  await db.pool.query("CREATE FUNCTION fail_second_seed_episode() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='episode-002' THEN RAISE EXCEPTION 'simulated_seed_interruption'; END IF; RETURN NEW; END $$; CREATE TRIGGER inject_seed_interruption BEFORE INSERT ON care_episodes FOR EACH ROW EXECUTE FUNCTION fail_second_seed_episode();");
  await expect(seedDatabase(db)).rejects.toThrow('simulated_seed_interruption');
  for(const table of ['organizations','users','patients','screening_results','care_episodes','episode_events','audit_events','workflow_executions']){
   const count=await db.pool.query<{count:number}>(`SELECT count(*)::int AS count FROM ${table}`);expect(count.rows[0]!.count).toBe(0);
  }
  await db.pool.query('DROP TRIGGER inject_seed_interruption ON care_episodes; DROP FUNCTION fail_second_seed_episode();');
  await Promise.all([seedDatabase(db),seedDatabase(db)]);
  const episodes=await db.pool.query<{count:number}>('SELECT count(*)::int AS count FROM care_episodes');expect(episodes.rows[0]!.count).toBe(16);
  const closures=await db.pool.query<{count:number}>('SELECT count(*)::int AS count FROM closure_decisions');expect(closures.rows[0]!.count).toBe(2);
  const events=await db.pool.query<{count:number}>('SELECT count(*)::int AS count FROM episode_events');
  const consent=await db.pool.query<{count:number}>('SELECT count(*)::int AS count FROM patient_consents');
  await seedDatabase(db);
  expect((await db.pool.query<{count:number}>('SELECT count(*)::int AS count FROM episode_events')).rows[0]!.count).toBe(events.rows[0]!.count);
  expect((await db.pool.query<{count:number}>('SELECT count(*)::int AS count FROM patient_consents')).rows[0]!.count).toBe(consent.rows[0]!.count);
 });
});
