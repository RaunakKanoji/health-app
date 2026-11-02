import {z} from 'zod';
import type {CareLoopApp} from './app.ts';
import {DocumentManagementService} from '../../../packages/workflows/src/documents/service.ts';
import {createDocumentStorage,resolveDocumentStorage,maximumDocumentBytes,type DocumentStorage} from '../../../packages/workflows/src/documents/storage.ts';
import {documentFiltersSchema,documentUploadInitSchema,documentUploadSessionSchema,documentMetadataSchema,documentReviewSchema,observationCorrectionSchema} from '../../../packages/contracts/src/documents.ts';
import {DomainError} from '../../../packages/domain/src/index.ts';
import {documentFhirBundle} from '../../../packages/fhir/src/documents.ts';

const patientParams=z.object({patientId:z.string().min(1).max(100)});
const documentParams=patientParams.extend({documentId:z.uuid()});
const pagination=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).max(10000).default(0)}).strict();
const empty=z.object({}).strict();
const requestKey=(headers:Record<string,unknown>)=>z.string().min(1).max(200).parse(headers['idempotency-key']);
const limited={config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
export type DocumentManagementOptions={storage?:DocumentStorage|null;resolveStorage?:(provider:string,bucket?:string)=>DocumentStorage|null};

/** All identities pass through the existing Clerk verifier and patient relationship authorization. */
export async function registerDocumentManagementRoutes(app:CareLoopApp,options:DocumentManagementOptions={}){
 const store=options.storage===undefined?createDocumentStorage():options.storage;
 const stores=new Map<string,DocumentStorage>();if(store)stores.set(`${store.provider}:${store.bucket}`,store);
 const resolve=options.resolveStorage??((provider:string,bucket?:string)=>{
  if(options.storage!==undefined)return store?.provider===provider&&(!bucket||store.bucket===bucket)?store:null;
  const existing=[...stores.values()].find(item=>item.provider===provider&&(!bucket||item.bucket===bucket));if(existing)return existing;
  const found=resolveDocumentStorage(provider);if(!found||bucket&&found.bucket!==bucket){found?.close?.();return null;}stores.set(`${provider}:${found.bucket}`,found);return found;
 });
 const service=new DocumentManagementService(app.db,store,resolve,maximumDocumentBytes());
 if(options.storage===undefined)app.addHook('onClose',async()=>{for(const item of stores.values())item.close?.();});
 const base='/api/patients/:patientId/documents';
 app.get(`${base}/manage`,async request=>{const {patientId}=patientParams.parse(request.params);return service.list(await app.authenticate(request),patientId,documentFiltersSchema.parse(request.query));});
 app.get(`${base}/review-queue`,async request=>{const actor=await app.authenticate(request);if(actor.role!=='clinician')throw new DomainError('FORBIDDEN','An approved treating clinician must review documents.',403);const {patientId}=patientParams.parse(request.params);return service.list(actor,patientId,documentFiltersSchema.parse(request.query),true);});
 app.get(`${base}/observations`,async request=>{const {patientId}=patientParams.parse(request.params),page=pagination.parse(request.query);return service.observations(await app.authenticate(request),patientId,page.limit,page.offset);});
 app.get(`${base}/timeline`,async request=>{const {patientId}=patientParams.parse(request.params),page=pagination.parse(request.query);return service.timelineEntries(await app.authenticate(request),patientId,page.limit,page.offset);});
 app.get(`${base}/trends`,async request=>{const {patientId}=patientParams.parse(request.params);empty.parse(request.query);return service.trends(await app.authenticate(request),patientId);});
 app.post(`${base}/upload/init`,limited,async request=>{const {patientId}=patientParams.parse(request.params);return service.initialize(await app.authenticate(request),patientId,documentUploadInitSchema.parse(request.body),requestKey(request.headers));});
 app.post(`${base}/upload/complete`,limited,async request=>{const {patientId}=patientParams.parse(request.params),{sessionId}=documentUploadSessionSchema.parse(request.body);return service.complete(await app.authenticate(request),patientId,sessionId,requestKey(request.headers));});
 app.post(`${base}/upload/cancel`,limited,async request=>{const {patientId}=patientParams.parse(request.params),{sessionId}=documentUploadSessionSchema.parse(request.body);return service.cancel(await app.authenticate(request),patientId,sessionId,requestKey(request.headers));});
 app.get(`${base}/:documentId/detail`,async request=>{const {patientId,documentId}=documentParams.parse(request.params);return service.detail(await app.authenticate(request),patientId,documentId);});
 app.get(`${base}/:documentId/fhir`,async request=>{const {patientId,documentId}=documentParams.parse(request.params);const detail=await service.detail(await app.authenticate(request),patientId,documentId);if(detail.document.deletedAt||detail.document.securityStatus!=='safe')throw new DomainError('DOCUMENT_QUARANTINED','Security checks must complete before exporting the document.',409);return documentFhirBundle(detail);});
 for(const mode of ['preview','download-managed'] as const)app.get(`${base}/:documentId/${mode}`,async request=>{const {patientId,documentId}=documentParams.parse(request.params),{versionId}=z.object({versionId:z.uuid().optional()}).strict().parse(request.query);return service.file(await app.authenticate(request),patientId,documentId,mode==='preview',versionId);});
 app.patch(`${base}/:documentId`,async request=>{const {patientId,documentId}=documentParams.parse(request.params);return service.update(await app.authenticate(request),patientId,documentId,documentMetadataSchema.parse(request.body),requestKey(request.headers));});
 app.delete(`${base}/:documentId`,async request=>{const {patientId,documentId}=documentParams.parse(request.params),{reason}=z.object({reason:z.string().trim().min(5).max(1000)}).strict().parse(request.body);return service.remove(await app.authenticate(request),patientId,documentId,reason,requestKey(request.headers));});
 for(const operation of ['restore','retry','process','request-review'] as const)app.post(`${base}/:documentId/${operation}`,limited,async request=>{const {patientId,documentId}=documentParams.parse(request.params);empty.parse(request.body??{});const actor=await app.authenticate(request),key=requestKey(request.headers);return operation==='restore'?service.restore(actor,patientId,documentId,key):operation==='request-review'?service.requestReview(actor,patientId,documentId,key):service.retry(actor,patientId,documentId,key);});
 app.post(`${base}/:documentId/review`,async request=>{const {patientId,documentId}=documentParams.parse(request.params);return service.review(await app.authenticate(request),patientId,documentId,documentReviewSchema.parse(request.body),requestKey(request.headers));});
 app.patch(`${base}/:documentId/observations/:observationId`,async request=>{const {patientId,documentId,observationId}=documentParams.extend({observationId:z.uuid()}).parse(request.params);return service.correct(await app.authenticate(request),patientId,documentId,observationId,observationCorrectionSchema.parse(request.body),requestKey(request.headers));});
}
