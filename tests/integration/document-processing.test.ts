import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {testApplication} from '../helpers.ts';
import {WorkflowService} from '../../packages/workflows/src/service.ts';
import {DocumentManagementService} from '../../packages/workflows/src/documents/service.ts';
import {createDocumentExtractor} from '../../packages/workflows/src/documents/extraction.ts';
import {createDocumentScanner} from '../../packages/workflows/src/documents/scanner.ts';
import {processDocumentJobs,type DocumentProcessingOptions} from '../../packages/workflows/src/documents/processing.ts';
import {syntheticDocumentFixtures,syntheticPdf} from '../../packages/workflows/src/documents/synthetic-fixtures.ts';
import type {DocumentStorage} from '../../packages/workflows/src/documents/storage.ts';
import type {User} from '../../packages/contracts/src/careloop.ts';

describe('durable document extraction pipeline',()=>{
 let ctx:Awaited<ReturnType<typeof testApplication>>,service:DocumentManagementService,patient:User;
 const objects=new Map<string,Uint8Array>();let failDownload=false;
 const store:DocumentStorage={provider:'test-private-store',bucket:'test-private-bucket',async createUploadUrl({key}){return {url:`https://fixture.invalid/${encodeURIComponent(key)}`};},async getObjectMetadata(key){return {size:objects.get(key)?.byteLength??0,mimeType:'application/pdf'};},async getObjectBytes(key){if(failDownload)throw new Error('sensitive infrastructure diagnostic');const bytes=objects.get(key);if(!bytes)throw new Error('missing');return bytes;},async put({key,body}){objects.set(key,body);},async createDownloadUrl(){return 'https://fixture.invalid/private';},async deleteObject(key){objects.delete(key);}};
 const scanner=createDocumentScanner({DOCUMENT_SYNTHETIC_FIXTURES:'true',DEMO_MODE:'true',DATABASE_ENVIRONMENT:'test'}),extractor=createDocumentExtractor({});
 const run=(id:string,options:DocumentProcessingOptions={})=>processDocumentJobs(ctx.app.db,{storageFor:()=>store,scanner,extractor,documentIds:[id],...options});
 const upload=async(documentId?:string,bytes=syntheticDocumentFixtures.hba1c.bytes)=>{
  const fixture=syntheticDocumentFixtures.hba1c,session=await service.initialize(patient,'patient-001',{title:'Synthetic HbA1c report',filename:fixture.filename,mimeType:fixture.mimeType,fileSize:bytes.length,checksumSha256:createHash('sha256').update(bytes).digest('hex'),documentType:'laboratory_report',documentId,changeReason:documentId?'Synthetic revision for verification':undefined},randomUUID());
  objects.set(decodeURIComponent(new URL(session.uploadUrl).pathname.slice(1)),bytes);
  return (await service.complete(patient,'patient-001',session.sessionId,randomUUID())).document;
 };
 const rows=async(id:string)=>({document:(await ctx.app.db.pool.query('SELECT * FROM medical_documents WHERE id=$1',[id])).rows[0],jobs:(await ctx.app.db.pool.query('SELECT * FROM document_processing_jobs WHERE document_id=$1 ORDER BY created_at',[id])).rows,extractions:(await ctx.app.db.pool.query('SELECT * FROM document_extractions WHERE document_id=$1',[id])).rows,observations:(await ctx.app.db.pool.query('SELECT * FROM clinical_observations WHERE document_id=$1',[id])).rows});
 beforeAll(async()=>{ctx=await testApplication();patient=(await new WorkflowService(ctx.app.db).user('user-patient'))!;service=new DocumentManagementService(ctx.app.db,store);});
 afterAll(async()=>{await ctx?.close();});
 it('processes a sealed PDF once, attests security, and leaves every clinical result provisional',async()=>{
  const doc=await upload();expect(await run(doc.id)).toMatchObject({claimed:1,completed:1});const saved=await rows(doc.id);
  expect(saved.document).toMatchObject({security_status:'safe',processing_stage:'awaiting_review',clinical_review_status:'pending_review'});
  expect(saved.extractions).toHaveLength(1);expect(saved.observations).toHaveLength(1);expect(saved.observations[0]).toMatchObject({original_value:'5.2000',numeric_value:'5.2000',original_unit:'%',unit:'%',verification_status:'unverified',verified_by:null,verified_at:null});
  expect((await ctx.app.db.pool.query('SELECT verdict FROM document_security_checks WHERE document_id=$1',[doc.id])).rows).toEqual([{verdict:'safe'}]);
  expect((await service.observations(patient,'patient-001')).observations).toEqual([]);expect((await service.file(patient,'patient-001',doc.id)).expiresIn).toBe(60);
  expect(await run(doc.id)).toMatchObject({claimed:0});expect((await rows(doc.id)).observations).toHaveLength(1);
 });
 it('rejects active PDF content before publishing a safe preview attestation',async()=>{
  const bytes=Buffer.from(Buffer.from(syntheticPdf(['SYNTHETIC active-content security fixture'])).toString().replace('/Type /Catalog','/Type /Catalog /OpenAction << /S /JavaScript /JS (1) >>'));
  const doc=await upload(undefined,bytes);expect(await run(doc.id,{scanner:{provider:'scanner-fixture',async scan(){return {status:'safe',provider:'scanner-fixture'};}}})).toMatchObject({failed:1});
  const saved=await rows(doc.id);expect(saved.jobs[0].failure_code).toBe('PDF_ACTIVE_CONTENT');expect(saved.document.security_status).not.toBe('safe');expect((await ctx.app.db.pool.query('SELECT id FROM document_security_checks WHERE document_id=$1',[doc.id])).rows).toEqual([]);await expect(service.file(patient,'patient-001',doc.id)).rejects.toMatchObject({code:'DOCUMENT_QUARANTINED'});
 });
 it('quarantines files when no scanner exists and safely supports explicit retry after configuration',async()=>{
  const doc=await upload();expect(await run(doc.id,{scanner:createDocumentScanner({})})).toMatchObject({failed:1});let saved=await rows(doc.id);
  expect(saved.document).toMatchObject({security_status:'unavailable',processing_stage:'unavailable'});expect(saved.jobs[0].failure_code).toBe('SCANNER_UNAVAILABLE');expect(saved.extractions).toEqual([]);
  await expect(service.file(patient,'patient-001',doc.id)).rejects.toMatchObject({code:'DOCUMENT_QUARANTINED'});
  await service.retry(patient,'patient-001',doc.id,randomUUID());expect(await run(doc.id)).toMatchObject({completed:1});saved=await rows(doc.id);expect(saved.extractions).toHaveLength(1);
 });
 it('does not claim documents outside an explicit scope and prevents simultaneous duplicate processing',async()=>{
  const a=await upload(),b=await upload();expect(await processDocumentJobs(ctx.app.db,{documentIds:[]})).toMatchObject({claimed:0});
  const results=await Promise.all([run(a.id),run(a.id)]);expect(results.reduce((sum,result)=>sum+result.completed,0)).toBe(1);expect((await rows(a.id)).extractions).toHaveLength(1);expect((await rows(b.id)).jobs[0].status).toBe('pending');expect(await run(b.id)).toMatchObject({completed:1});
 });
 it('rechecks uploader authorization after extraction and persists no clinical rows after revocation',async()=>{
  const doc=await upload();try{
   const result=await run(doc.id,{extractor:{async extract(bytes,mime){const output=await extractor.extract(bytes,mime);await ctx.app.db.pool.query("UPDATE users SET account_status='suspended' WHERE id='user-patient'");return output;}}});
   expect(result).toMatchObject({cancelled:1});const saved=await rows(doc.id);expect(saved.jobs[0].failure_code).toBe('AUTHORIZATION_REVOKED');expect(saved.extractions).toEqual([]);expect(saved.observations).toEqual([]);
  }finally{await ctx.app.db.pool.query("UPDATE users SET account_status='active' WHERE id='user-patient'");}
 });
 it('rejects altered sealed objects before security scanning or extraction',async()=>{
  const doc=await upload(),key=(await ctx.app.db.pool.query('SELECT storage_key FROM document_versions WHERE id=$1',[doc.currentVersionId])).rows[0].storage_key;objects.set(key,Buffer.from('tampered private content'));const scan=vi.fn(scanner.scan);
  expect(await run(doc.id,{scanner:{provider:scanner.provider,scan}})).toMatchObject({failed:1});expect(scan).not.toHaveBeenCalled();const saved=await rows(doc.id);expect(saved.jobs[0].failure_code).toBe('INTEGRITY_MISMATCH');expect(saved.observations).toEqual([]);
 });
 it('uses delayed retries with sanitized diagnostics and recovers without duplicate rows',async()=>{
  const doc=await upload();failDownload=true;try{expect(await run(doc.id)).toMatchObject({retried:1});}finally{failDownload=false;}
  let saved=await rows(doc.id);expect(saved.jobs[0]).toMatchObject({attempts:1,status:'retry_pending',failure_code:'DOCUMENT_STORAGE_UNAVAILABLE'});expect(JSON.stringify(saved.jobs)).not.toContain('sensitive infrastructure');expect(await run(doc.id)).toMatchObject({claimed:0});
  await ctx.app.db.pool.query('UPDATE document_processing_jobs SET available_at=now() WHERE document_id=$1',[doc.id]);expect(await run(doc.id)).toMatchObject({completed:1});saved=await rows(doc.id);expect(saved.jobs[0].attempts).toBe(2);expect(saved.extractions).toHaveLength(1);
 });
 it('cancels a stale version in flight and processes only the newest version',async()=>{
  const doc=await upload();let replacement:string|undefined;
  expect(await run(doc.id,{extractor:{async extract(bytes,mime){const output=await extractor.extract(bytes,mime);replacement=(await upload(doc.id)).currentVersionId!;return output;}}})).toMatchObject({cancelled:1});
  expect((await rows(doc.id)).extractions).toHaveLength(0);expect(await run(doc.id)).toMatchObject({completed:1});const saved=await rows(doc.id);expect(saved.extractions[0].document_version_id).toBe(replacement);expect(saved.jobs.map(job=>job.status)).toEqual(['cancelled','completed']);
 });
 it('recovers an expired lease and stops exhausted jobs without another extraction attempt',async()=>{
  const doc=await upload();await ctx.app.db.pool.query("UPDATE document_processing_jobs SET status='processing',attempts=1,lease_token=$2,lease_expires_at=now()-interval '1 minute' WHERE document_id=$1",[doc.id,randomUUID()]);expect(await run(doc.id)).toMatchObject({completed:1});expect((await rows(doc.id)).jobs[0].attempts).toBe(2);
  const exhausted=await upload();await ctx.app.db.pool.query("UPDATE document_processing_jobs SET status='processing',attempts=max_attempts,lease_token=$2,lease_expires_at=now()-interval '1 minute' WHERE document_id=$1",[exhausted.id,randomUUID()]);const extract=vi.fn(extractor.extract);expect(await run(exhausted.id,{extractor:{extract}})).toMatchObject({failed:1});expect(extract).not.toHaveBeenCalled();expect((await rows(exhausted.id)).jobs[0]).toMatchObject({attempts:3,failure_code:'PROCESSING_RETRIES_EXHAUSTED'});
 });
});
