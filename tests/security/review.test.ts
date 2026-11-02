import { describe, expect, it } from 'vitest';
import type { Command, Episode, User } from '../../packages/contracts/src/careloop.ts';
import { canReadEpisode, closureGaps, transition } from '../../packages/domain/src/index.ts';

const now = '2026-10-27T12:00:00.000Z';
const clinician: User = { id:'clinician-a',name:'Synthetic clinician',email:'clinician@example.invalid',role:'clinician',organizationId:'org-a',patientId:null };
const receiver: User = { ...clinician,id:'receiver-b',role:'receiver',organizationId:'org-b' };
const patient: User = { ...clinician,id:'patient-user',role:'patient',patientId:'patient-a' };
function readyEpisode(): Episode {
 return {
  id:'episode-a',organizationId:'org-a',patient:{id:'patient-a',name:'Synthetic patient',birthDate:'1980-01-01',language:'en',synthetic:true,communicationConsent:false},
  pathway:'diabetes',title:'Synthetic screening follow-up',phase:'OUTCOME_VERIFICATION',status:'ACTIVE',version:10,ownerId:'coordinator-a',ownerName:'Synthetic coordinator',createdAt:now,updatedAt:now,dueAt:null,urgency:'ROUTINE',
  result:{id:'result-a',summary:'Synthetic source requiring review',sourceId:'source-a',issuedAt:now,status:'final',revision:1},
  review:{clinicianId:clinician.id,reviewedAt:now,note:'Reviewed synthetic source',patientExplanation:'Please review your next steps with your clinician.',policyVersion:'demo-1.0'},
  acknowledgedAt:now,
  referrals:[{id:'referral-b',resultRevision:1,receivingOrganizationId:'org-b',receivingOrganizationName:'Synthetic receiving provider',status:'ACCEPTED',reason:'Synthetic human-approved referral',createdAt:now,respondedAt:now}],
  appointments:[{id:'appointment-b',resultRevision:1,referralId:'referral-b',scheduledAt:now,location:'Synthetic clinic',status:'COMPLETED',completedAt:now}],
  communications:[{id:'message-a',channel:'portal',content:'Please sign in to your portal.',status:'DELIVERED',attempts:1,createdAt:now,deliveredAt:now}],
  evidence:['encounter_note','followup_report'].map((kind,index)=>({id:`evidence-${index}`,appointmentId:'appointment-b',resultRevision:1,kind:kind as 'encounter_note'|'followup_report',title:'Synthetic source evidence',content:'Synthetic documented encounter result.',submittedBy:clinician.id,createdAt:now,verifiedBy:clinician.id,verifiedAt:now})),
  tasks:[],events:[],closure:null,ownershipTransfer:null,
 };
}
function apply(e:Episode,actor:User,command:Omit<Command,'expectedVersion'>,shared=false) {
 return transition(e,actor,{...command,expectedVersion:e.version},{now,shared});
}

describe('independent clinical and authorization regression review',()=>{
 it('rejects cross-tenant identifiers and ungranted provider access',()=>{
  const e=readyEpisode();
  expect(canReadEpisode({...clinician,organizationId:'org-other'},e,false)).toBe(false);
  expect(canReadEpisode({...patient,patientId:'different-patient'},e,false)).toBe(false);
  expect(canReadEpisode(receiver,e,false)).toBe(false);
  expect(canReadEpisode(receiver,e,true)).toBe(true);
 });
 it.each(['patient','coordinator','admin','receiver'] as const)('never allows %s to clinically close a case',role=>{
  const e=readyEpisode();const before=structuredClone(e);
  const actor={...clinician,role,patientId:role==='patient'?'patient-a':null,organizationId:role==='receiver'?'org-b':'org-a'};
  expect(()=>apply(e,actor,{type:'close',note:'Complete synthetic clinician attestation'},role==='receiver')).toThrow();
  expect(e).toEqual(before);
 });
 it('requires explicit patient acknowledgement even after delivery',()=>{
  const e=readyEpisode();e.acknowledgedAt=null;
  expect(closureGaps(e)).toContain('Patient acknowledgement');
  expect(()=>apply(e,clinician,{type:'close',note:'Complete synthetic clinician attestation'})).toThrow();
 });
 it('does not treat a scheduled appointment or stale evidence as completed care',()=>{
  const e=readyEpisode();e.appointments[0]!.status='SCHEDULED';e.appointments[0]!.completedAt=null;
  expect(closureGaps(e)).toContain('Completed encounter');
  expect(()=>apply(e,clinician,{type:'close',note:'Complete synthetic clinician attestation'})).toThrow();
  e.appointments[0]!.status='COMPLETED';e.evidence[0]!.resultRevision=0;
  expect(closureGaps(e)).toContain('Clinician-verified encounter note');
 });
 it('cannot attach closure evidence to another providers encounter after referral rejection',()=>{
  const e=readyEpisode();e.referrals[0]!.status='REJECTED';
  e.referrals.push({...e.referrals[0]!,id:'referral-c',receivingOrganizationId:'org-c',status:'ACCEPTED'});
  e.appointments[0]!.referralId='referral-c';
  const before=structuredClone(e);
  expect(()=>apply(e,receiver,{type:'add_evidence',evidenceKind:'encounter_note',title:'Untrusted provider submission',content:'An unrelated provider tries to add evidence.'},true)).toThrow();
  expect(e).toEqual(before);
 });
 it('accepts evidence from the explicitly authorized receiving provider only as unverified',()=>{
  const result=apply(readyEpisode(),receiver,{type:'add_evidence',appointmentId:'appointment-b',evidenceKind:'encounter_note',title:'Synthetic encounter note',content:'Documented synthetic completed encounter.'},true);
  expect(result.evidence.at(-1)?.verifiedBy).toBeNull();
  expect(()=>apply(result,receiver,{type:'verify_evidence',evidenceId:result.evidence.at(-1)!.id,note:'Receiver cannot grant clinical approval'},true)).toThrow();
 });
 it('does not allow the patient or coordinator to assert acknowledgement',()=>{
  const e=readyEpisode();e.acknowledgedAt=null;
  expect(()=>apply(e,{...clinician,role:'coordinator'},{type:'acknowledge'})).toThrow();
  expect(()=>apply(e,{...patient,patientId:'other'},{type:'acknowledge'})).toThrow();
  expect(apply(e,patient,{type:'acknowledge'}).acknowledgedAt).toBe(now);
 });
 it.each(['<script>alert(1)</script>','<iframe src="https://evil.invalid"></iframe>','javascript:steal()','binary\u0000payload'])('rejects executable evidence content: %s',content=>{
  expect(()=>apply(readyEpisode(),clinician,{type:'add_evidence',title:'Synthetic unsafe upload',evidenceKind:'encounter_note',content})).toThrow();
 });
 it('revoked optional consent prevents email but preserves secure portal access',()=>{
  const e=readyEpisode();
  expect(()=>apply(e,clinician,{type:'send_message',channel:'email'})).toThrow();
  const result=apply(e,clinician,{type:'send_message',channel:'portal'});
  expect(result.communications.at(-1)?.status).toBe('QUEUED');
  expect(result.communications.at(-1)?.content).not.toContain('diabetes');
 });
 it('restricts escalation/correction to internal worker authority and rejects stale writes',()=>{
  const e=readyEpisode();
  expect(()=>apply(e,clinician,{type:'mark_overdue'})).toThrow();
  expect(()=>apply(e,clinician,{type:'correct_result',content:'Untrusted source correction'})).toThrow();
  expect(()=>transition(e,clinician,{type:'close',expectedVersion:9,note:'Complete clinician attestation'},{now,shared:false})).toThrow();
 });
 it('failed ownership transfer retains the previous accountable owner',()=>{
  const e=readyEpisode();e.ownershipTransfer={requestedBy:clinician.id,targetUserId:'coordinator-next',targetName:'New owner',status:'PENDING',reason:'Request explicit handoff acceptance'};
  const result=apply(e,{...clinician,id:'coordinator-next',role:'coordinator'},{type:'reject_transfer',note:'Unable to accept this workload'});
  expect(result.ownerId).toBe(e.ownerId);expect(result.ownershipTransfer?.status).toBe('REJECTED');
  expect(result.tasks.some(task=>task.type==='transfer_rejected'&&task.status==='OPEN')).toBe(true);
 });
 it('requires explicit clinician closure even when every prerequisite exists',()=>{
  const e=readyEpisode();expect(closureGaps(e)).toEqual([]);expect(e.phase).not.toBe('CLOSED');
  const result=apply(e,clinician,{type:'close',note:'Reviewed all synthetic evidence and approve closure.'});
  expect(result.phase).toBe('CLOSED');expect(result.closure?.clinicianId).toBe(clinician.id);
 });
});
