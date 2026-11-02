import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { action, grantPatient, newEpisode, observation, signIn, testApplication } from '../helpers.ts';
import { seedDatabase } from '../../scripts/seed/index.ts';
import type { Episode } from '../../packages/contracts/src/careloop.ts';

describe('Clerk identity does not substitute for clinical authorization',()=>{
 let context:Awaited<ReturnType<typeof testApplication>>;
 let clinician:string,patient:string,admin:string,unassigned:string;
 beforeAll(async()=>{
  context=await testApplication();
  await context.app.db.pool.query("INSERT INTO users(id,organization_id,email,name,role) VALUES('user-unassigned','org-screening','unassigned@careloop.demo','Unassigned test clinician','clinician')");
  await context.app.db.pool.query("INSERT INTO clinician_profiles(user_id,professional_name,specialty,registration_identifier,verification_status) VALUES('user-unassigned','Unassigned test clinician','Synthetic','SYN-UNASSIGNED','approved')");
  clinician=await signIn(context.app,'clinician');patient=await signIn(context.app,'patient');admin=await signIn(context.app,'admin');unassigned=await signIn(context.app,'unassigned');
 });
 afterAll(async()=>{await context?.close();});
 const get=(path:string,cookie:string)=>context.app.inject({url:path,headers:{cookie}});
 it('an approved but unassigned clinician has an empty workspace and cannot read, act, import or use the assistant',async()=>{
  const e=await newEpisode(context.app,clinician);
  const workspace=await get('/api/workspace',unassigned);expect(workspace.statusCode).toBe(200);expect(workspace.json().episodes).toEqual([]);
  expect((await get(`/api/episodes/${e.id}`,unassigned)).statusCode).toBe(404);
  expect((await action(context.app,unassigned,e,{type:'block',note:'Unauthorised synthetic access attempt'})).statusCode).toBe(404);
  expect((await context.app.inject({method:'POST',url:`/api/episodes/${e.id}/assistant`,headers:{cookie:unassigned},payload:{question:'Summarize this episode'}})).statusCode).toBe(404);
  expect((await context.app.inject({method:'POST',url:'/api/fhir/ingest',headers:{cookie:unassigned},payload:{source:'scope-test',eventId:randomUUID(),resource:observation()}})).statusCode).toBe(404);
  expect((await get('/api/audit',unassigned)).json().events).toEqual([]);
  expect((await get('/api/operations',unassigned)).json().outbox).toEqual([]);
 });
 it('an administrator receives no automatic clinical record access or workflow authority',async()=>{
  const e=await newEpisode(context.app,clinician);
  expect((await get('/api/episodes',admin)).json().episodes).toEqual([]);
  expect((await get(`/api/episodes/${e.id}`,admin)).statusCode).toBe(404);
  expect((await action(context.app,admin,e,{type:'review',note:'Administrator cannot clinically approve a result',patientExplanation:'Please discuss follow-up with your care team.',urgency:'ROUTINE',dueAt:new Date(Date.now()+86400000).toISOString()})).statusCode).toBe(404);
  await grantPatient(context.app,e.patient.id,['user-admin']);
  expect((await get(`/api/episodes/${e.id}`,admin)).statusCode).toBe(200);
  expect((await action(context.app,admin,e,{type:'close',note:'Explicit read access is not clinical approval authority'})).statusCode).toBe(403);
  await context.app.db.pool.query("DELETE FROM clinician_patient_relationships WHERE clinician_id='user-admin'");
 });
 it('revocation takes effect before idempotent command and FHIR replay lookups',async()=>{
  await grantPatient(context.app,'patient-001',['user-unassigned']);
  const resource=observation(),intake={source:'scope-replay',eventId:randomUUID(),resource};
  const send=()=>context.app.inject({method:'POST',url:'/api/fhir/ingest',headers:{cookie:unassigned},payload:intake});
  const imported=await send();expect(imported.statusCode).toBe(200);
  const e=(await get(`/api/episodes/${imported.json().episodeId}`,unassigned)).json<{episode:Episode}>().episode;
  const key=randomUUID(),command={type:'block' as const,note:'Explicitly assigned clinician records synthetic barrier'};
  expect((await action(context.app,unassigned,e,command,key)).statusCode).toBe(200);
  await context.app.db.pool.query("UPDATE clinician_patient_relationships SET relationship_status='revoked',revoked_at=now() WHERE clinician_id='user-unassigned'");
  expect((await action(context.app,unassigned,e,command,key)).statusCode).toBe(404);
  expect((await send()).statusCode).toBe(404);
  // A receiving-organization grant cannot replace a clinician's revoked patient relationship.
  await context.app.db.pool.query('INSERT INTO access_grants(id,organization_id,episode_id,receiving_organization_id,granted_by) VALUES($1,$2,$3,$2,$4)',[randomUUID(),'org-screening',e.id,'user-clinician']);
  expect((await get(`/api/episodes/${e.id}`,unassigned)).statusCode).toBe(404);
  expect((await get('/api/episodes',unassigned)).json().episodes).toEqual([]);
 });
 it('revoked or pending clinician approval defeats an otherwise active relationship, including stale service actors',async()=>{
  await grantPatient(context.app,'patient-001',['user-unassigned']);
  const actor=(await context.app.service.user('user-unassigned'))!;
  expect((await get('/api/episodes/episode-001',unassigned)).statusCode).toBe(200);
  await context.app.db.pool.query("UPDATE clinician_profiles SET verification_status='pending' WHERE user_id='user-unassigned'");
  expect((await get('/api/episodes/episode-001',unassigned)).statusCode).toBe(404);
  await expect(context.app.service.getEpisode(actor,'episode-001')).rejects.toMatchObject({status:404});
  await context.app.db.pool.query("UPDATE clinician_profiles SET verification_status='approved' WHERE user_id='user-unassigned'");
  await context.app.db.pool.query("UPDATE users SET account_status='suspended' WHERE id='user-unassigned'");
  await expect(context.app.service.getEpisode(actor,'episode-001')).rejects.toMatchObject({status:404});
  expect((await get('/api/episodes/episode-001',unassigned)).statusCode).toBe(403);
 });
 it('patient projections omit source narratives, review notes, evidence and staff history on reads and action replay',async()=>{
  let e=await newEpisode(context.app,clinician);
  const before=(await get(`/api/episodes/${e.id}`,patient)).json<{episode:Episode}>().episode;
  expect(before.result.summary).toBe('');expect(before.events).toEqual([]);expect(before.tasks).toEqual([]);
  const staffNote='PRIVATE STAFF REVIEW — must never reach the patient';
  e=(await action(context.app,clinician,e,{type:'review',note:staffNote,patientExplanation:'Approved explanation for this patient.',urgency:'ROUTINE',dueAt:new Date(Date.now()+86400000).toISOString()})).json<{episode:Episode}>().episode;
  const read=await get(`/api/episodes/${e.id}`,patient);expect(read.body).not.toContain(staffNote);expect(read.json().episode.review.note).toBeUndefined();expect(read.json().episode.result.summary).toBe('Approved explanation for this patient.');
  const key=randomUUID(),command={type:'update_consent' as const,consent:false};
  for(let i=0;i<2;i++){
   const response=await action(context.app,patient,e,command,key);expect(response.statusCode).toBe(200);expect(response.body).not.toContain(staffNote);expect(response.json().episode.events).toEqual([]);expect(response.json().episode.evidence).toEqual([]);
  }
  const workspace=await get('/api/workspace',patient);expect(workspace.body).not.toContain(staffNote);expect(workspace.json().users).toEqual([]);
  const stored=(await context.app.service.getEpisode((await context.app.service.user('user-clinician'))!,e.id));expect(stored.review?.note).toBe(staffNote);expect(stored.events.length).toBeGreaterThan(0);
 });
 it('creating a FHIR patient does not silently grant its importer clinical access',async()=>{
  const patientId=`scope-${randomUUID()}`;
  const created=await context.app.inject({method:'POST',url:'/api/fhir/ingest',headers:{cookie:clinician},payload:{source:'scope-patient',eventId:randomUUID(),resource:{resourceType:'Patient',id:patientId,name:[{text:'Synthetic unassigned participant'}],birthDate:'1980-01-01'}}});expect(created.statusCode).toBe(200);
  const denied=await context.app.inject({method:'POST',url:'/api/fhir/ingest',headers:{cookie:clinician},payload:{source:'scope-patient',eventId:randomUUID(),resource:observation(patientId)}});expect(denied.statusCode).toBe(404);
  const rows=await context.app.db.pool.query('SELECT id FROM clinician_patient_relationships WHERE patient_id=$1',[patientId]);expect(rows.rowCount).toBe(0);
 });
 it('receiving providers lose episode access when their explicit grant is revoked',async()=>{
  const receiver=await signIn(context.app,'receiver');
  expect((await get('/api/episodes/episode-005',receiver)).statusCode).toBe(200);
  await context.app.db.pool.query("UPDATE access_grants SET revoked_at=now() WHERE episode_id='episode-005' AND receiving_organization_id='org-receiver'");
  expect((await get('/api/episodes/episode-005',receiver)).statusCode).toBe(404);
  expect((await get('/api/episodes',receiver)).json<{episodes:Episode[]}>().episodes.some(e=>e.id==='episode-005')).toBe(false);
 });
 it('re-running the synthetic seed never restores a revoked care relationship or approval decision',async()=>{
  await context.app.db.pool.query("UPDATE clinician_patient_relationships SET relationship_status='revoked',revoked_at=now() WHERE clinician_id='user-clinician' AND patient_id='patient-016'");
  await context.app.db.pool.query("UPDATE clinician_profiles SET verification_status='rejected' WHERE user_id='user-outsider'");
  await seedDatabase(context.app.db);
  expect((await get('/api/episodes/episode-016',clinician)).statusCode).toBe(404);
  expect((await context.app.service.user('user-outsider'))?.clinicianStatus).toBe('rejected');
 });
 it('serializes a care mutation with concurrent relationship revocation',async()=>{
  const e=await newEpisode(context.app,clinician),actor=(await context.app.service.user('user-coordinator-2'))!;
  let releaseAuthority=()=>{},authorityChecked=()=>{};
  const authorityReady=new Promise<void>(resolve=>{authorityChecked=resolve;}),continueMutation=new Promise<void>(resolve=>{releaseAuthority=resolve;});
  const original=context.app.service.canAccessPatient.bind(context.app.service);
  const spy=vi.spyOn(context.app.service,'canAccessPatient').mockImplementation(async(...args)=>{
   const allowed=await original(...args);
   if(args[0].id===actor.id&&args[3]){authorityChecked();await continueMutation;}
   return allowed;
  });
  const mutation=context.app.service.command(actor,e.id,{type:'block',expectedVersion:e.version,note:'Authorized synthetic care barrier'},randomUUID());
  let revocation:Promise<void>|undefined;
  try{
   await authorityReady;
   let announcePid=(_pid:number)=>{};
   const revokerPid=new Promise<number>(resolve=>{announcePid=resolve;});
   let committed=false;
   revocation=context.app.db.transaction(async tx=>{
    announcePid((await tx.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
    await tx.query("UPDATE clinician_patient_relationships SET relationship_status='revoked',revoked_at=now() WHERE clinician_id=$1 AND patient_id=$2",[actor.id,e.patient.id]);
   }).then(()=>{committed=true;});
   const pid=await revokerPid;
   await expect.poll(async()=>committed?'committed':(await context.app.db.pool.query<{wait_event_type:string|null}>('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type,{timeout:2000,interval:20}).toBe('Lock');
   releaseAuthority();expect((await mutation).status).toBe('BLOCKED');await revocation;
  }finally{releaseAuthority();spy.mockRestore();await Promise.allSettled([mutation,...(revocation?[revocation]:[])]);}
  await expect(context.app.service.getEpisode(actor,e.id)).rejects.toMatchObject({status:404});
 });

});
