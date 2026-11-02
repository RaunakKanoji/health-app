import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testApplication, signIn } from '../helpers.ts';
import { seedClinicalJourney } from '../../scripts/seed/clinical-journey.ts';

describe('longitudinal patient care',()=>{
 let fixture:Awaited<ReturnType<typeof testApplication>>;
 let clinician:string,patient:string,admin:string,outsider:string,coordinator:string;
 const path='/api/patients/patient-001/clinical-records';
 beforeAll(async()=>{fixture=await testApplication();clinician=await signIn(fixture.app,'clinician');patient=await signIn(fixture.app,'patient');admin=await signIn(fixture.app,'admin');outsider=await signIn(fixture.app,'outsider');coordinator=await signIn(fixture.app,'coordinator');});
 afterAll(async()=>{await fixture?.close();});
 const post=(resource:string,payload:Record<string,unknown>,cookie=clinician,key=randomUUID())=>fixture.app.inject({method:'POST',url:`${path}/${resource}`,headers:{cookie,'idempotency-key':key},payload});
 it('authenticates every record request and enforces patient relationships',async()=>{
  for(const cookie of [undefined,outsider,admin]){const response=await fixture.app.inject({url:path,headers:cookie?{cookie}:{}});expect([401,404]).toContain(response.statusCode);}
  expect((await fixture.app.inject({url:'/api/patients/patient-002/clinical-records',headers:{cookie:patient}})).statusCode).toBe(404);
  expect((await post('consultations',{chiefComplaint:'Synthetic consultation'},coordinator)).statusCode).toBe(403);
  expect((await fixture.app.inject({url:'/api/health/database'})).statusCode).toBe(401);
 });
 it('persists a consultation, immutable signed note, lab measurements, review, summary and plan',async()=>{
  const key=randomUUID();const input={chiefComplaint:'Synthetic screening follow-up',encounterType:'outpatient'};
  const first=await post('consultations',input,clinician,key);expect(first.statusCode,first.body).toBe(200);const consultation=first.json().record;
  expect((await post('consultations',input,clinician,key)).json().record.id).toBe(consultation.id);
  expect((await post('consultations',{...input,chiefComplaint:'Different'},clinician,key)).statusCode).toBe(409);
  const note=await post('notes',{consultationId:consultation.id,content:'Synthetic signed note',status:'signed'});expect(note.statusCode,note.body).toBe(200);
  await expect(fixture.app.db.pool.query('UPDATE clinical_notes SET content=$1 WHERE id=$2',['overwrite',note.json().record.id])).rejects.toThrow();
  const revision=await post('notes',{consultationId:consultation.id,content:'Synthetic addendum',status:'signed',supersedesNoteId:note.json().record.id});expect(revision.statusCode,revision.body).toBe(200);expect(revision.json().record.revision).toBe(2);
  const order=await post('lab-orders',{consultationId:consultation.id,testName:'Synthetic measurement'});expect(order.statusCode,order.body).toBe(200);
  const report=await post('lab-reports',{labOrderId:order.json().record.id,laboratoryName:'Synthetic Lab',reportDate:'2026-11-02'});expect(report.statusCode,report.body).toBe(200);const reportId=report.json().record.id;
  const result=await post('lab-results',{labReportId:reportId,testName:'Measurement',numericValue:'5.20',unit:'mmol/L',referenceLow:'3.1',referenceHigh:'6.2',extractionStatus:'manual'});expect(result.statusCode,result.body).toBe(200);
  const hidden=await fixture.app.inject({url:path,headers:{cookie:patient}});expect(hidden.json().labReports).toEqual([]);expect(hidden.json().labResults).toEqual([]);
  expect((await post(`lab-reports/${reportId}/review`,{decision:'reviewed'})).statusCode).toBe(200);
  const analysis=await post('analyses',{labReportId:reportId,consultationId:consultation.id});expect(analysis.statusCode,analysis.body).toBe(200);const analysisId=analysis.json().record.id;
  expect(analysis.json().record.status).toBe('pending_review');expect(analysis.json().record.structuredOutput.diagnosis).toBeNull();
  expect((await post(`analyses/${analysisId}/review`,{decision:'accepted'},patient)).statusCode).toBe(403);
  expect((await post(`analyses/${analysisId}/review`,{decision:'accepted'})).statusCode).toBe(200);
  const plan=await post('treatment-plans',{consultationId:consultation.id,title:'Synthetic plan',description:'Discuss original report with clinician',status:'approved'});expect(plan.statusCode,plan.body).toBe(200);
  expect((await post('followups',{consultationId:consultation.id,dueAt:'2026-11-16T09:00:00.000Z',reason:'Synthetic follow-up'})).statusCode).toBe(200);
  const visible=(await fixture.app.inject({url:path,headers:{cookie:patient}})).json();expect(visible.labResults[0].numericValue).toBe('5.20');expect(visible.analyses[0].id).toBe(analysisId);expect(visible.treatmentPlans[0].id).toBe(plan.json().record.id);
  const corrected=await post('lab-results',{labReportId:reportId,testName:'Measurement',numericValue:'5.30',unit:'mmol/L',replacesResultId:result.json().record.id});expect(corrected.statusCode,corrected.body).toBe(200);
  const after=(await fixture.app.inject({url:path,headers:{cookie:patient}})).json();expect(after.labReports).toEqual([]);expect(after.analyses).toEqual([]);
  expect((await fixture.app.db.pool.query('SELECT status FROM ai_analyses WHERE id=$1',[analysisId])).rows[0].status).toBe('superseded');
  await expect(fixture.app.db.pool.query('DELETE FROM lab_results WHERE id=$1',[result.json().record.id])).rejects.toThrow();
  expect((await post(`analyses/${analysisId}/review`,{decision:'accepted'})).statusCode).toBe(409);
 });
 it('rejects cross-patient references even for an assigned clinician',async()=>{
  const other=await fixture.app.inject({method:'POST',url:'/api/patients/patient-002/clinical-records/consultations',headers:{cookie:clinician,'idempotency-key':randomUUID()},payload:{chiefComplaint:'Another synthetic patient'}});expect(other.statusCode,other.body).toBe(200);
  expect((await post('notes',{consultationId:other.json().record.id,content:'Mismatched patient',status:'signed'})).statusCode).toBe(404);
  await expect(fixture.app.db.pool.query("INSERT INTO clinical_notes(organization_id,patient_id,consultation_id,author_id,note_type,content) VALUES('org-screening','patient-001',$1,'user-clinician','clinical','Mismatch')",[other.json().record.id])).rejects.toThrow();
 });
 it('keeps controlled clinical seeding idempotent and does not create Clerk identities',async()=>{
  await seedClinicalJourney(fixture.app.db);const before=(await fixture.app.db.pool.query('SELECT count(*)::int AS n FROM clinical_record_commands')).rows[0].n;
  await seedClinicalJourney(fixture.app.db);expect((await fixture.app.db.pool.query('SELECT count(*)::int AS n FROM clinical_record_commands')).rows[0].n).toBe(before);
  const context=await fixture.app.inject({method:'POST',url:'/api/patients/patient-001/clinical-context',headers:{cookie:patient},payload:{includeAIHistory:false}});expect(context.statusCode,context.body).toBe(200);expect(context.json().analyses).toEqual([]);expect(context.json().externalTransmission).toBe(false);
 });
 it('blocks a revoked relationship and pending clinician approval immediately',async()=>{
  await fixture.app.db.pool.query("UPDATE clinician_profiles SET verification_status='pending' WHERE user_id='user-clinician'");
  expect((await post('consultations',{chiefComplaint:'Blocked applicant'})).statusCode).toBe(404);
  await fixture.app.db.pool.query("UPDATE clinician_profiles SET verification_status='approved' WHERE user_id='user-clinician'");
  await fixture.app.db.pool.query("UPDATE clinician_patient_relationships SET relationship_status='revoked',revoked_at=now() WHERE clinician_id='user-clinician' AND patient_id='patient-001'");
  expect((await fixture.app.inject({url:path,headers:{cookie:clinician}})).statusCode).toBe(404);
 });
});
