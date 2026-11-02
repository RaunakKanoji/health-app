import type { AssistantResponse, Episode, Policy } from '../../contracts/src/careloop.ts';
import { closureGaps } from '../../domain/src/index.ts';
/** No model or untrusted text may execute commands; this adapter only retrieves and drafts. */
export function summarizeEpisode(episode:Episode,policy:Policy,question:string):AssistantResponse {
 const q=question.toLowerCase();let answer:string;let proposedAction:string|null=null;
 const open=episode.tasks.filter(t=>t.status==='OPEN');const gaps=closureGaps(episode);
 if(/diagnos|prescrib|treatment|urgent|urgency|close.*case|approve/.test(q))answer='I can summarize records and draft administrative actions. Clinical interpretation, urgency, referrals and closure require an authorized clinician. The recorded urgency is '+episode.urgency+'.';
 else if(/accountab|owner|responsib/.test(q))answer=episode.ownerName?`${episode.ownerName} is the accountable owner. ${episode.ownershipTransfer?.status==='PENDING'?'A transfer is pending; current ownership remains unchanged.':''}`:'No accountable owner is assigned. The unassigned escalation task requires staff attention.';
 else if(/evidence|closure|close/.test(q))answer=gaps.length?`Closure is blocked by: ${gaps.join('; ')}. Policy ${policy.id} ${policy.version} requires a clinician attestation after these facts are verified.`:'The recorded prerequisites are present. An authorized clinician must review the evidence and sign closure.';
 else if(/referral/.test(q))answer=episode.referrals.length?episode.referrals.map(r=>`${r.receivingOrganizationName}: ${r.status.toLowerCase()}${r.status==='REJECTED'?`; reason: ${r.reason}`:''}.`).join(' '):'No referral is recorded. A clinician must authorize a referral after review and acknowledgement.';
 else if(/remind|message|draft/.test(q)){answer='Draft neutral reminder: “You have an update in your secure CareLoop portal. Please sign in to review it.” This is an unsent draft. Optional channel consent must be checked at dispatch.';proposedAction='Prepare a consent-aware portal reminder for staff review.';}
 else if(/next|due|delay|blocked/.test(q))answer=`This episode is ${episode.status.toLowerCase()}. ${open.length?`Pending work: ${open.map(t=>t.title).join('; ')}.`:'There are no open tasks.'} ${episode.dueAt?`The clinician-assigned deadline is ${episode.dueAt}.`:'A clinician has not yet assigned a deadline.'} ${episode.ownerName?`Accountable owner: ${episode.ownerName}.`:'Ownership is unassigned and escalated.'}`;
 else answer=`${episode.title} is in ${episode.phase.toLowerCase().replaceAll('_',' ')} (${episode.status.toLowerCase()}). ${episode.review?'Clinical review is recorded.':'Clinical review is still required.'} ${episode.acknowledgedAt?'The patient explicitly acknowledged the result.':'Patient acknowledgement is not recorded.'} ${episode.referrals.length} referral(s), ${episode.appointments.filter(a=>a.status==='COMPLETED').length} completed encounter(s), and ${episode.evidence.filter(e=>e.verifiedBy).length} verified evidence item(s) are recorded. ${gaps.length?`Closure still requires: ${gaps.join(', ')}.`:'Closure prerequisites are present; clinician attestation remains required unless already closed.'}`;
 return {mode:'deterministic-fallback',answer,citations:[{label:`Episode ${episode.id} · version ${episode.version}`,reference:`/episodes/${episode.id}`},{label:`${policy.title} · ${policy.version}`,reference:`policy:${policy.id}:${policy.version}`},...episode.events.slice(-3).map(e=>({label:`${e.type} · ${e.at}`,reference:`event:${e.id}`}))],proposedAction,clinicalActionsAllowed:false};
}
export const assistantTools = ['getCareEpisode','getEpisodeTimeline','getReferralStatus','getApplicablePolicy','getPendingTasks','getClosureRequirements','draftPatientCommunication','proposeAdministrativeAction'] as const;

/** The loader performs authorization on every read; tools expose no mutation capability. */
export function createAssistantTools(loadEpisode:()=>Promise<Episode>,policy:Policy){
 return {
  getCareEpisode:async()=>{const e=await loadEpisode();return {id:e.id,phase:e.phase,status:e.status,ownerName:e.ownerName,version:e.version};},
  getEpisodeTimeline:async()=>(await loadEpisode()).events,
  getReferralStatus:async()=>(await loadEpisode()).referrals,
  getApplicablePolicy:async()=>{await loadEpisode();return policy;},
  getPendingTasks:async()=>(await loadEpisode()).tasks.filter(t=>t.status==='OPEN'),
  getClosureRequirements:async()=>closureGaps(await loadEpisode()),
  draftPatientCommunication:async()=>{const e=await loadEpisode();return {episodeId:e.id,language:e.patient.language,draft:true,content:e.patient.language==='ar'?'لديك تحديث في بوابة CareLoop الآمنة. يرجى تسجيل الدخول لمراجعته.':'You have an update in your secure CareLoop portal. Please sign in to review it.',canSend:false};},
  proposeAdministrativeAction:async()=>{const e=await loadEpisode();return {episodeId:e.id,proposal:e.tasks.find(t=>t.status==='OPEN')?.title??'No pending administrative task',requiresHumanApproval:true,executed:false};},
 };
}
