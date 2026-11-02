import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../../../packages/db/src/index.ts';
import type { User, Command } from '../../../packages/contracts/src/careloop.ts';
import { WorkflowService } from '../../../packages/workflows/src/service.ts';
import { DomainError } from '../../../packages/domain/src/index.ts';
import { predictOperationalRisk } from '../../../packages/ai/src/risk.ts';

export type Scenario = { id: string; title: string; description: string; expectedState: string };
export const scenarioCatalog = JSON.parse(readFileSync(new URL('../../../data/scenarios/catalog.json', import.meta.url), 'utf8')) as Scenario[];
export type ScenarioRun = { id: string; scenarioId: string; seed: number; passed: boolean; expectedState: string; actualState: string; events: { type: string; detail: string }[]; simulatedAt: string; simulatedDurationHours: number; invariantViolations: string[]; episodeId?: string };
type ScenarioApp = FastifyInstance & { db: Db; authenticate(request: FastifyRequest): Promise<User> };

export async function runScenario(db: Db, requestedBy: User, scenarioId: string, seed: number): Promise<ScenarioRun> {
  if (requestedBy.role !== 'admin' || requestedBy.organizationId !== 'org-screening') throw new DomainError('FORBIDDEN', 'Synthetic scenarios require the demonstration administrator.', 403);
  const scenario = scenarioCatalog.find(s => s.id === scenarioId);
  if (!scenario) throw new DomainError('NOT_FOUND', 'Scenario not found.', 404);
  const runId = randomUUID();
  const epoch = Date.UTC(2026, 9, 27, 9) + (seed % 7) * 86400000;
  let elapsed = 0;
  const clock = () => new Date(epoch + elapsed).toISOString();
  const advance = (hours: number) => { elapsed += hours * 3600000; };
  const service = new WorkflowService(db, clock);
  const actor = async (id: string) => { const user = await service.user(id); if (!user) throw new Error('Run pnpm db:seed before scenarios.'); return user; };
  const [clinician, coordinator, receiver, outsider] = await Promise.all(['user-clinician','user-coordinator','user-receiver','user-outsider'].map(actor));
  if (!clinician || !coordinator || !receiver || !outsider) throw new Error('Missing demonstration accounts.');
  const patientId = `sim-p-${runId}`;
  const patient: User = { id: `sim-u-${runId}`, name: `Synthetic scenario participant ${seed}`, email: `${runId}@scenario.invalid`, role: 'patient', organizationId: requestedBy.organizationId, patientId };
  await service.ingest(clinician, { source: `scenario:${runId}`, eventId: 'patient-1', resource: { resourceType: 'Patient', id: patientId, name: [{ text: patient.name }], birthDate: '1970-01-01' } });
  // These restricted synthetic identities are created only by the authenticated demo administrator.
  await db.pool.query('INSERT INTO users(id,organization_id,email,name,password_hash,role,patient_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [patient.id,patient.organizationId,patient.email,patient.name,'disabled-scenario-account','patient',patientId]);
  const codes = ['4548-4','2335-8','85354-9'];
  const resource = { resourceType: 'Observation', id: `sim-r-${runId}`, meta: { versionId: '1', lastUpdated: clock() }, status: 'final', subject: { reference: `Patient/${patientId}` }, code: { coding: [{ system: 'http://loinc.org', code: codes[seed % codes.length]!, display: 'Synthetic screening finding' }], text: 'Synthetic source explicitly requests clinician follow-up. No software diagnosis is asserted.' }, effectiveDateTime: clock(), extension: [{url:'https://careloop.demo/fhir/StructureDefinition/follow-up-required',valueBoolean:true}] };
  const intake = { source: `scenario:${runId}`, eventId: 'observation-1', resource };
  const imported = await service.ingest(clinician, intake);
  if (!imported.episodeId) throw new Error(`Scenario intake failed: ${imported.status}`);
  let episode = await service.getEpisode(clinician, imported.episodeId);
  const violations: string[] = [];
  const checkpoints: {type:string;detail:string}[] = [{type:'source_event',detail:'FHIR R4 synthetic Observation ingested with an explicit source follow-up flag.'}];
  let step = 0;
  const check = (value: unknown, message: string) => { if (!value) violations.push(message); checkpoints.push({type:value?'invariant_pass':'invariant_fail',detail:message}); };
  const command = async (user: User, input: Omit<Command,'expectedVersion'>) => {
    episode = await service.command(user, episode.id, {...input,expectedVersion:episode.version},`${runId}:${++step}`);
    return episode;
  };
  const denied = async (operation: () => Promise<unknown>, codes: string[], message: string) => {
    try { await operation(); check(false,message); } catch(error) { check(error instanceof DomainError && codes.includes(error.code),message); }
    episode = await service.getEpisode(clinician, episode.id);
  };
  const review = () => command(clinician,{type:'review',note:'Synthetic clinician review confirms follow-up workflow is appropriate.',patientExplanation:'Your synthetic screening result needs a follow-up discussion with your care team.',urgency:'ROUTINE',dueAt:new Date(epoch+86400000).toISOString()});
  const message = async () => { await command(coordinator,{type:'send_message',channel:'portal'}); await service.tick(clock(),episode.id); episode=await service.getEpisode(clinician,episode.id); };
  const acknowledged = async () => { await review();await message();await command(patient,{type:'acknowledge'}); };
  const referred = async () => { await acknowledged();await command(clinician,{type:'create_referral',receivingOrganizationId:'org-receiver',note:'Synthetic clinician-approved follow-up consultation.'}); };
  const scheduled = async () => { await referred();await command(receiver,{type:'accept_referral',referralId:episode.referrals.at(-1)!.id});await command(coordinator,{type:'schedule_appointment',referralId:episode.referrals.at(-1)!.id,scheduledAt:new Date(epoch+3600000).toISOString(),location:'Synthetic outpatient clinic'});advance(2); };
  const completed = async () => { await scheduled();await command(receiver,{type:'complete_appointment',appointmentId:episode.appointments.at(-1)!.id,note:'Synthetic encounter occurred; follow-up documentation requested.'}); };
  const evidence = async () => { for (const kind of ['encounter_note','followup_report'] as const) { await command(coordinator,{type:'add_evidence',evidenceKind:kind,title:`Synthetic ${kind.replaceAll('_',' ')}`,content:'Synthetic clinician-authored documentation of the completed follow-up encounter. This is demonstration evidence only.'});await command(clinician,{type:'verify_evidence',evidenceId:episode.evidence.at(-1)!.id,note:'Synthetic source and encounter references clinically reviewed.'}); } };
  try {
    switch(scenarioId) {
      case 'duplicate-webhook': {const duplicate=await service.ingest(clinician,intake);check(duplicate.status==='DUPLICATE'&&duplicate.episodeId===episode.id,'Duplicate source event creates no additional episode.');break;}
      case 'cross-tenant-access': await denied(()=>service.getEpisode(outsider,episode.id),['NOT_FOUND'],'Unauthorized tenant cannot enumerate the episode.');break;
      case 'failed-ownership-transfer': {const prior=episode.ownerId;await command(coordinator,{type:'request_transfer',targetUserId:clinician.id,note:'Synthetic transfer request for review.'});await command(clinician,{type:'reject_transfer',note:'Synthetic capacity limitation; current owner must retain the case.'});check(episode.ownerId===prior,'Rejected transfer retains the accountable owner.');break;}
      case 'ml-provider-failure': {const prediction=await predictOperationalRisk({days_waiting:7,prior_no_shows:0,contact_attempts:1,referral_rejected:false,patient_acknowledged:false,transport_barrier:false},{url:'http://127.0.0.1:1',key:'synthetic-unavailable-provider-key-at-least-32',fetcher:async()=>{throw new Error('simulated_provider_outage');}});check(prediction.status==='unavailable','Model outage is visible and does not create a clinical score.');await review();const summary=await service.assistant(clinician,episode.id,'Which action is due next?');check(summary.mode==='deterministic-fallback'&&summary.citations.length>0,'Record-grounded coordination remains available during provider outage.');break;}
      case 'missing-acknowledgement': await review();await message();check(!episode.acknowledgedAt&&episode.communications.some(c=>c.status==='DELIVERED'),'Delivery alone never records patient acknowledgement.');await denied(()=>command(clinician,{type:'close',note:'Attempted closure without acknowledged follow-up.'}),['PRECONDITION_FAILED'],'Closure without acknowledgement is refused.');break;
      case 'revoked-consent': await review();await command(patient,{type:'update_consent',consent:true});await command(coordinator,{type:'send_message',channel:'sms'});await command(patient,{type:'update_consent',consent:false});await service.tick(clock(),episode.id);episode=await service.getEpisode(clinician,episode.id);check(episode.communications.every(c=>c.status==='CANCELLED'),'Optional queued outreach is cancelled after consent revocation.');break;
      case 'overdue-critical-review': await review();advance(25);await service.tick(clock(),episode.id);episode=await service.getEpisode(clinician,episode.id);check(episode.urgency==='ROUTINE'&&!episode.closure,'Deadline escalation does not alter clinical urgency or close care.');break;
      case 'referral-rejection': await referred();await command(receiver,{type:'reject_referral',referralId:episode.referrals.at(-1)!.id,note:'Synthetic receiving clinic cannot accept this referral.'});check(episode.ownerId===coordinator.id&&episode.tasks.some(t=>t.type==='referral_rejected'&&t.status==='OPEN'),'Rejected referral returns actionable recovery work to the accountable owner.');break;
      case 'appointment-no-show': await scheduled();await command(receiver,{type:'no_show',appointmentId:episode.appointments.at(-1)!.id,note:'Synthetic appointment was not attended.'});check(!episode.appointments.some(a=>a.status==='COMPLETED'),'No-show does not create a completed encounter.');break;
      case 'incomplete-documentation': await completed();await command(coordinator,{type:'add_evidence',evidenceKind:'encounter_note',title:'Unverified synthetic encounter note',content:'Synthetic note recorded but not yet reviewed by a clinician.'});await denied(()=>command(clinician,{type:'close',note:'Attempted closure while documentation remains incomplete.'}),['PRECONDITION_FAILED'],'Unverified and incomplete documentation cannot support closure.');break;
      case 'missing-evidence': await completed();await denied(()=>command(clinician,{type:'close',note:'Attempted closure without follow-up evidence.'}),['PRECONDITION_FAILED'],'A completed encounter alone cannot close an episode.');break;
      case 'unauthorized-closure': await completed();await evidence();await denied(()=>command(coordinator,{type:'close',note:'Coordinator attempts closure despite complete evidence.'}),['FORBIDDEN'],'Complete evidence cannot grant clinical authority to a coordinator.');break;
      case 'corrected-report': await completed();await evidence();await command(clinician,{type:'close',note:'Synthetic clinician attests that all closure evidence is verified.'});await service.ingest(clinician,{...intake,eventId:'observation-2',resource:{...resource,meta:{versionId:'2',lastUpdated:clock()},status:'corrected',code:{...resource.code,text:'Synthetic corrected result requires a new clinical review.'}}});episode=await service.getEpisode(clinician,episode.id);check(!episode.review&&!episode.closure&&episode.result.revision===2,'Correction preserves history and invalidates earlier clinical approvals.');break;
      case 'successful-followup': case 'verified-closure': await completed();await evidence();await command(clinician,{type:'close',note:'Synthetic clinician attests that encounter and follow-up evidence meet the policy.'});check(episode.closure?.clinicianId===clinician.id,'Verified closure records the authorized clinician and evidence.');break;
      default: throw new Error('Scenario has no implementation.');
    }
  } catch(error) { violations.push(error instanceof DomainError?`${error.code}: ${error.message}`:'Scenario execution failed; inspect the synthetic audit trail.'); }
  check(Boolean(episode.ownerId)||episode.tasks.some(t=>t.type==='unassigned'&&t.status==='OPEN'),'Every active episode retains ownership or an unassigned escalation.');
  const expectedState = scenario.expectedState;
  check(episode.status===expectedState,`Expected operational state: ${expectedState}; observed: ${episode.status}.`);
  const result:ScenarioRun={id:runId,scenarioId,seed,passed:violations.length===0,expectedState,actualState:episode.status,events:[...episode.events.map(e=>({type:e.type,detail:e.detail})),...checkpoints],simulatedAt:clock(),simulatedDurationHours:elapsed/3600000,invariantViolations:violations,episodeId:episode.id};
  await db.pool.query('INSERT INTO scenario_runs(id,organization_id,actor_id,seed,results,created_at) VALUES($1,$2,$3,$4,$5,$6)',[runId,requestedBy.organizationId,requestedBy.id,seed,JSON.stringify(result),clock()]);
  return result;
}

export function registerScenarioRoutes(app: ScenarioApp) {
  app.get('/api/scenarios', async request => {
    const actor=await app.authenticate(request);
    if(actor.role!=='admin')throw new DomainError('FORBIDDEN','Scenario evaluation requires a demonstration administrator.',403);
    const runs=(await app.db.pool.query<{results:ScenarioRun}>('SELECT results FROM scenario_runs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100',[actor.organizationId])).rows.map(r=>r.results);
    return {scenarios:scenarioCatalog,runs};
  });
  app.post('/api/scenarios/run', {config:{rateLimit:{max:30,timeWindow:'1 minute'}}}, async request => {
    const actor=await app.authenticate(request);
    const input=z.object({scenarioId:z.string().max(100),seed:z.number().int().min(0).max(2147483647)}).strict().parse(request.body);
    return runScenario(app.db,actor,input.scenarioId,input.seed);
  });
}
