import { randomBytes, scryptSync } from 'node:crypto';
import type { User, Role } from '../../contracts/src/careloop.ts';
import type { AccountStatus, ClinicianStatus } from '../../contracts/src/identity.ts';

/** Legacy synthetic-fixture compatibility only. No runtime password login accepts this hash. */
export function hashPassword(password:string):string { const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(password,salt,64).toString('hex')}`; }
export type UserRow={
  id:string; organization_id:string; email:string; name:string; role:Role; patient_id:string|null;
  password_hash?:string|null; clerk_user_id?:string|null; account_status?:AccountStatus;
  onboarding_completed?:boolean; clinician_status?:ClinicianStatus|null; created_at?:string|Date;
};
export const publicUser=(u:UserRow):User=>({
  id:u.id,organizationId:u.organization_id,email:u.email,name:u.name,role:u.role,patientId:u.patient_id,
  clerkUserId:u.clerk_user_id??null, accountStatus:u.account_status??'active',
  onboardingCompleted:u.onboarding_completed??true, clinicianStatus:u.clinician_status??null,
});
