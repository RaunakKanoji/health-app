import 'dotenv/config';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { buildApp, type CareLoopApp } from '../apps/api/src/app.ts';
import type { Command, Episode } from '../packages/contracts/src/careloop.ts';

export async function testApplication() {
  process.env.DEMO_MODE='true';
  process.env.SESSION_SECRET??='test-only-session-key-at-least-thirty-two-characters';
  process.env.WORKER_SECRET??='test-only-worker-key-at-least-thirty-two-characters';
  const url=new URL(process.env.TEST_DATABASE_URL??'postgresql://careloop:careloop@127.0.0.1:54329/careloop');
  const admin=new pg.Pool({connectionString:url.href});
  const schema=`careloop_test_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options',`-c search_path=${schema}`);
  let app:CareLoopApp;
  try { app=await buildApp({databaseUrl:url.href});await app.ready(); }
  catch(error) {await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();throw error;}
  return {app,schema,async close(){await app.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}};
}
export async function signIn(app:CareLoopApp,role:string) {
  const result=await app.inject({method:'POST',url:'/api/auth/login',payload:{email:`${role}@careloop.demo`,password:'CareLoop-Demo-2026!'}});
  if(result.statusCode!==200)throw new Error(`Login failed (${role}): ${result.body}`);
  return result.cookies.map(c=>`${c.name}=${c.value}`).join('; ');
}
export async function action(app:CareLoopApp,cookie:string,episode:Episode,command:Omit<Command,'expectedVersion'>,key=randomUUID()) {
  return app.inject({method:'POST',url:`/api/episodes/${episode.id}/actions`,headers:{cookie,'idempotency-key':key},payload:{...command,expectedVersion:episode.version}});
}
export function observation(patientId='patient-001',id=randomUUID()) {
  return {resourceType:'Observation',id,status:'final',meta:{versionId:'1',lastUpdated:'2026-10-27T09:00:00.000Z'},code:{coding:[{system:'http://loinc.org',code:'4548-4',display:'Synthetic screening'}],text:'Synthetic source requests clinician review.'},subject:{reference:`Patient/${patientId}`},effectiveDateTime:'2026-10-27T09:00:00.000Z',extension:[{url:'https://careloop.demo/fhir/StructureDefinition/follow-up-required',valueBoolean:true}]};
}
export async function newEpisode(app:CareLoopApp,cookie:string) {
  const result=await app.inject({method:'POST',url:'/api/fhir/ingest',headers:{cookie},payload:{source:'integration-tests',eventId:randomUUID(),resource:observation()}});
  if(result.statusCode!==200||!result.json().episodeId)throw new Error(`Ingest failed: ${result.body}`);
  return (await app.inject({url:`/api/episodes/${result.json().episodeId}`,headers:{cookie}})).json<{episode:Episode}>().episode;
}
