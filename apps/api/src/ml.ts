import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CareLoopApp } from './app.ts';
import { DomainError } from '../../../packages/domain/src/index.ts';
import { predictOperationalRisk, riskInputSchema } from '../../../packages/ai/src/risk.ts';

/** Deliberately separate from clinical actions. No feature is inferred from missing history. */
export async function registerMlRoutes(app:CareLoopApp):Promise<void>{
 app.post<{Params:{id:string}}>('/api/episodes/:id/research-risk',async request=>{
  const actor=await app.authenticate(request);
  if(actor.role!=='admin')throw new DomainError('FORBIDDEN','Only demonstration administrators may submit explicit synthetic research samples.',403);
  const episode=await app.service.getEpisode(actor,request.params.id);
  const input=z.object({syntheticResearchSample:z.literal(true),features:riskInputSchema}).strict().parse(request.body);
  const key=z.string().min(1).max(200).parse(request.headers['idempotency-key']);
  const fingerprint=createHash('sha256').update(JSON.stringify({kind:'research-risk',episodeId:episode.id,input})).digest('hex');
  return app.db.transaction(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${actor.organizationId}:${actor.id}:${key}`]);
   const prior=(await tx.query<{fingerprint:string;result:unknown}>('SELECT fingerprint,result FROM workflow_executions WHERE organization_id=$1 AND actor_id=$2 AND idempotency_key=$3',[actor.organizationId,actor.id,key])).rows[0];
   if(prior){if(prior.fingerprint!==fingerprint)throw new DomainError('IDEMPOTENCY_CONFLICT','This key was already used for a different request.',409);return prior.result;}
   const prediction=await predictOperationalRisk(input.features,{url:process.env.ML_URL??'http://127.0.0.1:8001',key:process.env.ML_INTERNAL_KEY??''});
   const result={prediction,source:'explicit_synthetic_research_sample',clinicalDecisionsAllowed:false,episodeId:episode.id};
   if(prediction.status==='available'){
    const modelId=`research-${createHash('sha256').update(`${actor.organizationId}:${prediction.version}`).digest('hex').slice(0,32)}`;
    await tx.query('INSERT INTO model_registry(id,organization_id,version,kind,metadata) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',[modelId,actor.organizationId,prediction.version,prediction.model,JSON.stringify({syntheticOnly:true,operationalOnly:true,clinicalValidation:false,fallback:prediction.fallback})]);
    await tx.query('INSERT INTO risk_predictions(id,organization_id,episode_id,model_id,score,inputs) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.organizationId,episode.id,modelId,prediction.probability,JSON.stringify({features:input.features,source:'explicit_synthetic_research_sample',actorId:actor.id})]);
   }
   await tx.query('INSERT INTO audit_events(id,organization_id,actor_id,episode_id,action,request_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),actor.organizationId,actor.id,episode.id,'research_risk_requested',request.id,JSON.stringify({status:prediction.status,syntheticOnly:true,clinicalDecisionsAllowed:false})]);
   await tx.query('INSERT INTO workflow_executions(id,organization_id,actor_id,episode_id,idempotency_key,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),actor.organizationId,actor.id,episode.id,key,fingerprint,JSON.stringify(result)]);
   return result;
  });
 });
}
