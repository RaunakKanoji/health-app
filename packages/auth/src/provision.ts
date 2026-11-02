import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/src/index.ts';
import { DomainError } from '../../domain/src/index.ts';
import type { VerifiedIdentity } from './clerk.ts';
import type { UserRow } from './index.ts';

export type MissingClerkUser = Readonly<{clerkUserId:string;verifiedAt:number}>;
const confirmedMissingUsers=new WeakSet<MissingClerkUser>();

/** Only a trusted local Clerk Backend API lookup can issue in-process recovery evidence. */
export async function verifyMissingClerkUser(clerkUserId:string,getUser:(id:string)=>Promise<unknown>):Promise<MissingClerkUser>{
  if(!/^user_[A-Za-z0-9_-]+$/.test(clerkUserId))throw new DomainError('INVALID_IDENTITY','An exact former Clerk user ID is required.',422);
  try {await getUser(clerkUserId);}
  catch(error){
    if(typeof error==='object'&&error!==null&&'status' in error&&error.status===404){
      const proof=Object.freeze({clerkUserId,verifiedAt:Date.now()});confirmedMissingUsers.add(proof);return proof;
    }
    throw new DomainError('IDENTITY_LOOKUP_UNAVAILABLE','The former Clerk identity could not be checked. No mapping was changed.',503);
  }
  throw new DomainError('IDENTITY_STILL_EXISTS','The former Clerk identity still exists. Recovery cannot replace it.',409);
}

type ProvisionInput={
  userId:string;identity:Omit<VerifiedIdentity,'sessionId'>;administrator:boolean;apply:boolean;
  replacement?:{expectedClerkUserId:string;absence:MissingClerkUser};
};

/** Trusted local operation. Never register this function or its recovery proof helper as an HTTP route. */
export async function provisionClerkIdentity(db:Db,input:ProvisionInput){
  const {identity,replacement}=input;
  if(!identity.clerkUserId.startsWith('user_')||!identity.emailVerified)throw new DomainError('UNVERIFIED_IDENTITY','A verified Clerk identity is required.',403);
  if(replacement){
    if(input.administrator)throw new DomainError('ROLE_CONFLICT','Identity recovery cannot assign or promote administrator access.',409);
    if(!confirmedMissingUsers.has(replacement.absence)||replacement.absence.clerkUserId!==replacement.expectedClerkUserId)throw new DomainError('IDENTITY_ABSENCE_UNVERIFIED','Recovery requires a successful trusted check that the exact former Clerk identity is missing.',409);
    if(replacement.expectedClerkUserId===identity.clerkUserId)throw new DomainError('IDENTITY_REPLACEMENT_MISMATCH','The replacement Clerk identity must differ from the former identity.',409);
  }
  return db.transaction(async tx=>{
    const clerkIds=[identity.clerkUserId,...replacement?[replacement.expectedClerkUserId]:[]].sort();
    for(const id of clerkIds)await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`clerk:${id}`]);
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`identity-email:${identity.email.toLowerCase()}`]);
    const target=(await tx.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE',[input.userId])).rows[0];
    if(!target)throw new DomainError('NOT_FOUND','The explicit local user ID does not exist.',404);
    if(target.account_status!=='active')throw new DomainError('ACCOUNT_DISABLED','Disabled identities cannot be provisioned.',409);
    if(replacement){
      if(target.clerk_user_id!==replacement.expectedClerkUserId)throw new DomainError('IDENTITY_REPLACEMENT_MISMATCH','The local account is not mapped to the exact former Clerk identity.',409);
      if(target.role!=='patient'||!target.patient_id||!target.onboarding_completed)throw new DomainError('IDENTITY_RECOVERY_ROLE','Recovery is limited to active, onboarded patient accounts.',409);
      if(target.email.toLowerCase()!==identity.email.toLowerCase())throw new DomainError('IDENTITY_RECOVERY_EMAIL','The new verified primary email must exactly match the existing account email.',409);
      if((await tx.query("SELECT id FROM role_assignments WHERE user_id=$1 AND role<>'patient'",[target.id])).rowCount)throw new DomainError('IDENTITY_RECOVERY_ROLE','An account with privileged role assignments cannot use patient identity recovery.',409);
    }else if(target.clerk_user_id&&target.clerk_user_id!==identity.clerkUserId){
      throw new DomainError('IDENTITY_ALREADY_LINKED','The local user already has a different Clerk identity.',409);
    }
    const collision=await tx.query('SELECT id FROM users WHERE id<>$1 AND (clerk_user_id=$2 OR lower(email)=lower($3))',[target.id,identity.clerkUserId,identity.email]);
    if(collision.rowCount)throw new DomainError('IDENTITY_CONFLICT','The Clerk identity or verified email is already attached to another local account. Automatic merging is not allowed.',409);
    if((await tx.query('SELECT clerk_user_id FROM clerk_identity_tombstones WHERE clerk_user_id=$1',[identity.clerkUserId])).rowCount)throw new DomainError('IDENTITY_DELETED','This Clerk identity was deleted.',409);
    if(input.administrator&&target.patient_id)throw new DomainError('ROLE_CONFLICT','A patient identity cannot be promoted to administrator.',409);
    const role=input.administrator?'admin':target.role;
    if(input.apply){
      if(replacement){
        await tx.query('INSERT INTO clerk_identity_tombstones(clerk_user_id,deleted_at) VALUES($1,$2) ON CONFLICT(clerk_user_id) DO UPDATE SET deleted_at=GREATEST(clerk_identity_tombstones.deleted_at,excluded.deleted_at)',[replacement.expectedClerkUserId,replacement.absence.verifiedAt]);
        // Recovery changes only the external identity mapping. Keep the local patient and authorization state.
        await tx.query('UPDATE users SET clerk_user_id=$1,clerk_updated_at=$2,password_hash=NULL,updated_at=now() WHERE id=$3',[identity.clerkUserId,identity.updatedAt,target.id]);
      }else{
        await tx.query('UPDATE users SET clerk_user_id=$1,email=$2,name=$3,clerk_updated_at=$4,password_hash=NULL,role=$5,onboarding_completed=CASE WHEN $5=\'admin\' THEN true ELSE onboarding_completed END,updated_at=now() WHERE id=$6',[identity.clerkUserId,identity.email.toLowerCase(),identity.name,identity.updatedAt,role,target.id]);
      }
      if(input.administrator){
        await tx.query('DELETE FROM role_assignments WHERE user_id=$1',[target.id]);
        await tx.query("INSERT INTO role_assignments(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')",[randomUUID(),target.organization_id,target.id]);
        await tx.query("UPDATE clinician_patient_relationships SET relationship_status='revoked',revoked_at=now(),updated_at=now() WHERE clinician_id=$1 AND relationship_status='active'",[target.id]);
      }
      await tx.query('INSERT INTO audit_events(id,organization_id,actor_id,action,request_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),target.organization_id,target.id,replacement?'identity.recovered':'identity.provisioned',randomUUID(),JSON.stringify({subjectUserId:target.id,role,trustedLocalCommand:true,existingClinicalRecordsRetained:true,...replacement?{previousClerkUserId:replacement.expectedClerkUserId,clerkUserId:identity.clerkUserId,oldIdentityConfirmedMissing:true}:{}})]);
    }
    return {applied:input.apply,userId:target.id,clerkUserId:identity.clerkUserId,role,existingClinicalRecordsRetained:true,...replacement?{replacedClerkUserId:replacement.expectedClerkUserId,patientId:target.patient_id,onboardingCompleted:target.onboarding_completed,accountStatus:target.account_status}:{}};
  });
}
