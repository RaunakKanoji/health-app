import { pathToFileURL } from 'node:url';
import type { Db } from '../../packages/db/src/index.ts';
import { createDatabase, requireMigrations } from '../../packages/db/src/index.ts';
import { readConfig, assertDevelopmentDatabase } from '../../packages/config/src/index.ts';
import { WorkflowService } from '../../packages/workflows/src/service.ts';
import { ClinicalRecordService } from '../../packages/workflows/src/clinical-records.ts';

/** Optional fixed fixture. Never discovers or attaches itself to user-created profiles. */
export async function seedClinicalJourney(db:Db,options:{reportDocumentId?:string}={}){
 if(process.env.DEMO_MODE!=='true'||(process.env.DATABASE_ENVIRONMENT&&!['development','test'].includes(process.env.DATABASE_ENVIRONMENT)))throw new Error('Clinical fixtures require synthetic development or test mode.');
 const fixture=(await db.pool.query("SELECT p.id FROM patients p JOIN patient_identifiers i ON i.patient_id=p.id AND i.organization_id=p.organization_id WHERE p.id='patient-001' AND p.organization_id='org-screening' AND p.synthetic=true AND i.system='https://careloop.demo/synthetic' AND i.value='SYN-001'")).rows[0];
 const actor=await new WorkflowService(db).user('user-clinician');
 if(!fixture||!actor||actor.email!=='clinician@careloop.demo'||actor.clinicianStatus!=='approved')throw new Error('The controlled synthetic patient and approved fixture clinician are required.');
 const service=new ClinicalRecordService(db);const patient='patient-001';
 const create=async(resource:Parameters<ClinicalRecordService['create']>[2],body:unknown,key:string)=>(await service.create(actor,patient,resource,body,`synthetic-journey-v1:${key}`)).record;
 const consultation=await create('consultations',{chiefComplaint:'Synthetic demonstration: discuss a screening result; no diagnosis established.',encounterType:'outpatient'},'consultation');
 await create('notes',{consultationId:consultation.id,noteType:'clinical',content:'SYNTHETIC EXAMPLE. A clinician reviewed the screening context and arranged a laboratory investigation. This fixture is not clinical guidance.',status:'signed'},'note');
 const order=await create('lab-orders',{consultationId:consultation.id,testName:'Synthetic glucose measurement',testCode:'SYN-GLUCOSE'},'order');
 const report=await create('lab-reports',{labOrderId:order.id,laboratoryName:'Synthetic Demonstration Laboratory',reportDate:'2026-11-02',...(options.reportDocumentId?{documentId:options.reportDocumentId}:{})},'report');
 await create('lab-results',{labReportId:report.id,testName:'Synthetic glucose measurement',numericValue:'5.2',unit:'mmol/L',referenceText:'Synthetic fixture range; not for clinical interpretation.',extractionStatus:'manual'},'result');
 await service.review(actor,patient,'lab-reports',report.id,'reviewed','synthetic-journey-v1:report-review');
 const analysis=await create('analyses',{labReportId:report.id,consultationId:consultation.id},'analysis');
 await service.review(actor,patient,'analyses',analysis.id,'accepted','synthetic-journey-v1:analysis-review');
 await create('treatment-plans',{consultationId:consultation.id,title:'Synthetic clinician follow-up plan',description:'Synthetic fixture: review the original report together at follow-up. No medication or diagnosis is prescribed by this example.',status:'approved'},'plan');
 await create('followups',{consultationId:consultation.id,dueAt:'2026-11-16T09:00:00.000Z',reason:'Synthetic follow-up to discuss the reviewed report and patient questions.'},'followup');
 return {status:'ready',synthetic:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const config=readConfig();assertDevelopmentDatabase(config);const db=createDatabase(config.DATABASE_URL);
 try{await requireMigrations(db);await seedClinicalJourney(db);process.stdout.write('Synthetic longitudinal care fixture is ready.\n');}catch{process.stderr.write('Clinical fixture seeding failed. Verify the selected development database and existing synthetic fixtures.\n');process.exitCode=1;}finally{await db.close();}
}
