import { randomUUID } from 'node:crypto';
import type { Db, Transaction } from '../../db/src/index.ts';
import type { User } from '../../contracts/src/careloop.ts';
import { clinicalInputs, clinicalContextOptions, type ClinicalResource, type ClinicalRecords, type ClinicalRow, type ClinicalContextOptions, type ClinicalCommandResponse, type AnalysisSourceReference } from '../../contracts/src/clinical-records.ts';
import { DomainError } from '../../domain/src/index.ts';
import { WorkflowService, hash } from './service.ts';

type Row=Record<string,unknown>;
const unavailable=()=>new DomainError('NOT_FOUND','This patient record is unavailable.',404);
function camel(row:Row):ClinicalRow {
 return Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase()),value instanceof Date?value.toISOString():key==='file_size'?Number(value):value])) as ClinicalRow;
}
/** SQL identifiers here are closed, source-controlled constants, never request input. */
const collections={
 consultations:{table:'consultations',columns:'id,patient_id,clinician_id,status,encounter_type,chief_complaint,scheduled_at,started_at,completed_at,created_at'},
 notes:{table:'clinical_notes',columns:'id,patient_id,consultation_id,author_id,note_type,content,status,signed_at,revision,supersedes_note_id,created_at'},
 documents:{table:'medical_documents',columns:'id,patient_id,uploaded_by,document_type,original_filename,mime_type,file_size,checksum,processing_status,created_at'},
 labOrders:{table:'lab_orders',columns:'id,patient_id,consultation_id,ordered_by,test_name,test_code,status,ordered_at,completed_at,created_at'},
 labReports:{table:'lab_reports',columns:'id,patient_id,lab_order_id,document_id,laboratory_name,report_date,processing_status,review_status,reviewed_by,reviewed_at,created_at'},
 labResults:{table:'lab_results',columns:'id,patient_id,lab_report_id,test_name,test_code,numeric_value,text_value,unit,reference_low,reference_high,reference_text,abnormal_flag,extraction_status,source_page,collected_at,resulted_at,replaces_result_id,verified_by,verified_at,created_at'},
 analyses:{table:'ai_analyses',columns:'id,patient_id,consultation_id,analysis_type,model_provider,model_identifier,model_version,input_context_version,structured_output,status,reviewed_by,reviewed_at,supersedes_analysis_id,created_at'},
 findings:{table:'ai_findings',columns:'id,patient_id,analysis_id,finding_type,finding_text,severity,confidence,review_status,reviewed_by,reviewed_at,created_at'},
 treatmentPlans:{table:'treatment_plans',columns:'id,patient_id,consultation_id,clinician_id,title,description,status,start_date,end_date,approved_by,approved_at,created_at'},
 followups:{table:'followups',columns:'id,patient_id,consultation_id,clinician_id,due_at,scheduled_at,status,reason,completed_at,created_at'},
} as const;

export class ClinicalRecordService {
 private workflow:WorkflowService;
 constructor(private db:Db){this.workflow=new WorkflowService(db);}
 private async authorize(tx:Transaction,actor:User,patientId:string,write=false){
  if(!await this.workflow.canAccessPatient(actor,patientId,actor.organizationId,tx))throw unavailable();
  if(!(await tx.query('SELECT id FROM patients WHERE organization_id=$1 AND id=$2',[actor.organizationId,patientId])).rowCount)throw unavailable();
  if(write){
   if(actor.role!=='clinician')throw new DomainError('FORBIDDEN','An approved clinician must author or review this record.',403);
   if(!(await tx.query("SELECT user_id FROM clinician_profiles WHERE user_id=$1 AND verification_status='approved' FOR SHARE",[actor.id])).rowCount)throw new DomainError('FORBIDDEN','Clinical approval is required.',403);
  }
 }
 async patients(actor:User,limit=50,offset=0){
  return this.db.transaction(async tx=>{
   const current=(await tx.query<{account_status:string;onboarding_completed:boolean;role:string;organization_id:string}>('SELECT account_status,onboarding_completed,role,organization_id FROM users WHERE id=$1 FOR SHARE',[actor.id])).rows[0];
   if(!current||current.account_status!=='active'||!current.onboarding_completed||current.role!==actor.role||current.organization_id!==actor.organizationId)throw new DomainError('FORBIDDEN','Complete onboarding before viewing patient records.',403);
   const rows=(await tx.query<{id:string;name:string;birth_date:Date;language:string}>(`SELECT p.id,p.name,p.birth_date,p.language FROM patients p WHERE p.organization_id=$1 AND ${actor.role==='patient'?'p.id=$2':"EXISTS(SELECT 1 FROM clinician_patient_relationships r WHERE r.organization_id=p.organization_id AND r.patient_id=p.id AND r.clinician_id=$2 AND r.relationship_status='active' AND r.revoked_at IS NULL)"} ORDER BY p.name,p.id LIMIT $3 OFFSET $4`,[actor.organizationId,actor.role==='patient'?actor.patientId:actor.id,limit,offset])).rows;
   const patients=[];
   for(const p of rows)if(await this.workflow.canAccessPatient(actor,p.id,actor.organizationId,tx))patients.push({id:p.id,name:p.name,dateOfBirth:new Date(p.birth_date).toISOString().slice(0,10),preferredLanguage:p.language});
   return {patients,pagination:{limit,offset}};
  });
 }
 async records(actor:User,patientId:string,{limit=20,offset=0}={}):Promise<ClinicalRecords>{
  return this.db.transaction(async tx=>{
   await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
   return this.recordsInTransaction(tx,actor,patientId,limit,offset);
  });
 }
 private async recordsInTransaction(tx:Transaction,actor:User,patientId:string,limit:number,offset:number,selected?:Set<keyof typeof collections>):Promise<ClinicalRecords>{
   await this.authorize(tx,actor,patientId);
   const result={} as Record<keyof typeof collections,ClinicalRow[]>;
   for(const [key,def] of Object.entries(collections) as [keyof typeof collections,(typeof collections)[keyof typeof collections]][]){
    if(selected&&!selected.has(key)){result[key]=[];continue;}
    let filter='';
    if(actor.role==='patient'){
     if(key==='notes')filter=" AND status='signed'";
     if(key==='labReports')filter=" AND review_status='reviewed'";
     if(key==='labResults')filter=" AND EXISTS(SELECT 1 FROM lab_reports r WHERE r.id=lab_results.lab_report_id AND r.review_status='reviewed') AND NOT EXISTS(SELECT 1 FROM lab_results correction WHERE correction.replaces_result_id=lab_results.id)";
     if(key==='analyses')filter=" AND status='reviewed' AND EXISTS(SELECT 1 FROM ai_analysis_sources s JOIN lab_reports r ON r.id=s.lab_report_id WHERE s.analysis_id=ai_analyses.id AND r.review_status='reviewed')";
     if(key==='findings')filter=" AND review_status='accepted' AND EXISTS(SELECT 1 FROM ai_analyses a JOIN ai_analysis_sources s ON s.analysis_id=a.id JOIN lab_reports r ON r.id=s.lab_report_id WHERE a.id=ai_findings.analysis_id AND a.status='reviewed' AND r.review_status='reviewed')";
     if(key==='treatmentPlans')filter=" AND status IN ('approved','completed')";
     // Documents uploaded by staff become patient-visible only after their report is reviewed.
     if(key==='documents')filter=" AND processing_status='ready' AND (uploaded_by=$5 OR EXISTS(SELECT 1 FROM lab_reports r WHERE r.document_id=medical_documents.id AND r.review_status='reviewed'))";
    }
    if(key==='documents')filter+=" AND deleted_at IS NULL AND (NOT mdms_managed OR (security_status='safe' AND processing_stage NOT IN ('uploading','security_checks')))";
    const args:unknown[]=[actor.organizationId,patientId,limit,offset];if(key==='documents'&&actor.role==='patient')args.push(actor.id);
    result[key]=(await tx.query(`SELECT ${def.columns} FROM ${def.table} WHERE organization_id=$1 AND patient_id=$2${filter} ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,args)).rows.map(camel);
   }
   if(result.analyses.length){
    const sources=(await tx.query<{id:string;analysis_id:string;consultation_id:string|null;lab_report_id:string|null;document_id:string|null;observation_id:string|null;source_version:string}>('SELECT id,analysis_id,consultation_id,lab_report_id,document_id,observation_id,source_version FROM ai_analysis_sources WHERE organization_id=$1 AND patient_id=$2 AND analysis_id=ANY($3::uuid[]) ORDER BY id',[actor.organizationId,patientId,result.analyses.map(a=>a.id)])).rows;
    for(const analysis of result.analyses)analysis.sources=sources.filter(source=>source.analysis_id===analysis.id).map(source=>({id:source.id,resourceType:source.lab_report_id?'lab_report':source.consultation_id?'consultation':source.document_id?'document':'observation',resourceId:source.lab_report_id??source.consultation_id??source.document_id??source.observation_id!,sourceVersion:source.source_version} satisfies AnalysisSourceReference));
   }
   // Each projection above corresponds to the schema-inferred DTO, with timestamp
   // and bigint serialization performed only at this SQL boundary.
   return {...result,pagination:{limit,offset}} as unknown as ClinicalRecords;
 }
 async getPatientClinicalContext(actor:User,patientId:string,options:ClinicalContextOptions={}){
  const flags=clinicalContextOptions.parse(options);
  return this.db.transaction(async tx=>{
   await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
   const selected=new Set<keyof typeof collections>(['followups']);
   if(flags.includeConsultations){selected.add('consultations');selected.add('notes');}
   if(flags.includeLabResults){selected.add('labReports');selected.add('labResults');}
   if(flags.includeTreatments)selected.add('treatmentPlans');
   if(flags.includeAIHistory){selected.add('analyses');selected.add('findings');}
   const records=await this.recordsInTransaction(tx,actor,patientId,50,0,selected);
   const profile=(await tx.query('SELECT id,name,birth_date,language,synthetic FROM patients WHERE organization_id=$1 AND id=$2',[actor.organizationId,patientId])).rows[0];
   // Original observations preserve coded components and source provenance. Patients
   // see released report measurements instead of unreviewed FHIR source payloads.
   const observations=actor.role==='patient'?[]:(await tx.query('SELECT id,coding,value,effective_at,source_resource_id,created_at FROM observations WHERE organization_id=$1 AND patient_id=$2 ORDER BY effective_at DESC NULLS LAST,id LIMIT 50',[actor.organizationId,patientId])).rows.map(camel);
   const documentObservations=flags.includeLabResults?(await tx.query(`SELECT o.id,o.patient_id,o.document_id,o.document_version_id,o.test_name,o.numeric_value,o.text_value,o.original_value,o.original_unit,o.unit,o.reference_range_low,o.reference_range_high,o.reference_range_text,o.observed_at::text AS observed_at,o.source_page,o.source_text,o.verification_status,o.verified_by,o.verified_at FROM clinical_observations o JOIN medical_documents d ON d.id=o.document_id AND d.current_version_id=o.document_version_id WHERE o.organization_id=$1 AND o.patient_id=$2 AND o.verification_status='verified' AND d.deleted_at IS NULL AND d.security_status='safe' AND d.clinical_review_status='approved' ORDER BY o.observed_at DESC NULLS LAST,o.id LIMIT 50`,[actor.organizationId,patientId])).rows.map(camel):[];
   return {patient:camel(profile),observations,documentObservations,consultations:flags.includeConsultations?records.consultations:[],notes:flags.includeConsultations?records.notes:[],labReports:flags.includeLabResults?records.labReports:[],labResults:flags.includeLabResults?records.labResults:[],treatmentPlans:flags.includeTreatments?records.treatmentPlans:[],followups:records.followups,analyses:flags.includeAIHistory?records.analyses:[],findings:flags.includeAIHistory?records.findings:[],retrievedAt:new Date().toISOString(),synthetic:true,externalTransmission:false,limitations:['Bounded to 50 records per collection; use paginated records for history.','General condition, allergy and prescription modules are not implemented.','AI output is a draft until reviewed and never establishes a diagnosis.']};
  });
 }
 private async reference(tx:Transaction,actor:User,patientId:string,table:string,id:string|undefined){
  if(!id)return;
  if(!(await tx.query(`SELECT id FROM ${table} WHERE organization_id=$1 AND patient_id=$2 AND id=$3`,[actor.organizationId,patientId,id])).rowCount)throw unavailable();
 }
 private async audit(tx:Transaction,actor:User,patientId:string,resource:string,id:string,key:string){
  await tx.query('INSERT INTO audit_events(id,organization_id,actor_id,action,request_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.organizationId,actor.id,`clinical_record.${resource}`,key,JSON.stringify({patientId,resourceId:id,synthetic:true})]);
 }
 private async command(actor:User,patientId:string,action:string,input:unknown,key:string,fn:(tx:Transaction)=>Promise<Row>):Promise<{record:ClinicalRow}>{
  return this.db.transaction(async tx=>{
   await this.authorize(tx,actor,patientId,true);
   await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`clinical:${actor.organizationId}:${actor.id}:${key}`]);
   const fingerprint=hash({patientId,action,input});
   const prior=(await tx.query<{fingerprint:string;response:{record:ClinicalRow}}>('SELECT fingerprint,response FROM clinical_record_commands WHERE organization_id=$1 AND actor_id=$2 AND idempotency_key=$3',[actor.organizationId,actor.id,key])).rows[0];
   if(prior){if(prior.fingerprint!==fingerprint)throw new DomainError('IDEMPOTENCY_CONFLICT','This request key was already used for different input.',409);return prior.response;}
   let row:Row;
   try{row=await fn(tx);}catch(error){const code=(error as {code?:string}).code;if(['23503','23505','23514','22P02'].includes(code??''))throw new DomainError('RECORD_CONFLICT','The record references changed or conflict with this patient. Reload and try again.',409);throw error;}
   const response={record:camel(row)};
   await this.audit(tx,actor,patientId,action,response.record.id,key);
   await tx.query('INSERT INTO clinical_record_commands(organization_id,actor_id,patient_id,idempotency_key,fingerprint,response) VALUES($1,$2,$3,$4,$5,$6)',[actor.organizationId,actor.id,patientId,key,fingerprint,JSON.stringify(response)]);
   return response;
  });
 }
 async create<Resource extends ClinicalResource>(actor:User,patientId:string,resource:Resource,body:unknown,key:string):Promise<ClinicalCommandResponse<Resource>>{
  const parsed=clinicalInputs[resource].parse(body);
  const response=await this.command(actor,patientId,`create.${resource}`,parsed,key,async tx=>{
   const base=[actor.organizationId,patientId];
   const insert=async(table:string,fields:string[],values:unknown[])=>{
    const columns=['organization_id','patient_id',...fields];const args=[...base,...values];
    return (await tx.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${args.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,args)).rows[0] as Row;
   };
   switch(resource){
    case 'consultations':{
     const d=clinicalInputs.consultations.parse(parsed);const now=new Date().toISOString();
     return insert('consultations',['clinician_id','chief_complaint','encounter_type','status','scheduled_at','started_at','completed_at'],[actor.id,d.chiefComplaint,d.encounterType,d.status,d.scheduledAt??null,d.status==='in_progress'||d.status==='completed'?now:null,d.status==='completed'?now:null]);
    }
    case 'notes':{
     const d=clinicalInputs.notes.parse(parsed);await this.reference(tx,actor,patientId,'consultations',d.consultationId);
     let revision=1;
     if(d.supersedesNoteId){const old=(await tx.query<{revision:number;status:string}>('SELECT revision,status FROM clinical_notes WHERE organization_id=$1 AND patient_id=$2 AND consultation_id=$3 AND id=$4 FOR SHARE',[...base,d.consultationId,d.supersedesNoteId])).rows[0];if(!old)throw unavailable();if(old.status!=='signed')throw new DomainError('NOTE_REVISION_INVALID','Only a signed note can be superseded by an addendum.',409);revision=old.revision+1;}
     return insert('clinical_notes',['consultation_id','author_id','note_type','content','status','signed_at','revision','supersedes_note_id'],[d.consultationId,actor.id,d.noteType,d.content,d.status,d.status==='signed'?new Date().toISOString():null,revision,d.supersedesNoteId??null]);
    }
    case 'lab-orders':{
     const d=clinicalInputs['lab-orders'].parse(parsed);await this.reference(tx,actor,patientId,'consultations',d.consultationId);
     return insert('lab_orders',['consultation_id','ordered_by','test_name','test_code'],[d.consultationId??null,actor.id,d.testName,d.testCode??null]);
    }
    case 'lab-reports':{
     const d=clinicalInputs['lab-reports'].parse(parsed);await this.reference(tx,actor,patientId,'lab_orders',d.labOrderId);await this.reference(tx,actor,patientId,'medical_documents',d.documentId);
     if(d.documentId&&!(await tx.query("SELECT id FROM medical_documents WHERE id=$1 AND processing_status='ready' AND deleted_at IS NULL AND (NOT mdms_managed OR (security_status='safe' AND clinical_review_status='approved'))",[d.documentId])).rowCount)throw new DomainError('DOCUMENT_NOT_READY','Complete the document upload before linking a report.',409);
     return insert('lab_reports',['lab_order_id','document_id','laboratory_name','report_date','created_by','processing_status'],[d.labOrderId??null,d.documentId??null,d.laboratoryName,d.reportDate,actor.id,'processed']);
    }
    case 'lab-results':{
     const d=clinicalInputs['lab-results'].parse(parsed);await this.lockReport(tx,actor,patientId,d.labReportId);
     if(d.replacesResultId&&!(await tx.query('SELECT id FROM lab_results WHERE organization_id=$1 AND patient_id=$2 AND lab_report_id=$3 AND id=$4',[...base,d.labReportId,d.replacesResultId])).rowCount)throw unavailable();
     await tx.query("UPDATE lab_reports SET review_status='pending',reviewed_by=NULL,reviewed_at=NULL,updated_at=now() WHERE id=$1",[d.labReportId]);
     await tx.query("UPDATE ai_analyses SET status='superseded',updated_at=now() WHERE id IN (SELECT analysis_id FROM ai_analysis_sources WHERE lab_report_id=$1) AND status IN ('pending_review','reviewed')",[d.labReportId]);
     return insert('lab_results',['lab_report_id','recorded_by','test_name','test_code','numeric_value','text_value','unit','reference_low','reference_high','reference_text','abnormal_flag','extraction_status','source_page','collected_at','resulted_at','replaces_result_id'],[d.labReportId,actor.id,d.testName,d.testCode??null,d.numericValue??null,d.textValue??null,d.unit??null,d.referenceLow??null,d.referenceHigh??null,d.referenceText??null,d.abnormalFlag??null,'manual',d.sourcePage??null,d.collectedAt??null,d.resultedAt??null,d.replacesResultId??null]);
    }
    case 'analyses':{
     const d=clinicalInputs.analyses.parse(parsed);await this.lockReport(tx,actor,patientId,d.labReportId);await this.reference(tx,actor,patientId,'consultations',d.consultationId);
     const measurements=await this.reportMeasurements(tx,d.labReportId);
     if(!measurements.length)throw new DomainError('RESULTS_REQUIRED','Add laboratory measurements before creating a summary.',409);
     const version=hash(measurements);
     const output={synthetic:true,kind:'deterministic_report_summary',summary:`Synthetic report contains ${measurements.length} recorded measurements. A clinician must interpret the original results and reference ranges.`,measurements:measurements.map(camel),diagnosis:null,externalTransmission:false};
     const analysis=await insert('ai_analyses',['consultation_id','created_by','analysis_type','model_provider','model_identifier','model_version','input_context_version','structured_output'],[d.consultationId??null,actor.id,'laboratory_summary','careloop-local','deterministic-synthetic-summary','1',version,JSON.stringify(output)]);
     await insert('ai_analysis_sources',['analysis_id','lab_report_id','source_version'],[analysis.id,d.labReportId,version]);
     await insert('ai_findings',['analysis_id','finding_type','finding_text','severity'],[analysis.id,'review_required','Synthetic summary only. These measurements require clinician interpretation and do not establish a diagnosis.','info']);
     return analysis;
    }
    case 'treatment-plans':{
     const d=clinicalInputs['treatment-plans'].parse(parsed);await this.reference(tx,actor,patientId,'consultations',d.consultationId);
     return insert('treatment_plans',['consultation_id','clinician_id','title','description','status','start_date','end_date','approved_by','approved_at'],[d.consultationId??null,actor.id,d.title,d.description,d.status,d.startDate??null,d.endDate??null,d.status==='approved'?actor.id:null,d.status==='approved'?new Date().toISOString():null]);
    }
    case 'followups':{
     const d=clinicalInputs.followups.parse(parsed);await this.reference(tx,actor,patientId,'consultations',d.consultationId);
     return insert('followups',['consultation_id','clinician_id','due_at','scheduled_at','status','reason'],[d.consultationId??null,actor.id,d.dueAt,d.scheduledAt??null,d.scheduledAt?'scheduled':'pending',d.reason]);
    }
   }
  });
  return response as unknown as ClinicalCommandResponse<Resource>;
 }
 private async lockReport(tx:Transaction,actor:User,patientId:string,id:string){
  const report=(await tx.query('SELECT id,lab_order_id,review_status FROM lab_reports WHERE organization_id=$1 AND patient_id=$2 AND id=$3 FOR UPDATE',[actor.organizationId,patientId,id])).rows[0];
  if(!report)throw unavailable();return report as {id:string;lab_order_id:string|null;review_status:string};
 }
 private async reportMeasurements(tx:Transaction,id:string){
  return (await tx.query('SELECT id,test_name,numeric_value,text_value,unit,reference_low,reference_high,reference_text,abnormal_flag,extraction_status,source_page FROM lab_results r WHERE lab_report_id=$1 AND NOT EXISTS(SELECT 1 FROM lab_results correction WHERE correction.replaces_result_id=r.id) ORDER BY id',[id])).rows as Row[];
 }
 async review(actor:User,patientId:string,resource:'lab-reports'|'analyses',id:string,decision:'reviewed'|'accepted'|'rejected',key:string){
  return this.command(actor,patientId,`review.${resource}`,{id,decision},key,async tx=>{
   if(resource==='lab-reports'){
    const report=await this.lockReport(tx,actor,patientId,id);
    if(decision==='reviewed'&&!(await this.reportMeasurements(tx,id)).length)throw new DomainError('RESULTS_REQUIRED','Add laboratory measurements before marking a report reviewed.',409);
    if(report.lab_order_id&&decision==='reviewed')await tx.query("UPDATE lab_orders SET status='completed',completed_at=now(),updated_at=now() WHERE id=$1",[report.lab_order_id]);
    if(decision==='rejected')await tx.query("UPDATE ai_analyses SET status='superseded',updated_at=now() WHERE id IN (SELECT analysis_id FROM ai_analysis_sources WHERE lab_report_id=$1) AND status IN ('pending_review','reviewed')",[id]);
    return (await tx.query('UPDATE lab_reports SET review_status=$1,reviewed_by=$2,reviewed_at=now(),updated_at=now() WHERE id=$3 RETURNING *',[decision,actor.id,id])).rows[0];
   }
   // Lock the report before its analyses, matching result-correction lock order.
   const source=(await tx.query<{lab_report_id:string}>('SELECT s.lab_report_id FROM ai_analysis_sources s JOIN ai_analyses a ON a.id=s.analysis_id WHERE a.organization_id=$1 AND a.patient_id=$2 AND a.id=$3',[actor.organizationId,patientId,id])).rows[0];
   if(!source)throw unavailable();const report=await this.lockReport(tx,actor,patientId,source.lab_report_id);
   if(decision==='accepted'&&report.review_status!=='reviewed')throw new DomainError('REPORT_REVIEW_REQUIRED','Review the source laboratory report before accepting its summary.',409);
   const analysis=(await tx.query<{status:string;input_context_version:string}>('SELECT status,input_context_version FROM ai_analyses WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!analysis||analysis.status!=='pending_review'||analysis.input_context_version!==hash(await this.reportMeasurements(tx,source.lab_report_id)))throw new DomainError('STALE_ANALYSIS','This analysis is already reviewed or its source changed. Create a new analysis.',409);
   await tx.query('UPDATE ai_findings SET review_status=$1,reviewed_by=$2,reviewed_at=now(),updated_at=now() WHERE analysis_id=$3',[decision==='accepted'?'accepted':'rejected',actor.id,id]);
   return (await tx.query('UPDATE ai_analyses SET status=$1,reviewed_by=$2,reviewed_at=now(),updated_at=now() WHERE id=$3 RETURNING *',[decision==='accepted'?'reviewed':'rejected',actor.id,id])).rows[0];
  });
 }
}
