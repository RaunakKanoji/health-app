import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrate, migrationFiles, type Db } from '../../packages/db/src/index.ts';
import { consultations } from '../../packages/db/src/schema.ts';

describe('additive longitudinal schema integrity',()=>{
 const schema=`careloop_schema_test_${randomUUID().replaceAll('-','')}`;
 let admin:pg.Pool,db:Db;
 let created=false;
 let baseline:unknown;
 beforeAll(async()=>{
  const url=new URL(process.env.TEST_DATABASE_URL??'postgresql://careloop:careloop@127.0.0.1:54329/careloop');
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Schema tests require local PostgreSQL and a disposable schema.');
  admin=new pg.Pool({connectionString:url.href});
  await admin.query(`CREATE SCHEMA ${schema}`);created=true;
  url.searchParams.set('options',`-c search_path=${schema}`);db=createDatabase(url.href);
  // Exercise an upgrade from the existing five migrations with pre-existing records.
  await db.transaction(async tx=>{
   await tx.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
   for(const migration of await migrationFiles()){
    if(migration.name>='0006')continue;
    await tx.query(migration.sql);await tx.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[migration.name,migration.sha256]);
   }
   await tx.query("INSERT INTO organizations(id,name) VALUES('schema-org','Synthetic schema organization'),('schema-other','Synthetic other organization')");
   await tx.query("INSERT INTO patients(id,organization_id,name,birth_date) VALUES('schema-patient-a','schema-org','Synthetic A','1980-01-01'),('schema-patient-b','schema-org','Synthetic B','1981-01-01')");
   await tx.query("INSERT INTO users(id,organization_id,email,name,password_hash,role) VALUES('schema-clinician','schema-org','schema@example.invalid','Synthetic Clinician',NULL,'clinician'),('schema-outsider','schema-other','other@example.invalid','Synthetic Other',NULL,'clinician')");
   await tx.query("INSERT INTO observations(id,organization_id,patient_id,coding,value) VALUES('schema-observation','schema-org','schema-patient-a','{\"text\":\"Synthetic measurement\"}','{\"value\":5,\"unit\":\"mg/dL\"}')");
  });
  baseline=(await db.pool.query('SELECT id,organization_id,patient_id,coding,value FROM observations ORDER BY id')).rows;
  await migrate(db);
 });
 afterAll(async()=>{
  await db?.close();
  if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin?.end();
 });
 async function consultation(patient='schema-patient-a'){
  return (await db.pool.query<{id:string}>("INSERT INTO consultations(organization_id,patient_id,clinician_id,encounter_type,chief_complaint) VALUES('schema-org',$1,'schema-clinician','outpatient','Synthetic test consultation') RETURNING id",[patient])).rows[0]!.id;
 }
 async function report(patient='schema-patient-a'){
  return (await db.pool.query<{id:string}>("INSERT INTO lab_reports(organization_id,patient_id,created_by,laboratory_name,report_date) VALUES('schema-org',$1,'schema-clinician','Synthetic laboratory','2026-01-01') RETURNING id",[patient])).rows[0]!.id;
 }
 async function analysis(patient='schema-patient-a'){
  return (await db.pool.query<{id:string}>("INSERT INTO ai_analyses(organization_id,patient_id,created_by,analysis_type,model_provider,model_identifier,model_version,input_context_version,structured_output) VALUES('schema-org',$1,'schema-clinician','synthetic_summary','deterministic','demo','1','source-v1','{}') RETURNING id",[patient])).rows[0]!.id;
 }
 it('preserves existing measurements, applies once, exposes typed tables and required indexes',async()=>{
  expect((await db.pool.query('SELECT id,organization_id,patient_id,coding,value FROM observations ORDER BY id')).rows).toEqual(baseline);
  await migrate(db);
  expect((await db.pool.query("SELECT count(*)::int AS count FROM schema_migrations WHERE name='0006_longitudinal_care.sql'")).rows[0].count).toBe(1);
  expect((await db.pool.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename IN ('consultations','clinical_notes','medical_documents','lab_orders','lab_reports','lab_results','ai_analyses','ai_findings','ai_analysis_sources','treatment_plans','followups','clinical_record_commands')")).rows).toHaveLength(12);
  expect((await db.pool.query("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname IN ('consultations_patient_time_idx','lab_results_report_idx','lab_reports_review_queue_idx','followups_patient_due_idx')")).rows).toHaveLength(4);
  expect(await db.orm.select({id:consultations.id}).from(consultations)).toEqual([]);
 });
 it('rejects cross-patient consultations, reports and author organizations',async()=>{
  const id=await consultation();
  await expect(db.pool.query("INSERT INTO clinical_notes(organization_id,patient_id,consultation_id,author_id,note_type,content) VALUES('schema-org','schema-patient-b',$1,'schema-clinician','progress','Synthetic invalid')",[id])).rejects.toMatchObject({code:'23503'});
  await expect(db.pool.query("INSERT INTO lab_orders(organization_id,patient_id,consultation_id,ordered_by,test_name) VALUES('schema-org','schema-patient-b',$1,'schema-clinician','Synthetic investigation')",[id])).rejects.toMatchObject({code:'23503'});
  await expect(db.pool.query("INSERT INTO consultations(organization_id,patient_id,clinician_id,encounter_type,chief_complaint) VALUES('schema-org','schema-patient-a','schema-outsider','outpatient','Synthetic invalid author')")).rejects.toMatchObject({code:'23503'});
 });
 it('preserves signed notes and enforces same-consultation revision history',async()=>{
  const id=await consultation(),other=await consultation();
  const note=(await db.pool.query<{id:string}>("INSERT INTO clinical_notes(organization_id,patient_id,consultation_id,author_id,note_type,content,status,signed_at) VALUES('schema-org','schema-patient-a',$1,'schema-clinician','progress','Original synthetic note','signed',now()) RETURNING id",[id])).rows[0]!.id;
  await expect(db.pool.query('UPDATE clinical_notes SET content=$1 WHERE id=$2',['Overwritten',note])).rejects.toThrow('signed_note_is_immutable');
  await expect(db.pool.query('DELETE FROM clinical_notes WHERE id=$1',[note])).rejects.toThrow('signed_note_is_immutable');
  await expect(db.pool.query("INSERT INTO clinical_notes(organization_id,patient_id,consultation_id,author_id,note_type,content,revision,supersedes_note_id) VALUES('schema-org','schema-patient-a',$1,'schema-clinician','progress','Wrong consultation',2,$2)",[other,note])).rejects.toMatchObject({code:'23503'});
  await expect(db.pool.query("INSERT INTO clinical_notes(organization_id,patient_id,consultation_id,author_id,note_type,content,revision,supersedes_note_id) VALUES('schema-org','schema-patient-a',$1,'schema-clinician','progress','Skipped version',3,$2)",[id,note])).rejects.toThrow('invalid_note_revision');
  const revision=await db.pool.query("INSERT INTO clinical_notes(organization_id,patient_id,consultation_id,author_id,note_type,content,status,signed_at,revision,supersedes_note_id) VALUES('schema-org','schema-patient-a',$1,'schema-clinician','progress','Synthetic amendment','signed',now(),2,$2)",[id,note]);
  expect(revision.rowCount).toBe(1);
 });
 it('preserves exact numeric units and append-only result corrections',async()=>{
  const id=await report(),other=await report();
  const result=(await db.pool.query<{id:string}>("INSERT INTO lab_results(organization_id,patient_id,lab_report_id,recorded_by,test_name,numeric_value,unit,reference_low,reference_high,source_page) VALUES('schema-org','schema-patient-a',$1,'schema-clinician','Synthetic analyte','4.1200','mmol/L','3.0','5.0',2) RETURNING id",[id])).rows[0]!.id;
  expect((await db.pool.query('SELECT numeric_value,unit,reference_low,reference_high,source_page FROM lab_results WHERE id=$1',[result])).rows[0]).toEqual({numeric_value:'4.1200',unit:'mmol/L',reference_low:'3.0',reference_high:'5.0',source_page:2});
  await expect(db.pool.query('UPDATE lab_results SET numeric_value=5 WHERE id=$1',[result])).rejects.toThrow('immutable_record');
  await expect(db.pool.query("INSERT INTO lab_results(organization_id,patient_id,lab_report_id,recorded_by,test_name,text_value,replaces_result_id) VALUES('schema-org','schema-patient-a',$1,'schema-clinician','Synthetic correction','Negative',$2)",[other,result])).rejects.toMatchObject({code:'23503'});
  expect((await db.pool.query("INSERT INTO lab_results(organization_id,patient_id,lab_report_id,recorded_by,test_name,text_value,replaces_result_id,extraction_status,verified_by,verified_at) VALUES('schema-org','schema-patient-a',$1,'schema-clinician','Synthetic correction','Negative',$2,'verified','schema-clinician',now())",[id,result])).rowCount).toBe(1);
 });
 it('rejects orphan results, invalid ranges and false verification',async()=>{
  const id=await report();
  await expect(db.pool.query("INSERT INTO lab_results(organization_id,patient_id,lab_report_id,recorded_by,test_name,text_value) VALUES('schema-org','schema-patient-a',$1,'schema-clinician','Synthetic','Negative')",[randomUUID()])).rejects.toMatchObject({code:'23503'});
  await expect(db.pool.query("INSERT INTO lab_results(organization_id,patient_id,lab_report_id,recorded_by,test_name,numeric_value,reference_low,reference_high) VALUES('schema-org','schema-patient-a',$1,'schema-clinician','Synthetic',1,10,2)",[id])).rejects.toMatchObject({code:'23514'});
  await expect(db.pool.query("INSERT INTO lab_results(organization_id,patient_id,lab_report_id,recorded_by,test_name,text_value,extraction_status) VALUES('schema-org','schema-patient-a',$1,'schema-clinician','Synthetic','Negative','verified')",[id])).rejects.toMatchObject({code:'23514'});
 });
 it('enforces private document metadata and same-patient report linkage',async()=>{
  const document=(await db.pool.query<{id:string}>("INSERT INTO medical_documents(organization_id,patient_id,uploaded_by,document_type,original_filename,storage_provider,storage_key,mime_type,file_size,checksum) VALUES('schema-org','schema-patient-a','schema-clinician','lab_report','synthetic.txt','private-test','opaque-synthetic-key','text/plain',32,$1) RETURNING id",['a'.repeat(64)])).rows[0]!.id;
  await expect(db.pool.query("INSERT INTO lab_reports(organization_id,patient_id,created_by,laboratory_name,report_date,document_id) VALUES('schema-org','schema-patient-b','schema-clinician','Synthetic','2026-01-01',$1)",[document])).rejects.toMatchObject({code:'23503'});
  await expect(db.pool.query("INSERT INTO medical_documents(organization_id,patient_id,uploaded_by,document_type,original_filename,storage_provider,storage_key,mime_type,file_size,checksum) VALUES('schema-org','schema-patient-a','schema-clinician','lab_report','unsafe.html','private-test','unsafe-key','text/html',32,$1)",['a'.repeat(64)])).rejects.toMatchObject({code:'23514'});
 });
 it('binds analysis sources to one patient and preserves finalized output and evidence',async()=>{
  const id=await analysis(),otherReport=await report('schema-patient-b');
  await expect(db.pool.query("INSERT INTO ai_analysis_sources(organization_id,patient_id,analysis_id,lab_report_id,source_version) VALUES('schema-org','schema-patient-a',$1,$2,'1')",[id,otherReport])).rejects.toMatchObject({code:'23503'});
  const source=(await db.pool.query<{id:string}>("INSERT INTO ai_analysis_sources(organization_id,patient_id,analysis_id,observation_id,source_version) VALUES('schema-org','schema-patient-a',$1,'schema-observation','v1') RETURNING id",[id])).rows[0]!.id;
  await db.pool.query("UPDATE ai_analyses SET status='reviewed',reviewed_by='schema-clinician',reviewed_at=now() WHERE id=$1",[id]);
  await expect(db.pool.query("UPDATE ai_analyses SET structured_output='{\"changed\":true}' WHERE id=$1",[id])).rejects.toThrow('analysis_payload_is_immutable');
  await expect(db.pool.query('DELETE FROM ai_analysis_sources WHERE id=$1',[source])).rejects.toThrow('immutable_record');
  await expect(db.pool.query("INSERT INTO ai_findings(organization_id,patient_id,analysis_id,finding_type,finding_text) VALUES('schema-org','schema-patient-a',$1,'synthetic','Late addition')",[id])).rejects.toThrow('analysis_review_is_final');
  expect((await db.pool.query("UPDATE ai_analyses SET status='superseded' WHERE id=$1",[id])).rowCount).toBe(1);
 });
 it('requires treatment approval provenance and valid follow-up completion',async()=>{
  await expect(db.pool.query("INSERT INTO treatment_plans(organization_id,patient_id,clinician_id,title,description,status) VALUES('schema-org','schema-patient-a','schema-clinician','Synthetic','Synthetic plan','approved')")).rejects.toMatchObject({code:'23514'});
  expect((await db.pool.query("INSERT INTO treatment_plans(organization_id,patient_id,clinician_id,title,description,status,approved_by,approved_at) VALUES('schema-org','schema-patient-a','schema-clinician','Synthetic','Synthetic clinician-approved plan','approved','schema-clinician',now())")).rowCount).toBe(1);
  await expect(db.pool.query("INSERT INTO followups(organization_id,patient_id,clinician_id,due_at,reason,status) VALUES('schema-org','schema-patient-a','schema-clinician',now(),'Synthetic follow-up','completed')")).rejects.toMatchObject({code:'23514'});
 });
 it('rejects duplicate operation keys and prevents cascading patient history deletion',async()=>{
  const key=randomUUID();
  await db.pool.query("INSERT INTO clinical_record_commands(organization_id,patient_id,actor_id,idempotency_key,fingerprint,response) VALUES('schema-org','schema-patient-a','schema-clinician',$1,'digest','{}')",[key]);
  await expect(db.pool.query("INSERT INTO clinical_record_commands(organization_id,patient_id,actor_id,idempotency_key,fingerprint,response) VALUES('schema-org','schema-patient-b','schema-clinician',$1,'digest','{}')",[key])).rejects.toMatchObject({code:'23505'});
  await expect(db.pool.query("DELETE FROM patients WHERE id='schema-patient-a'")).rejects.toMatchObject({code:'23503'});
 });
});
