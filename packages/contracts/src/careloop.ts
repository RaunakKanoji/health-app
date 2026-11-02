import { z } from 'zod';

export const roles = ['clinician', 'coordinator', 'patient', 'receiver', 'admin'] as const;
export type Role = typeof roles[number];
export type User = { id: string; name: string; email: string; role: Role; organizationId: string; patientId: string | null; clerkUserId?: string | null; accountStatus?: 'active' | 'suspended' | 'deleted'; onboardingCompleted?: boolean; clinicianStatus?: 'pending' | 'approved' | 'rejected' | null };
export type Organization = { id: string; name: string };
export const phases = ['RESULT_RECEIVED', 'CLINICAL_REVIEW', 'PATIENT_CONTACT', 'CARE_COORDINATION', 'OUTCOME_VERIFICATION', 'CLOSED'] as const;
export type Phase = typeof phases[number];
export type OperationalStatus = 'ACTIVE' | 'BLOCKED' | 'OVERDUE' | 'CLOSED' | 'REOPENED';
export type Pathway = 'diabetes' | 'colorectal' | 'hypertension';
export type Patient = { id: string; name: string; birthDate: string; language: 'en' | 'hi' | 'ar'; synthetic: true; communicationConsent: boolean };
export type EpisodeEvent = { id: string; type: string; at: string; actorId: string; actorName: string; detail: string; version: number };
export type Task = { id: string; type: string; title: string; status: 'OPEN' | 'DONE'; dueAt: string | null };
export type Referral = { id: string; resultRevision: number; receivingOrganizationId: string; receivingOrganizationName: string; status: 'REQUESTED' | 'ACCEPTED' | 'REJECTED'; reason: string; createdAt: string; respondedAt: string | null };
export type Appointment = { id: string; resultRevision: number; referralId: string; scheduledAt: string; location: string; status: 'SCHEDULED' | 'COMPLETED' | 'NO_SHOW'; completedAt: string | null };
export type Communication = { id: string; channel: 'portal' | 'email' | 'sms'; content: string; status: 'QUEUED' | 'DELIVERED' | 'FAILED' | 'CANCELLED'; attempts: number; createdAt: string; deliveredAt: string | null };
export type Evidence = { id: string; appointmentId: string; resultRevision: number; kind: 'encounter_note' | 'followup_report'; title: string; content: string; submittedBy: string; createdAt: string; verifiedBy: string | null; verifiedAt: string | null };
export type Policy = { id: string; version: string; pathway: Pathway; title: string; description: string; approvalStatus: 'DEMO_APPROVED'; effectiveDate: string; approvingRole: 'clinician'; requiresClinicalReview: true; closureRequirements: string[]; sourceReferences: string[]; permittedActions: string[]; escalationConditions: string[] };
export type Episode = {
  id: string; organizationId: string; patient: Patient; pathway: Pathway; title: string;
  phase: Phase; status: OperationalStatus; version: number; ownerId: string | null; ownerName: string | null;
  createdAt: string; updatedAt: string; dueAt: string | null; urgency: 'UNREVIEWED' | 'ROUTINE' | 'URGENT';
  result: { id: string; summary: string; sourceId: string; issuedAt: string; status: 'final' | 'amended' | 'corrected'; revision: number };
  review: { clinicianId: string; reviewedAt: string; note?: string; patientExplanation: string; policyVersion: string } | null;
  acknowledgedAt: string | null; referrals: Referral[]; appointments: Appointment[]; communications: Communication[];
  evidence: Evidence[]; tasks: Task[]; events: EpisodeEvent[];
  closure: { clinicianId: string; at: string; note?: string; evidenceIds: string[]; policyVersion: string } | null;
  ownershipTransfer: { requestedBy: string; targetUserId: string; targetName: string; status: 'PENDING' | 'ACCEPTED' | 'REJECTED'; reason: string } | null;
};
export const actionTypes = ['review','send_message','acknowledge','create_referral','accept_referral','reject_referral','schedule_appointment','complete_appointment','no_show','add_evidence','verify_evidence','close','reopen','request_transfer','accept_transfer','reject_transfer','request_help','update_consent','mark_overdue','block','correct_result'] as const;
export type ActionType = typeof actionTypes[number];
export const commandSchema = z.object({
  type: z.enum(actionTypes), expectedVersion: z.number().int().positive(),
  note: z.string().trim().max(4000).optional(), patientExplanation: z.string().trim().max(2000).optional(),
  dueAt: z.string().datetime({ offset: true }).optional(), urgency: z.enum(['ROUTINE','URGENT']).optional(),
  receivingOrganizationId: z.string().max(100).optional(), referralId: z.string().max(100).optional(),
  appointmentId: z.string().max(100).optional(), scheduledAt: z.string().datetime({ offset: true }).optional(), location: z.string().trim().max(250).optional(),
  evidenceId: z.string().max(100).optional(), evidenceKind: z.enum(['encounter_note','followup_report']).optional(),
  title: z.string().trim().max(200).optional(), content: z.string().trim().max(10000).optional(),
  targetUserId: z.string().max(100).optional(), consent: z.boolean().optional(), language: z.enum(['en','ar']).optional(),
  channel: z.enum(['portal','email','sms']).optional(), simulateFailure: z.boolean().optional(),
}).strict();
export type Command = z.infer<typeof commandSchema>;
export type Metric = { numerator: number; denominator: number; rate: number | null };
export type Metrics = { totalResults: number; activeEpisodes: number; overdueEpisodes: number; unassignedEpisodes: number; pendingReviews: number; acknowledgement: Metric; referralAcceptance: Metric; appointmentCompletion: Metric; verifiedClosure: Metric; pathways: { pathway: Pathway; total: number; closed: number; overdue: number }[]; timeToCareDays: number[]; delayedProviderTransitions: number; observationWindow: string; privacy: string };
export type Workspace = { user: User; organizations: Organization[]; users: User[]; policies: Policy[]; episodes: Episode[]; metrics: Metrics; simulated: true };
export type AssistantResponse = { mode: 'deterministic-fallback'; answer: string; citations: { label: string; reference: string }[]; proposedAction: string | null; clinicalActionsAllowed: false };
export type ApiError = { error: { code: string; message: string; requestId?: string } };
