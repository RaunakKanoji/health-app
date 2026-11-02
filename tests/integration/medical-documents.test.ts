import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {createDocumentStore,type PrivateDocumentStore} from '../../packages/workflows/src/medical-documents.ts';
import {grantPatient,signIn,testApplication} from '../helpers.ts';

describe('private medical documents',()=>{
  let ctx:Awaited<ReturnType<typeof testApplication>>,patient:string,otherPatient:string,clinician:string,admin:string;
  const uploaded=new Map<string,{body:Uint8Array;mimeType:string;checksum:string}>();
  const downloads:Array<{key:string;filename:string;expiresIn:number}>=[];
  let fail=false;
  const store:PrivateDocumentStore={provider:'private-test-fixture',async put(input){if(fail)throw new Error('secret-storage-debug');uploaded.set(input.key,input);},async download(input){downloads.push(input);return `https://private-storage.example.test/${input.key}?temporary=synthetic`;}};
  const payload={documentType:'laboratory_report',filename:'synthetic-report.txt',mimeType:'text/plain',contentBase64:Buffer.from('Synthetic laboratory report; not medical advice.').toString('base64')};
  const upload=(cookie:string,patientId='patient-001',body:Record<string,unknown>=payload,key=randomUUID())=>ctx.app.inject({method:'POST',url:`/api/patients/${patientId}/documents`,headers:{cookie,'idempotency-key':key},payload:body});
  const get=(cookie:string,patientId='patient-001')=>ctx.app.inject({url:`/api/patients/${patientId}/documents`,headers:{cookie}});
  const download=(cookie:string,id:string,patientId='patient-001')=>ctx.app.inject({method:'POST',url:`/api/patients/${patientId}/documents/${id}/download`,headers:{cookie},payload:{}});
  beforeAll(async()=>{ctx=await testApplication({documentStore:store});patient=await signIn(ctx.app,'patient');otherPatient=await signIn(ctx.app,'patient002');clinician=await signIn(ctx.app,'clinician');admin=await signIn(ctx.app,'admin');});
  afterAll(async()=>{await ctx?.close();});

  it('persists checksummed metadata and keeps object keys outside API projections',async()=>{
    const key=randomUUID(),before=uploaded.size,response=await upload(patient,'patient-001',payload,key);
    expect(response.statusCode,response.body).toBe(200);
    const saved=response.json().document;
    expect(saved).toMatchObject({filename:payload.filename,documentType:'laboratory_report',mimeType:'text/plain',fileSize:Buffer.from(payload.contentBase64,'base64').length,checksum:createHash('sha256').update(Buffer.from(payload.contentBase64,'base64')).digest('hex'),processingStatus:'ready'});
    const row=(await ctx.app.db.pool.query('SELECT patient_id,storage_key,storage_provider FROM medical_documents WHERE id=$1',[saved.id])).rows[0];
    expect(row.patient_id).toBe('patient-001');expect(uploaded.has(row.storage_key)).toBe(true);expect(row.storage_key).not.toContain('patient-001');
    expect(response.body).not.toContain(row.storage_key);expect(response.body).not.toContain(store.provider);
    const repeat=await upload(patient,'patient-001',payload,key);expect(repeat.json()).toEqual(response.json());expect(uploaded.size).toBe(before+1);
    expect((await upload(patient,'patient-001',{...payload,filename:'different.txt'},key)).statusCode).toBe(409);
    const list=await get(patient);expect(list.statusCode).toBe(200);expect(list.json().documents.some((item:{id:string})=>item.id===saved.id)).toBe(true);expect(list.body).not.toContain(row.storage_key);
    const audit=(await ctx.app.db.pool.query("SELECT metadata FROM audit_events WHERE action='medical_document.uploaded' AND metadata->>'resourceId'=$1",[saved.id])).rows[0].metadata;
    expect(audit).toEqual({resourceType:'medical_document',resourceId:saved.id});
  });
  it('blocks cross-patient access, route tampering, unrelated clinicians and administrators',async()=>{
    const saved=(await upload(patient)).json().document;
    expect((await get(otherPatient)).statusCode).toBe(404);
    expect((await upload(otherPatient)).statusCode).toBe(404);
    expect((await download(otherPatient,saved.id)).statusCode).toBe(404);
    expect((await download(patient,saved.id,'patient-002')).statusCode).toBe(404);
    const outsider=await signIn(ctx.app,'outsider');expect((await get(outsider)).statusCode).toBe(404);
    expect((await get(admin)).statusCode).toBe(404);expect((await upload(admin)).statusCode).toBe(404);
    expect((await ctx.app.inject({url:'/api/patients/patient-001/documents'})).statusCode).toBe(401);
  });
  it('allows assigned approved clinicians and rechecks approval and revoked relationships',async()=>{
    const uploadedByClinician=await upload(clinician);expect(uploadedByClinician.statusCode).toBe(200);
    const documentId=uploadedByClinician.json().document.id;
    expect((await download(patient,documentId)).statusCode).toBe(404);
    expect((await get(patient)).json().documents.some((item:{id:string})=>item.id===documentId)).toBe(false);
    await ctx.app.db.pool.query("INSERT INTO lab_reports(organization_id,patient_id,document_id,created_by,laboratory_name,report_date,review_status,reviewed_by,reviewed_at) VALUES('org-screening','patient-001',$1,'user-clinician','Synthetic lab','2026-11-02','reviewed','user-clinician',now())",[documentId]);
    expect((await download(patient,documentId)).statusCode).toBe(200);
    await ctx.app.db.pool.query("UPDATE clinician_patient_relationships SET relationship_status='revoked',revoked_at=now() WHERE clinician_id='user-clinician' AND patient_id='patient-001'");
    expect((await get(clinician)).statusCode).toBe(404);
    await grantPatient(ctx.app,'patient-001',['user-clinician']);
    await ctx.app.db.pool.query("UPDATE clinician_profiles SET verification_status='pending' WHERE user_id='user-clinician'");
    expect([403,404]).toContain((await upload(clinician)).statusCode);
    await ctx.app.db.pool.query("UPDATE clinician_profiles SET verification_status='approved' WHERE user_id='user-clinician'");
  });
  it('allows an explicitly assigned administrator to read but not upload',async()=>{
    await grantPatient(ctx.app,'patient-001',['user-admin']);
    expect((await get(admin)).statusCode).toBe(200);expect((await upload(admin)).statusCode).toBe(403);
  });
  it('authorizes a short download and then denies a revoked reader',async()=>{
    const saved=(await upload(patient)).json().document,result=await download(clinician,saved.id);
    expect(result.statusCode,result.body).toBe(200);expect(result.json().expiresIn).toBe(60);expect(downloads.at(-1)).toMatchObject({filename:payload.filename,expiresIn:60});
    await ctx.app.db.pool.query("UPDATE clinician_patient_relationships SET relationship_status='revoked',revoked_at=now() WHERE clinician_id='user-clinician' AND patient_id='patient-001'");
    expect((await download(clinician,saved.id)).statusCode).toBe(404);
    await grantPatient(ctx.app,'patient-001',['user-clinician']);
  });
  it('rejects disguised, oversized and path-bearing files before writing to storage',async()=>{
    const before=uploaded.size;
    for(const body of [{...payload,mimeType:'application/pdf'},{...payload,filename:'../../private.txt'},{...payload,contentBase64:'invalid!'},{...payload,contentBase64:Buffer.alloc(500*1024+1).toString('base64')},{...payload,mimeType:'text/html'}])expect((await upload(patient,'patient-001',body)).statusCode).toBe(422);
    expect(uploaded.size).toBe(before);
  });
  it('sanitizes storage outages and does not persist a false successful upload',async()=>{
    const before=(await ctx.app.db.pool.query('SELECT count(*)::int AS count FROM medical_documents')).rows[0].count;
    fail=true;const result=await upload(patient);fail=false;
    expect(result.statusCode).toBe(503);expect(result.body).not.toContain('secret-storage-debug');
    expect((await ctx.app.db.pool.query('SELECT count(*)::int AS count FROM medical_documents')).rows[0].count).toBe(before);
  });
});

describe('missing private storage configuration',()=>{
  it('does not create a public/local fallback or accept a plaintext object endpoint',()=>{
    expect(createDocumentStore({})).toBeNull();
    expect(createDocumentStore({DOCUMENT_STORAGE_PRIVATE:'true',DOCUMENT_STORAGE_BUCKET:'synthetic',DOCUMENT_STORAGE_REGION:'test',DOCUMENT_STORAGE_ACCESS_KEY_ID:'test',DOCUMENT_STORAGE_SECRET_ACCESS_KEY:'test',DOCUMENT_STORAGE_ENDPOINT:'http://insecure.example.test'})).toBeNull();
  });
  it('signs a sixty-second attachment download using the real S3 adapter without network access',async()=>{
    const store=createDocumentStore({DOCUMENT_STORAGE_PRIVATE:'true',DOCUMENT_STORAGE_BUCKET:'synthetic',DOCUMENT_STORAGE_REGION:'us-east-1',DOCUMENT_STORAGE_ACCESS_KEY_ID:'synthetic-key',DOCUMENT_STORAGE_SECRET_ACCESS_KEY:'synthetic-secret',DOCUMENT_STORAGE_ENDPOINT:'https://private-storage.example.test'})!;
    try {
      const url=new URL(await store.download({key:'medical-documents/synthetic',filename:'Synthetic laboratory report.txt',expiresIn:60}));
      expect(url.protocol).toBe('https:');expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
      expect(url.searchParams.get('response-content-disposition')).toContain('attachment;');
      expect(url.searchParams.get('response-content-type')).toBe('application/octet-stream');
      expect(url.searchParams.get('response-cache-control')).toBe('private, no-store');
    } finally {store.close?.();}
  });
  it('uses CLI-owned Neon credentials as one tuple and keeps branch copies accessible',async()=>{
    const environment={DOCUMENT_STORAGE_PROVIDER:'neon',DOCUMENT_STORAGE_PRIVATE:'true',AWS_ENDPOINT_URL_S3:'https://br-synthetic-parent.storage.c-2.us-east-2.aws.neon.tech',AWS_REGION:'us-east-2',AWS_ACCESS_KEY_ID:'synthetic-neon-key',AWS_SECRET_ACCESS_KEY:'synthetic-neon-secret'};
    const parent=createDocumentStore(environment)!,child=createDocumentStore({...environment,AWS_ENDPOINT_URL_S3:'https://br-synthetic-child.storage.c-2.us-east-2.aws.neon.tech'})!;
    try {
      expect(parent.provider).toBe('neon-private:careloop-medical-documents');expect(child.provider).toBe(parent.provider);
      const url=new URL(await child.download({key:'medical-documents/synthetic',filename:'Synthetic.txt',expiresIn:60}));
      expect(url.hostname).toBe('br-synthetic-child.storage.c-2.us-east-2.aws.neon.tech');
      expect(url.pathname).toBe('/careloop-medical-documents/medical-documents/synthetic');
      expect(url.searchParams.get('X-Amz-Credential')).toContain('synthetic-neon-key/');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
      expect(url.href).not.toContain('synthetic-neon-secret');
      expect(createDocumentStore({...environment,AWS_SECRET_ACCESS_KEY:undefined,DOCUMENT_STORAGE_SECRET_ACCESS_KEY:'unrelated-key'})).toBeNull();
      expect(createDocumentStore({...environment,AWS_ENDPOINT_URL_S3:'https://unrelated.example.test'})).toBeNull();
      expect(createDocumentStore({...environment,DOCUMENT_STORAGE_PRIVATE:undefined})).toBeNull();
    } finally {parent.close?.();child.close?.();}
  });
  it('exposes metadata honestly and returns a configuration error for uploads',async()=>{
    const ctx=await testApplication({documentStore:null});
    try {
      const cookie=await signIn(ctx.app,'patient');
      const list=await ctx.app.inject({url:'/api/patients/patient-001/documents',headers:{cookie}});
      expect(list.statusCode).toBe(200);expect(list.json().storageAvailable).toBe(false);
      const result=await ctx.app.inject({method:'POST',url:'/api/patients/patient-001/documents',headers:{cookie,'idempotency-key':randomUUID()},payload:{documentType:'other',filename:'synthetic.txt',mimeType:'text/plain',contentBase64:Buffer.from('Synthetic').toString('base64')}});
      expect(result.statusCode).toBe(503);expect(result.json().error.code).toBe('DOCUMENT_STORAGE_UNAVAILABLE');
    } finally {await ctx.close();}
  });
});
