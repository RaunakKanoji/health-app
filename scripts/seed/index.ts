import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Db } from '../../packages/db/src/index.ts';
import { createDatabase, migrate, transactionDatabase } from '../../packages/db/src/index.ts';
import { policies } from '../../packages/domain/src/index.ts';
import { WorkflowService } from '../../packages/workflows/src/service.ts';
import type { User, Command } from '../../packages/contracts/src/careloop.ts';
import { readConfig, assertDevelopmentDatabase, migrationConnection } from '../../packages/config/src/index.ts';
export const DEMO_PASSWORD='CareLoop-Demo-2026!';
const names=['Amal Al Mansoori','Omar Hassan','Layla Ibrahim','Yousef Khalid','Maryam Nasser','Ali Saeed','Sara Ahmed','Khalid Rashid','Fatima Noor','Hamad Salim','Noura Faisal','Zayed Abdullah','Aisha Karim','Rashid Jamal','Hana Farid','Saeed Tariq'];
export async function seedDatabase(db:Db){
 if(process.env.DEMO_MODE!=='true')throw new Error('Seeding requires explicit DEMO_MODE=true.');
 if(process.env.DATABASE_ENVIRONMENT&& !['development','test'].includes(process.env.DATABASE_ENVIRONMENT))throw new Error('Seeding is restricted to development and test environments.');
 await db.transaction(async tx=>{
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('careloop-seed'))");
  await seedTransaction(transactionDatabase(tx));
 });
}
// Only the fixed, source-identified synthetic fixture receives these initial authorizations.
// Existing approval decisions and revoked relationships always win on subsequent startup.
async function seedSyntheticCareTeam(db:Db){
 for(const [id,email] of [['user-clinician','clinician@careloop.demo'],['user-outsider','outsider@careloop.demo']]){
  await db.pool.query("INSERT INTO clinician_profiles(user_id,professional_name,specialty,registration_identifier,institution,verification_status,approved_by,approved_at) SELECT id,name,'Synthetic care coordination','SYNTHETIC-'||id,'Synthetic demonstration organization','approved',id,now() FROM users WHERE id=$1 AND email=$2 AND role='clinician' ON CONFLICT(user_id) DO NOTHING",[id,email]);
 }
 for(const [id,email] of [['user-clinician','clinician@careloop.demo'],['user-coordinator','coordinator@careloop.demo'],['user-coordinator-2','coordinator2@careloop.demo']]){
  for(let i=0;i<names.length;i++){
   const num=String(i+1).padStart(3,'0');
   await db.pool.query("INSERT INTO clinician_patient_relationships(id,organization_id,clinician_id,patient_id,authorization_basis,authorized_by) SELECT $1,u.organization_id,u.id,p.id,'Fixed synthetic demonstration care team',a.id FROM users u JOIN users a ON a.id='user-admin' AND a.organization_id=u.organization_id AND a.role='admin' JOIN patients p ON p.organization_id=u.organization_id AND p.id=$4 AND p.synthetic=true JOIN patient_identifiers pi ON pi.patient_id=p.id AND pi.organization_id=p.organization_id AND pi.system='https://careloop.demo/synthetic' AND pi.value=$5 WHERE u.id=$2 AND u.email=$3 AND u.organization_id='org-screening' ON CONFLICT(clinician_id,patient_id) DO NOTHING",[randomUUID(),id,email,`patient-${num}`,`SYN-${num}`]);
  }
 }
}
async function seedTransaction(db:Db){
 const existing=await db.pool.query("SELECT id FROM care_episodes WHERE id='episode-001'");if(existing.rowCount){await seedSyntheticCareTeam(db);return;}
 // Clerk owns credentials. Retain existing legacy hashes; new fixtures have none.
 const password=null;
 await db.transaction(async tx=>{
  for(const [id,name] of [['org-screening','Al Noor Screening Network'],['org-receiver','Harbor Specialist Centre'],['org-outsider','Isolated Demonstration Organization']])await tx.query('INSERT INTO organizations(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[id,name]);
  const staff=[['user-clinician','clinician','Dr. Leila Hassan','org-screening'],['user-coordinator','coordinator','Nadia Al Farsi','org-screening'],['user-admin','admin','Demo Administrator','org-screening'],['user-receiver','receiver','Harbor Referral Desk','org-receiver'],['user-outsider','clinician','Isolated Clinician','org-outsider'],['user-coordinator-2','coordinator','Samir Ahmed','org-screening']];
  for(const [id,role,name,org] of staff){const email=id==='user-outsider'?'outsider@careloop.demo':id==='user-coordinator-2'?'coordinator2@careloop.demo':`${role}@careloop.demo`;await tx.query('INSERT INTO users(id,organization_id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',[id,org,email,name,password,role]);}
  for(let i=0;i<names.length;i++){
   const num=String(i+1).padStart(3,'0'),patientId=`patient-${num}`,userId=i===0?'user-patient':`user-patient-${num}`;
   await tx.query('INSERT INTO patients(id,organization_id,name,birth_date,language) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',[patientId,'org-screening',names[i],`${1964+i}-0${i%9+1}-15`,i%4===0?'hi':'en']);
   await tx.query('INSERT INTO users(id,organization_id,email,name,password_hash,role,patient_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',[userId,'org-screening',i===0?'patient@careloop.demo':`patient${num}@careloop.demo`,names[i],password,'patient',patientId]);
   await tx.query('INSERT INTO patient_identifiers(id,organization_id,patient_id,system,value) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,system,value) DO NOTHING',[randomUUID(),'org-screening',patientId,'https://careloop.demo/synthetic',`SYN-${num}`]);
   await tx.query('INSERT INTO patient_consents(id,organization_id,patient_id,purpose,granted,actor_id) VALUES($1,$2,$3,$4,true,$5)',[randomUUID(),'org-screening',patientId,'optional_communications',userId]);
  }
  await tx.query("INSERT INTO organization_memberships(id,organization_id,user_id) SELECT 'membership-'||id,organization_id,id FROM users ON CONFLICT(organization_id,user_id) DO NOTHING");
  await tx.query("INSERT INTO role_assignments(id,organization_id,user_id,role) SELECT 'role-'||id,organization_id,id,role FROM users ON CONFLICT(organization_id,user_id,role) DO NOTHING");
  for(const p of policies){await tx.query('INSERT INTO clinical_policies(id,pathway) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[p.id,p.pathway]);await tx.query('INSERT INTO policy_versions(id,policy_id,version,approval_status,document) VALUES($1,$2,$3,$4,$5) ON CONFLICT(policy_id,version) DO NOTHING',[`${p.id}:${p.version}`,p.id,p.version,p.approvalStatus,JSON.stringify(p)]);}
 });
 await seedSyntheticCareTeam(db);
 const base=Date.now();let time=base-14*86400000;const service=new WorkflowService(db,()=>new Date(time).toISOString());
 const clinician=(await service.user('user-clinician'))!,coordinator=(await service.user('user-coordinator'))!,receiver=(await service.user('user-receiver'))!;
 for(let i=0;i<names.length;i++){
  const num=String(i+1).padStart(3,'0');time=base-(14-i%10)*86400000;const patient=(await service.user(i===0?'user-patient':`user-patient-${num}`))!;
  let e=await db.transaction(tx=>service.createEpisode(tx,clinician,{id:`episode-${num}`,patientId:`patient-${num}`,source:'careloop-synthetic-seed',sourceId:`screen-${num}`,pathway:(['diabetes','colorectal','hypertension'] as const)[i%3]!,summary:'Synthetic screening finding flagged by the source clinician for follow-up. Interpretation and next steps require human review.',issuedAt:new Date(time-3600000).toISOString(),ownerId:i===14?null:'user-coordinator'}));
  async function act(actor:User,body:Omit<Command,'expectedVersion'>){time+=3600000;e=await service.command(actor,e.id,{...body,expectedVersion:e.version},`seed:${e.id}:${e.version}`);}
  // Seed stages exercise the same authorized command handlers used by the UI.
  const stage=[0,1,2,3,4,5,6,7,8,8,2,4,6,1,0,3][i]!;
  if(stage>=1)await act(clinician,{type:'review',note:'Synthetic clinician reviewed the source and approved follow-up coordination.',patientExplanation:'Your screening result needs a follow-up conversation with your care team. This screening result does not establish a diagnosis.',urgency:i===13?'URGENT':'ROUTINE',dueAt:new Date(base+(i%3-1)*86400000).toISOString()});
  if(stage>=2){await act(coordinator,{type:'send_message',channel:'portal'});time+=1000;await service.tick(new Date(time).toISOString(),e.id);e=await service.getEpisode(clinician,e.id);}
  if(stage>=3)await act(patient,{type:'acknowledge'});
  if(stage>=4)await act(clinician,{type:'create_referral',receivingOrganizationId:'org-receiver',note:'Synthetic clinician-authorized specialist follow-up.'});
  if(i===5){await act(receiver,{type:'reject_referral',referralId:e.referrals.at(-1)!.id,note:'Synthetic service unavailable; return to accountable owner.'});continue;}
  if(stage>=5)await act(receiver,{type:'accept_referral',referralId:e.referrals.at(-1)!.id});
  if(stage>=6){await act(coordinator,{type:'schedule_appointment',referralId:e.referrals.at(-1)!.id,scheduledAt:new Date(time+1800000).toISOString(),location:'Harbor Specialist Centre · Room 204 (simulated)'});}
  if(i===12){await act(receiver,{type:'no_show',appointmentId:e.appointments.at(-1)!.id,note:'Synthetic attendance reconciliation: patient did not attend.'});continue;}
  if(stage>=7)await act(receiver,{type:'complete_appointment',appointmentId:e.appointments.at(-1)!.id,note:'Synthetic consultation completed and recorded by receiving provider.'});
  if(stage>=7){for(const kind of ['encounter_note','followup_report'] as const){await act(receiver,{type:'add_evidence',evidenceKind:kind,title:`Synthetic ${kind.replaceAll('_',' ')}`,content:'Synthetic demonstration document: the follow-up consultation occurred and the responsible clinician documented the outcome. This is not a clinical record.'});if(stage>=8)await act(clinician,{type:'verify_evidence',evidenceId:e.evidence.at(-1)!.id,note:'Clinician verified synthetic evidence matches this follow-up episode.'});}}
  if(stage>=8)await act(clinician,{type:'close',note:'Clinician confirms intended follow-up occurred and all synthetic evidence supports closure.'});
 }
 await service.tick(new Date(base).toISOString());
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const config=readConfig();assertDevelopmentDatabase(config);const db=createDatabase(migrationConnection(config));try{await migrate(db);await seedDatabase(db);process.stdout.write('Synthetic CareLoop seed is ready.\n');}finally{await db.close();}}
