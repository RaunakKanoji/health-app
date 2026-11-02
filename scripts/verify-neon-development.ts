import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { CareLoopApp } from '../apps/api/src/app.ts';
import type { Db } from '../packages/db/src/index.ts';
import type { IdentityVerifier, VerifiedIdentity } from '../packages/auth/src/clerk.ts';

// This is an explicitly invoked integration probe, never an application auth mode.
// Root must review before running against the designated development branch.
const EXPECTED_BRANCH='br-cold-haze-b30hq0yn';
const ORGANIZATION='org-neon-development-verification';
const PATIENT_A='neon-verification-patient-a';
const PATIENT_B='neon-verification-patient-b';
const BUCKET='careloop-medical-documents';
let phase='configuration';

class VerificationFailure extends Error {
 constructor(readonly code:string,readonly httpStatus?:number){super(code);}
}
function requireCondition(value:unknown,code:string):asserts value {if(!value)throw new VerificationFailure(code);}
function progress(next:string){phase=next;process.stdout.write(JSON.stringify({phase:next,status:'running'})+'\n');}
type JsonRecord=Record<string,unknown>;
type RowResponse={record:{id:string;[key:string]:unknown}};
type DocumentResponse={document:{id:string;checksum:string;fileSize:number;[key:string]:unknown}};

const fixtureUsers=[
 {id:'neon-verification-clinician',role:'clinician',name:'Synthetic verification clinician',patientId:null},
 {id:'neon-verification-coordinator',role:'coordinator',name:'Synthetic verification coordinator',patientId:null},
 {id:'neon-verification-patient-user-a',role:'patient',name:'Synthetic verification patient A',patientId:PATIENT_A},
 {id:'neon-verification-patient-user-b',role:'patient',name:'Synthetic verification patient B',patientId:PATIENT_B},
] as const;

async function seedVerificationIdentities(db:Db){
 await db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[ORGANIZATION]);
  await tx.query('INSERT INTO organizations(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[ORGANIZATION,'Synthetic Neon verification fixtures; no Clerk accounts']);
  const org=(await tx.query<{name:string}>('SELECT name FROM organizations WHERE id=$1',[ORGANIZATION])).rows[0];
  requireCondition(org?.name==='Synthetic Neon verification fixtures; no Clerk accounts','FIXTURE_ORGANIZATION_CONFLICT');
  for(const [id,name] of [[PATIENT_A,'Synthetic verification patient A'],[PATIENT_B,'Synthetic verification patient B']]){
   await tx.query("INSERT INTO patients(id,organization_id,name,birth_date,language,synthetic) VALUES($1,$2,$3,'1980-01-01','en',true) ON CONFLICT(id) DO NOTHING",[id,ORGANIZATION,name]);
   const patient=(await tx.query<{organization_id:string;synthetic:boolean}>('SELECT organization_id,synthetic FROM patients WHERE id=$1',[id])).rows[0];
   requireCondition(patient?.organization_id===ORGANIZATION&&patient.synthetic,'FIXTURE_PATIENT_CONFLICT');
  }
  for(const user of fixtureUsers){
   const email=`${user.id}@example.invalid`,clerkId=`user_neon_verification_${user.id.replaceAll('-','_')}`;
   await tx.query("INSERT INTO users(id,organization_id,email,name,password_hash,role,patient_id,clerk_user_id,account_status,onboarding_completed) VALUES($1,$2,$3,$4,NULL,$5,$6,$7,'active',true) ON CONFLICT(id) DO NOTHING",[user.id,ORGANIZATION,email,user.name,user.role,user.patientId,clerkId]);
   const row=(await tx.query<{organization_id:string;email:string;role:string;patient_id:string|null;clerk_user_id:string;account_status:string;onboarding_completed:boolean}>('SELECT organization_id,email,role,patient_id,clerk_user_id,account_status,onboarding_completed FROM users WHERE id=$1',[user.id])).rows[0];
   requireCondition(row?.organization_id===ORGANIZATION&&row.email===email&&row.role===user.role&&row.patient_id===user.patientId&&row.clerk_user_id===clerkId&&row.account_status==='active'&&row.onboarding_completed,'FIXTURE_IDENTITY_CONFLICT');
   await tx.query('INSERT INTO organization_memberships(id,organization_id,user_id) VALUES($1,$2,$3) ON CONFLICT(organization_id,user_id) DO NOTHING',[randomUUID(),ORGANIZATION,user.id]);
   await tx.query('INSERT INTO role_assignments(id,organization_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,user_id,role) DO NOTHING',[randomUUID(),ORGANIZATION,user.id,user.role]);
  }
  const clinician=fixtureUsers[0]!.id;
  await tx.query("INSERT INTO clinician_profiles(user_id,professional_name,specialty,registration_identifier,institution,verification_status,approved_by,approved_at) VALUES($1,'Synthetic verification clinician','Synthetic fixture only','SYNTHETIC-NEON-VERIFICATION','Synthetic verification organization','approved',$1,now()) ON CONFLICT(user_id) DO NOTHING",[clinician]);
  requireCondition((await tx.query("SELECT user_id FROM clinician_profiles WHERE user_id=$1 AND verification_status='approved' AND registration_identifier='SYNTHETIC-NEON-VERIFICATION'",[clinician])).rowCount===1,'FIXTURE_CLINICIAN_CONFLICT');
  for(const user of fixtureUsers.slice(0,2)){
   await tx.query("INSERT INTO clinician_patient_relationships(id,organization_id,clinician_id,patient_id,authorization_basis,authorized_by) VALUES($1,$2,$3,$4,'Explicit synthetic Neon verification fixture',$5) ON CONFLICT(clinician_id,patient_id) DO NOTHING",[randomUUID(),ORGANIZATION,user.id,PATIENT_A,clinician]);
   requireCondition((await tx.query("SELECT id FROM clinician_patient_relationships WHERE organization_id=$1 AND clinician_id=$2 AND patient_id=$3 AND relationship_status='active' AND revoked_at IS NULL AND authorization_basis='Explicit synthetic Neon verification fixture'",[ORGANIZATION,user.id,PATIENT_A])).rowCount===1,'FIXTURE_RELATIONSHIP_CONFLICT');
  }
 });
}

export async function verifyNeonDevelopment(){
 // Capture only the explicitly preloaded file/process environment before config modules
 // load the normal application's production owner/runtime settings.
 const loaded={...process.env};
 requireCondition(loaded.DATABASE_ENVIRONMENT==='development','DEVELOPMENT_ENVIRONMENT_REQUIRED');
 requireCondition(loaded.NEON_BRANCH==='development'||loaded.NEON_BRANCH===EXPECTED_BRANCH,'EXPECTED_DEVELOPMENT_BRANCH_REQUIRED');
 const runtime=loaded.DATABASE_URL,direct=loaded.DATABASE_URL_UNPOOLED??loaded.DATABASE_DIRECT_URL;
 requireCondition(runtime&&direct,'CLI_DATABASE_CONNECTIONS_REQUIRED');
 requireCondition(new URL(runtime).hostname.endsWith('.neon.tech')&&new URL(direct).hostname.endsWith('.neon.tech'),'NEON_DATABASE_REQUIRED');
 const endpoint=loaded.AWS_ENDPOINT_URL_S3;
 requireCondition(endpoint,'DEVELOPMENT_STORAGE_ENDPOINT_REQUIRED');
 const storageUrl=new URL(endpoint);
 requireCondition(storageUrl.protocol==='https:'&&storageUrl.hostname.startsWith(`${EXPECTED_BRANCH}.storage.`)&&storageUrl.hostname.endsWith('.neon.tech')&&!storageUrl.username&&!storageUrl.password&&!storageUrl.search&&!storageUrl.hash,'EXPECTED_DEVELOPMENT_STORAGE_REQUIRED');
 requireCondition(loaded.AWS_ACCESS_KEY_ID&&loaded.AWS_SECRET_ACCESS_KEY&&loaded.AWS_REGION,'CLI_STORAGE_CREDENTIALS_REQUIRED');
 requireCondition(!loaded.DOCUMENT_STORAGE_BUCKET||loaded.DOCUMENT_STORAGE_BUCKET===BUCKET,'EXPECTED_PRIVATE_BUCKET_REQUIRED');
 // Pin a complete selected-branch tuple before dynamic imports. No environment file is
 // read or rewritten here, and the ordinary application's runtime role is never used.
 Object.assign(process.env,{
  DATABASE_URL:runtime,DATABASE_DIRECT_URL:direct,DATABASE_URL_UNPOOLED:direct,DATABASE_RUNTIME_URL:runtime,
  DATABASE_ENVIRONMENT:'development',DEMO_MODE:'true',DEFAULT_ORGANIZATION_ID:ORGANIZATION,
  DOCUMENT_STORAGE_PROVIDER:'neon',DOCUMENT_STORAGE_PRIVATE:'true',DOCUMENT_STORAGE_BUCKET:BUCKET,
 });
 const [{parseConfig,migrationConnection},{createDatabase,migrate},{buildApp},{DomainError},{createDocumentStore}]=await Promise.all([
  import('../packages/config/src/index.ts'),import('../packages/db/src/index.ts'),import('../apps/api/src/app.ts'),
  import('../packages/domain/src/index.ts'),import('../packages/workflows/src/medical-documents.ts'),
 ]);
 const config=parseConfig({...process.env,DATABASE_URL:runtime,DATABASE_DIRECT_URL:direct,DATABASE_URL_UNPOOLED:direct,DATABASE_RUNTIME_URL:runtime,DATABASE_ENVIRONMENT:'development'});
 const store=createDocumentStore({...loaded,DOCUMENT_STORAGE_PROVIDER:'neon',DOCUMENT_STORAGE_PRIVATE:'true',DOCUMENT_STORAGE_BUCKET:BUCKET});
 requireCondition(store,'PRIVATE_NEON_ADAPTER_REQUIRED');
 const db=createDatabase(migrationConnection(config),{max:2});let app:CareLoopApp|undefined;
 const identities=new Map<string,VerifiedIdentity>();
 const cookies=new Map<string,string>();
 try{
  progress('development_migrations');await migrate(db);
  progress('synthetic_identity_fixtures');await seedVerificationIdentities(db);
  for(const user of fixtureUsers){
   const token=randomUUID();cookies.set(user.id,`__session=${token}`);
   identities.set(token,{clerkUserId:`user_neon_verification_${user.id.replaceAll('-','_')}`,email:`${user.id}@example.invalid`,name:user.name,emailVerified:true,sessionId:`sess_neon_fixture_${randomUUID()}`,updatedAt:Date.now()});
  }
  const verifier:IdentityVerifier=async request=>{
   const identity=identities.get(request.cookies.__session??'');
   if(!identity)throw new DomainError('UNAUTHENTICATED','A synthetic verification session is required.',401);
   return identity;
  };
  progress('loopback_http_server');
  app=await buildApp({databaseUrl:runtime,seed:false,identityVerifier:verifier,documentStore:store});
  const address=await app.listen({host:'127.0.0.1',port:0});
  const clinician=cookies.get(fixtureUsers[0]!.id)!,coordinator=cookies.get(fixtureUsers[1]!.id)!,patient=cookies.get(fixtureUsers[2]!.id)!,otherPatient=cookies.get(fixtureUsers[3]!.id)!;
  const run=randomUUID(),path=`/api/patients/${PATIENT_A}`;
  async function request<T extends object>(route:string,options:{cookie?:string;body?:JsonRecord;key?:string;expected?:number}={}):Promise<T>{
   const response=await fetch(new URL(route,address),{method:options.body===undefined?'GET':'POST',headers:{...(options.cookie?{cookie:options.cookie}:{}),...(options.body?{'content-type':'application/json'}:{}),...(options.key?{'idempotency-key':options.key}:{})},body:options.body===undefined?undefined:JSON.stringify(options.body),signal:AbortSignal.timeout(30000)});
   const body=await response.json() as T&{error?:{code?:string}};
   if(response.status!==(options.expected??200))throw new VerificationFailure(body.error?.code&&/^[A-Z0-9_]+$/.test(body.error.code)?body.error.code:'HTTP_STATUS_MISMATCH',response.status);
   return body;
  }
  const command=(resource:string,body:JsonRecord,key=`${run}:${resource}`)=>request<RowResponse>(`${path}/clinical-records/${resource}`,{cookie:clinician,body,key});

  progress('authorization_denials');
  await request(`${path}/clinical-records`,{expected:401});
  await request(`${path}/clinical-records`,{cookie:otherPatient,expected:404});
  await request(`${path}/clinical-records/consultations`,{cookie:coordinator,body:{chiefComplaint:'Synthetic forbidden coordinator write'},key:`${run}:denied-consultation`,expected:403});

  progress('private_document_roundtrip');
  const bytes=Buffer.from('SYNTHETIC NEON VERIFICATION DOCUMENT. No patient information or medical advice.\n','utf8');
  const checksum=createHash('sha256').update(bytes).digest('hex');
  const upload={documentType:'laboratory_report',filename:'synthetic-neon-verification.txt',mimeType:'text/plain',contentBase64:bytes.toString('base64')};
  const uploadKey=`${run}:document`;
  const uploaded=await request<DocumentResponse>(`${path}/documents`,{cookie:patient,body:upload,key:uploadKey});
  const replay=await request<DocumentResponse>(`${path}/documents`,{cookie:patient,body:upload,key:uploadKey});
  const documentId=uploaded.document.id;
  requireCondition(documentId===replay.document.id&&uploaded.document.checksum===checksum&&uploaded.document.fileSize===bytes.length,'DOCUMENT_REPLAY_OR_CHECKSUM_FAILED');
  requireCondition(!('storageKey' in uploaded.document)&&!('storageProvider' in uploaded.document),'DOCUMENT_INTERNAL_METADATA_EXPOSED');
  await request(`${path}/documents`,{cookie:coordinator,body:upload,key:`${run}:denied-upload`,expected:403});
  await request(`${path}/documents/${documentId}/download`,{cookie:otherPatient,body:{},expected:404});
  await request(`${path}/documents/${documentId}/download`,{body:{},expected:401});
  await request(`/api/patients/${PATIENT_B}/documents/${documentId}/download`,{cookie:patient,body:{},expected:404});
  const download=await request<{url:string;expiresIn:number}>(`${path}/documents/${documentId}/download`,{cookie:patient,body:{}});
  const signed=new URL(download.url);
  requireCondition(download.expiresIn===60&&signed.protocol==='https:'&&signed.hostname===storageUrl.hostname&&signed.pathname.startsWith(`/${BUCKET}/medical-documents/`),'SIGNED_DOWNLOAD_SCOPE_FAILED');
  const fetched=await fetch(signed,{redirect:'error',signal:AbortSignal.timeout(20000)});
  requireCondition(fetched.status===200,'SIGNED_DOWNLOAD_FAILED');
  requireCondition(fetched.headers.get('content-disposition')?.toLowerCase().startsWith('attachment'),'DOWNLOAD_ATTACHMENT_REQUIRED');
  requireCondition(Buffer.from(await fetched.arrayBuffer()).equals(bytes),'DOWNLOADED_BYTES_DIFFER');
  const anonymous=new URL(signed);anonymous.search='';
  const denied=await fetch(anonymous,{redirect:'error',signal:AbortSignal.timeout(20000)});
  await denied.body?.cancel();requireCondition([401,403,404].includes(denied.status),'ANONYMOUS_OBJECT_ACCESS_ALLOWED');

  progress('persisted_clinical_journey');
  const consultation=(await command('consultations',{chiefComplaint:'Synthetic Neon verification consultation',encounterType:'synthetic-verification'})).record;
  const note=(await command('notes',{consultationId:consultation.id,content:'SYNTHETIC: verification of signed note persistence only.',status:'signed'})).record;
  const order=(await command('lab-orders',{consultationId:consultation.id,testName:'Synthetic verification measurement'})).record;
  const report=(await command('lab-reports',{labOrderId:order.id,documentId,laboratoryName:'Synthetic verification laboratory',reportDate:new Date().toISOString().slice(0,10)})).record;
  const measurement=(await command('lab-results',{labReportId:report.id,testName:'Synthetic verification measurement',numericValue:'5.2000',unit:'synthetic-unit',referenceText:'Synthetic example only; no clinical reference range.'})).record;
  const unreleased=await request<{labReports:Array<{id:string}>;labResults:Array<{id:string}>}>(`${path}/clinical-records`,{cookie:patient});
  requireCondition(!unreleased.labReports.some(row=>row.id===report.id)&&!unreleased.labResults.some(row=>row.id===measurement.id),'UNREVIEWED_REPORT_RELEASED');
  await command(`lab-reports/${report.id}/review`,{decision:'reviewed'});
  const analysis=(await command('analyses',{labReportId:report.id,consultationId:consultation.id})).record;
  await command(`analyses/${analysis.id}/review`,{decision:'accepted'});
  const treatment=(await command('treatment-plans',{consultationId:consultation.id,title:'Synthetic verification plan',description:'Synthetic clinician-authored persistence fixture. No medication is prescribed.',status:'approved'})).record;
  const followup=(await command('followups',{consultationId:consultation.id,dueAt:new Date(Date.now()+7*86400000).toISOString(),reason:'Synthetic verification follow-up only.'})).record;
  const released=await request<{labReports:Array<{id:string}>;labResults:Array<{id:string;numericValue:string}>;analyses:Array<{id:string;sources:Array<{resourceId:string}>}>;treatmentPlans:Array<{id:string}>;followups:Array<{id:string}>}>(`${path}/clinical-records`,{cookie:patient});
  requireCondition(released.labReports.some(row=>row.id===report.id)&&released.labResults.some(row=>row.id===measurement.id&&row.numericValue==='5.2000'),'REVIEWED_MEASUREMENTS_NOT_RETRIEVABLE');
  requireCondition(released.analyses.some(row=>row.id===analysis.id&&row.sources.some(source=>source.resourceId===report.id)),'ANALYSIS_PROVENANCE_NOT_RETRIEVABLE');
  requireCondition(released.treatmentPlans.some(row=>row.id===treatment.id)&&released.followups.some(row=>row.id===followup.id),'PLAN_OR_FOLLOWUP_NOT_RETRIEVABLE');

  progress('database_record_verification');
  const persisted=(await db.pool.query<{document_count:number;checksum_matches:boolean;replay_count:number;note_signed:boolean;analysis_reviewed:boolean;source_count:number}>(`SELECT
   (SELECT count(*)::int FROM medical_documents WHERE id=$1 AND organization_id=$2 AND patient_id=$3) AS document_count,
   (SELECT checksum=$4 AND processing_status='ready' FROM medical_documents WHERE id=$1) AS checksum_matches,
   (SELECT count(*)::int FROM clinical_record_commands WHERE organization_id=$2 AND actor_id=$5 AND idempotency_key=$6) AS replay_count,
   (SELECT status='signed' AND signed_at IS NOT NULL FROM clinical_notes WHERE id=$7) AS note_signed,
   (SELECT status='reviewed' AND reviewed_by=$8 FROM ai_analyses WHERE id=$9) AS analysis_reviewed,
   (SELECT count(*)::int FROM ai_analysis_sources WHERE analysis_id=$9 AND lab_report_id=$10 AND patient_id=$3) AS source_count`,
   [documentId,ORGANIZATION,PATIENT_A,checksum,fixtureUsers[2]!.id,uploadKey,note.id,fixtureUsers[0]!.id,analysis.id,report.id])).rows[0];
  requireCondition(persisted?.document_count===1&&persisted.checksum_matches&&persisted.replay_count===1&&persisted.note_signed&&persisted.analysis_reviewed&&persisted.source_count===1,'PERSISTED_RECORD_VERIFICATION_FAILED');
  return {status:'passed',database:'live-neon-development',storage:'live-neon-private-object-storage',httpTransport:true,syntheticFixtureUsers:4,clerkApiCalls:0,liveClerkAuthenticationVerified:false,identityVerification:'injected-test-boundary',consultation:true,signedNote:true,reviewedReport:true,exactDecimalMeasurement:true,analysisProvenance:true,clinicianApprovedPlan:true,followup:true,documentChecksum:true,documentReplay:true,signedDownload:true,attachmentDownload:true,anonymousObjectDenied:true,crossPatientDenied:true,coordinatorWritesDenied:true,unauthenticatedDenied:true,fixturesRetained:true};
 }finally{
  identities.clear();
  try{if(app)await app.close();else store.close?.();}finally{await db.close();}
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{process.stdout.write(JSON.stringify(await verifyNeonDevelopment())+'\n');}
 catch(error){
  const failure=error instanceof VerificationFailure?error:undefined;
  process.stderr.write(JSON.stringify({status:'failed',phase,code:failure?.code??'UNEXPECTED_FAILURE',...(failure?.httpStatus?{httpStatus:failure.httpStatus}:{})})+'\n');
  process.exitCode=1;
 }
}
