import {describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {createDocumentStorage,resolveDocumentStorage,verifyDocumentBytes,maximumDocumentBytes} from '../../packages/workflows/src/documents/storage.ts';

const r2={DOCUMENT_STORAGE_PRIVATE:'true',DOCUMENT_STORAGE_PROVIDER:'r2',R2_ACCOUNT_ID:'a'.repeat(32),R2_ENDPOINT:`https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,R2_BUCKET_NAME:'synthetic-records',R2_ACCESS_KEY_ID:'synthetic-access',R2_SECRET_ACCESS_KEY:'synthetic-secret'};
describe('private managed document storage',()=>{
 it('requires a complete provider tuple and the matching HTTPS R2 account endpoint',()=>{
  expect(createDocumentStorage({})).toBeNull();
  expect(createDocumentStorage({...r2,R2_SECRET_ACCESS_KEY:undefined,AWS_SECRET_ACCESS_KEY:'wrong-provider'})).toBeNull();
  for(const endpoint of ['http://insecure.example','https://unrelated.example',`https://${'b'.repeat(32)}.r2.cloudflarestorage.com`])expect(createDocumentStorage({...r2,R2_ENDPOINT:endpoint})).toBeNull();
  expect(createDocumentStorage({...r2,DOCUMENT_STORAGE_PRIVATE:'false'})).toBeNull();
 });
 it('signs short, content-type-bound PUT URLs and private preview responses without exposing credentials',async()=>{
  const store=createDocumentStorage(r2)!;
  try{
   const upload=await store.createUploadUrl({key:'document-uploads/synthetic',mimeType:'application/pdf',expiresIn:300,fileSize:1234});
   const put=new URL(upload.url);
   expect(put.searchParams.get('X-Amz-Expires')).toBe('300');
   expect(put.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
   expect(put.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
   expect(upload.headers).toEqual({'Content-Type':'application/pdf'});
   expect(put.hostname).toBe(`${r2.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
   expect(upload.url).not.toContain(r2.R2_SECRET_ACCESS_KEY);
   const preview=new URL(await store.createDownloadUrl({key:'medical-documents/synthetic',filename:'report.pdf',mimeType:'application/pdf',expiresIn:60,inline:true}));
   expect(preview.searchParams.get('X-Amz-Expires')).toBe('60');
   expect(preview.searchParams.get('response-content-disposition')).toContain('inline;');
   expect(preview.searchParams.get('response-cache-control')).toBe('private, no-store');
   await expect(store.createUploadUrl({key:'document-uploads/synthetic',mimeType:'application/pdf',expiresIn:301})).rejects.toThrow();
   await expect(store.createDownloadUrl({key:'private',filename:'x.html',mimeType:'text/html',expiresIn:60,inline:true})).rejects.toThrow();
  }finally{store.close?.();}
 });
 it('retains access to original Neon references when R2 becomes the upload provider',()=>{
  const env={...r2,AWS_ENDPOINT_URL_S3:'https://br-synthetic.storage.c-2.us-east-2.aws.neon.tech',AWS_REGION:'us-east-2',AWS_ACCESS_KEY_ID:'synthetic-key',AWS_SECRET_ACCESS_KEY:'synthetic-secret',DOCUMENT_STORAGE_BUCKET:'careloop-medical-documents'};
  const store=resolveDocumentStorage('neon-private:careloop-medical-documents',env);
  try{expect(store?.provider).toBe('neon-private:careloop-medical-documents');expect(resolveDocumentStorage('unrecognized-provider',env)).toBeNull();}finally{store?.close?.();}
 });
 it('checks byte signatures, declared MIME, bounded size and SHA256 without treating a signature as a malware scan',()=>{
  const bytes=Buffer.from('%PDF-1.7\nsynthetic');
  expect(verifyDocumentBytes(bytes,'application/pdf')).toMatchObject({fileSize:bytes.length,checksum:createHash('sha256').update(bytes).digest('hex')});
  expect(()=>verifyDocumentBytes(bytes,'image/png')).toThrow();
  expect(()=>verifyDocumentBytes(bytes,'application/pdf',3)).toThrow();
  expect(()=>verifyDocumentBytes(Buffer.from('<script>'),'application/pdf')).toThrow();
  expect(maximumDocumentBytes({})).toBe(15*1024*1024);
  expect(()=>maximumDocumentBytes({DOCUMENT_MAX_BYTES:'16777216'})).toThrow();
 });
});
