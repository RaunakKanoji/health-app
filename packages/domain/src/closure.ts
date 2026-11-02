import type { Episode } from '../../contracts/src/careloop.ts';
export function closureGaps(episode: Episode): string[] {
  const gaps: string[] = [];
  if (!episode.review) gaps.push('Clinical review');
  if (!episode.acknowledgedAt) gaps.push('Patient acknowledgement');
  if (!episode.referrals.some(r=>r.status==='ACCEPTED'&&r.resultRevision===episode.result.revision)) gaps.push('Accepted referral');
  if (!episode.appointments.some(a=>a.status==='COMPLETED'&&a.resultRevision===episode.result.revision)) gaps.push('Completed encounter');
  for (const kind of ['encounter_note','followup_report']) if (!episode.evidence.some(e=>e.kind===kind && e.verifiedBy && e.resultRevision===episode.result.revision && episode.appointments.some(a=>a.id===e.appointmentId&&a.status==='COMPLETED'&&a.resultRevision===episode.result.revision))) gaps.push(`Clinician-verified ${kind.replaceAll('_',' ')}`);
  return gaps;
}
