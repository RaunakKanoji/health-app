import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import type {CareLoopApp} from '../apps/api/src/app.ts';
import type {IdentityVerifier,VerifiedIdentity} from '../packages/auth/src/clerk.ts';
import type {DocumentUploadSession,ManagedDocument,DocumentDetailResponse,DocumentFileResponse} from '../packages/contracts/src/documents.ts';

// Explicit integration probe. It never creates Clerk identities or alters existing application users.
// Invoke only with the designated branch file: node --env-file=.env.neon-development --import tsx scripts/verify-document-development.ts
const EXPECTED_BRANCH='br-cold-haze-b30hq0yn';
const EXPECTED_DATABASE='ep-mute-smoke-b3oy0p7l.c-4.ap-southeast-1.aws.neon.tech';
const ORGANIZATION='org-neon-development-verification';
const PATIENT='neon-verification-patient-a';
const BUCKET='careloop-medical-documents';
const FIXTURE_IDS=['neon-verification-patient-user-a','neon-verification-patient-user-b','neon-verification-clinician'] as const;
let phase='configuration';
class VerificationFailure extends Error{constructor(readonly code:string,readonly status?:number){super(code);}}
function requireCondition(value:unknown,code:string):asserts value{if(!value)throw new VerificationFailure(code);}
function progress(value:string){phase=value;process.stdout.write(JSON.stringify({phase,status:'running'})+'\n');}
type FixtureUser={id:string;email:string;name:string;role:string;patient_id:string|null;clerk_user_id:string;organization_id:string;account_status:string;onboarding_completed:boolean};

export async function verifyDocumentDevelopment(){
 const loaded={...process.env};
 requireCondition(loaded.DATABASE_ENVIRONMENT==='development','DEVELOPMENT_ENVIRONMENT_REQUIRED');
 requireCondition(['development',EXPECTED_BRANCH].includes(loaded.NEON_BRANCH??''),'EXPECTED_BRANCH_REQUIRED');
 const runtime=loaded.DATABASE_URL,direct=loaded.DATABASE_URL_UNPOOLED??loaded.DATABASE_DIRECT_URL;
 requireCondition(runtime&&direct,'DEVELOPMENT_DATABASE_CONNECTIONS_REQUIRED');
 requireCondition(new URL(direct).hostname===EXPECTED_DATABASE&&new URL(runtime).hostname.replace('-pooler.','.')===EXPECTED_DATABASE,'EXPECTED_DEVELOPMENT_DATABASE_REQUIRED');
 const endpoint=loaded.AWS_ENDPOINT_URL_S3;requireCondition(endpoint,'DEVELOPMENT_STORAGE_ENDPOINT_REQUIRED');
 const storageUrl=new URL(endpoint);
 requireCondition(storageUrl.protocol==='https:'&&storageUrl.hostname.startsWith(`${EXPECTED_BRANCH}.storage.`)&&storageUrl.hostname.endsWith('.neon.tech')&&!storageUrl.username&&!storageUrl.password&&!storageUrl.search&&!storageUrl.hash,'EXPECTED_DEVELOPMENT_STORAGE_REQUIRED');
 requireCondition(loaded.AWS_ACCESS_KEY_ID&&loaded.AWS_SECRET_ACCESS_KEY&&loaded.AWS_REGION,'COMPLETE_DEVELOPMENT_STORAGE_TUPLE_REQUIRED');
 requireCondition(!loaded.DOCUMENT_STORAGE_BUCKET||loaded.DOCUMENT_STORAGE_BUCKET===BUCKET,'EXPECTED_BUCKET_REQUIRED');
 Object.assign(process.env,{DATABASE_URL:runtime,DATABASE_DIRECT_URL:direct,DATABASE_URL_UNPOOLED:direct,DATABASE_RUNTIME_URL:runtime,DATABASE_ENVIRONMENT:'development',DEMO_MODE:'true',DEFAULT_ORGANIZATION_ID:ORGANIZATION,DOCUMENT_STORAGE_PROVIDER:'neon',DOCUMENT_STORAGE_PRIVATE:'true',DOCUMENT_STORAGE_BUCKET:BUCKET,DOCUMENT_SYNTHETIC_FIXTURES:'true',DOCUMENT_EXTERNAL_PROCESSING_ALLOWED:'false'});
 // Pin branch credentials before any application module may load the normal .env file.
 const [{createDatabase,verifyMigrations},{buildApp},{DomainError},{createDocumentStorage},{createDocumentScanner},{createDocumentExtractor},{processDocumentJobs},{syntheticDocumentFixtures}]=await Promise.all([
  import('../packages/db/src/index.ts'),import('../apps/api/src/app.ts'),import('../packages/domain/src/index.ts'),import('../packages/workflows/src/documents/storage.ts'),import('../packages/workflows/src/documents/scanner.ts'),import('../packages/workflows/src/documents/extraction.ts'),import('../packages/workflows/src/documents/processing.ts'),import('../packages/workflows/src/documents/synthetic-fixtures.ts'),
 ]);
 const db=createDatabase(direct,{max:2}),store=createDocumentStorage({...loaded,DOCUMENT_STORAGE_PROVIDER:'neon',DOCUMENT_STORAGE_PRIVATE:'true',DOCUMENT_STORAGE_BUCKET:BUCKET});
 requireCondition(store,'PRIVATE_STORAGE_REQUIRED');let app:CareLoopApp|undefined;let browser:import('@playwright/test').Browser|undefined;let page:import('@playwright/test').Page|undefined;
 const identities=new Map<string,VerifiedIdentity>(),cookies=new Map<string,string>();
 try{
  progress('read_only_migration_and_fixture_guards');
  const migration=await verifyMigrations(db);requireCondition(migration.pending.length===0&&migration.applied.includes('0007_document_management.sql'),'REVIEWED_MIGRATIONS_MUST_ALREADY_BE_APPLIED');
  const users=(await db.pool.query<FixtureUser>('SELECT * FROM users WHERE id=ANY($1::text[])',[FIXTURE_IDS])).rows;
  requireCondition(users.length===3&&users.every(user=>user.organization_id===ORGANIZATION&&user.account_status==='active'&&user.onboarding_completed&&user.clerk_user_id===`user_neon_verification_${user.id.replaceAll('-','_')}`&&user.email===`${user.id}@example.invalid`),'EXISTING_SYNTHETIC_IDENTITIES_REQUIRED');
  requireCondition(users.find(user=>user.id===FIXTURE_IDS[0])?.patient_id===PATIENT&&users.find(user=>user.id===FIXTURE_IDS[1])?.patient_id==='neon-verification-patient-b'&&users.find(user=>user.id===FIXTURE_IDS[2])?.role==='clinician','EXPECTED_FIXTURE_ROLES_REQUIRED');
  requireCondition((await db.pool.query("SELECT id FROM patients WHERE organization_id=$1 AND id=$2 AND synthetic=true",[ORGANIZATION,PATIENT])).rowCount===1,'SYNTHETIC_PATIENT_REQUIRED');
  for(const user of users){const token=randomUUID();cookies.set(user.id,`__session=${token}`);identities.set(token,{clerkUserId:user.clerk_user_id,email:user.email,name:user.name,emailVerified:true,sessionId:`sess_mdms_fixture_${randomUUID()}`,updatedAt:Date.now()});}
  const identityVerifier:IdentityVerifier=async request=>{const identity=identities.get(request.cookies.__session??'');if(!identity)throw new DomainError('UNAUTHENTICATED','Synthetic verification session required.',401);return identity;};
  app=await buildApp({databaseUrl:runtime,seed:false,identityVerifier,documentStore:null,documentManagementStorage:store});
  const address=await app.listen({host:'127.0.0.1',port:0}),base=`/api/patients/${PATIENT}/documents`,patient=cookies.get(FIXTURE_IDS[0])!,other=cookies.get(FIXTURE_IDS[1])!,clinician=cookies.get(FIXTURE_IDS[2])!,run=randomUUID();
  async function request<T>(path:string,options:{cookie?:string;body?:object;method?:string;key?:string;expected?:number}={}):Promise<T>{
   const response=await fetch(new URL(path,address),{method:options.method??(options.body?'POST':'GET'),headers:{...(options.cookie?{cookie:options.cookie}:{}),...(options.body?{'content-type':'application/json'}:{}),...(options.key?{'idempotency-key':options.key}:{})},body:options.body?JSON.stringify(options.body):undefined,signal:AbortSignal.timeout(30000)});
   const body=await response.json() as T&{error?:{code?:string}};if(response.status!==(options.expected??200))throw new VerificationFailure(body.error?.code&&/^[A-Z_]+$/.test(body.error.code)?body.error.code:'HTTP_STATUS_MISMATCH',response.status);return body;
  }
  if(loaded.DOCUMENT_VERIFY_BROWSER==='true'){
   const {chromium}=await import('@playwright/test');browser=await chromium.launch({headless:true});page=await browser.newPage();
   await page.route('http://localhost:3001/__mdms_storage_probe',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Synthetic private storage verification</title><p>Private synthetic document storage verification</p>'}));
   await page.goto('http://localhost:3001/__mdms_storage_probe');
  }
  progress('direct_upload_and_idempotency');const fixture=syntheticDocumentFixtures.hba1c;
  const session=await request<DocumentUploadSession>(`${base}/upload/init`,{cookie:patient,key:`${run}:init`,body:{title:'Synthetic MDMS development verification',description:'Synthetic source fixture; software verification only.',documentType:'laboratory_report',filename:fixture.filename,mimeType:fixture.mimeType,fileSize:fixture.bytes.byteLength,checksumSha256:fixture.sha256,tags:['synthetic-verification']}});
  const signedUpload=new URL(session.uploadUrl);requireCondition(signedUpload.hostname===storageUrl.hostname&&signedUpload.pathname.startsWith(`/${BUCKET}/document-uploads/`),'SIGNED_UPLOAD_SCOPE_FAILED');
  if(page){const result=await page.evaluate(async({url,headers,base64})=>{const body=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));const response=await fetch(url,{method:'PUT',headers,body,credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(30000)});await response.body?.cancel();return response.ok;},{url:signedUpload.href,headers:session.headers,base64:Buffer.from(fixture.bytes).toString('base64')});requireCondition(result,'BROWSER_SIGNED_UPLOAD_FAILED');}
  else {const put=await fetch(signedUpload,{method:'PUT',headers:session.headers,body:Buffer.from(fixture.bytes),redirect:'error',signal:AbortSignal.timeout(30000)});await put.body?.cancel();requireCondition(put.ok,'SIGNED_UPLOAD_FAILED');}
  const completed=await request<{document:ManagedDocument}>(`${base}/upload/complete`,{cookie:patient,key:`${run}:complete`,body:{sessionId:session.sessionId}}),document=completed.document;
  const replay=await request<{document:ManagedDocument}>(`${base}/upload/complete`,{cookie:patient,key:`${run}:complete`,body:{sessionId:session.sessionId}});requireCondition(replay.document.id===document.id&&document.checksumSha256===fixture.sha256,'UPLOAD_REPLAY_OR_CHECKSUM_FAILED');
  requireCondition(document.securityStatus==='awaiting_scan'&&document.processingStage==='security_checks','UPLOAD_NOT_QUARANTINED');
  await request(`${base}/${document.id}/preview`,{cookie:patient,expected:409});await request(`${base}/${document.id}/detail`,{cookie:other,expected:404});await request(`${base}/${document.id}/detail`,{expected:401});
  progress('exact_fixture_scanning_and_native_pdf_processing');
  const counts=await processDocumentJobs(db,{storageFor:(provider,bucket)=>provider===store.provider&&bucket===store.bucket?store:null,documentIds:[document.id],limit:1,scanner:createDocumentScanner({DOCUMENT_SYNTHETIC_FIXTURES:'true',DEMO_MODE:'true',DATABASE_ENVIRONMENT:'development'}),extractor:createDocumentExtractor({DOCUMENT_EXTERNAL_PROCESSING_ALLOWED:'false'})});
  requireCondition(counts.completed===1,'NATIVE_PDF_PROCESSING_FAILED');
  const detail=await request<DocumentDetailResponse>(`${base}/${document.id}/detail`,{cookie:patient});requireCondition(detail.document.securityStatus==='safe'&&detail.observations.length===1&&detail.observations[0]?.verificationStatus==='unverified'&&detail.observations[0]?.numericValue==='5.2000','PROVISIONAL_EXTRACTION_FAILED');
  const scan=(await db.pool.query('SELECT provider,verdict,checksum_sha256 FROM document_security_checks WHERE document_version_id=$1',[document.currentVersionId])).rows;
  requireCondition(scan.some(row=>row.provider==='synthetic-fixture-sha256'&&row.verdict==='safe'&&row.checksum_sha256===fixture.sha256),'EXACT_VERSION_SCAN_PROOF_MISSING');
  progress('explicit_clinician_review_and_clinical_context');
  const observation=detail.observations[0]!;
  await request(`${base}/${document.id}/review`,{cookie:patient,key:`${run}:denied-review`,expected:403,body:{versionId:document.currentVersionId,status:'approved',reviewNotes:'Forbidden patient approval fixture'}});
  await request(`${base}/${document.id}/observations/${observation.id}`,{cookie:clinician,method:'PATCH',key:`${run}:verify-observation`,body:{verificationStatus:'verified',reason:'Compared exact synthetic HbA1c fixture source, value, unit and date.'}});
  await request(`${base}/${document.id}/review`,{cookie:clinician,key:`${run}:review`,body:{versionId:document.currentVersionId,status:'approved',reviewNotes:'Reviewed the complete synthetic fixture. No patient diagnosis or treatment.'}});
  const context=await request<{documentObservations:Array<{id:string}>}>(`/api/patients/${PATIENT}/clinical-context`,{cookie:patient,body:{includeAIHistory:false}});requireCondition(context.documentObservations.some(row=>row.id===observation.id),'APPROVED_CONTEXT_MISSING');
  progress('signed_private_download');
  const download=await request<DocumentFileResponse>(`${base}/${document.id}/download-managed`,{cookie:patient});const url=new URL(download.url);requireCondition(download.expiresIn===60&&url.hostname===storageUrl.hostname&&url.pathname.startsWith(`/${BUCKET}/medical-documents/`),'SIGNED_DOWNLOAD_SCOPE_FAILED');
  const result=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000)});requireCondition(result.ok&&result.headers.get('content-disposition')?.startsWith('attachment'),'SIGNED_DOWNLOAD_FAILED');requireCondition(createHash('sha256').update(Buffer.from(await result.arrayBuffer())).digest('hex')===fixture.sha256,'DOWNLOADED_BYTES_DIFFER');
  if(page){const digest=await page.evaluate(async(url)=>{const response=await fetch(url,{credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('Private download failed');const digest=await crypto.subtle.digest('SHA-256',await response.arrayBuffer());return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');},url.href);requireCondition(digest===fixture.sha256,'BROWSER_DOWNLOADED_BYTES_DIFFER');}
  url.search='';const anonymous=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});await anonymous.body?.cancel();requireCondition([401,403,404].includes(anonymous.status),'ANONYMOUS_OBJECT_ACCESS_ALLOWED');
  return {status:'passed',database:'live-neon-development',storage:'live-neon-private',httpTransport:true,browserStorageRoundtrip:Boolean(page),signedDirectUpload:true,immutableVersionChecksum:true,quarantineBeforeScan:true,exactSyntheticFixtureScan:true,liveMalwareScannerVerified:false,nativePdfExtraction:true,provisionalObservations:true,manualClinicianReview:true,approvedClinicalContext:true,signedDownload:true,anonymousObjectDenied:true,crossPatientDenied:true,idempotencyReplay:true,liveClerkAuthenticationVerified:false,identityVerification:'injected-existing-synthetic-fixtures',externalClinicalProcessorCalls:0,fixtureDocumentRetained:true};
 }finally{identities.clear();await browser?.close();try{await app?.close();}finally{store.close?.();await db.close();}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{process.stdout.write(JSON.stringify(await verifyDocumentDevelopment())+'\n');}
 catch(error){const failure=error instanceof VerificationFailure?error:undefined;process.stderr.write(JSON.stringify({status:'failed',phase,code:failure?.code??'UNEXPECTED_FAILURE',...(failure?.status?{httpStatus:failure.status}:{})})+'\n');process.exitCode=1;}
}
