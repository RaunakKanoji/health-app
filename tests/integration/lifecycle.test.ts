import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { testApplication,signIn,action,newEpisode,observation } from '../helpers.ts';
import type { Episode } from '../../packages/contracts/src/careloop.ts';
import { migrate } from '../../packages/db/src/index.ts';
import { scenarioCatalog,runScenario } from '../../apps/api/src/scenarios.ts';

describe('PostgreSQL-backed authorized care lifecycle',()=>{
 let context:Awaited<ReturnType<typeof testApplication>>;
 let clinician:string,coordinator:string,patient:string,receiver:string;
 beforeAll(async()=>{context=await testApplication();[clinician,coordinator,patient,receiver]=await Promise.all([signIn(context.app,'clinician'),signIn(context.app,'coordinator'),signIn(context.app,'patient'),signIn(context.app,'receiver')]);});
 afterAll(async()=>{if(context)await context.close();});
 it('reapplies migrations safely and persists all required table families',async()=>{
  await migrate(context.app.db);await migrate(context.app.db);
  const tables=await context.app.db.pool.query<{table_name:string}>('SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()');
  expect(tables.rows.map(r=>r.table_name)).toEqual(expect.arrayContaining(['users','care_episodes','audit_events','outbox_events','closure_decisions','evidence_records','fhir_resources','risk_predictions']));
 });
 it('deduplicates intake, rejects altered replay, and retains invalid input for review',async()=>{
  const payload={source:'test-fhir',eventId:randomUUID(),resource:observation()};
  const first=await context.app.inject({method:'POST',url:'/api/fhir/ingest',headers:{cookie:clinician},payload});
  expect(first.statusCode).toBe(200);expect(first.json().status).toBe('IMPORTED');
  const replay=await context.app.inject({method:'POST',url:'/api/fhir/ingest',headers:{cookie:clinician},payload});
  expect(replay.json().episodeId).toBe(first.json().episodeId);expect(replay.json().status).toBe('DUPLICATE');
  const conflict=await context.app.inject({method:'POST',url:'/api/fhir/ingest',headers:{cookie:clinician},payload:{...payload,resource:{...payload.resource,status:'corrected'}}});expect(conflict.statusCode).toBe(409);
  const invalid=await context.app.inject({method:'POST',url:'/api/fhir/ingest',headers:{cookie:clinician},payload:{source:'test-fhir',eventId:randomUUID(),resource:{resourceType:'Observation'}}});expect(invalid.json().status).toBe('DEAD_LETTER');
  const rows=await context.app.db.pool.query("SELECT id FROM inbox_events WHERE status='DEAD_LETTER'");expect(rows.rowCount).toBeGreaterThan(0);
 });
 it('commits review, audit and downstream work once; concurrent stale commands conflict',async()=>{
  const e=await newEpisode(context.app,clinician);const key=randomUUID();
  const command={type:'review' as const,note:'Synthetic clinical review is complete.',patientExplanation:'Please arrange follow-up with your synthetic care team.',urgency:'ROUTINE' as const,dueAt:new Date(Date.now()+86400000).toISOString()};
  const first=await action(context.app,clinician,e,command,key);expect(first.statusCode).toBe(200);
  const replay=await action(context.app,clinician,e,command,key);expect(replay.json()).toEqual(first.json());
  const changed=first.json<{episode:Episode}>().episode;
  const concurrent=await Promise.all([action(context.app,coordinator,changed,{type:'block',note:'Synthetic barrier one.'}),action(context.app,coordinator,changed,{type:'block',note:'Synthetic barrier two.'})]);expect(concurrent.map(r=>r.statusCode).sort()).toEqual([200,409]);
  const audit=await context.app.db.pool.query('SELECT action FROM audit_events WHERE episode_id=$1',[e.id]);expect(audit.rows.filter(r=>r.action==='review')).toHaveLength(1);
  await expect(context.app.db.pool.query('DELETE FROM episode_events WHERE episode_id=$1',[e.id])).rejects.toThrow('immutable_record');
 });
 it('rolls back an interrupted state/event/audit transaction',async()=>{
  const e=await newEpisode(context.app,clinician);
  await expect(context.app.db.transaction(async tx=>{await tx.query("UPDATE care_episodes SET status='BLOCKED' WHERE id=$1",[e.id]);throw new Error('simulated_process_interruption');})).rejects.toThrow('simulated_process_interruption');
  const record=await context.app.service.getEpisode((await context.app.service.user('user-clinician'))!,e.id);expect(record.status).toBe('ACTIVE');expect(record.version).toBe(e.version);
 });
 it('does not turn delivery into acknowledgement and dispatch checks revoked consent',async()=>{
  let e=await newEpisode(context.app,clinician);
  const reviewed=await action(context.app,clinician,e,{type:'review',note:'Synthetic review for consent workflow.',patientExplanation:'Review your follow-up information.',urgency:'ROUTINE',dueAt:new Date(Date.now()+86400000).toISOString()});e=reviewed.json<{episode:Episode}>().episode;
  e=(await action(context.app,coordinator,e,{type:'send_message',channel:'sms'})).json<{episode:Episode}>().episode;
  e=(await action(context.app,patient,e,{type:'update_consent',consent:false})).json<{episode:Episode}>().episode;
  await context.app.service.tick(undefined,e.id);
  const actual=await context.app.service.getEpisode((await context.app.service.user('user-clinician'))!,e.id);expect(actual.communications.at(-1)?.status).toBe('CANCELLED');expect(actual.acknowledgedAt).toBeNull();
  await action(context.app,patient,actual,{type:'update_consent',consent:true});
 });
 it('retries failed messages with bounded backoff and exposes durable dead letters',async()=>{
  let e=await newEpisode(context.app,clinician);
  e=(await action(context.app,clinician,e,{type:'review',note:'Synthetic review for provider outage.',patientExplanation:'Your care team will arrange follow-up.',urgency:'ROUTINE',dueAt:new Date(Date.now()+86400000).toISOString()})).json<{episode:Episode}>().episode;
  e=(await action(context.app,coordinator,e,{type:'send_message',channel:'portal',simulateFailure:true})).json<{episode:Episode}>().episode;
  for(let i=0;i<3;i++)await context.app.service.tick(new Date(Date.now()+i*60000+1000).toISOString(),e.id);
  const job=await context.app.db.pool.query('SELECT status,attempts FROM outbox_events WHERE episode_id=$1',[e.id]);expect(job.rows[0]).toMatchObject({status:'DEAD_LETTER',attempts:3});
  const actual=await context.app.service.getEpisode((await context.app.service.user('user-clinician'))!,e.id);expect(actual.status).toBe('BLOCKED');expect(actual.closure).toBeNull();expect(actual.tasks.some(t=>t.type==='delivery_failure'&&t.status==='OPEN')).toBe(true);
 });
 it('imports the actual Synthea Patient with source provenance preserved',async()=>{
  const bundle=JSON.parse(readFileSync(new URL('../../data/fixtures/synthea-r4-bundle.json',import.meta.url),'utf8')) as {entry:{resource:{resourceType:string;id:string}}[]};
  const resource=bundle.entry.find(e=>e.resource.resourceType==='Patient')!.resource;
  const result=await context.app.inject({method:'POST',url:'/api/fhir/ingest',headers:{cookie:clinician},payload:{source:'official-synthea-sample',eventId:`patient:${resource.id}`,resource}});expect(result.json().status).toBe('IMPORTED');
  const stored=await context.app.db.pool.query('SELECT resource FROM fhir_resources WHERE source=$1 AND source_id=$2',['official-synthea-sample',resource.id]);expect(stored.rows[0].resource).toEqual(resource);
 });
 it.each(scenarioCatalog)('executes $id using real persisted transitions',async scenario=>{
  const admin=(await context.app.service.user('user-admin'))!;
  const result=await runScenario(context.app.db,admin,scenario.id,2026);
  expect(result.invariantViolations).toEqual([]);expect(result.passed).toBe(true);expect(result.actualState).toBe(result.expectedState);
 });
 it('calculates metrics from persisted records and restricts receiver access to granted episodes',async()=>{
  const metrics=await context.app.inject({url:'/api/metrics',headers:{cookie:clinician}});const count=await context.app.db.pool.query("SELECT count(*)::int AS count FROM care_episodes WHERE organization_id='org-screening'");expect(metrics.json().totalResults).toBe(count.rows[0].count);
  const list=await context.app.inject({url:'/api/episodes',headers:{cookie:receiver}});expect(list.json<{episodes:Episode[]}>().episodes.every(e=>e.referrals.some(r=>r.receivingOrganizationId==='org-receiver'))).toBe(true);
 });
});
