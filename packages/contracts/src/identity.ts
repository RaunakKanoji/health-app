import { z } from 'zod';
import type { User, Role } from './careloop.ts';

export type AccountStatus = 'active' | 'suspended' | 'deleted';
export type ClinicianStatus = 'pending' | 'approved' | 'rejected';
export type ClinicianProfile = {
  userId: string; name: string; email: string; professionalName: string;
  specialty: string; registrationIdentifier: string; institution: string;
  verificationStatus: ClinicianStatus; reviewReason: string | null;
  approvedAt: string | null; approvedBy: string | null; createdAt: string; updatedAt: string;
};
export type IdentityState = {
  user: User;
  onboarding: { kind: 'none' | 'patient' | 'clinician'; status: 'required' | 'complete' | 'pending' | 'rejected' };
  clinicianProfile: ClinicianProfile | null;
  destination: '/' | '/onboarding' | '/onboarding/clinician/pending' | '/admin';
};
export type AdminUser = User & { accountStatus: AccountStatus; onboardingCompleted: boolean; clerkUserId: string | null; createdAt: string };
export type CareRelationship = {
  id: string; clinicianId: string; clinicianName: string; patientId: string; patientName: string;
  relationshipStatus: 'active' | 'revoked'; authorizationBasis: string; authorizedAt: string; revokedAt: string | null;
};
export type RelationshipDirectory = {
  relationships: CareRelationship[];
  patients: { id: string; name: string }[];
  careTeam: { id: string; name: string; role: Role }[];
};
export type IdentityAuditEvent = { id: string; actorId: string; action: string; createdAt: string; metadata: Record<string, unknown> };

export const patientOnboardingSchema = z.object({
  name: z.string().trim().min(2).max(120), birthDate: z.string().date(),
  language: z.enum(['en', 'hi']), consent: z.boolean().default(false), privacyAcknowledged: z.literal(true),
}).strict();
export const clinicianOnboardingSchema = z.object({
  professionalName: z.string().trim().min(2).max(120), specialty: z.string().trim().min(2).max(120),
  registrationIdentifier: z.string().trim().min(2).max(120), institution: z.string().trim().max(160).default(''),
  privacyAcknowledged: z.literal(true),
}).strict();
export const clinicianReviewSchema = z.object({decision:z.enum(['approved','rejected']),reason:z.string().trim().min(5).max(500)}).strict();
export const accountStatusSchema = z.object({accountStatus:z.enum(['active','suspended'])}).strict();
export const roleChangeSchema = z.object({role:z.enum(['patient','clinician','coordinator','receiver'])}).strict();
export const relationshipSchema = z.object({clinicianId:z.string().min(1).max(200),patientId:z.string().min(1).max(200),authorizationBasis:z.string().trim().min(5).max(500)}).strict();
export type PatientOnboarding = z.infer<typeof patientOnboardingSchema>;
export type ClinicianOnboarding = z.infer<typeof clinicianOnboardingSchema>;
