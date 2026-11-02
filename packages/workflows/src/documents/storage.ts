import {createHash} from 'node:crypto';
import {S3Client,PutObjectCommand,GetObjectCommand,HeadObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {DomainError} from '../../../domain/src/index.ts';

export const DEFAULT_MAX_DOCUMENT_BYTES=15*1024*1024;
export const SUPPORTED_DOCUMENT_MIMES=['application/pdf','image/png','image/jpeg'] as const;
export interface DocumentStorage {
 readonly provider:string;
 readonly bucket:string;
 createUploadUrl(input:{key:string;mimeType:string;expiresIn:number;fileSize?:number}):Promise<{url:string;headers?:Record<string,string>}>;
 getObjectMetadata(key:string):Promise<{size:number;mimeType?:string}>;
 getObjectBytes(key:string,maxBytes:number):Promise<Uint8Array>;
 put(input:{key:string;body:Uint8Array;mimeType:string;checksum:string}):Promise<void>;
 createDownloadUrl(input:{key:string;filename:string;mimeType:string;expiresIn:number;inline?:boolean}):Promise<string>;
 deleteObject(key:string):Promise<void>;
 verifyUploadedObject?(key:string,maxBytes:number):Promise<{body:Uint8Array;mimeType:string;checksum:string}>;
 getObjectStream?(key:string,maxBytes:number):Promise<AsyncIterable<Uint8Array>>;
 copyObjectVersion?(input:{sourceKey:string;targetKey:string;maxBytes:number}):Promise<{checksum:string;fileSize:number;mimeType:string}>;
 close?():void;
}
type Environment=Record<string,string|undefined>;
function unavailable(){return new DomainError('DOCUMENT_STORAGE_UNAVAILABLE','Private document storage is unavailable. Retry after its configuration has been checked.',503);}
function invalid(message:string){return new DomainError('INVALID_DOCUMENT',message,422);}
function storageKey(key:string){if(!key||key.length>1024||key.startsWith('/')||key.split('/').some(part=>part==='..'||part==='.')||[...key].some(c=>c==='\\'||c.charCodeAt(0)<32||c.charCodeAt(0)===127))throw invalid('Invalid document object reference.');return key;}
export function maximumDocumentBytes(environment:Environment=process.env){
 const bytes=Number(environment.DOCUMENT_MAX_BYTES??DEFAULT_MAX_DOCUMENT_BYTES);
 if(!Number.isSafeInteger(bytes)||bytes<1024||bytes>DEFAULT_MAX_DOCUMENT_BYTES)throw new Error('DOCUMENT_MAX_BYTES must be between 1024 and 15728640.');
 return bytes;
}
export function detectDocumentMime(bytes:Uint8Array):typeof SUPPORTED_DOCUMENT_MIMES[number]{
 const head=Buffer.from(bytes.subarray(0,16));
 if(head.subarray(0,5).toString('ascii')==='%PDF-')return 'application/pdf';
 if(head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(head[0]===255&&head[1]===216&&head[2]===255)return 'image/jpeg';
 throw invalid('Only PDF, PNG and JPEG documents with matching file signatures are supported.');
}
export function verifyDocumentBytes(bytes:Uint8Array,declaredMime:string,maxBytes=DEFAULT_MAX_DOCUMENT_BYTES){
 if(!bytes.byteLength||bytes.byteLength>maxBytes)throw invalid('The document is empty or exceeds the configured file-size limit.');
 const mimeType=detectDocumentMime(bytes);
 if(mimeType!==declaredMime)throw invalid('The file contents do not match its declared document type.');
 return {mimeType,checksum:createHash('sha256').update(bytes).digest('hex'),fileSize:bytes.byteLength};
}
function disposition(filename:string,inline=false){
 const safe=[...filename].filter(c=>c.charCodeAt(0)>=32&&c.charCodeAt(0)!==127).join('').slice(0,180);
 return `${inline?'inline':'attachment'}; filename="medical-document"; filename*=UTF-8''${encodeURIComponent(safe).replace(/['()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** Explicit provider tuples only. A selected provider never borrows another provider's key. */
export function createDocumentStorage(environment:Environment=process.env):DocumentStorage|null {
 const selected=environment.DOCUMENT_STORAGE_PROVIDER??'s3';
 if(!['neon','s3','r2'].includes(selected)||environment.DOCUMENT_STORAGE_PRIVATE!=='true')return null;
 const neon=selected==='neon',r2=selected==='r2';
 const bucket=r2?environment.R2_BUCKET_NAME:environment.DOCUMENT_STORAGE_BUCKET??(neon?'careloop-medical-documents':undefined);
 const endpoint=r2?environment.R2_ENDPOINT:neon?environment.AWS_ENDPOINT_URL_S3:environment.DOCUMENT_STORAGE_ENDPOINT;
 const region=r2?'auto':neon?environment.AWS_REGION:environment.DOCUMENT_STORAGE_REGION;
 const accessKeyId=r2?environment.R2_ACCESS_KEY_ID:neon?environment.AWS_ACCESS_KEY_ID:environment.DOCUMENT_STORAGE_ACCESS_KEY_ID;
 const secretAccessKey=r2?environment.R2_SECRET_ACCESS_KEY:neon?environment.AWS_SECRET_ACCESS_KEY:environment.DOCUMENT_STORAGE_SECRET_ACCESS_KEY;
 if(!bucket||!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)||!region||!accessKeyId||!secretAccessKey)return null;
 if(endpoint){try{const url=new URL(endpoint);if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.pathname!=='/')return null;}catch{return null;}}
 if(neon&&(!endpoint||!/^br-[a-z0-9-]+\.storage(?:\.[a-z0-9-]+)+\.neon\.tech$/.test(new URL(endpoint).hostname)))return null;
 if(r2){
  const account=environment.R2_ACCOUNT_ID;
  if(!account||!/^([a-f0-9]{32})$/.test(account)||!endpoint)return null;
  const host=new URL(endpoint).hostname;
  if(![`${account}.r2.cloudflarestorage.com`,`${account}.eu.r2.cloudflarestorage.com`,`${account}.fedramp.r2.cloudflarestorage.com`].includes(host))return null;
 }
 const client=new S3Client({endpoint,region,credentials:{accessKeyId,secretAccessKey},forcePathStyle:Boolean(endpoint),maxAttempts:2,requestChecksumCalculation:'WHEN_REQUIRED'});
 const suffix=createHash('sha256').update(JSON.stringify([endpoint??'aws',region,bucket])).digest('hex').slice(0,24);
 const provider=neon?`neon-private:${bucket}`:`${r2?'r2':'s3'}-private:${suffix}`;
 const store:DocumentStorage={
  provider,bucket,
  async createUploadUrl({key,mimeType,expiresIn,fileSize}){
   if(!(SUPPORTED_DOCUMENT_MIMES as readonly string[]).includes(mimeType)||expiresIn<1||expiresIn>300)throw invalid('Unsupported upload type or expiration.');
   if(fileSize!==undefined&&(!Number.isSafeInteger(fileSize)||fileSize<1||fileSize>maximumDocumentBytes(environment)))throw invalid('Invalid upload size.');
   try{return {url:await getSignedUrl(client,new PutObjectCommand({Bucket:bucket,Key:storageKey(key),ContentType:mimeType,ContentLength:fileSize}),{expiresIn,signableHeaders:new Set(['content-type',...(fileSize===undefined?[]:['content-length'])])}),headers:{'Content-Type':mimeType}};}catch{throw unavailable();}
  },
  async getObjectMetadata(key){
   try{const object=await client.send(new HeadObjectCommand({Bucket:bucket,Key:storageKey(key)}),{abortSignal:AbortSignal.timeout(15000)});return {size:object.ContentLength??0,mimeType:object.ContentType};}catch{throw unavailable();}
  },
  async getObjectBytes(key,maxBytes){
   if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>DEFAULT_MAX_DOCUMENT_BYTES)throw invalid('Invalid object-size limit.');
   try{
    const object=await client.send(new GetObjectCommand({Bucket:bucket,Key:storageKey(key)}),{abortSignal:AbortSignal.timeout(30000)});
    if(!object.Body)throw unavailable();
    const body=object.Body as AsyncIterable<Uint8Array>&{destroy?:()=>void};
    if((object.ContentLength??0)>maxBytes){body.destroy?.();throw invalid('The uploaded document exceeds the file-size limit.');}
    const chunks:Uint8Array[]=[];let size=0;
    for await(const chunk of body){size+=chunk.byteLength;if(size>maxBytes){body.destroy?.();throw invalid('The uploaded document exceeds the file-size limit.');}chunks.push(chunk);}
    return Buffer.concat(chunks,size);
   }catch(error){if(error instanceof DomainError)throw error;throw unavailable();}
  },
  async put({key,body,mimeType,checksum}){
   if(body.byteLength>DEFAULT_MAX_DOCUMENT_BYTES||!body.byteLength||createHash('sha256').update(body).digest('hex')!==checksum)throw invalid('The sealed object checksum or size is invalid.');
   try{await client.send(new PutObjectCommand({Bucket:bucket,Key:storageKey(key),Body:body,ContentType:mimeType,ContentLength:body.byteLength,ContentDisposition:'attachment',CacheControl:'private, no-store',Metadata:{sha256:checksum}}),{abortSignal:AbortSignal.timeout(30000)});}catch{throw unavailable();}
  },
  async createDownloadUrl({key,filename,mimeType,expiresIn,inline}){
   if(expiresIn<1||expiresIn>60)throw invalid('Download links must expire within sixty seconds.');
   if(inline&&!(SUPPORTED_DOCUMENT_MIMES as readonly string[]).includes(mimeType))throw invalid('Preview is not supported for this file type.');
   try{return await getSignedUrl(client,new GetObjectCommand({Bucket:bucket,Key:storageKey(key),ResponseContentType:inline?mimeType:'application/octet-stream',ResponseContentDisposition:disposition(filename,inline),ResponseCacheControl:'private, no-store'}),{expiresIn});}catch{throw unavailable();}
  },
  async deleteObject(key){try{await client.send(new DeleteObjectCommand({Bucket:bucket,Key:storageKey(key)}),{abortSignal:AbortSignal.timeout(15000)});}catch{throw unavailable();}},
  async verifyUploadedObject(key,maxBytes){const metadata=await store.getObjectMetadata(key);if(metadata.size>maxBytes)throw invalid('The uploaded document exceeds the file-size limit.');const body=await store.getObjectBytes(key,maxBytes);const checked=verifyDocumentBytes(body,metadata.mimeType??'',maxBytes);return {body,mimeType:checked.mimeType,checksum:checked.checksum};},
  async getObjectStream(key,maxBytes){const body=await store.getObjectBytes(key,maxBytes);return (async function*(){yield body;})();},
  async copyObjectVersion({sourceKey,targetKey,maxBytes}){if(sourceKey===targetKey)throw invalid('A document version must use a new object reference.');const body=await store.getObjectBytes(sourceKey,maxBytes);const mimeType=detectDocumentMime(body),checked=verifyDocumentBytes(body,mimeType,maxBytes);await store.put({key:targetKey,body,mimeType,checksum:checked.checksum});return checked;},
  close(){client.destroy();},
 };
 return store;
}

/** Resolve existing version references after selecting a different upload provider. */
export function resolveDocumentStorage(provider:string,environment:Environment=process.env):DocumentStorage|null {
 for(const selected of ['neon','r2','s3']){
  const store=createDocumentStorage({...environment,DOCUMENT_STORAGE_PROVIDER:selected});
  if(store?.provider===provider)return store;
  store?.close?.();
 }
 return null;
}
