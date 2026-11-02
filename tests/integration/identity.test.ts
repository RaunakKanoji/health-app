import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import type { IdentityState } from '../../packages/contracts/src/identity.ts';
import type { VerifiedIdentity } from '../../packages/auth/src/clerk.ts';
import { provisionClerkIdentity, verifyMissingClerkUser } from '../../packages/auth/src/provision.ts';
import { grantPatient, newEpisode, registerFixtureIdentity, revokeFixtureSession, signIn, testApplication } from '../helpers.ts';

describe('Clerk identity and explicit care authorization',()=>{
  let ctx:Awaited<ReturnType<typeof testApplication>>,adminCookie:string;
  beforeAll(async()=>{ctx=await testApplication();adminCookie=await signIn(ctx.app,'admin');});
  afterAll(async()=>{vi.unstubAllEnvs();await ctx?.close();});
  function fresh(overrides:Partial<VerifiedIdentity>={}){
    const id=randomUUID();const identity:VerifiedIdentity={clerkUserId:`user_${id}`,email:`${id}@identity.example`,name:'Synthetic Test User',emailVerified:true,sessionId:`sess_${id}`,updatedAt:Date.now(),...overrides};
    return {identity,cookie:registerFixtureIdentity(ctx.app,identity)};
  }
  const get=(url:string,cookie?:string)=>ctx.app.inject({url,headers:cookie?{cookie}:{}});
  const post=(url:string,cookie:string,payload:Record<string,unknown>)=>ctx.app.inject({method:'POST',url,headers:{cookie},payload});
  async function identityState(cookie:string){const result=await get('/api/identity',cookie);expect(result.statusCode,result.body).toBe(200);return result.json<IdentityState>();}
  async function patient(cookie:string){const result=await post('/api/onboarding/patient',cookie,{name:'Synthetic Patient',birthDate:'1980-01-01',language:'en',consent:false,privacyAcknowledged:true});expect(result.statusCode,result.body).toBe(200);return result.json<IdentityState>();}

  it('rejects anonymous, legacy-password and forged-cookie authentication',async()=>{
    expect((await get('/api/identity')).statusCode).toBe(401);
    expect((await get('/api/episodes','careloop_session=legacy; __session=forged')).statusCode).toBe(401);
    expect((await post('/api/auth/login','',{email:'admin@careloop.demo',password:'demo-password'})).statusCode).toBe(410);
  });
  it('reconciles the first verified sign-in without a webhook and never trusts role fields',async()=>{
    const account=fresh();const [state,concurrentState]=await Promise.all([identityState(account.cookie),identityState(account.cookie)]);
    expect(concurrentState.user.id).toBe(state.user.id);
    expect(state).toMatchObject({user:{role:'patient',patientId:null,onboardingCompleted:false,accountStatus:'active'},destination:'/onboarding'});
    expect((await get('/api/episodes',account.cookie)).statusCode).toBe(403);
    const forged=await post('/api/onboarding/patient',account.cookie,{name:'Synthetic Patient',birthDate:'1980-01-01',language:'en',privacyAcknowledged:true,role:'admin'});
    expect(forged.statusCode).toBe(422);
    expect((await get('/api/admin/users',account.cookie)).statusCode).toBe(403);
    expect((await identityState(account.cookie)).user.id).toBe(state.user.id);
  });
  it('does not automatically link a matching email to preexisting care records',async()=>{
    const account=fresh({email:'patient@careloop.demo'});
    const result=await get('/api/identity',account.cookie);
    expect(result.statusCode).toBe(409);expect(result.json().error.code).toBe('IDENTITY_LINK_REQUIRED');
    expect((await ctx.app.db.pool.query('SELECT id FROM users WHERE clerk_user_id=$1',[account.identity.clerkUserId])).rowCount).toBe(0);
    const sharedEmail=`${randomUUID()}@identity.example`,first=fresh({email:sharedEmail}),second=fresh({email:sharedEmail});
    const responses=await Promise.all([get('/api/identity',first.cookie),get('/api/identity',second.cookie)]);
    expect(responses.map(result=>result.statusCode).sort()).toEqual([200,409]);
    expect((await ctx.app.db.pool.query('SELECT id FROM users WHERE email=$1',[sharedEmail])).rowCount).toBe(1);
  });
  it('requires verified email and idempotently creates a single local patient',async()=>{
    const unverified=fresh({emailVerified:false});expect((await get('/api/identity',unverified.cookie)).statusCode).toBe(403);
    const account=fresh();const [first,second]=await Promise.all([patient(account.cookie),patient(account.cookie)]);
    expect(first.user.patientId).toBeTruthy();expect(second.user.patientId).toBe(first.user.patientId);
    expect(first.onboarding.status).toBe('complete');
    expect((await ctx.app.db.pool.query('SELECT id FROM patient_consents WHERE patient_id=$1',[first.user.patientId])).rowCount).toBe(1);
    expect((await get('/api/episodes',account.cookie)).json()).toEqual({episodes:[]});
  });
  it('keeps pending clinicians out, requires admin approval, and enforces grant/revocation on every request',async()=>{
    const account=fresh();const applicant=await identityState(account.cookie);
    const requested=await post('/api/onboarding/clinician',account.cookie,{professionalName:'Synthetic Doctor',specialty:'Primary care',registrationIdentifier:'DEMO-ONLY-001',institution:'Demo clinic',privacyAcknowledged:true});
    expect(requested.statusCode,requested.body).toBe(200);expect(requested.json().destination).toBe('/onboarding/clinician/pending');
    expect((await get('/api/episodes',account.cookie)).statusCode).toBe(403);
    const reviewPath=`/api/admin/clinicians/${applicant.user.id}/review`;
    expect((await post(reviewPath,account.cookie,{decision:'approved',reason:'Forged self approval'})).statusCode).toBe(403);
    expect((await post(reviewPath,adminCookie,{decision:'approved',reason:'Synthetic demo verification only'})).statusCode).toBe(200);
    expect((await identityState(account.cookie)).user.role).toBe('clinician');
    expect((await get('/api/episodes',account.cookie)).json()).toEqual({episodes:[]});
    const clinicalCookie=await signIn(ctx.app,'clinician');await grantPatient(ctx.app,'patient-001');
    const episode=await newEpisode(ctx.app,clinicalCookie);
    expect((await get(`/api/episodes/${episode.id}`,account.cookie)).statusCode).toBe(404);
    const granted=await post('/api/admin/relationships',adminCookie,{clinicianId:applicant.user.id,patientId:'patient-001',authorizationBasis:'Explicit synthetic care assignment'});
    expect(granted.statusCode,granted.body).toBe(200);
    expect((await get(`/api/episodes/${episode.id}`,account.cookie)).statusCode).toBe(200);
    expect((await get(`/api/episodes/${episode.id}`,adminCookie)).statusCode).toBe(404);
    const relationshipId=granted.json().relationship.id;
    expect((await post(`/api/admin/relationships/${relationshipId}/revoke`,adminCookie,{})).statusCode).toBe(200);
    expect((await get(`/api/episodes/${episode.id}`,account.cookie)).statusCode).toBe(404);
    await post('/api/admin/relationships',adminCookie,{clinicianId:applicant.user.id,patientId:'patient-001',authorizationBasis:'Explicit synthetic reassignment'});
    expect((await post(`/api/admin/users/${applicant.user.id}/status`,adminCookie,{accountStatus:'suspended'})).statusCode).toBe(200);
    expect((await get('/api/identity',account.cookie)).statusCode).toBe(403);
    await post(`/api/admin/users/${applicant.user.id}/status`,adminCookie,{accountStatus:'active'});
    expect((await get(`/api/episodes/${episode.id}`,account.cookie)).statusCode).toBe(404);
    revokeFixtureSession(ctx.app,account.cookie);expect((await get('/api/identity',account.cookie)).statusCode).toBe(401);
  });
  it('supports rejection and resubmission without clinical access or self-elevation',async()=>{
    const account=fresh();const state=await identityState(account.cookie);
    const fields={professionalName:'Synthetic Applicant',specialty:'Primary care',registrationIdentifier:'DEMO-REVIEW',institution:'',privacyAcknowledged:true};
    await post('/api/onboarding/clinician',account.cookie,fields);
    await post(`/api/admin/clinicians/${state.user.id}/review`,adminCookie,{decision:'rejected',reason:'Synthetic application requires clarification'});
    expect((await identityState(account.cookie)).onboarding.status).toBe('rejected');
    expect((await get('/api/episodes',account.cookie)).statusCode).toBe(403);
    expect((await post(`/api/admin/users/${state.user.id}/role`,adminCookie,{role:'admin'})).statusCode).toBe(422);
    expect((await post('/api/onboarding/clinician',account.cookie,fields)).json().onboarding.status).toBe('pending');
  });
  it('limits administrator audit views to safe access metadata',async()=>{
    await ctx.app.db.pool.query("INSERT INTO audit_events(id,organization_id,actor_id,action,request_id,metadata) VALUES($1,'org-screening','user-admin','authorization_denied',$2,$3)",[randomUUID(),randomUUID(),JSON.stringify({code:'FORBIDDEN',route:'/api/episodes/:id',clinicalNarrative:'SYNTHETIC PRIVATE CONTENT',sessionToken:'synthetic-token'})]);
    const result=await get('/api/admin/audit',adminCookie);expect(result.statusCode).toBe(200);
    expect(result.body).not.toContain('SYNTHETIC PRIVATE CONTENT');expect(result.body).not.toContain('synthetic-token');
    expect(result.json().events.some((event:{action:string})=>event.action==='authorization_denied')).toBe(true);
    expect(result.json().events.every((event:{action:string})=>event.action.startsWith('identity.')||event.action==='authorization_denied')).toBe(true);
  });
  it('provisions an explicit identity locally while preserving database IDs and records',async()=>{
    const account=fresh({name:'Explicitly Mapped Synthetic Patient'});
    const before=(await ctx.app.db.pool.query<{id:string;patient_id:string}>('SELECT id,patient_id FROM users WHERE id=$1',['user-patient'])).rows[0]!;
    const input={userId:before.id,identity:account.identity,administrator:false};
    expect((await provisionClerkIdentity(ctx.app.db,{...input,apply:false})).applied).toBe(false);
    expect((await ctx.app.db.pool.query('SELECT clerk_user_id FROM users WHERE id=$1',[before.id])).rows[0].clerk_user_id).toBeNull();
    await provisionClerkIdentity(ctx.app.db,{...input,apply:true});
    const state=await identityState(account.cookie);
    expect(state.user.id).toBe(before.id);expect(state.user.patientId).toBe(before.patient_id);
    expect((await ctx.app.db.pool.query('SELECT id FROM patients WHERE id=$1',[before.patient_id])).rowCount).toBe(1);
    await expect(provisionClerkIdentity(ctx.app.db,{userId:before.id,identity:fresh().identity,administrator:false,apply:true})).rejects.toMatchObject({code:'IDENTITY_ALREADY_LINKED'});
  });
  it('recovers an explicitly selected patient after verified Clerk deletion without changing local records or authorization',async()=>{
    const former=fresh(),before=await patient(former.cookie),replacement=fresh({email:former.identity.email,name:'New Clerk display label'});
    const input={userId:before.user.id,identity:replacement.identity,administrator:false};
    expect((await get('/api/identity',replacement.cookie)).statusCode).toBe(409);
    await expect(provisionClerkIdentity(ctx.app.db,{...input,apply:true})).rejects.toMatchObject({code:'IDENTITY_ALREADY_LINKED'});
    const absence=await verifyMissingClerkUser(former.identity.clerkUserId,async()=>{throw {status:404};});
    const recovery={...input,replacement:{expectedClerkUserId:former.identity.clerkUserId,absence}};
    expect((await provisionClerkIdentity(ctx.app.db,{...recovery,apply:false})).applied).toBe(false);
    expect((await ctx.app.db.pool.query('SELECT clerk_user_id FROM users WHERE id=$1',[before.user.id])).rows[0].clerk_user_id).toBe(former.identity.clerkUserId);
    expect((await ctx.app.db.pool.query('SELECT clerk_user_id FROM clerk_identity_tombstones WHERE clerk_user_id=$1',[former.identity.clerkUserId])).rowCount).toBe(0);
    const result=await provisionClerkIdentity(ctx.app.db,{...recovery,apply:true});
    expect(result).toMatchObject({applied:true,userId:before.user.id,replacedClerkUserId:former.identity.clerkUserId,patientId:before.user.patientId,role:'patient',onboardingCompleted:true,accountStatus:'active'});
    const after=await identityState(replacement.cookie);
    expect(after.user).toEqual({...before.user,clerkUserId:replacement.identity.clerkUserId});
    expect((await ctx.app.db.pool.query('SELECT id FROM patient_consents WHERE patient_id=$1',[before.user.patientId])).rowCount).toBe(1);
    expect((await get('/api/identity',former.cookie)).statusCode).toBe(403);
    await ctx.app.identity.synchronize({deliveryId:randomUUID(),type:'user.deleted',clerkUserId:former.identity.clerkUserId,timestamp:Date.now()});
    await ctx.app.identity.synchronize({deliveryId:randomUUID(),type:'user.updated',clerkUserId:former.identity.clerkUserId,timestamp:Date.now()+1000,disabled:true,identity:{...former.identity,name:'Stale former identity',updatedAt:Date.now()+1000}});
    expect((await identityState(replacement.cookie)).user).toEqual(after.user);
    const audit=(await ctx.app.db.pool.query("SELECT metadata FROM audit_events WHERE actor_id=$1 AND action='identity.recovered'",[before.user.id])).rows;
    expect(audit).toHaveLength(1);expect(audit[0].metadata).toMatchObject({previousClerkUserId:former.identity.clerkUserId,clerkUserId:replacement.identity.clerkUserId,oldIdentityConfirmedMissing:true});
  });
  it('rejects recovery with an unexpected old identity, changed email, forged absence evidence, or role promotion',async()=>{
    const former=fresh(),before=await patient(former.cookie),replacement=fresh({email:former.identity.email});
    const absence=await verifyMissingClerkUser(former.identity.clerkUserId,async()=>{throw {status:404};});
    const input={userId:before.user.id,identity:replacement.identity,administrator:false,apply:true,replacement:{expectedClerkUserId:former.identity.clerkUserId,absence}};
    const otherId=`user_${randomUUID()}`,otherAbsence=await verifyMissingClerkUser(otherId,async()=>{throw {status:404};});
    await expect(provisionClerkIdentity(ctx.app.db,{...input,replacement:{expectedClerkUserId:otherId,absence:otherAbsence}})).rejects.toMatchObject({code:'IDENTITY_REPLACEMENT_MISMATCH'});
    await expect(provisionClerkIdentity(ctx.app.db,{...input,identity:{...replacement.identity,email:'different@identity.example'}})).rejects.toMatchObject({code:'IDENTITY_RECOVERY_EMAIL'});
    await expect(provisionClerkIdentity(ctx.app.db,{...input,replacement:{...input.replacement,absence:{...absence}}})).rejects.toMatchObject({code:'IDENTITY_ABSENCE_UNVERIFIED'});
    await expect(provisionClerkIdentity(ctx.app.db,{...input,administrator:true})).rejects.toMatchObject({code:'ROLE_CONFLICT'});
    expect((await ctx.app.db.pool.query('SELECT clerk_user_id FROM users WHERE id=$1',[before.user.id])).rows[0].clerk_user_id).toBe(former.identity.clerkUserId);
  });
  it('rejects recovery for staff accounts or a replacement identity already mapped elsewhere',async()=>{
    const admin=(await identityState(adminCookie)).user;
    const absence=await verifyMissingClerkUser(admin.clerkUserId!,async()=>{throw {status:404};});
    await expect(provisionClerkIdentity(ctx.app.db,{userId:admin.id,identity:fresh({email:admin.email}).identity,administrator:false,apply:true,replacement:{expectedClerkUserId:admin.clerkUserId!,absence}})).rejects.toMatchObject({code:'IDENTITY_RECOVERY_ROLE'});
    const former=fresh(),before=await patient(former.cookie),alreadyMapped=fresh();await patient(alreadyMapped.cookie);
    const oldAbsence=await verifyMissingClerkUser(former.identity.clerkUserId,async()=>{throw {status:404};});
    await expect(provisionClerkIdentity(ctx.app.db,{userId:before.user.id,identity:{...alreadyMapped.identity,email:former.identity.email},administrator:false,apply:true,replacement:{expectedClerkUserId:former.identity.clerkUserId,absence:oldAbsence}})).rejects.toMatchObject({code:'IDENTITY_CONFLICT'});
    expect((await ctx.app.db.pool.query('SELECT clerk_user_id FROM users WHERE id=$1',[before.user.id])).rows[0].clerk_user_id).toBe(former.identity.clerkUserId);
  });

  const signingSecret=Buffer.from('only-for-isolated-integration-signature-test').toString('base64');
  async function webhook(type:string,data:Record<string,unknown>,deliveryId=randomUUID(),valid=true){
    vi.stubEnv('CLERK_WEBHOOK_SIGNING_SECRET',`whsec_${signingSecret}`);
    const timestamp=Math.floor(Date.now()/1000).toString();
    const payload=JSON.stringify({type,data,timestamp:Date.now(),object:'event'},null,2);
    const signature=createHmac('sha256',Buffer.from(signingSecret,'base64')).update(`${deliveryId}.${timestamp}.${payload}`).digest('base64');
    return ctx.app.inject({method:'POST',url:'/api/webhooks/clerk',headers:{'content-type':'application/json','svix-id':deliveryId,'svix-timestamp':timestamp,'svix-signature':`v1,${valid?signature:'invalid'}`},payload});
  }
  function webhookData(id:string,updatedAt:number,name='Synthetic Webhook User'){
    return {id,first_name:name,last_name:null,updated_at:updatedAt,primary_email_address_id:'email_test',email_addresses:[{id:'email_test',email_address:`${id}@identity.example`,verification:{status:'verified'}}],banned:false,locked:false,unsafe_metadata:{role:'admin'},public_metadata:{role:'admin'}};
  }
  it('verifies raw webhook signatures, deduplicates deliveries, and ignores stale updates and metadata roles',async()=>{
    const id=`user_${randomUUID()}`,now=Date.now(),deliveryId=randomUUID();
    expect((await webhook('user.created',webhookData(id,now),deliveryId,false)).statusCode).toBe(400);
    expect((await ctx.app.db.pool.query('SELECT id FROM users WHERE clerk_user_id=$1',[id])).rowCount).toBe(0);
    const created=await webhook('user.created',webhookData(id,now),deliveryId);expect(created.statusCode,created.body).toBe(200);
    expect((await webhook('user.created',webhookData(id,now),deliveryId)).json().duplicate).toBe(true);
    const updated=await webhook('user.updated',webhookData(id,now+100,'Newer Name'));expect(updated.statusCode,updated.body).toBe(200);
    await webhook('user.updated',{...webhookData(id,now-100,'Stale Name'),banned:true});
    const user=(await ctx.app.db.pool.query('SELECT name,role,account_status FROM users WHERE clerk_user_id=$1',[id])).rows[0];
    expect(user).toEqual({name:'Newer Name',role:'patient',account_status:'active'});
    expect((await webhook('session.revoked',{id:'sess_ignored'})).json().ignored).toBe(true);
  });
  it('retains clinical data on deletion and prevents delayed create/update resurrection',async()=>{
    const account=fresh();const state=await patient(account.cookie),patientId=state.user.patientId;
    const deleted=await webhook('user.deleted',{id:account.identity.clerkUserId,deleted:true});expect(deleted.statusCode,deleted.body).toBe(200);
    expect((await get('/api/identity',account.cookie)).statusCode).toBe(403);
    expect((await ctx.app.db.pool.query('SELECT id FROM patients WHERE id=$1',[patientId])).rowCount).toBe(1);
    await webhook('user.updated',webhookData(account.identity.clerkUserId,Date.now()+200));
    expect((await ctx.app.db.pool.query('SELECT account_status FROM users WHERE id=$1',[state.user.id])).rows[0].account_status).toBe('deleted');
    const deletedFirst=`user_${randomUUID()}`;
    await webhook('user.deleted',{id:deletedFirst,deleted:true});await webhook('user.created',webhookData(deletedFirst,Date.now()-1000));
    expect((await ctx.app.db.pool.query('SELECT id FROM users WHERE clerk_user_id=$1',[deletedFirst])).rowCount).toBe(0);
  });
});
