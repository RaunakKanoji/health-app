import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testApplication, signIn,grantPatient, newEpisode } from '../helpers.ts';
import type { Episode } from '../../packages/contracts/src/careloop.ts';

const sample={syntheticResearchSample:true,features:{days_waiting:4,prior_no_shows:1,contact_attempts:2,referral_rejected:false,patient_acknowledged:true,transport_barrier:false}};
const modelResponse={probability:0.42,model:'logistic_regression',version:'synthetic-logreg-v1-api-test',fallback:false,explanation_method:'Exact linear log odds, not SHAP',factors:[],synthetic_only:true,operational_only:true,clinical_validation:false};
describe('authorized research API does not gain clinical authority',()=>{
 let context:Awaited<ReturnType<typeof testApplication>>;
 let admin:string,clinician:string,patient:string,episode:Episode;
 beforeAll(async()=>{
  context=await testApplication();admin=await signIn(context.app,'admin');clinician=await signIn(context.app,'clinician');patient=await signIn(context.app,'patient');episode=await newEpisode(context.app,clinician);await grantPatient(context.app,episode.patient.id,['user-admin']);
 });
 afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
 afterAll(async()=>{if(context)await context.close();});
 const request=(cookie:string,payload:Record<string,unknown>=sample,key=randomUUID())=>context.app.inject({method:'POST',url:`/api/episodes/${episode.id}/research-risk`,headers:{cookie,'idempotency-key':key},payload});
 it('requires an authenticated administrator and complete explicit sample',async()=>{
  expect((await request('')).statusCode).toBe(401);
  expect((await request(clinician)).statusCode).toBe(403);
  expect((await request(patient)).statusCode).toBe(403);
  expect((await request(admin,{...sample,syntheticResearchSample:false})).statusCode).toBe(422);
  expect((await request(admin,{syntheticResearchSample:true,features:{days_waiting:2}})).statusCode).toBe(422);
 });
 it('persists a model version and prediction exactly once, with unchanged episode',async()=>{
  vi.stubEnv('ML_INTERNAL_KEY','synthetic-test-service-secret-at-least32');
  const provider=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(modelResponse)));
  vi.stubGlobal('fetch',provider);
  const key=randomUUID();const first=await request(admin,sample,key);expect(first.statusCode).toBe(200);expect(first.json().prediction.status).toBe('available');
  expect((await request(admin,sample,key)).json()).toEqual(first.json());expect(provider).toHaveBeenCalledTimes(1);
  expect((await request(admin,{...sample,features:{...sample.features,days_waiting:5}},key)).statusCode).toBe(409);
  const records=await context.app.db.pool.query('SELECT score FROM risk_predictions WHERE episode_id=$1',[episode.id]);expect(records.rowCount).toBe(1);expect(records.rows[0]?.score).toBe(0.42);
  const current=await context.app.service.getEpisode((await context.app.service.user('user-clinician'))!,episode.id);expect(current).toEqual(episode);
 });
 it('provider outage is visible without fabricating a score or changing care',async()=>{
  vi.stubEnv('ML_INTERNAL_KEY','synthetic-test-service-secret-at-least32');vi.stubGlobal('fetch',vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')));
  const response=await request(admin);expect(response.statusCode).toBe(200);expect(response.json().prediction.status).toBe('unavailable');expect(response.json().clinicalDecisionsAllowed).toBe(false);
  const records=await context.app.db.pool.query('SELECT score FROM risk_predictions WHERE episode_id=$1',[episode.id]);expect(records.rowCount).toBe(1);
  const current=await context.app.service.getEpisode((await context.app.service.user('user-clinician'))!,episode.id);expect(current).toEqual(episode);
 });
});
