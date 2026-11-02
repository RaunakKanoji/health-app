import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { buildApp, type CareLoopApp } from '../apps/api/src/app.ts';
import { DomainError } from '../packages/domain/src/index.ts';
import type { IdentityVerifier, VerifiedIdentity } from '../packages/auth/src/clerk.ts';
import type { Command, Episode } from '../packages/contracts/src/careloop.ts';
import type { PrivateDocumentStore } from '../packages/workflows/src/medical-documents.ts';

const sessions=new WeakMap<CareLoopApp,Map<string,VerifiedIdentity>>();
export async function testApplication(options:{documentStore?:PrivateDocumentStore|null}={}) {
  process.env.DEMO_MODE='true';
  process.env.WORKER_SECRET??='test-only-worker-key-at-least-thirty-two-characters';
  const url=new URL(process.env.TEST_DATABASE_URL??'postgresql://careloop:careloop@127.0.0.1:54329/careloop');
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Integration fixtures require an explicit local PostgreSQL test database.');
  // Config validation and bootstrap must never inherit a developer's live Neon target.
  process.env.DATABASE_ENVIRONMENT='test';
  process.env.DATABASE_URL=url.href;
  process.env.DATABASE_DIRECT_URL=url.href;
  process.env.DATABASE_URL_UNPOOLED=url.href;
  delete process.env.DATABASE_RUNTIME_URL;
  const admin=new pg.Pool({connectionString:url.href});
  const schema=`careloop_test_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options',`-c search_path=${schema}`);
  const registry=new Map<string,VerifiedIdentity>();
  const identityVerifier:IdentityVerifier=async request=>{const identity=registry.get(request.cookies.__session??'');if(!identity)throw new DomainError('UNAUTHENTICATED','Sign in to access CareLoop.',401);return identity;};
  let app:CareLoopApp;
  try { app=await buildApp({databaseUrl:url.href,identityVerifier,documentStore:options.documentStore??null});await app.ready();sessions.set(app,registry); }
  catch(error) {await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();throw error;}
  return {app,schema,async close(){await app.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}};
}
export async function signIn(app:CareLoopApp,role:string) {
  const user=(await app.db.pool.query<{id:string;email:string;name:string}>('SELECT id,email,name FROM users WHERE email=$1',[`${role}@careloop.demo`])).rows[0];
  if(!user)throw new Error(`Missing test identity: ${role}`);
  const clerkUserId=`user_test_${user.id}`;
  await app.db.pool.query('UPDATE users SET clerk_user_id=$1 WHERE id=$2',[clerkUserId,user.id]);
  return registerFixtureIdentity(app,{clerkUserId,email:user.email,name:user.name,emailVerified:true,sessionId:`sess_${randomUUID()}`,updatedAt:Date.now()});
}
export function registerFixtureIdentity(app:CareLoopApp,identity:VerifiedIdentity){
 const registry=sessions.get(app);if(!registry)throw new Error('Fixture identities require the injected test verifier.');
 const token=randomUUID();registry.set(token,identity);return `__session=${token}`;
}
export function revokeFixtureSession(app:CareLoopApp,cookie:string){sessions.get(app)?.delete(cookie.split('=')[1]!);}
/** Explicit fixture authorization; never available in application request handling. */
export async function grantPatient(app:CareLoopApp,patientId:string,userIds=['user-clinician','user-coordinator']){
 for(const id of userIds)await app.db.pool.query("INSERT INTO clinician_patient_relationships(id,organization_id,clinician_id,patient_id,authorization_basis,authorized_by) SELECT $1,u.organization_id,u.id,$2,'Explicit isolated test fixture',u.id FROM users u WHERE u.id=$3 ON CONFLICT(clinician_id,patient_id) DO UPDATE SET relationship_status='active',revoked_at=NULL",[randomUUID(),patientId,id]);
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
