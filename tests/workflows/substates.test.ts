import { describe,expect,it } from 'vitest';
import { transition } from '../../packages/domain/src/index.ts';
import type { Command,Episode,User } from '../../packages/contracts/src/careloop.ts';
const now='2026-10-27T12:00:00Z';
const clinician:User={id:'clinician',name:'Synthetic clinician',email:'c@example.invalid',role:'clinician',organizationId:'org',patientId:null};
const coordinator:User={...clinician,id:'coordinator',role:'coordinator'};
const patient:User={...clinician,id:'patient-user',role:'patient',patientId:'patient'};
const receiver:User={...clinician,id:'receiver',role:'receiver',organizationId:'receiver-org'};
const target:User={...coordinator,id:'next-owner',name:'Next owner'};
function reviewed():Episode{return {id:'episode',organizationId:'org',patient:{id:'patient',name:'Synthetic Patient',birthDate:'1970-01-01',language:'en',synthetic:true,communicationConsent:true},pathway:'diabetes',title:'Follow-up',phase:'PATIENT_CONTACT',status:'ACTIVE',version:2,ownerId:coordinator.id,ownerName:coordinator.name,createdAt:now,updatedAt:now,dueAt:null,urgency:'ROUTINE',result:{id:'result',summary:'Synthetic source flag',sourceId:'source',issuedAt:now,status:'final',revision:1},review:{clinicianId:clinician.id,reviewedAt:now,note:'Reviewed synthetic result',patientExplanation:'Please follow up with your care team.',policyVersion:'demo-1.0'},acknowledgedAt:null,referrals:[],appointments:[],communications:[],evidence:[],tasks:[],events:[],closure:null,ownershipTransfer:null};}
function apply(e:Episode,actor:User,command:Omit<Command,'expectedVersion'>){return transition(e,actor,{...command,expectedVersion:e.version},{now,shared:actor.role==='receiver',targetUser:target,receivingOrganizationName:'Receiving organization'});}
function referred(){const e=reviewed();e.acknowledgedAt=now;e.phase='CARE_COORDINATION';return apply(e,clinician,{type:'create_referral',receivingOrganizationId:receiver.organizationId,note:'Clinician approves the synthetic referral.'});}
function accepted(){const e=referred();return apply(e,receiver,{type:'accept_referral',referralId:e.referrals[0]!.id});}
describe('separate workflow lifecycle edge cases',()=>{
 it('cannot replace a pending ownership recipient or accept a resolved transfer twice',()=>{
  const requested=apply(reviewed(),coordinator,{type:'request_transfer',targetUserId:target.id,note:'Request explicit accepted handoff.'});
  expect(()=>apply(requested,coordinator,{type:'request_transfer',targetUserId:clinician.id,note:'Overwrite still pending recipient.'})).toThrow('already pending');
  const transferred=apply(requested,target,{type:'accept_transfer'});
  const before=structuredClone(transferred);
  expect(()=>apply(transferred,target,{type:'accept_transfer'})).toThrow();
  expect(transferred).toEqual(before);expect(transferred.events.filter(e=>e.type==='accept_transfer')).toHaveLength(1);
 });
 it('cannot reverse an already accepted referral by responding again with a fresh episode version',()=>{
  const e=accepted();const before=structuredClone(e);
  expect(()=>apply(e,receiver,{type:'reject_referral',referralId:e.referrals[0]!.id,note:'Attempt to reverse the resolved response.'})).toThrow('already responded');
  expect(e).toEqual(before);expect(e.referrals[0]?.status).toBe('ACCEPTED');
 });
 it('prevents duplicate scheduled bookings and permits a new booking after a no-show',()=>{
  const schedule={type:'schedule_appointment' as const,scheduledAt:'2026-10-26T10:00:00Z',location:'Synthetic clinic'};
  let e=accepted();e=apply(e,coordinator,{...schedule,referralId:e.referrals[0]!.id});
  expect(()=>apply(e,coordinator,{...schedule,referralId:e.referrals[0]!.id})).toThrow('already scheduled');
  const missedId=e.appointments[0]!.id;e=apply(e,receiver,{type:'no_show',appointmentId:missedId,note:'Confirmed synthetic nonattendance.'});
  expect(()=>apply(e,receiver,{type:'complete_appointment',appointmentId:missedId,note:'Do not overwrite terminal no-show fact.'})).toThrow();
  e=apply(e,coordinator,{...schedule,referralId:e.referrals[0]!.id});
  expect(e.appointments).toHaveLength(2);expect(e.appointments[0]?.status).toBe('NO_SHOW');expect(e.appointments[1]?.status).toBe('SCHEDULED');
  expect(e.tasks.find(t=>t.type==='no_show')?.status).toBe('DONE');expect(e.closure).toBeNull();
 });
 it('failed delivery remains distinct from a patient acknowledgement',()=>{
  const e=reviewed();e.communications=[{id:'failed',channel:'portal',content:'Neutral synthetic update',status:'FAILED',attempts:3,createdAt:now,deliveredAt:null}];
  expect(()=>apply(e,patient,{type:'acknowledge'})).toThrow('delivered');
  expect(e.acknowledgedAt).toBeNull();expect(e.phase).toBe('PATIENT_CONTACT');
 });
 it('revokes consent after clinical closure without reopening or changing the attestation',()=>{
  const e=reviewed();e.phase='CLOSED';e.status='CLOSED';e.closure={clinicianId:clinician.id,at:now,note:'Previously signed synthetic closure.',evidenceIds:['earlier-evidence'],policyVersion:'demo-1.0'};
  const result=apply(e,patient,{type:'update_consent',consent:false,language:'ar'});
  expect(result.patient.communicationConsent).toBe(false);expect(result.patient.language).toBe('ar');expect(result.phase).toBe('CLOSED');expect(result.closure).toEqual(e.closure);
  expect(()=>apply(result,coordinator,{type:'send_message',channel:'portal'})).toThrow('Reopen');
 });
});
