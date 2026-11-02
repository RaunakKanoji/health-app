import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../../packages/db/src/index.ts';
import { ClinicalRecordService } from '../../packages/workflows/src/clinical-records.ts';
import { signIn, testApplication } from '../helpers.ts';

describe('clinical write concurrency and transaction boundaries',()=>{
 let fixture:Awaited<ReturnType<typeof testApplication>>;
 let clinician:string,patient:string;
 const path='/api/patients/patient-001/clinical-records';
 beforeAll(async()=>{
  fixture=await testApplication();clinician=await signIn(fixture.app,'clinician');patient=await signIn(fixture.app,'patient');
 });
 afterAll(async()=>{await fixture?.close();});
 const post=(resource:string,payload:Record<string,unknown>,key=randomUUID())=>fixture.app.inject({method:'POST',url:`${path}/${resource}`,headers:{cookie:clinician,'idempotency-key':key},payload});

 it('serializes simultaneous retries into one consultation, audit and command response',async()=>{
  const key=randomUUID(),payload={chiefComplaint:`Synthetic concurrency ${key}`};
  const results=await Promise.all([post('consultations',payload,key),post('consultations',payload,key),post('consultations',payload,key)]);
  for(const response of results)expect(response.statusCode,response.body).toBe(200);
  expect(new Set(results.map(response=>response.json().record.id)).size).toBe(1);
  expect(results[1]!.json()).toEqual(results[0]!.json());
  expect((await fixture.app.db.pool.query('SELECT count(*)::int AS n FROM consultations WHERE chief_complaint=$1',[payload.chiefComplaint])).rows[0].n).toBe(1);
  expect((await fixture.app.db.pool.query('SELECT count(*)::int AS n FROM clinical_record_commands WHERE idempotency_key=$1',[key])).rows[0].n).toBe(1);
  expect((await fixture.app.db.pool.query("SELECT count(*)::int AS n FROM audit_events WHERE request_id=$1 AND action='clinical_record.create.consultations'",[key])).rows[0].n).toBe(1);
 });

 it('never leaves an accepted analysis current when a simultaneous result correction commits',async()=>{
  const report=await post('lab-reports',{laboratoryName:'Synthetic concurrency laboratory',reportDate:'2026-11-02'});
  expect(report.statusCode,report.body).toBe(200);const reportId=report.json().record.id;
  const result=await post('lab-results',{labReportId:reportId,testName:'Synthetic measurement',numericValue:'4.20',unit:'mmol/L'});
  expect(result.statusCode,result.body).toBe(200);
  const reviewed=await post(`lab-reports/${reportId}/review`,{decision:'reviewed'});expect(reviewed.statusCode,reviewed.body).toBe(200);
  const analysis=await post('analyses',{labReportId:reportId});expect(analysis.statusCode,analysis.body).toBe(200);const analysisId=analysis.json().record.id;
  const [accepted,corrected]=await Promise.all([
   post(`analyses/${analysisId}/review`,{decision:'accepted'}),
   post('lab-results',{labReportId:reportId,testName:'Synthetic measurement',numericValue:'4.30',unit:'mmol/L',replacesResultId:result.json().record.id}),
  ]);
  expect([200,409],accepted.body).toContain(accepted.statusCode);expect(corrected.statusCode,corrected.body).toBe(200);
  expect((await fixture.app.db.pool.query('SELECT status FROM ai_analyses WHERE id=$1',[analysisId])).rows[0].status).toBe('superseded');
  expect((await fixture.app.db.pool.query('SELECT review_status FROM lab_reports WHERE id=$1',[reportId])).rows[0].review_status).toBe('pending');
  const visible=await fixture.app.inject({url:path,headers:{cookie:patient}});expect(visible.statusCode,visible.body).toBe(200);
  expect(visible.json().analyses.some((row:{id:string})=>row.id===analysisId)).toBe(false);
  expect((await post(`lab-reports/${reportId}/review`,{decision:'reviewed'})).statusCode).toBe(200);
  expect((await post(`analyses/${analysisId}/review`,{decision:'accepted'})).statusCode).toBe(409);
 });

 it('returns a controlled conflict for an attempted amendment of an unsigned note',async()=>{
  const consultation=await post('consultations',{chiefComplaint:'Synthetic draft note revision'});expect(consultation.statusCode,consultation.body).toBe(200);
  const draft=await post('notes',{consultationId:consultation.json().record.id,content:'Synthetic unsigned draft',status:'draft'});expect(draft.statusCode,draft.body).toBe(200);
  const amended=await post('notes',{consultationId:consultation.json().record.id,content:'Synthetic premature amendment',status:'signed',supersedesNoteId:draft.json().record.id});
  expect(amended.statusCode,amended.body).toBe(409);
  expect((await fixture.app.db.pool.query('SELECT content,status FROM clinical_notes WHERE id=$1',[draft.json().record.id])).rows[0]).toEqual({content:'Synthetic unsigned draft',status:'draft'});
  expect((await fixture.app.db.pool.query('SELECT id FROM clinical_notes WHERE supersedes_note_id=$1',[draft.json().record.id])).rowCount).toBe(0);
 });

 it('lists authorized patients with a one-connection pool without a nested pool acquisition',async()=>{
  const url=new URL(process.env.TEST_DATABASE_URL??'postgresql://careloop:careloop@127.0.0.1:54329/careloop');
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('This regression uses only the disposable local test schema.');
  url.searchParams.set('options',`-c search_path=${fixture.schema}`);
  const db=createDatabase(url.href,{max:1});
  try{
   const actor=await fixture.app.service.user('user-clinician');expect(actor).toBeDefined();
   const directory=await new ClinicalRecordService(db).patients(actor!);
   expect(directory.patients.some(row=>row.id==='patient-001')).toBe(true);
  }finally{await db.close();}
 });
});
