import {z} from 'zod';
import {DomainError} from '../../../packages/domain/src/index.ts';
import type {CareLoopApp} from './app.ts';
import {createDocumentStore,MedicalDocumentService,type PrivateDocumentStore} from '../../../packages/workflows/src/medical-documents.ts';

export async function registerDocumentRoutes(app:CareLoopApp,store:PrivateDocumentStore|null=createDocumentStore()){
  const service=new MedicalDocumentService(app.db,store);
  app.addHook('onClose',async()=>{store?.close?.();});
  app.get<{Params:{patientId:string}}>('/api/patients/:patientId/documents',async request=>{
    const page=z.object({limit:z.coerce.number().int().min(1).max(100).default(25),offset:z.coerce.number().int().min(0).max(10000).default(0)}).strict().parse(request.query);
    return service.list(await app.authenticate(request),request.params.patientId,page.limit,page.offset);
  });
  app.post<{Params:{patientId:string}}>('/api/patients/:patientId/documents',async request=>{
    await app.authenticate(request);
    throw new DomainError('MANAGED_UPLOAD_REQUIRED','Use the medical-document upload initialization and completion endpoints.',410);
  });
  app.post<{Params:{patientId:string;documentId:string}}>('/api/patients/:patientId/documents/:documentId/download',async request=>{
    const actor=await app.authenticate(request);
    z.object({}).strict().parse(request.body??{});
    const documentId=z.uuid().parse(request.params.documentId);
    return service.download(actor,request.params.patientId,documentId);
  });
}
