import {createHash,randomUUID} from 'node:crypto';
import {S3Client,PutObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {z} from 'zod';
import type {Db,Transaction} from '../../db/src/index.ts';
import type {User} from '../../contracts/src/careloop.ts';
import {DomainError} from '../../domain/src/index.ts';
import {WorkflowService} from './service.ts';

export const MAX_DOCUMENT_BYTES=500*1024;
export const NEON_MEDICAL_DOCUMENT_BUCKET='careloop-medical-documents';
const DOWNLOAD_SECONDS=60;
export const documentUploadSchema=z.object({
  documentType:z.enum(['laboratory_report','prescription','consultation_record','imaging_report','discharge_summary','other']),
  filename:z.string().trim().min(1).max(180).refine(value=>![...value].some(character=>character==='/'||character==='\\'||character.charCodeAt(0)<32||character.charCodeAt(0)===127),'Use a filename without paths or control characters.'),
  mimeType:z.enum(['application/pdf','image/png','image/jpeg','text/plain']),
  contentBase64:z.string().min(4).max(Math.ceil(MAX_DOCUMENT_BYTES/3)*4),
}).strict();
export type DocumentUpload=z.infer<typeof documentUploadSchema>;
export interface PrivateDocumentStore {
  readonly provider:string;
  put(input:{key:string;body:Uint8Array;mimeType:string;checksum:string}):Promise<void>;
  download(input:{key:string;filename:string;expiresIn:number}):Promise<string>;
  close?():void;
}
export type MedicalDocument={id:string;documentType:string;filename:string;mimeType:string;fileSize:number;checksum:string;processingStatus:string;createdAt:string};
type DocumentRow={id:string;document_type:string;original_filename:string;mime_type:string;file_size:string|number;checksum:string;processing_status:string;created_at:Date|string;storage_provider?:string;storage_key?:string;uploaded_by?:string};
const columns='id,document_type,original_filename,mime_type,file_size,checksum,processing_status,created_at';
function document(row:DocumentRow):MedicalDocument{return {id:row.id,documentType:row.document_type,filename:row.original_filename,mimeType:row.mime_type,fileSize:Number(row.file_size),checksum:row.checksum,processingStatus:row.processing_status,createdAt:new Date(row.created_at).toISOString()};}
function unavailable():DomainError{return new DomainError('DOCUMENT_STORAGE_UNAVAILABLE','Private document storage is not available. Please try again after storage is configured.',503);}
function attachment(filename:string):string{return `attachment; filename="medical-document"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g,value=>`%${value.charCodeAt(0).toString(16).toUpperCase()}`)}`;}

/** Only explicit credential tuples; no ambient AWS profile lookup or public/local fallback. */
export function createDocumentStore(environment:Record<string,string|undefined>=process.env):PrivateDocumentStore|null {
  const neon=environment.DOCUMENT_STORAGE_PROVIDER==='neon';
  if(environment.DOCUMENT_STORAGE_PROVIDER&&!['neon','s3'].includes(environment.DOCUMENT_STORAGE_PROVIDER))return null;
  // Neon CLI owns AWS_*; do not duplicate credentials into application-specific variables.
  // Treat each provider's settings as a complete tuple so a stale key cannot cross providers.
  const bucket=environment.DOCUMENT_STORAGE_BUCKET??(neon?NEON_MEDICAL_DOCUMENT_BUCKET:undefined);
  const region=neon?environment.AWS_REGION:environment.DOCUMENT_STORAGE_REGION;
  const accessKeyId=neon?environment.AWS_ACCESS_KEY_ID:environment.DOCUMENT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey=neon?environment.AWS_SECRET_ACCESS_KEY:environment.DOCUMENT_STORAGE_SECRET_ACCESS_KEY;
  const endpoint=neon?environment.AWS_ENDPOINT_URL_S3:environment.DOCUMENT_STORAGE_ENDPOINT;
  if(environment.DOCUMENT_STORAGE_PRIVATE!=='true'||!bucket||!region||!accessKeyId||!secretAccessKey)return null;
  if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))return null;
  if(endpoint){try{const value=new URL(endpoint);if(value.protocol!=='https:'||value.username||value.password||value.search||value.hash)return null;}catch{return null;}}
  if(neon){
    if(!endpoint)return null;
    const value=new URL(endpoint);
    if(!/^br-[a-z0-9-]+\.storage(?:\.[a-z0-9-]+)+\.neon\.tech$/.test(value.hostname)||value.port||value.pathname!=='/')return null;
  }
  const client=new S3Client({region,endpoint,credentials:{accessKeyId,secretAccessKey},forcePathStyle:neon||Boolean(endpoint),maxAttempts:2,requestChecksumCalculation:'WHEN_REQUIRED'});
  // Neon copies the object and metadata together when branching. Use the configured branch
  // endpoint at access time; embedding the ancestor endpoint in this ID would break copies.
  const provider=neon?`neon-private:${bucket}`:`s3-private:${createHash('sha256').update(JSON.stringify([endpoint??'aws',region,bucket])).digest('hex').slice(0,24)}`;
  return {
    provider,
    async put({key,body,mimeType,checksum}){await client.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:body,ContentLength:body.byteLength,ContentType:mimeType,ContentDisposition:'attachment',CacheControl:'private, no-store',Metadata:{sha256:checksum}}),{abortSignal:AbortSignal.timeout(15000)});},
    async download({key,filename,expiresIn}){return getSignedUrl(client,new GetObjectCommand({Bucket:bucket,Key:key,ResponseContentDisposition:attachment(filename),ResponseContentType:'application/octet-stream',ResponseCacheControl:'private, no-store'}),{expiresIn});},
    close(){client.destroy();},
  };
}

function decodeUpload(input:DocumentUpload):Buffer {
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.contentBase64))throw new DomainError('INVALID_DOCUMENT','Upload a valid base64-encoded document.',422);
  const bytes=Buffer.from(input.contentBase64,'base64');
  if(bytes.byteLength===0||bytes.byteLength>MAX_DOCUMENT_BYTES||bytes.toString('base64')!==input.contentBase64)throw new DomainError('INVALID_DOCUMENT','Documents must contain between 1 byte and 500 KB.',422);
  const header=bytes.subarray(0,8);
  const valid=input.mimeType==='application/pdf'?header.subarray(0,5).toString()==='%PDF-':input.mimeType==='image/png'?header.equals(Buffer.from([137,80,78,71,13,10,26,10])):input.mimeType==='image/jpeg'?bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255:!bytes.includes(0)&&Buffer.from(bytes.toString('utf8'),'utf8').equals(bytes);
  if(!valid)throw new DomainError('INVALID_DOCUMENT','The file contents do not match the selected document type.',422);
  return bytes;
}

export class MedicalDocumentService {
  private workflow:WorkflowService;
  constructor(private db:Db,private store:PrivateDocumentStore|null){this.workflow=new WorkflowService(db);}
  private async authorize(actor:User,patientId:string,tx:Transaction,write=false){
    if(!await this.workflow.canAccessPatient(actor,patientId,actor.organizationId,tx))throw new DomainError('NOT_FOUND','This patient is unavailable.',404);
    if(write&&!['patient','clinician'].includes(actor.role))throw new DomainError('FORBIDDEN','Only the patient or an approved treating clinician may upload a medical document.',403);
    if(actor.role==='clinician'){
      const approval=(await tx.query<{verification_status:string}>('SELECT verification_status FROM clinician_profiles WHERE user_id=$1 FOR SHARE',[actor.id])).rows[0];
      if(approval?.verification_status!=='approved')throw new DomainError('FORBIDDEN','Approved clinician access is required.',403);
    }
  }
  async list(actor:User,patientId:string,limit=25,offset=0){
    return this.db.transaction(async tx=>{
      await this.authorize(actor,patientId,tx);
      const release=actor.role==='patient'?" AND processing_status='ready' AND (uploaded_by=$5 OR EXISTS(SELECT 1 FROM lab_reports r WHERE r.document_id=medical_documents.id AND r.review_status='reviewed'))":'';
      const rows=(await tx.query<DocumentRow>(`SELECT ${columns} FROM medical_documents WHERE organization_id=$1 AND patient_id=$2${release} ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,[actor.organizationId,patientId,limit+1,offset,...(actor.role==='patient'?[actor.id]:[])])).rows;
      return {documents:rows.slice(0,limit).map(document),nextOffset:rows.length>limit?offset+limit:null,storageAvailable:Boolean(this.store)};
    });
  }
  async upload(actor:User,patientId:string,input:DocumentUpload,key:string):Promise<MedicalDocument>{
    const validated=documentUploadSchema.parse(input),body=decodeUpload(validated),checksum=createHash('sha256').update(body).digest('hex');
    const fingerprint=createHash('sha256').update(JSON.stringify(['document.upload',patientId,validated.documentType,validated.filename,validated.mimeType,checksum])).digest('hex');
    return this.db.transaction(async tx=>{
      await this.authorize(actor,patientId,tx,true);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`clinical:${actor.organizationId}:${actor.id}:${key}`]);
      const prior=(await tx.query<{fingerprint:string;response:MedicalDocument}>('SELECT fingerprint,response FROM clinical_record_commands WHERE organization_id=$1 AND actor_id=$2 AND idempotency_key=$3',[actor.organizationId,actor.id,key])).rows[0];
      if(prior){if(prior.fingerprint!==fingerprint)throw new DomainError('IDEMPOTENCY_CONFLICT','This request identifier was already used for different content.',409);return prior.response;}
      if(!this.store)throw unavailable();
      const id=randomUUID(),storageKey=`medical-documents/${id}`;
      try{await this.store.put({key:storageKey,body,mimeType:validated.mimeType,checksum});}catch{throw unavailable();}
      // If the transaction cannot commit after upload, retain the inaccessible private object.
      // Deleting on an ambiguous commit could corrupt a successfully saved clinical record.
      const row=(await tx.query<DocumentRow>(`INSERT INTO medical_documents(id,organization_id,patient_id,uploaded_by,document_type,original_filename,storage_provider,storage_key,mime_type,file_size,checksum,processing_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ready') RETURNING ${columns}`,[id,actor.organizationId,patientId,actor.id,validated.documentType,validated.filename,this.store.provider,storageKey,validated.mimeType,body.byteLength,checksum])).rows[0]!;
      const result=document(row);
      await tx.query('INSERT INTO audit_events(id,organization_id,actor_id,action,request_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.organizationId,actor.id,'medical_document.uploaded',randomUUID(),JSON.stringify({resourceType:'medical_document',resourceId:id})]);
      await tx.query('INSERT INTO clinical_record_commands(organization_id,patient_id,actor_id,idempotency_key,fingerprint,response) VALUES($1,$2,$3,$4,$5,$6)',[actor.organizationId,patientId,actor.id,key,fingerprint,JSON.stringify(result)]);
      return result;
    });
  }
  async download(actor:User,patientId:string,documentId:string){
    return this.db.transaction(async tx=>{
      await this.authorize(actor,patientId,tx);
      const row=(await tx.query<DocumentRow>(`SELECT ${columns},storage_provider,storage_key,uploaded_by FROM medical_documents WHERE organization_id=$1 AND patient_id=$2 AND id=$3`,[actor.organizationId,patientId,documentId])).rows[0];
      if(!row)throw new DomainError('NOT_FOUND','This document is unavailable.',404);
      if(actor.role==='patient'&&row.uploaded_by!==actor.id&&!(await tx.query("SELECT id FROM lab_reports WHERE document_id=$1 AND review_status='reviewed' FOR SHARE",[row.id])).rowCount)throw new DomainError('NOT_FOUND','This document is unavailable.',404);
      if(!this.store||row.storage_provider!==this.store.provider||row.processing_status!=='ready')throw unavailable();
      let url:string;
      try{url=await this.store.download({key:row.storage_key!,filename:row.original_filename,expiresIn:DOWNLOAD_SECONDS});}catch{throw unavailable();}
      await tx.query('INSERT INTO audit_events(id,organization_id,actor_id,action,request_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.organizationId,actor.id,'medical_document.download_authorized',randomUUID(),JSON.stringify({resourceType:'medical_document',resourceId:row.id})]);
      return {url,expiresIn:DOWNLOAD_SECONDS};
    });
  }
}
