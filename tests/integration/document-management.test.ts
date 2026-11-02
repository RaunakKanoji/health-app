import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {grantPatient,signIn,testApplication} from '../helpers.ts';
import type {DocumentStorage} from '../../packages/workflows/src/documents/storage.ts';
import type {DocumentDetailResponse,DocumentUploadSession,ManagedDocument} from '../../packages/contracts/src/documents.ts';

describe('managed documents: isolated storage and database',()=>{
 let ctx:Awaited<ReturnType<typeof testApplication>>,patient:string,clinician:string,other:string,outsider:string;
 const bytes=Buffer.from('%PDF-1.7\nSynthetic laboratory fixture; no clinical interpretation.\n%%EOF');
 const objects=new Map<string,Uint8Array>(),uploads=new Map<string,string>(),downloads:Array<{key:string;inline?:boolean}>=[];
 const store:DocumentStorage={provider:'synthetic-private',bucket:'synthetic',async createUploadUrl({key}){const url=`https://storage.example.test/upload/${randomUUID()}`;uploads.set(url,key);return {url,headers:{'content-type':'application/pdf'}};},async getObjectMetadata(key){const body=objects.get(key);if(!body)throw new Error('missing object');return {size:body.length,mimeType:'application/pdf'};},async getObjectBytes(key,max){const body=objects.get(key)!;if(body.length>max)throw new Error('too large');return new Uint8Array(body);},async put({key,body}){objects.set(key,new Uint8Array(body));},async createDownloadUrl(input){downloads.push(input);return 'https://storage.example.test/signed-preview?expires=60';},async deleteObject(key){objects.delete(key);}};
 const base='/api/patients/patient-001/documents';
 const metadata={title:'Synthetic source document',description:'Test source only',documentType:'laboratory_report',tags:['synthetic'],documentDate:'2026-11-02',healthcareProviderName:'Synthetic laboratory'};
 const mutation=(path:string,payload:unknown,cookie=patient,key=randomUUID(),method:'POST'|'PATCH'|'DELETE'='POST')=>ctx.app.inject({method,url:`${base}${path}`,headers:{cookie,'idempotency-key':key},payload:payload as Record<string,unknown>});
 const get=(path:string,cookie=patient)=>ctx.app.inject({url:`${base}${path}`,headers:{cookie}});
 async function initialize(extra:Record<string,unknown>={},cookie=patient){const result=await mutation('/upload/init',{...metadata,filename:'synthetic.pdf',mimeType:'application/pdf',fileSize:bytes.length,...extra},cookie);expect(result.statusCode,result.body).toBe(200);return result.json<DocumentUploadSession>();}
 async function upload(extra:Record<string,unknown>={},cookie=patient){const session=await initialize(extra,cookie);objects.set(uploads.get(session.uploadUrl)!,bytes);const result=await mutation('/upload/complete',{sessionId:session.sessionId},cookie);expect(result.statusCode,result.body).toBe(200);return {session,document:result.json<{document:ManagedDocument}>().document};}
 async function markSafe(document:ManagedDocument){await ctx.app.db.pool.query("UPDATE medical_documents SET security_status='safe',processing_stage='awaiting_review',processing_status='ready' WHERE id=$1",[document.id]);await ctx.app.db.pool.query("INSERT INTO document_security_checks(organization_id,patient_id,document_id,document_version_id,provider,verdict,checksum_sha256) VALUES('org-screening','patient-001',$1,$2,'synthetic-scanner','safe',$3)",[document.id,document.currentVersionId,document.checksumSha256]);await ctx.app.db.pool.query("UPDATE document_processing_jobs SET status='completed' WHERE document_id=$1",[document.id]);}
 async function extraction(document:ManagedDocument){const extractionId=randomUUID(),observationId=randomUUID();await markSafe(document);await ctx.app.db.pool.query("INSERT INTO document_extractions(id,organization_id,patient_id,document_id,document_version_id,extractor_name,extractor_model_version,structured_output,extraction_status) VALUES($1,'org-screening','patient-001',$2,$3,'fixture','1',$4,'completed')",[extractionId,document.id,document.currentVersionId,JSON.stringify({summary:'Source fixture only',pages:[{page:1,text:'Glucose 5.2 mmol/L'}]})]);await ctx.app.db.pool.query("INSERT INTO clinical_observations(id,organization_id,patient_id,document_id,document_version_id,extraction_id,source_index,test_name,original_value,numeric_value,original_unit,unit,reference_range_low,reference_range_high,observed_at,method,specimen_type,source_page,source_text,original_source) VALUES($1,'org-screening','patient-001',$2,$3,$4,0,'Glucose','5.2','5.2','mmol/L','mmol/L',3.1,6.2,'2026-11-02','documented synthetic method','plasma',1,'Glucose 5.2 mmol/L',$5)",[observationId,document.id,document.currentVersionId,extractionId,JSON.stringify({originalValue:'5.2',originalUnit:'mmol/L',sourcePage:1})]);return observationId;}
 beforeAll(async()=>{ctx=await testApplication({documentManagementStorage:store});patient=await signIn(ctx.app,'patient');clinician=await signIn(ctx.app,'clinician');other=await signIn(ctx.app,'patient002');outsider=await signIn(ctx.app,'outsider');});
 afterAll(async()=>{await ctx?.close();});

 it('seals validated bytes away from the mutable signed upload and creates one immutable version/job',async()=>{
  const session=await initialize(),stage=uploads.get(session.uploadUrl)!;objects.set(stage,bytes);const key=randomUUID(),first=await mutation('/upload/complete',{sessionId:session.sessionId},patient,key);expect(first.statusCode,first.body).toBe(200);
  const doc=first.json().document as ManagedDocument;expect(doc).toMatchObject({securityStatus:'awaiting_scan',processingStage:'security_checks',clinicalReviewStatus:'pending_review',documentDate:'2026-11-02',checksumSha256:createHash('sha256').update(bytes).digest('hex')});
  expect((await mutation('/upload/complete',{sessionId:session.sessionId},patient,key)).json()).toEqual(first.json());
  const version=(await ctx.app.db.pool.query('SELECT * FROM document_versions WHERE id=$1',[doc.currentVersionId])).rows[0];expect(version.storage_key).not.toBe(stage);objects.set(stage,Buffer.from('overwritten staging object'));expect(Buffer.from(objects.get(version.storage_key)!)).toEqual(bytes);
  expect((await ctx.app.db.pool.query('SELECT count(*)::int AS n FROM document_processing_jobs WHERE document_id=$1',[doc.id])).rows[0].n).toBe(1);
  await expect(ctx.app.db.pool.query('UPDATE document_versions SET checksum_sha256=$1 WHERE id=$2',['0'.repeat(64),doc.currentVersionId])).rejects.toThrow();
  expect((await get(`/${doc.id}/preview`)).statusCode).toBe(409);expect(JSON.stringify((await get(`/${doc.id}/detail`)).json())).not.toContain(version.storage_key);
 });
 it('enforces authentication, patient scope, active care relationships and fresh clinician approval',async()=>{
  const {document}=await upload();expect((await ctx.app.inject({url:`${base}/manage`})).statusCode).toBe(401);
  for(const cookie of [other,outsider]){expect((await get('/manage',cookie)).statusCode).toBe(404);expect((await get(`/${document.id}/detail`,cookie)).statusCode).toBe(404);expect((await mutation(`/${document.id}`,metadata,cookie,randomUUID(),'PATCH')).statusCode).toBe(404);}
  expect((await mutation('/upload/init',{...metadata,filename:'x.pdf',mimeType:'application/pdf',fileSize:bytes.length},other)).statusCode).toBe(404);
  await ctx.app.db.pool.query("UPDATE clinician_profiles SET verification_status='pending' WHERE user_id='user-clinician'");expect([403,404]).toContain((await get(`/${document.id}/detail`,clinician)).statusCode);await ctx.app.db.pool.query("UPDATE clinician_profiles SET verification_status='approved' WHERE user_id='user-clinician'");
  await ctx.app.db.pool.query("UPDATE clinician_patient_relationships SET relationship_status='revoked',revoked_at=now() WHERE clinician_id='user-clinician' AND patient_id='patient-001'");expect((await get('/manage',clinician)).statusCode).toBe(404);await grantPatient(ctx.app,'patient-001',['user-clinician']);
 });
 it('rejects content spoofing, declared length/hash mismatch, expired or cancelled sessions, and missing idempotency keys',async()=>{
  const forged=await initialize();objects.set(uploads.get(forged.uploadUrl)!,Buffer.alloc(bytes.length,65));expect((await mutation('/upload/complete',{sessionId:forged.sessionId})).statusCode).toBe(422);
  const checksum=await initialize({checksumSha256:'0'.repeat(64)});objects.set(uploads.get(checksum.uploadUrl)!,bytes);expect((await mutation('/upload/complete',{sessionId:checksum.sessionId})).statusCode).toBe(422);
  const short=await initialize();objects.set(uploads.get(short.uploadUrl)!,bytes.subarray(0,20));expect((await mutation('/upload/complete',{sessionId:short.sessionId})).statusCode).toBe(422);
  const expired=await initialize();objects.set(uploads.get(expired.uploadUrl)!,bytes);await ctx.app.db.pool.query("UPDATE document_upload_sessions SET expires_at=now()-interval '1 minute' WHERE id=$1",[expired.sessionId]);expect((await mutation('/upload/complete',{sessionId:expired.sessionId})).statusCode).toBe(409);
  const cancelled=await initialize();expect((await mutation('/upload/cancel',{sessionId:cancelled.sessionId})).statusCode).toBe(200);objects.set(uploads.get(cancelled.uploadUrl)!,bytes);expect((await mutation('/upload/complete',{sessionId:cancelled.sessionId})).statusCode).toBe(409);
  expect((await ctx.app.inject({method:'POST',url:`${base}/upload/cancel`,headers:{cookie:patient},payload:{sessionId:cancelled.sessionId}})).statusCode).toBe(422);
  expect((await mutation('/upload/init',{...metadata,filename:'huge.pdf',mimeType:'application/pdf',fileSize:15728641})).statusCode).toBe(422);
 });
 it('keeps provisional evidence outside approved clinical context and records clinician corrections without altering originals',async()=>{
  const {document}=await upload(),observationId=await extraction(document);
  const detail=(await get(`/${document.id}/detail`)).json<DocumentDetailResponse>();expect(detail.observations[0]).toMatchObject({originalValue:'5.2',observedAt:'2026-11-02',verificationStatus:'unverified'});expect((await get('/observations')).json().observations.some((item:{id:string})=>item.id===observationId)).toBe(false);
  const review={versionId:document.currentVersionId,status:'approved',reviewNotes:'Checked original synthetic source'};
  expect((await mutation(`/${document.id}/review`,review,patient)).statusCode).toBe(403);expect((await mutation(`/${document.id}/review`,review,clinician)).statusCode).toBe(409);
  const correction={reason:'Compared with the synthetic original',numericValue:'5.30',verificationStatus:'verified'};
  expect((await mutation(`/${document.id}/observations/${observationId}`,correction,patient,randomUUID(),'PATCH')).statusCode).toBe(403);
  const corrected=await mutation(`/${document.id}/observations/${observationId}`,correction,clinician,randomUUID(),'PATCH');expect(corrected.statusCode,corrected.body).toBe(200);expect(corrected.json().observation).toMatchObject({numericValue:'5.30',originalValue:'5.2',originalUnit:'mmol/L',verificationStatus:'verified'});
  await expect(ctx.app.db.pool.query('UPDATE clinical_observations SET original_value=$1 WHERE id=$2',['9.9',observationId])).rejects.toThrow();await expect(ctx.app.db.pool.query('DELETE FROM document_extractions WHERE document_id=$1',[document.id])).rejects.toThrow();
  expect((await mutation(`/${document.id}/review`,review,clinician)).statusCode).toBe(200);
  expect((await get('/observations')).json().observations.some((item:{id:string})=>item.id===observationId)).toBe(true);expect((await get('/trends')).json().trends.some((item:{points:Array<{observationId:string}>})=>item.points.some(point=>point.observationId===observationId))).toBe(true);
  const context=await ctx.app.inject({method:'POST',url:'/api/patients/patient-001/clinical-context',headers:{cookie:patient},payload:{includeAIHistory:false}});expect(context.statusCode,context.body).toBe(200);expect(JSON.stringify(context.json().documentObservations)).toContain(observationId);
  const bundle=await get(`/${document.id}/fhir`);expect(bundle.statusCode,bundle.body).toBe(200);expect(bundle.json().entry.some((item:{resource:{resourceType:string;id:string}})=>item.resource.resourceType==='Observation'&&item.resource.id===observationId)).toBe(true);
  const reviewed=(await get(`/${document.id}/detail`)).json<DocumentDetailResponse>();expect(reviewed.corrections).toHaveLength(1);expect(reviewed.corrections[0]?.beforeValue.originalValue).toBe('5.2');expect(reviewed.reviews).toHaveLength(1);
  await expect(ctx.app.db.pool.query("UPDATE document_security_checks SET verdict='infected' WHERE document_id=$1",[document.id])).rejects.toThrow();
 });
 it('requires exact-version scan proof and retains earlier versions without permitting stale completion',async()=>{
  const {document}=await upload();await markSafe(document);expect((await get(`/${document.id}/preview`)).statusCode).toBe(200);expect(downloads.at(-1)?.inline).toBe(true);
  const second=await initialize({documentId:document.id,changeReason:'Replace synthetic source'}),third=await initialize({documentId:document.id,changeReason:'Newest synthetic source'});objects.set(uploads.get(second.uploadUrl)!,bytes);objects.set(uploads.get(third.uploadUrl)!,bytes);
  expect((await mutation('/upload/complete',{sessionId:third.sessionId})).statusCode).toBe(200);expect((await mutation('/upload/complete',{sessionId:second.sessionId})).statusCode).toBe(409);
  expect((await get(`/${document.id}/preview`)).statusCode).toBe(409);expect((await get(`/${document.id}/preview?versionId=${document.currentVersionId}`)).statusCode).toBe(200);
  const detail=(await get(`/${document.id}/detail`)).json<DocumentDetailResponse>();expect(detail.versions.map(item=>item.versionNumber)).toEqual([3,1]);expect(detail.versions.find(item=>item.id===document.currentVersionId)?.securityStatus).toBe('safe');
 });
 it('soft deletion hides search, timeline, verified facts and previews while retaining all version bytes',async()=>{
  const {document}=await upload({title:'Unique retention token',tags:['indexfixtureonly']});await markSafe(document);const count=objects.size;const tagged=(await get('/manage?q=indexfixtureonly')).json();expect(tagged.documents.map((item:{id:string})=>item.id)).toEqual([document.id]);expect(tagged.pagination.total).toBe(1);expect(tagged.counts.total).toBeGreaterThan(1);expect((await get('/manage?q=retention')).json().documents.some((item:{id:string})=>item.id===document.id)).toBe(true);
  expect((await mutation(`/${document.id}`,{reason:'Synthetic restoration exercise'},patient,randomUUID(),'DELETE')).statusCode).toBe(200);expect(objects.size).toBe(count);
  expect((await get('/manage?q=retention')).json().documents).toEqual([]);expect((await get(`/${document.id}/preview`)).statusCode).toBe(404);expect((await get('/timeline')).json().entries.some((item:{documentId:string})=>item.documentId===document.id)).toBe(false);
  expect((await get('/manage?deleted=true&q=retention')).json().documents).toHaveLength(1);expect((await mutation(`/${document.id}/restore`,{})).statusCode).toBe(200);expect((await get(`/${document.id}/preview`)).statusCode).toBe(200);
 });
 it('withholds clinician uploads until explicit clinical review release',async()=>{
  const {document}=await upload({},clinician);await markSafe(document);expect((await get(`/${document.id}/detail`)).statusCode).toBe(404);
  expect((await mutation(`/${document.id}/review`,{versionId:document.currentVersionId,status:'approved',reviewNotes:'Reviewed the complete synthetic original'},clinician)).statusCode).toBe(200);expect((await get(`/${document.id}/detail`)).statusCode).toBe(200);expect((await get(`/${document.id}/detail`)).json().capabilities.canEdit).toBe(false);
 });
 it('resumes a current upload cancelled by deletion and retains the deletion reason',async()=>{
  const {document}=await upload(),reason='Synthetic deletion during queued processing';
  expect((await mutation(`/${document.id}`,{reason},patient,randomUUID(),'DELETE')).statusCode).toBe(200);
  const paused=(await ctx.app.db.pool.query('SELECT status,failure_code FROM document_processing_jobs WHERE document_version_id=$1',[document.currentVersionId])).rows[0];expect(paused).toMatchObject({status:'cancelled',failure_code:'DOCUMENT_DELETED'});
  const restored=await mutation(`/${document.id}/restore`,{});expect(restored.statusCode,restored.body).toBe(200);expect(restored.json().document.processingStage).toBe('security_checks');
  expect((await ctx.app.db.pool.query('SELECT status FROM document_processing_jobs WHERE document_version_id=$1',[document.currentVersionId])).rows[0].status).toBe('retry_pending');
  const audit=(await ctx.app.db.pool.query("SELECT metadata FROM audit_events WHERE action='document.document_deleted' AND metadata->>'documentId'=$1",[document.id])).rows[0];expect(audit.metadata.reason).toBe(reason);
 });
});
