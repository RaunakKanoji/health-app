import { z } from 'zod';
import type { CareLoopApp } from './app.ts';
import { ClinicalRecordService } from '../../../packages/workflows/src/clinical-records.ts';
import { clinicalInputs, clinicalPagination } from '../../../packages/contracts/src/clinical-records.ts';

const params=z.object({patientId:z.string().min(1).max(100)});
const requestKey=(headers:Record<string,unknown>)=>z.string().min(1).max(200).parse(headers['idempotency-key']);
export async function registerClinicalRecordRoutes(app:CareLoopApp){
 const service=new ClinicalRecordService(app.db);
 app.get('/api/patients',async request=>{const page=clinicalPagination.parse(request.query);return service.patients(await app.authenticate(request),page.limit,page.offset);});
 app.get('/api/patients/:patientId/clinical-records',async request=>{
  const {patientId}=params.parse(request.params);return service.records(await app.authenticate(request),patientId,clinicalPagination.parse(request.query));
 });
 app.post('/api/patients/:patientId/clinical-context',async request=>{
  const {patientId}=params.parse(request.params);return service.getPatientClinicalContext(await app.authenticate(request),patientId,request.body??{});
 });
 app.post('/api/patients/:patientId/clinical-records/:resource',async request=>{
  const {patientId,resource}=params.extend({resource:z.enum(Object.keys(clinicalInputs) as [keyof typeof clinicalInputs,...(keyof typeof clinicalInputs)[]])}).parse(request.params);
  return service.create(await app.authenticate(request),patientId,resource,request.body,requestKey(request.headers));
 });
 app.post('/api/patients/:patientId/clinical-records/:resource/:id/review',async request=>{
  const {patientId,resource,id}=params.extend({resource:z.enum(['lab-reports','analyses']),id:z.string().uuid()}).parse(request.params);
  const {decision}=z.object({decision:resource==='lab-reports'?z.enum(['reviewed','rejected']):z.enum(['accepted','rejected'])}).strict().parse(request.body);
  return service.review(await app.authenticate(request),patientId,resource,id,decision,requestKey(request.headers));
 });
}
