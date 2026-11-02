import {createHash,randomUUID} from 'node:crypto';
import type {Db,Transaction} from '../../../db/src/index.ts';
import {publicUser,type UserRow} from '../../../auth/src/index.ts';
import {WorkflowService} from '../service.ts';
import {createDocumentExtractor,extractNativePdf,ExtractionFailure,type DocumentExtraction,type DocumentExtractor} from './extraction.ts';
import {createDocumentScanner,type DocumentScanner,type ScanResult} from './scanner.ts';
import {resolveDocumentStorage,verifyDocumentBytes,DEFAULT_MAX_DOCUMENT_BYTES,type DocumentStorage} from './storage.ts';

type Job={id:string;organization_id:string;patient_id:string;document_id:string;document_version_id:string;attempts:number;max_attempts:number;lease_token:string};
type Version={storage_provider:string;storage_bucket:string;storage_key:string;checksum_sha256:string;file_size:string;mime_type:string;created_by:string};
type CurrentDocument={id:string;current_version_id:string;deleted_at:Date|null;mdms_managed:boolean;encounter_id:string|null;security_status:string};
export type DocumentProcessingOptions={storageFor?:(provider:string,bucket:string)=>DocumentStorage|null;scanner?:DocumentScanner;extractor?:DocumentExtractor;limit?:number;documentIds?:string[]};
export type DocumentProcessingCounts={claimed:number;completed:number;failed:number;retried:number;cancelled:number};
const failures:Record<string,string>={SCANNER_UNAVAILABLE:'Security scanning is unavailable. The file remains quarantined.',MALWARE_DETECTED:'Security checks rejected this file. Upload a new file.',OCR_UNAVAILABLE:'Text recognition is unavailable. The original needs manual review.',DOCUMENT_STORAGE_UNAVAILABLE:'The private file could not be retrieved. Retry processing.',INTEGRITY_MISMATCH:'File integrity verification failed. Upload the document again.',PDF_ACTIVE_CONTENT:'The PDF contains active content and cannot be processed.',INVALID_PDF:'This PDF could not be parsed. Upload a readable PDF or image.',PDF_PAGE_LIMIT:'This document exceeds the supported page limit.',DOCUMENT_SIZE_LIMIT:'The document exceeds the supported file-size limit.',AUTHORIZATION_REVOKED:'Processing stopped because uploader access is no longer active.',DOCUMENT_VERSION_CHANGED:'Processing stopped because the current document version changed.',PROCESSING_RETRIES_EXHAUSTED:'Processing did not finish after the configured attempts.',PROCESSING_FAILED:'Document processing could not finish. Retry or request manual review.'};
function safeFailure(error:unknown){const code=error instanceof ExtractionFailure&&/^[A-Z_]{1,60}$/.test(error.code)?error.code:'PROCESSING_FAILED';return {code,message:failures[code]??failures.PROCESSING_FAILED!,retryable:error instanceof ExtractionFailure&&error.retryable};}

/** Claim short transactions; never hold row locks while downloading or calling a processor. */
async function claim(db:Db,documentIds?:string[]):Promise<{job:Job|null;exhausted:Job|null}>{return db.transaction(async tx=>{
 const pending=(await tx.query<Job>("SELECT * FROM document_processing_jobs WHERE processing_type='extract' AND ($1::uuid[] IS NULL OR document_id=ANY($1::uuid[])) AND ((status IN ('pending','retry_pending') AND available_at<=now()) OR (status='processing' AND lease_expires_at<now())) ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1",[documentIds??null])).rows[0];
 if(!pending)return {job:null,exhausted:null};
 if(pending.attempts>=pending.max_attempts){
  await tx.query("UPDATE document_processing_jobs SET status='failed',failure_code='PROCESSING_RETRIES_EXHAUSTED',sanitized_failure_message=$2,lease_token=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now() WHERE id=$1",[pending.id,failures.PROCESSING_RETRIES_EXHAUSTED]);
  return {job:null,exhausted:pending};
 }
 const job=(await tx.query<Job>("UPDATE document_processing_jobs SET status='processing',attempts=attempts+1,lease_token=$2,lease_expires_at=now()+interval '5 minutes',started_at=coalesce(started_at,now()),failure_code=NULL,sanitized_failure_message=NULL,updated_at=now() WHERE id=$1 RETURNING *",[pending.id,randomUUID()])).rows[0]!;
 return {job,exhausted:null};
});}
async function active(tx:Transaction,db:Db,job:Job,version:Version):Promise<CurrentDocument|null>{
 // Lock order matches document mutation: document, then job. Claim only holds job briefly.
 const doc=(await tx.query<CurrentDocument>('SELECT id,current_version_id,deleted_at,mdms_managed,encounter_id,security_status FROM medical_documents WHERE organization_id=$1 AND patient_id=$2 AND id=$3 FOR UPDATE',[job.organization_id,job.patient_id,job.document_id])).rows[0];
 const lease=(await tx.query('SELECT id FROM document_processing_jobs WHERE id=$1 AND lease_token=$2 AND status=\'processing\' AND lease_expires_at>now() FOR UPDATE',[job.id,job.lease_token])).rowCount;
 if(!lease)return null;
 let reason:string|null=!doc||doc.deleted_at||!doc.mdms_managed||doc.current_version_id!==job.document_version_id?'DOCUMENT_VERSION_CHANGED':null;
 if(!reason){const workflow=new WorkflowService(db),row=(await tx.query<UserRow>('SELECT u.*,cp.verification_status AS clinician_status FROM users u LEFT JOIN clinician_profiles cp ON cp.user_id=u.id WHERE u.id=$1 FOR SHARE OF u',[version.created_by])).rows[0],actor=row?publicUser(row):undefined;if(!actor||!['patient','clinician'].includes(actor.role)||!await workflow.canAccessPatient(actor,job.patient_id,job.organization_id,tx))reason='AUTHORIZATION_REVOKED';else if(actor.role==='clinician'&&(await tx.query("SELECT user_id FROM clinician_profiles WHERE user_id=$1 AND verification_status='approved' FOR SHARE",[actor.id])).rowCount!==1)reason='AUTHORIZATION_REVOKED';}
 if(reason){
  await tx.query("UPDATE document_processing_jobs SET status='cancelled',failure_code=$3,sanitized_failure_message=$4,lease_token=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now() WHERE id=$1 AND lease_token=$2",[job.id,job.lease_token,reason,failures[reason]]);
  if(doc?.current_version_id===job.document_version_id&&!doc.deleted_at)await tx.query("UPDATE medical_documents SET processing_stage='cancelled',updated_at=now() WHERE id=$1",[job.document_id]);
  return null;
 }
 return doc!;
}
async function audit(tx:Transaction,job:Job,actorId:string,action:string,metadata:Record<string,unknown>={}){
 await tx.query('INSERT INTO audit_events(id,organization_id,actor_id,action,request_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),job.organization_id,actorId,`document.${action}`,job.id,JSON.stringify({documentId:job.document_id,versionId:job.document_version_id,...metadata})]);
}
async function persistScan(db:Db,job:Job,version:Version,scan:ScanResult){return db.transaction(async tx=>{
 if(!await active(tx,db,job,version))return false;
 await tx.query('UPDATE medical_documents SET security_status=$2,processing_stage=$3,processing_status=$4,updated_at=now() WHERE id=$1',[job.document_id,scan.status,scan.status==='safe'?'extracting':scan.status==='infected'?'failed':'unavailable',scan.status==='safe'?'ready':'failed']);
 if(scan.status!=='unavailable')await tx.query('INSERT INTO document_security_checks(organization_id,patient_id,document_id,document_version_id,provider,verdict,checksum_sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[job.organization_id,job.patient_id,job.document_id,job.document_version_id,scan.provider,scan.status,version.checksum_sha256]);
 await tx.query('UPDATE document_processing_jobs SET provider=$3,updated_at=now() WHERE id=$1 AND lease_token=$2',[job.id,job.lease_token,scan.provider]);
 await audit(tx,job,version.created_by,'security_checked',{verdict:scan.status,provider:scan.provider,syntheticFixture:scan.syntheticFixture===true});return true;
});}
async function persistExtraction(db:Db,job:Job,version:Version,result:DocumentExtraction){return db.transaction(async tx=>{
 const doc=await active(tx,db,job,version);if(!doc)return false;
 if(doc.security_status!=='safe')throw new ExtractionFailure('SCANNER_UNAVAILABLE');
 const inserted=(await tx.query<{id:string}>('INSERT INTO document_extractions(organization_id,patient_id,document_id,document_version_id,extractor_name,extractor_model_version,detected_document_type,structured_output,extraction_confidence,extraction_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(document_version_id,extraction_version) DO NOTHING RETURNING id',[job.organization_id,job.patient_id,job.document_id,job.document_version_id,result.provider,result.modelVersion,result.metadata.detectedDocumentType,JSON.stringify(result),result.confidence,result.status])).rows[0];
 if(inserted){
  for(const [index,observation] of result.observations.entries()){
   const columns=['organization_id','patient_id','document_id','document_version_id','encounter_id','extraction_id','source_index','test_name','original_value','numeric_value','text_value','original_unit','unit','reference_range_low','reference_range_high','reference_range_text','result_flag','specimen_type','method','observed_at','source_page','source_location','source_text','original_source','confidence','validation_warnings'];
   const values=[job.organization_id,job.patient_id,job.document_id,job.document_version_id,doc.encounter_id,inserted.id,index,observation.testName,observation.originalValue,observation.numericValue,observation.textValue,observation.originalUnit,observation.originalUnit,observation.referenceRangeLow,observation.referenceRangeHigh,observation.referenceRangeText,observation.resultFlag,observation.specimenType,observation.method,observation.observedAt,observation.sourcePage,JSON.stringify(observation.sourceLocation),observation.sourceText,JSON.stringify(observation),observation.confidence,JSON.stringify(observation.validationWarnings)];
   await tx.query(`INSERT INTO clinical_observations(${columns.join(',')}) VALUES(${values.map((_,i)=>`$${i+1}`).join(',')}) ON CONFLICT(extraction_id,source_index) DO NOTHING`,values);
  }
  // Detected metadata stays inside the immutable extraction until a clinician/patient deliberately accepts edits.
  await tx.query("UPDATE medical_documents SET processing_status='ready',processing_stage='awaiting_review',clinical_review_status='pending_review',search_text=$2,updated_at=now() WHERE id=$1",[job.document_id,result.pages.flatMap(page=>page.lines.map(line=>line.text)).join('\n').slice(0,250000)]);
  await tx.query("INSERT INTO document_timeline_events(organization_id,patient_id,document_id,document_version_id,event_type,event_key,actor_id) VALUES($1,$2,$3,$4,'document_extracted',$5,$6) ON CONFLICT(event_key) DO NOTHING",[job.organization_id,job.patient_id,job.document_id,job.document_version_id,`extracted:${job.document_version_id}`,version.created_by]);
  await audit(tx,job,version.created_by,'extraction_completed',{observationCount:result.observations.length,provider:result.provider,status:result.status});
 }
 await tx.query("UPDATE document_processing_jobs SET status='completed',provider=$3,completed_at=now(),lease_token=NULL,lease_expires_at=NULL,failure_code=NULL,sanitized_failure_message=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2",[job.id,job.lease_token,result.provider]);return true;
});}
async function persistFailure(db:Db,job:Job,version:Version,error:unknown):Promise<'failed'|'retried'|'cancelled'>{
 const failure=safeFailure(error);return db.transaction(async tx=>{
  const doc=await active(tx,db,job,version);if(!doc)return 'cancelled';
  const retry=failure.retryable&&job.attempts<job.max_attempts;
  await tx.query("UPDATE document_processing_jobs SET status=$3,available_at=now()+($4*interval '1 second'),failure_code=$5,sanitized_failure_message=$6,completed_at=CASE WHEN $3='failed' THEN now() ELSE NULL END,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2",[job.id,job.lease_token,retry?'retry_pending':'failed',Math.min(600,30*2**(job.attempts-1)),failure.code,failure.message]);
  const unavailable=failure.code.endsWith('_UNAVAILABLE');
  await tx.query('UPDATE medical_documents SET processing_stage=$2,processing_status=$3,updated_at=now() WHERE id=$1',[job.document_id,retry?'security_checks':unavailable?'unavailable':'failed',doc.security_status==='safe'?'ready':'failed']);
  await audit(tx,job,version.created_by,'processing_failed',{code:failure.code,retry});return retry?'retried':'failed';
 });
}
/** Durable, idempotent processing. All rows remain provisional; this never approves clinical data. */
export async function processDocumentJobs(db:Db,options:DocumentProcessingOptions={}):Promise<DocumentProcessingCounts>{
 const scanner=options.scanner??createDocumentScanner(),extractor=options.extractor??createDocumentExtractor();
 const counts:DocumentProcessingCounts={claimed:0,completed:0,failed:0,retried:0,cancelled:0};
 if(options.documentIds){if(options.documentIds.length>10||options.documentIds.some(id=>!/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(id)))throw new Error('Processing scope must contain at most ten document UUIDs.');if(!options.documentIds.length)return counts;}
 for(let n=0;n<Math.max(1,Math.min(10,options.limit??1));n++){
  const claimed=await claim(db,options.documentIds);if(claimed.exhausted){
   // Claim transaction released its job lock before taking the document lock.
   await db.pool.query("UPDATE medical_documents SET processing_stage='failed',updated_at=now() WHERE id=$1 AND current_version_id=$2 AND deleted_at IS NULL AND processing_stage IN ('security_checks','extracting') AND EXISTS(SELECT 1 FROM document_processing_jobs WHERE id=$3 AND status='failed' AND failure_code='PROCESSING_RETRIES_EXHAUSTED')",[claimed.exhausted.document_id,claimed.exhausted.document_version_id,claimed.exhausted.id]);counts.claimed++;counts.failed++;continue;
  }if(!claimed.job)break;
  const job=claimed.job;counts.claimed++;
  const version=(await db.pool.query<Version>('SELECT storage_provider,storage_bucket,storage_key,checksum_sha256,file_size,mime_type,created_by FROM document_versions WHERE organization_id=$1 AND patient_id=$2 AND document_id=$3 AND id=$4',[job.organization_id,job.patient_id,job.document_id,job.document_version_id])).rows[0];
  if(!version)throw new Error('Document version integrity violation');
  let store:DocumentStorage|null=null;
  try{
   if(!await db.transaction(tx=>active(tx,db,job,version))){counts.cancelled++;continue;}
   store=options.storageFor?options.storageFor(version.storage_provider,version.storage_bucket):resolveDocumentStorage(version.storage_provider);
   if(!store||store.bucket!==version.storage_bucket)throw new ExtractionFailure('DOCUMENT_STORAGE_UNAVAILABLE',true);
   let bytes:Uint8Array;try{bytes=await store.getObjectBytes(version.storage_key,DEFAULT_MAX_DOCUMENT_BYTES);}catch{throw new ExtractionFailure('DOCUMENT_STORAGE_UNAVAILABLE',true);}
   if(bytes.byteLength!==Number(version.file_size)||createHash('sha256').update(bytes).digest('hex')!==version.checksum_sha256)throw new ExtractionFailure('INTEGRITY_MISMATCH');
   try{verifyDocumentBytes(bytes,version.mime_type);}catch{throw new ExtractionFailure('INTEGRITY_MISMATCH');}
   const scan=await scanner.scan(bytes);
   // Do not publish a downloadable safe verdict before rejecting PDF active content.
   const validatedPdfPages=scan.status==='safe'&&version.mime_type==='application/pdf'?await extractNativePdf(bytes):undefined;
   if(!await persistScan(db,job,version,scan)){counts.cancelled++;continue;}
   if(scan.status!=='safe')throw new ExtractionFailure(scan.status==='infected'?'MALWARE_DETECTED':'SCANNER_UNAVAILABLE',scan.provider==='clamav'&&scan.status==='unavailable');
   const result=await extractor.extract(bytes,version.mime_type,validatedPdfPages);
   if(await persistExtraction(db,job,version,result))counts.completed++;else counts.cancelled++;
  }catch(error){counts[await persistFailure(db,job,version,error)]++;}
  finally{if(!options.storageFor)store?.close?.();}
 }
 return counts;
}
