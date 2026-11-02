import { randomUUID } from 'node:crypto';
import type { Command, Episode, Policy, User } from '../../contracts/src/careloop.ts';

export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
function requireValue(condition: unknown, message: string, code = 'PRECONDITION_FAILED'): asserts condition { if (!condition) throw new DomainError(code, message, code === 'FORBIDDEN' ? 403 : 409); }
export { requireValue };
export const policies: Policy[] = (['diabetes', 'colorectal', 'hypertension'] as const).map(pathway => ({
  id: `policy-${pathway}`, version: 'demo-1.0', pathway,
  title: `${pathway[0]!.toUpperCase()}${pathway.slice(1)} screening follow-up`,
  description: 'Synthetic coordination policy. A clinician must interpret the source result, approve patient wording, select urgency and a deadline. No diagnostic thresholds are applied by this software.',
  approvalStatus: 'DEMO_APPROVED', effectiveDate: '2026-01-01', approvingRole: 'clinician', requiresClinicalReview: true,
  closureRequirements: ['Patient acknowledgement', 'Accepted referral', 'Completed encounter', 'Clinician-verified encounter note', 'Clinician-verified follow-up report', 'Clinician closure attestation'],
  sourceReferences: ['https://hl7.org/fhir/R4/diagnosticreport.html','https://www.healthit.gov/topic/safety/safer-guides'],
  permittedActions: ['Human clinical review','Consent-aware neutral outreach','Human-authorized referral','Evidence collection','Clinician-approved closure'],
  escalationConditions: ['Clinician-assigned due date has elapsed','No accountable owner','Referral rejected','Delivery failed','Appointment not attended','Required evidence unavailable'],
}));

export function canReadEpisode(actor: User, episode: Episode, shared: boolean): boolean {
  if (actor.accountStatus !== undefined && actor.accountStatus !== 'active') return false;
  if (actor.onboardingCompleted === false) return false;
  if (actor.role === 'patient') return actor.organizationId === episode.organizationId && actor.patientId === episode.patient.id;
  if (actor.role === 'receiver') return shared && episode.referrals.some(r => r.receivingOrganizationId === actor.organizationId);
  if (actor.role === 'admin') return shared && actor.organizationId === episode.organizationId;
  if (actor.role === 'clinician' && actor.clinicianStatus !== undefined && actor.clinicianStatus !== 'approved') return false;
  return shared && actor.organizationId === episode.organizationId && ['clinician','coordinator'].includes(actor.role);
}
export { closureGaps } from './closure.ts';
import { closureGaps } from './closure.ts';
export type TransitionContext = { now: string; targetUser?: User; receivingOrganizationName?: string; shared: boolean; worker?: boolean };
export function transition(current: Episode, actor: User, command: Command, context: TransitionContext): Episode {
  requireValue((context.worker === true && command.type === 'mark_overdue' && actor.role === 'admin' && actor.organizationId === current.organizationId) || canReadEpisode(actor,current,context.shared), 'This record is unavailable.', 'FORBIDDEN');
  requireValue(current.version === command.expectedVersion, 'This episode changed. Refresh before retrying.', 'VERSION_CONFLICT');
  const e = structuredClone(current);
  const ownStaff = actor.organizationId===e.organizationId && ['clinician','coordinator'].includes(actor.role);
  const clinician = actor.organizationId===e.organizationId && actor.role==='clinician';
  const receiver = actor.role==='receiver' && context.shared;
  const patient = actor.role==='patient' && actor.patientId===e.patient.id;
  const need = (value: unknown, message: string) => requireValue(value,message);
  const allowed = (value: unknown) => requireValue(value,'Your role cannot perform this action.','FORBIDDEN');
  const note = command.note?.trim() ?? '';
  const addTask = (type: string,title: string) => { if (!e.tasks.some(t=>t.type===type&&t.status==='OPEN')) e.tasks.push({id:randomUUID(),type,title,status:'OPEN',dueAt:e.dueAt}); };
  const done = (type: string) => e.tasks.filter(t=>t.type===type).forEach(t=>{t.status='DONE';});
  const active = () => need(e.phase!=='CLOSED','Reopen this episode before changing its workflow.');
  let detail = note;
  if (!['reopen','update_consent','correct_result'].includes(command.type)) active();
  switch(command.type) {
    case 'review':
      allowed(clinician); need(['RESULT_RECEIVED','CLINICAL_REVIEW'].includes(e.phase),'Result is already reviewed.');
      need(note.length>=10,'Record a clinical review note (at least 10 characters).');
      need(command.patientExplanation && command.patientExplanation.length>=10,'Approve a plain-language patient explanation.');
      need(command.dueAt && command.urgency,'A clinician must explicitly set urgency and a follow-up deadline.');
      need(Date.parse(command.dueAt!)>Date.parse(context.now),'Choose a future follow-up deadline.');
      e.review={clinicianId:actor.id, reviewedAt:context.now,note,patientExplanation:command.patientExplanation!,policyVersion:'demo-1.0'};
      e.dueAt=command.dueAt!; e.urgency=command.urgency!; e.phase='PATIENT_CONTACT'; e.status='ACTIVE';
      done('clinical_review'); addTask('patient_contact','Send approved portal message and obtain acknowledgement'); break;
    case 'send_message': {
      allowed(ownStaff); need(e.review,'Clinical review must approve patient-facing content first.');
      const channel=command.channel ?? 'portal';
      need(channel==='portal'||e.patient.communicationConsent,'Optional communication consent is revoked.');
      e.communications.push({id:randomUUID(),channel,content:e.patient.language==='ar'?'لديك تحديث في بوابة CareLoop الآمنة. يرجى تسجيل الدخول لمراجعته.':'You have an update in your secure CareLoop portal. Please sign in to review it.',status:'QUEUED',attempts:0,createdAt:context.now,deliveredAt:null});
      detail=`Neutral ${channel} reminder queued in simulated inbox.`;break;
    }
    case 'acknowledge':
      allowed(patient); need(e.review,'The result is awaiting clinical review.'); need(e.communications.some(c=>c.status==='DELIVERED'),'A delivered portal communication is required before acknowledgement.');
      need(!e.acknowledgedAt,'This result is already acknowledged.'); e.acknowledgedAt=context.now; e.phase='CARE_COORDINATION'; done('patient_contact'); addTask('referral','Clinician to authorize referral'); detail='Patient explicitly acknowledged the result.';break;
    case 'create_referral':
      allowed(clinician); need(e.review&&e.acknowledgedAt,'Review and patient acknowledgement are required.'); need(command.receivingOrganizationId&&context.receivingOrganizationName,'Select a receiving organization.');
      need(command.receivingOrganizationId!==e.organizationId,'Select a different receiving provider.'); need(note.length>=5,'Record the referral reason.');
      need(!e.referrals.some(r=>r.status!=='REJECTED'&&r.resultRevision===e.result.revision),'An active referral already exists.');
      e.referrals.push({id:randomUUID(),resultRevision:e.result.revision,receivingOrganizationId:command.receivingOrganizationId!,receivingOrganizationName:context.receivingOrganizationName!,status:'REQUESTED',reason:note,createdAt:context.now,respondedAt:null});
      e.phase='CARE_COORDINATION';e.status='ACTIVE'; done('referral');done('referral_rejected');addTask('referral_response','Receiving provider to accept referral');break;
    case 'accept_referral': case 'reject_referral': {
      allowed(receiver); const r=e.referrals.find(r=>r.id===command.referralId); need(r,'Referral not found.'); need(r!.receivingOrganizationId===actor.organizationId,'Only the receiving organization can respond.'); need(r!.status==='REQUESTED'&&r!.resultRevision===e.result.revision,'Referral already responded or belongs to a superseded result.');
      if(command.type==='reject_referral') need(note.length>=5,'Give a rejection reason.');
      r!.status=command.type==='accept_referral'?'ACCEPTED':'REJECTED'; r!.respondedAt=context.now; if(note)r!.reason=note;done('referral_response');
      if(r!.status==='REJECTED'){e.status='BLOCKED';addTask('referral_rejected','Referral rejected: accountable owner must arrange another route');}else{e.status='ACTIVE';addTask('appointment','Arrange an appointment with the receiving provider');} break;
    }
    case 'schedule_appointment': {
      allowed(ownStaff||receiver); const r=e.referrals.find(r=>r.id===command.referralId);need(r?.status==='ACCEPTED'&&r.resultRevision===e.result.revision,'An accepted referral for the current result is required.'); if(receiver)need(r!.receivingOrganizationId===actor.organizationId,'Referral belongs to another provider.');
      need(command.scheduledAt&&command.location,'Provide appointment time and location.');
      need(!e.appointments.some(a=>a.referralId===r!.id&&a.status==='SCHEDULED'),'An appointment is already scheduled.');
      e.appointments.push({id:randomUUID(),resultRevision:e.result.revision,referralId:r!.id,scheduledAt:command.scheduledAt!,location:command.location!,status:'SCHEDULED',completedAt:null});done('appointment');done('no_show');addTask('encounter','Record the actual encounter outcome');e.status='ACTIVE';break;
    }
    case 'complete_appointment': case 'no_show': {
      allowed(clinician||receiver||ownStaff&&command.type==='no_show');const a=e.appointments.find(a=>a.id===command.appointmentId);need(a?.status==='SCHEDULED'&&a.resultRevision===e.result.revision,'Select a scheduled appointment for the current result.');
      if(receiver)need(e.referrals.find(r=>r.id===a!.referralId)?.receivingOrganizationId===actor.organizationId,'Appointment belongs to another provider.');
      need(Date.parse(a!.scheduledAt)<=Date.parse(context.now),'An encounter cannot be recorded before its scheduled time.');need(note.length>=5,'Document the encounter outcome.');
      a!.status=command.type==='complete_appointment'?'COMPLETED':'NO_SHOW';a!.completedAt=command.type==='complete_appointment'?context.now:null;done('encounter');
      if(command.type==='no_show'){e.status='BLOCKED';addTask('no_show','Contact patient and arrange another appointment');}else{e.phase='OUTCOME_VERIFICATION';e.status='ACTIVE';addTask('evidence','Collect and clinically verify follow-up evidence');}break;
    }
    case 'add_evidence': {
      allowed(ownStaff||receiver);
      const appointment=e.appointments.find(a=>a.status==='COMPLETED'&&a.resultRevision===e.result.revision&&(!command.appointmentId||a.id===command.appointmentId)&&(!receiver||e.referrals.some(r=>r.id===a.referralId&&r.status==='ACCEPTED'&&r.receivingOrganizationId===actor.organizationId)));
      need(appointment,'Select an actual completed encounter for this result and an authorized receiving provider before attaching closure evidence.');
      need(command.title&&command.content&&command.evidenceKind,'Provide evidence type, title and document text.');need(command.content!.length>=10,'Evidence must contain at least 10 characters.');
      // Reject binary control bytes from the plain-text document adapter.
      // eslint-disable-next-line no-control-regex
      need(!/[\x00-\x08]|<script|<iframe|javascript:/i.test(command.content!),'Executable or binary content is not accepted.');
      e.evidence.push({id:randomUUID(),appointmentId:appointment!.id,resultRevision:e.result.revision,kind:command.evidenceKind!,title:command.title!,content:command.content!,submittedBy:actor.id,createdAt:context.now,verifiedBy:null,verifiedAt:null});e.phase='OUTCOME_VERIFICATION';break;
    }
    case 'verify_evidence': {
      allowed(clinician);const evidence=e.evidence.find(v=>v.id===command.evidenceId);need(evidence,'Evidence not found.');need(evidence!.resultRevision===e.result.revision,'Evidence belongs to a superseded result.');need(!evidence!.verifiedBy,'Evidence already verified.');need(note.length>=5,'Record a clinical verification note.');evidence!.verifiedBy=actor.id;evidence!.verifiedAt=context.now;
      if(closureGaps(e).length===0){done('evidence');addTask('closure_review','Clinician to review evidence and approve closure');}break;
    }
    case 'close':
      allowed(clinician); need(e.phase==='OUTCOME_VERIFICATION','The episode must be in outcome verification.'); need(closureGaps(e).length===0,`Closure requires: ${closureGaps(e).join(', ')}.`);need(note.length>=10,'Provide a closure attestation (at least 10 characters).');
      e.closure={clinicianId:actor.id,at:context.now,note,evidenceIds:e.evidence.filter(v=>v.verifiedBy).map(v=>v.id),policyVersion:'demo-1.0'};e.phase='CLOSED';e.status='CLOSED';e.tasks.forEach(t=>{t.status='DONE';});break;
    case 'reopen':
      allowed(clinician);need(e.phase==='CLOSED','Only a closed episode can be reopened.');need(note.length>=10,'Document the reason for reopening.'); e.phase='CLINICAL_REVIEW';e.status='REOPENED';e.closure=null;e.review=null;e.evidence.forEach(v=>{v.verifiedBy=null;v.verifiedAt=null;});addTask('clinical_review','Reassess new information after reopening');break;
    case 'request_transfer':
      allowed(ownStaff);need(!e.ownershipTransfer||e.ownershipTransfer.status!=='PENDING','An ownership transfer is already pending.');need(context.targetUser&&context.targetUser.organizationId===e.organizationId&&['coordinator','clinician'].includes(context.targetUser.role),'Select an eligible accountable owner from this organization.');
      need(context.targetUser!.id!==e.ownerId,'This user already owns the episode.');need(note.length>=5,'Record the reason for transfer.');
      e.ownershipTransfer={requestedBy:actor.id,targetUserId:context.targetUser!.id,targetName:context.targetUser!.name,status:'PENDING',reason:note};addTask('ownership_transfer','Proposed owner must explicitly accept responsibility');break;
    case 'accept_transfer':case 'reject_transfer':
      allowed(ownStaff);need(e.ownershipTransfer?.status==='PENDING'&&e.ownershipTransfer.targetUserId===actor.id,'Only the proposed owner may respond.');
      if(command.type==='accept_transfer'){e.ownerId=actor.id;e.ownerName=actor.name;e.ownershipTransfer!.status='ACCEPTED';done('unassigned');}else{need(note.length>=5,'Give a reason for rejecting the transfer.');e.ownershipTransfer!.status='REJECTED';e.ownershipTransfer!.reason=note;addTask('transfer_rejected','Ownership transfer declined; current owner remains accountable');}done('ownership_transfer');break;
    case 'request_help':
      allowed(patient);need(note.length>=5,'Tell your care team what help you need.');addTask('patient_help','Patient requested support: review the episode timeline');break;
    case 'update_consent':
      allowed(patient);need(typeof command.consent==='boolean','Specify optional communication consent.');e.patient.communicationConsent=command.consent!;if(command.language)e.patient.language=command.language;detail=`Optional email/SMS consent ${command.consent?'granted':'revoked'}.`;
      if(!command.consent)e.communications.filter(c=>c.status==='QUEUED'&&c.channel!=='portal').forEach(c=>{c.status='CANCELLED';});break;
    case 'mark_overdue':
      allowed(context.worker&&actor.role==='admin'&&actor.organizationId===e.organizationId);need(e.dueAt&&Date.parse(e.dueAt)<Date.parse(context.now),'The clinician-assigned deadline has not elapsed.');need(e.status!=='OVERDUE','This episode is already overdue.');e.status='OVERDUE';addTask('overdue','Clinician-assigned deadline elapsed; accountable owner must review');detail='Overdue escalation; clinical urgency unchanged.';break;
    case 'block':allowed(ownStaff);need(note.length>=5,'Record the barrier requiring intervention.');e.status='BLOCKED';addTask('barrier','Resolve documented care coordination barrier');break;
    case 'correct_result':
      allowed(context.worker&&ownStaff);need(command.content,'A corrected source result is required.'); e.result.summary=command.content!;e.result.status='corrected';e.result.revision++;e.review=null;e.closure=null;e.phase='CLINICAL_REVIEW';e.status='REOPENED';e.acknowledgedAt=null;e.evidence.forEach(v=>{v.verifiedBy=null;v.verifiedAt=null;});addTask('clinical_review','Review corrected source result; previous approval is superseded');break;
  }
  if(!e.ownerId&&e.phase!=='CLOSED')addTask('unassigned','Unassigned escalation: appoint an accountable owner');
  e.version++;e.updatedAt=context.now;
  e.events.push({id:randomUUID(),type:command.type,at:context.now,actorId:actor.id,actorName:actor.name,detail:detail||command.type.replaceAll('_',' '),version:e.version});
  return e;
}
