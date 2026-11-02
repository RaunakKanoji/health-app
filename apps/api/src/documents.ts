import {z} from 'zod';
import type {CareLoopApp} from './app.ts';
import {createDocumentStore,documentUploadSchema,MedicalDocumentService,type PrivateDocumentStore} from '../../../packages/workflows/src/medical-documents.ts';

export async function registerDocumentRoutes(app:CareLoopApp,store:PrivateDocumentStore|null=createDocumentStore()){
  const service=new MedicalDocumentService(app.db,store);
  app.addHook('onClose',async()=>{store?.close?.();});
  app.get<{Params:{patientId:string}}>('/api/patients/:patientId/documents',async request=>{
    const page=z.object({limit:z.coerce.number().int().min(1).max(100).default(25),offset:z.coerce.number().int().min(0).max(10000).default(0)}).strict().parse(request.query);
    return service.list(await app.authenticate(request),request.params.patientId,page.limit,page.offset);
  });
  app.post<{Params:{patientId:string}}>('/api/patients/:patientId/documents',async request=>{
    const actor=await app.authenticate(request),input=documentUploadSchema.parse(request.body),key=z.string().min(1).max(200).parse(request.headers['idempotency-key']);
    return {document:await service.upload(actor,request.params.patientId,input,key)};
  });
  app.post<{Params:{patientId:string;documentId:string}}>('/api/patients/:patientId/documents/:documentId/download',async request=>{
    const actor=await app.authenticate(request);
    z.object({}).strict().parse(request.body??{});
    const documentId=z.uuid().parse(request.params.documentId);
    return service.download(actor,request.params.patientId,documentId);
  });
}
