import {request} from './api';
import type {DocumentDetailResponse,DocumentFileResponse,DocumentFilters,DocumentListResponse,DocumentMetadataInput,DocumentReviewInput,DocumentTimelineEntry,DocumentTrend,DocumentUploadInitInput,DocumentUploadSession,ObservationCorrectionInput} from '../../../../packages/contracts/src/documents';

export type {ClinicalObservation,DocumentDetailResponse,DocumentExtraction,DocumentFilters,DocumentListResponse,DocumentMetadataInput,DocumentReviewInput,DocumentTimelineEntry,DocumentTrend,DocumentUploadInitInput,DocumentUploadSession,ManagedDocument,ObservationCorrectionInput} from '../../../../packages/contracts/src/documents';

const base=(patientId:string)=>`/patients/${encodeURIComponent(patientId)}/documents`;
const item=(patientId:string,id:string)=>`${base(patientId)}/${encodeURIComponent(id)}`;
const write=<T>(path:string,method:string,body:unknown,key:string,signal?:AbortSignal)=>request<T>(path,{method,body:JSON.stringify(body),headers:{'Idempotency-Key':key},signal});

/** All application requests use the existing Clerk session. Presigned storage requests do not. */
export const documentApi={
  list(patientId:string,filters:DocumentFilters,signal?:AbortSignal){
    const query=new URLSearchParams();
    for(const [name,value] of Object.entries(filters))if(value!==undefined&&value!=='')query.set(name,String(value));
    return request<DocumentListResponse>(`${base(patientId)}/manage?${query}`,{signal});
  },
  reviewQueue(patientId:string,filters:DocumentFilters,signal?:AbortSignal){const query=new URLSearchParams();for(const [name,value] of Object.entries(filters))if(value!==undefined&&value!=='')query.set(name,String(value));return request<DocumentListResponse>(`${base(patientId)}/review-queue?${query}`,{signal});},
  detail:(patientId:string,id:string,signal?:AbortSignal)=>request<DocumentDetailResponse>(`${item(patientId,id)}/detail`,{signal}),
  init:(patientId:string,body:DocumentUploadInitInput,key:string,signal?:AbortSignal)=>write<DocumentUploadSession>(`${base(patientId)}/upload/init`,'POST',body,key,signal),
  complete:(patientId:string,sessionId:string,key:string)=>write<unknown>(`${base(patientId)}/upload/complete`,'POST',{sessionId},key),
  cancel:(patientId:string,sessionId:string,key:string)=>write<unknown>(`${base(patientId)}/upload/cancel`,'POST',{sessionId},key),
  file:(patientId:string,id:string,download=false,versionId?:string,signal?:AbortSignal)=>request<DocumentFileResponse>(`${item(patientId,id)}/${download?'download-managed':'preview'}${versionId?`?versionId=${encodeURIComponent(versionId)}`:''}`,{signal}),
  metadata:(patientId:string,id:string,body:DocumentMetadataInput,key:string)=>write<unknown>(item(patientId,id),'PATCH',body,key),
  remove:(patientId:string,id:string,reason:string,key:string)=>write<unknown>(item(patientId,id),'DELETE',{reason},key),
  action:(patientId:string,id:string,action:'restore'|'retry'|'process'|'request-review',key:string)=>write<unknown>(`${item(patientId,id)}/${action}`,'POST',{},key),
  review:(patientId:string,id:string,body:DocumentReviewInput,key:string)=>write<unknown>(`${item(patientId,id)}/review`,'POST',body,key),
  observation:(patientId:string,id:string,observationId:string,body:ObservationCorrectionInput,key:string)=>write<unknown>(`${item(patientId,id)}/observations/${encodeURIComponent(observationId)}`,'PATCH',body,key),
  timeline:(patientId:string,signal?:AbortSignal)=>request<{entries:DocumentTimelineEntry[];pagination?:{limit:number;offset:number}}>(`${base(patientId)}/timeline?limit=100`,{signal}),
  trends:(patientId:string,signal?:AbortSignal)=>request<{trends:DocumentTrend[];limitations?:string[]}>(`${base(patientId)}/trends`,{signal}),
};

export const documentTypes=[['laboratory_report','Laboratory report'],['imaging_report','Imaging report'],['consultation_record','Consultation record'],['prescription','Prescription'],['medical_history','Medical history'],['discharge_summary','Discharge summary'],['referral_letter','Referral letter'],['vaccination_record','Vaccination record'],['other','Other']] as const;
export const documentStages=[['uploading','Uploading'],['security_checks','Security checks'],['extracting','Extracting'],['awaiting_review','Awaiting review'],['reviewed','Reviewed'],['failed','Processing failed'],['unavailable','Processing unavailable'],['cancelled','Cancelled'],['legacy','Legacy record']] as const;
export function documentLabel(value:string){return [...documentTypes,...documentStages].find(([key])=>key===value)?.[1]??value.replaceAll('_',' ');}
export function documentError(error:unknown){return error instanceof Error?error.message:'The document request could not be completed. Please try again.';}
export function readableBytes(value:number){return value>=1024*1024?`${(value/(1024*1024)).toFixed(1)} MB`:`${Math.max(1,Math.ceil(value/1024))} KB`;}
