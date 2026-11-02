import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Db, Transaction } from '../../db/src/index.ts';
import { DomainError } from '../../domain/src/index.ts';
import type { User, Role } from '../../contracts/src/careloop.ts';
import type { AdminUser, ClinicianProfile, IdentityState, PatientOnboarding, ClinicianOnboarding, CareRelationship, RelationshipDirectory, IdentityAuditEvent } from '../../contracts/src/identity.ts';
import type { IdentityVerifier, VerifiedIdentity } from './clerk.ts';
import { publicUser, type UserRow } from './index.ts';

const USER_SELECT='SELECT u.*, cp.verification_status AS clinician_status FROM users u LEFT JOIN clinician_profiles cp ON cp.user_id=u.id';
type Queryable=Pick<Transaction,'query'>;
type ProfileRow={user_id:string;name:string;email:string;professional_name:string;specialty:string;registration_identifier:string;institution:string;verification_status:'pending'|'approved'|'rejected';review_reason:string|null;approved_at:Date|null;approved_by:string|null;created_at:Date;updated_at:Date};
const iso=(v:Date|string|null|undefined)=>v==null?null:new Date(v).toISOString();
const AUDIT_METADATA_KEYS=new Set(['subjectUserId','role','previousRole','accountStatus','patientId','relationshipId','privacyAcknowledged','demoApprovalOnly','clinicalRecordsRetained','trustedLocalCommand','existingClinicalRecordsRetained','previousClerkUserId','clerkUserId','oldIdentityConfirmedMissing','code','method','route']);
const profile=(r:ProfileRow):ClinicianProfile=>({userId:r.user_id,name:r.name,email:r.email,professionalName:r.professional_name,specialty:r.specialty,registrationIdentifier:r.registration_identifier,institution:r.institution,verificationStatus:r.verification_status,reviewReason:r.review_reason,approvedAt:iso(r.approved_at),approvedBy:r.approved_by,createdAt:iso(r.created_at)!,updatedAt:iso(r.updated_at)!});
const requireActive=(u:UserRow|undefined):UserRow=>{if(!u)throw new DomainError('NOT_FOUND','Account unavailable.',404);if(u.account_status!=='active')throw new DomainError('ACCOUNT_DISABLED','This account is disabled. Contact the administrator.',403);return u;};

export type IdentitySyncEvent={deliveryId:string;type:'user.created'|'user.updated'|'user.deleted';clerkUserId:string;timestamp:number;identity?:Omit<VerifiedIdentity,'sessionId'>;disabled?:boolean};
export class IdentityService {
  private readonly requests=new WeakMap<FastifyRequest,Promise<User>>();
  constructor(readonly db:Db,private readonly options:{verifyIdentity:IdentityVerifier;organizationId:string}){}
  authenticate(request:FastifyRequest):Promise<User>{
    let result=this.requests.get(request);
    if(!result){result=this.options.verifyIdentity(request).then(identity=>this.reconcile(identity));this.requests.set(request,result);}
    return result;
  }
  private async audit(tx:Queryable,actor:UserRow|User,action:string,metadata:Record<string,unknown>){
    const organizationId='organizationId' in actor?actor.organizationId:actor.organization_id;
    await tx.query('INSERT INTO audit_events(id,organization_id,actor_id,action,request_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),organizationId,actor.id,action,randomUUID(),JSON.stringify(metadata)]);
  }
  private async upsertIdentity(tx:Queryable,identity:Omit<VerifiedIdentity,'sessionId'>):Promise<UserRow>{
    if(!identity.clerkUserId.startsWith('user_')||!identity.emailVerified)throw new DomainError('EMAIL_VERIFICATION_REQUIRED','A verified Clerk identity is required.',403);
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`clerk:${identity.clerkUserId}`]);
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`identity-email:${identity.email.toLowerCase()}`]);
    const tombstone=await tx.query('SELECT clerk_user_id FROM clerk_identity_tombstones WHERE clerk_user_id=$1',[identity.clerkUserId]);
    if(tombstone.rowCount)throw new DomainError('ACCOUNT_DISABLED','This identity was deleted.',403);
    let row=(await tx.query<UserRow & {clerk_updated_at:string}>(`${USER_SELECT} WHERE u.clerk_user_id=$1`,[identity.clerkUserId])).rows[0];
    if(row?.account_status==='deleted')throw new DomainError('ACCOUNT_DISABLED','This identity was deleted.',403);
    const collision=await tx.query('SELECT id FROM users WHERE lower(email)=lower($1) AND clerk_user_id IS DISTINCT FROM $2',[identity.email,identity.clerkUserId]);
    if(collision.rowCount)throw new DomainError('IDENTITY_LINK_REQUIRED','An existing account needs an explicit administrator identity link. No records were linked by email.',409);
    if(!row){
      const org=await tx.query('SELECT id FROM organizations WHERE id=$1',[this.options.organizationId]);
      if(!org.rowCount)throw new DomainError('IDENTITY_CONFIGURATION','The application organization must be configured.',503);
      const id=randomUUID();
      await tx.query("INSERT INTO users(id,organization_id,email,name,password_hash,role,clerk_user_id,onboarding_completed,account_status,clerk_updated_at) VALUES($1,$2,$3,$4,NULL,'patient',$5,false,'active',$6)",[id,this.options.organizationId,identity.email,identity.name,identity.clerkUserId,identity.updatedAt]);
      await tx.query('INSERT INTO organization_memberships(id,organization_id,user_id) VALUES($1,$2,$3)',[randomUUID(),this.options.organizationId,id]);
      row=(await tx.query<UserRow & {clerk_updated_at:string}>(`${USER_SELECT} WHERE u.id=$1`,[id])).rows[0]!;
      await this.audit(tx,row,'identity.created',{subjectUserId:id});
    }else if(identity.updatedAt>Number(row.clerk_updated_at)){
      await tx.query('UPDATE users SET email=$1,name=$2,clerk_updated_at=$3,updated_at=now() WHERE id=$4',[identity.email,identity.name,identity.updatedAt,row.id]);
      row={...row,email:identity.email,name:identity.name};
    }
    return row;
  }
  async reconcile(identity:VerifiedIdentity):Promise<User>{
    return this.db.transaction(async tx=>publicUser(requireActive(await this.upsertIdentity(tx,identity))));
  }
  async state(user:User):Promise<IdentityState>{
    const row=requireActive((await this.db.pool.query<UserRow>(`${USER_SELECT} WHERE u.id=$1`,[user.id])).rows[0]);
    const current=publicUser(row);const clinicianProfile=await this.clinicianProfile(user.id);
    if(clinicianProfile&&row.role==='patient'&&!row.onboarding_completed&&clinicianProfile.verificationStatus!=='approved')return {user:current,onboarding:{kind:'clinician',status:clinicianProfile.verificationStatus},clinicianProfile,destination:'/onboarding/clinician/pending'};
    if(!row.onboarding_completed)return {user:current,onboarding:{kind:'none',status:'required'},clinicianProfile,destination:'/onboarding'};
    return {user:current,onboarding:{kind:row.role==='patient'?'patient':row.role==='clinician'?'clinician':'none',status:'complete'},clinicianProfile,destination:row.role==='admin'?'/admin':'/'};
  }
  async clinicianProfile(id:string,tx:Queryable=this.db.pool):Promise<ClinicianProfile|null>{
    const row=(await tx.query<ProfileRow>('SELECT p.*,u.name,u.email FROM clinician_profiles p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1',[id])).rows[0];return row?profile(row):null;
  }
  async onboardPatient(actor:User,input:PatientOnboarding):Promise<IdentityState>{
    const date=new Date(`${input.birthDate}T00:00:00Z`);
    if(date>new Date()||input.birthDate<'1900-01-01')throw new DomainError('INVALID_INPUT','Enter a valid date of birth.',422);
    await this.db.transaction(async tx=>{
      const user=requireActive((await tx.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE',[actor.id])).rows[0]);
      if(user.role!=='patient')throw new DomainError('FORBIDDEN','This account cannot use patient onboarding.',403);
      if((await tx.query('SELECT user_id FROM clinician_profiles WHERE user_id=$1',[user.id])).rowCount)throw new DomainError('ONBOARDING_CONFLICT','A clinician application already exists for this account.',409);
      if(user.onboarding_completed&&user.patient_id)return;
      const patientId=user.patient_id??randomUUID();
      await tx.query('INSERT INTO patients(id,organization_id,name,birth_date,language) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',[patientId,user.organization_id,input.name,input.birthDate,input.language]);
      await tx.query('UPDATE users SET patient_id=$1,onboarding_completed=true,updated_at=now() WHERE id=$2',[patientId,user.id]);
      await tx.query("INSERT INTO patient_consents(id,organization_id,patient_id,purpose,granted,actor_id) VALUES($1,$2,$3,'optional_communications',$4,$5)",[randomUUID(),user.organization_id,patientId,input.consent,user.id]);
      await tx.query("INSERT INTO role_assignments(id,organization_id,user_id,role) VALUES($1,$2,$3,'patient') ON CONFLICT(organization_id,user_id,role) DO NOTHING",[randomUUID(),user.organization_id,user.id]);
      await this.audit(tx,user,'identity.patient_onboarded',{subjectUserId:user.id,privacyAcknowledged:true});
    });
    return this.state(actor);
  }
  async onboardClinician(actor:User,input:ClinicianOnboarding):Promise<IdentityState>{
    await this.db.transaction(async tx=>{
      const user=requireActive((await tx.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE',[actor.id])).rows[0]);
      const existing=await this.clinicianProfile(user.id,tx);
      if(existing?.verificationStatus==='approved')return;
      if(user.role!=='patient'||user.patient_id||user.onboarding_completed)throw new DomainError('FORBIDDEN','This account cannot request clinician onboarding.',403);
      await tx.query("INSERT INTO clinician_profiles(user_id,professional_name,specialty,registration_identifier,institution) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET professional_name=excluded.professional_name,specialty=excluded.specialty,registration_identifier=excluded.registration_identifier,institution=excluded.institution,verification_status='pending',review_reason=NULL,approved_at=NULL,approved_by=NULL,updated_at=now()",[user.id,input.professionalName,input.specialty,input.registrationIdentifier,input.institution]);
      await this.audit(tx,user,'identity.clinician_requested',{subjectUserId:user.id,demoApprovalOnly:true});
    });return this.state(actor);
  }
  private async admin(actor:User,tx:Queryable=this.db.pool):Promise<UserRow>{
    const row=requireActive((await tx.query<UserRow>(`SELECT * FROM users WHERE id=$1${tx===this.db.pool?'':' FOR UPDATE'}`,[actor.id])).rows[0]);
    if(row.role!=='admin'||!row.onboarding_completed)throw new DomainError('FORBIDDEN','Administrator access is required.',403);return row;
  }
  async listUsers(actor:User):Promise<AdminUser[]>{
    const admin=await this.admin(actor);
    const rows=(await this.db.pool.query<UserRow>(`${USER_SELECT} WHERE u.organization_id=$1 ORDER BY u.created_at DESC LIMIT 200`,[admin.organization_id])).rows;
    return rows.map(r=>({...publicUser(r),accountStatus:r.account_status!,onboardingCompleted:r.onboarding_completed!,clerkUserId:r.clerk_user_id??null,createdAt:iso(r.created_at)!}));
  }
  private async adminUser(actor:User,id:string):Promise<AdminUser>{
    const admin=await this.admin(actor);
    const row=(await this.db.pool.query<UserRow>(`${USER_SELECT} WHERE u.id=$1 AND u.organization_id=$2`,[id,admin.organization_id])).rows[0];
    if(!row)throw new DomainError('NOT_FOUND','Account unavailable.',404);
    return {...publicUser(row),accountStatus:row.account_status!,onboardingCompleted:row.onboarding_completed!,clerkUserId:row.clerk_user_id??null,createdAt:iso(row.created_at)!};
  }
  async listClinicians(actor:User):Promise<ClinicianProfile[]>{const admin=await this.admin(actor);return (await this.db.pool.query<ProfileRow>('SELECT p.*,u.name,u.email FROM clinician_profiles p JOIN users u ON u.id=p.user_id WHERE u.organization_id=$1 ORDER BY p.updated_at DESC LIMIT 200',[admin.organization_id])).rows.map(profile);}
  async reviewClinician(actor:User,id:string,decision:'approved'|'rejected',reason:string):Promise<ClinicianProfile>{
    await this.db.transaction(async tx=>{
      const admin=await this.admin(actor,tx);
      const target=requireActive((await tx.query<UserRow>('SELECT * FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE',[id,admin.organization_id])).rows[0]);
      if(id===admin.id||target.role==='admin'||target.patient_id)throw new DomainError('FORBIDDEN','This account cannot be reviewed as a clinician applicant.',403);
      if(!await this.clinicianProfile(id,tx))throw new DomainError('NOT_FOUND','Clinician application unavailable.',404);
      await tx.query("UPDATE clinician_profiles SET verification_status=$1,review_reason=$2,approved_by=$3,approved_at=CASE WHEN $1='approved' THEN now() ELSE NULL END,updated_at=now() WHERE user_id=$4",[decision,reason,admin.id,id]);
      await tx.query('UPDATE users SET role=$1,onboarding_completed=$2,updated_at=now() WHERE id=$3',[decision==='approved'?'clinician':'patient',decision==='approved',id]);
      await tx.query('DELETE FROM role_assignments WHERE user_id=$1',[id]);
      if(decision==='approved')await tx.query("INSERT INTO role_assignments(id,organization_id,user_id,role) VALUES($1,$2,$3,'clinician')",[randomUUID(),target.organization_id,id]);
      else await tx.query("UPDATE clinician_patient_relationships SET relationship_status='revoked',revoked_at=now(),updated_at=now() WHERE clinician_id=$1 AND relationship_status='active'",[id]);
      await this.audit(tx,admin,`identity.clinician_${decision}`,{subjectUserId:id,demoApprovalOnly:true});
    });return (await this.clinicianProfile(id))!;
  }
  async setAccountStatus(actor:User,id:string,status:'active'|'suspended'):Promise<AdminUser>{
    await this.db.transaction(async tx=>{
      const admin=await this.admin(actor,tx);
      const target=(await tx.query<UserRow>('SELECT * FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE',[id,admin.organization_id])).rows[0];
      if(!target)throw new DomainError('NOT_FOUND','Account unavailable.',404);
      if(target.role==='admin'||target.id===admin.id)throw new DomainError('FORBIDDEN','Administrator account changes require trusted provisioning.',403);
      if(target.account_status==='deleted')throw new DomainError('ACCOUNT_DELETED','Deleted identities cannot be reactivated.',409);
      await tx.query('UPDATE users SET account_status=$1,updated_at=now() WHERE id=$2',[status,id]);
      if(status==='suspended')await tx.query("UPDATE clinician_patient_relationships SET relationship_status='revoked',revoked_at=now(),updated_at=now() WHERE clinician_id=$1 AND relationship_status='active'",[id]);
      await this.audit(tx,admin,'identity.account_status_changed',{subjectUserId:id,accountStatus:status});
    });return this.adminUser(actor,id);
  }
  async setRole(actor:User,id:string,role:Exclude<Role,'admin'>):Promise<AdminUser>{
    await this.db.transaction(async tx=>{
      const admin=await this.admin(actor,tx);const target=requireActive((await tx.query<UserRow>('SELECT * FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE',[id,admin.organization_id])).rows[0]);
      if(id===admin.id||target.role==='admin')throw new DomainError('FORBIDDEN','Administrator roles require trusted provisioning.',403);
      if(role==='patient'&&!target.patient_id)throw new DomainError('PATIENT_PROFILE_REQUIRED','Patient onboarding is required before assigning the patient role.',409);
      if(role!=='patient'&&target.patient_id)throw new DomainError('ROLE_CONFLICT','Patient records must remain attached to their patient identity.',409);
      if(role==='clinician'&&(await this.clinicianProfile(id,tx))?.verificationStatus!=='approved')throw new DomainError('CLINICIAN_APPROVAL_REQUIRED','Approve the clinician application first.',409);
      await tx.query('UPDATE users SET role=$1,onboarding_completed=true,updated_at=now() WHERE id=$2',[role,id]);
      await tx.query('DELETE FROM role_assignments WHERE user_id=$1',[id]);
      await tx.query('INSERT INTO role_assignments(id,organization_id,user_id,role) VALUES($1,$2,$3,$4)',[randomUUID(),target.organization_id,id,role]);
      await tx.query("UPDATE clinician_patient_relationships SET relationship_status='revoked',revoked_at=now(),updated_at=now() WHERE clinician_id=$1 AND relationship_status='active'",[id]);
      await this.audit(tx,admin,'identity.role_changed',{subjectUserId:id,previousRole:target.role,role});
    });return this.adminUser(actor,id);
  }
  async relationships(actor:User):Promise<RelationshipDirectory>{
    const admin=await this.admin(actor);
    const rows=(await this.db.pool.query<{id:string;clinician_id:string;clinician_name:string;patient_id:string;patient_name:string;relationship_status:'active'|'revoked';authorization_basis:string;authorized_at:Date;revoked_at:Date|null}>('SELECT r.*,u.name AS clinician_name,p.name AS patient_name FROM clinician_patient_relationships r JOIN users u ON u.id=r.clinician_id JOIN patients p ON p.id=r.patient_id WHERE r.organization_id=$1 ORDER BY r.updated_at DESC LIMIT 200',[admin.organization_id])).rows;
    const relationships=rows.map(r=>({id:r.id,clinicianId:r.clinician_id,clinicianName:r.clinician_name,patientId:r.patient_id,patientName:r.patient_name,relationshipStatus:r.relationship_status,authorizationBasis:r.authorization_basis,authorizedAt:iso(r.authorized_at)!,revokedAt:iso(r.revoked_at)}));
    const patients=(await this.db.pool.query<{id:string;name:string}>('SELECT id,name FROM patients WHERE organization_id=$1 ORDER BY name LIMIT 200',[admin.organization_id])).rows;
    const careTeam=(await this.db.pool.query<{id:string;name:string;role:Role}>("SELECT u.id,u.name,u.role FROM users u LEFT JOIN clinician_profiles p ON p.user_id=u.id WHERE u.organization_id=$1 AND u.account_status='active' AND u.onboarding_completed AND (u.role IN ('admin','coordinator') OR (u.role='clinician' AND p.verification_status='approved')) ORDER BY u.name",[admin.organization_id])).rows;
    return {relationships,patients,careTeam};
  }
  async grantRelationship(actor:User,input:{clinicianId:string;patientId:string;authorizationBasis:string}):Promise<CareRelationship>{
    let id='';await this.db.transaction(async tx=>{
      const admin=await this.admin(actor,tx);const clinician=requireActive((await tx.query<UserRow>(`${USER_SELECT} WHERE u.id=$1 AND u.organization_id=$2 FOR UPDATE OF u`,[input.clinicianId,admin.organization_id])).rows[0]);
      if(!clinician.onboarding_completed||!['clinician','coordinator','admin'].includes(clinician.role)||(clinician.role==='clinician'&&clinician.clinician_status!=='approved'))throw new DomainError('FORBIDDEN','Only approved care-team accounts may receive assignments.',403);
      if(!(await tx.query('SELECT id FROM patients WHERE id=$1 AND organization_id=$2',[input.patientId,admin.organization_id])).rowCount)throw new DomainError('NOT_FOUND','Patient unavailable.',404);
      const row=(await tx.query<{id:string}>("INSERT INTO clinician_patient_relationships(id,organization_id,clinician_id,patient_id,authorization_basis,authorized_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(clinician_id,patient_id) DO UPDATE SET relationship_status='active',authorization_basis=excluded.authorization_basis,authorized_by=excluded.authorized_by,authorized_at=now(),revoked_at=NULL,updated_at=now() RETURNING id",[randomUUID(),admin.organization_id,input.clinicianId,input.patientId,input.authorizationBasis,admin.id])).rows[0]!;id=row.id;
      await this.audit(tx,admin,'identity.patient_access_granted',{subjectUserId:input.clinicianId,patientId:input.patientId,relationshipId:id});
    });return (await this.relationships(actor)).relationships.find(r=>r.id===id)!;
  }
  async revokeRelationship(actor:User,id:string):Promise<void>{await this.db.transaction(async tx=>{const admin=await this.admin(actor,tx);const changed=await tx.query("UPDATE clinician_patient_relationships SET relationship_status='revoked',revoked_at=now(),updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING clinician_id,patient_id",[id,admin.organization_id]);if(!changed.rowCount)throw new DomainError('NOT_FOUND','Assignment unavailable.',404);await this.audit(tx,admin,'identity.patient_access_revoked',{relationshipId:id,subjectUserId:changed.rows[0].clinician_id,patientId:changed.rows[0].patient_id});});}
  async auditEvents(actor:User):Promise<IdentityAuditEvent[]>{
    const admin=await this.admin(actor);
    return (await this.db.pool.query<{id:string;actor_id:string;action:string;created_at:Date;metadata:Record<string,unknown>}>("SELECT id,actor_id,action,created_at,metadata FROM audit_events WHERE organization_id=$1 AND (action LIKE 'identity.%' OR action='authorization_denied') ORDER BY created_at DESC LIMIT 200",[admin.organization_id])).rows.map(r=>({id:r.id,actorId:r.actor_id,action:r.action,createdAt:iso(r.created_at)!,metadata:Object.fromEntries(Object.entries(r.metadata).filter(([key])=>AUDIT_METADATA_KEYS.has(key)))}));
  }
  async synchronize(event:IdentitySyncEvent):Promise<{duplicate:boolean;ignored?:boolean}>{
    return this.db.transaction(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`clerk:${event.clerkUserId}`]);
      const inserted=await tx.query('INSERT INTO clerk_webhook_deliveries(delivery_id,event_type,clerk_user_id,event_timestamp) VALUES($1,$2,$3,$4) ON CONFLICT(delivery_id) DO NOTHING RETURNING delivery_id',[event.deliveryId,event.type,event.clerkUserId,event.timestamp]);
      if(!inserted.rowCount)return {duplicate:true};
      if(event.type==='user.deleted'){
        await tx.query('INSERT INTO clerk_identity_tombstones(clerk_user_id,deleted_at) VALUES($1,$2) ON CONFLICT(clerk_user_id) DO UPDATE SET deleted_at=GREATEST(clerk_identity_tombstones.deleted_at,excluded.deleted_at)',[event.clerkUserId,event.timestamp]);
        const user=(await tx.query<UserRow>("UPDATE users SET account_status='deleted',updated_at=now() WHERE clerk_user_id=$1 RETURNING *",[event.clerkUserId])).rows[0];
        if(user){await tx.query("UPDATE clinician_patient_relationships SET relationship_status='revoked',revoked_at=now(),updated_at=now() WHERE clinician_id=$1 AND relationship_status='active'",[user.id]);await this.audit(tx,user,'identity.deleted',{subjectUserId:user.id,clinicalRecordsRetained:true});}
        return {duplicate:false};
      }
      if((await tx.query('SELECT clerk_user_id FROM clerk_identity_tombstones WHERE clerk_user_id=$1',[event.clerkUserId])).rowCount)return {duplicate:false,ignored:true};
      const existing=(await tx.query<{clerk_updated_at:string}>('SELECT clerk_updated_at FROM users WHERE clerk_user_id=$1',[event.clerkUserId])).rows[0];
      if(existing&&Number(existing.clerk_updated_at)>event.timestamp)return {duplicate:false,ignored:true};
      if(!event.identity?.emailVerified)return {duplicate:false,ignored:true};
      const user=await this.upsertIdentity(tx,event.identity);
      if(event.disabled){await tx.query("UPDATE users SET account_status='suspended',updated_at=now() WHERE id=$1",[user.id]);await tx.query("UPDATE clinician_patient_relationships SET relationship_status='revoked',revoked_at=now(),updated_at=now() WHERE clinician_id=$1 AND relationship_status='active'",[user.id]);}
      return {duplicate:false};
    });
  }
}
