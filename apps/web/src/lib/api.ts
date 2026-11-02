import type { ApiError, Command, Episode, Workspace, User, AssistantResponse } from '../../../../packages/contracts/src/careloop.ts';
export type { Command, Episode, Workspace, User, AssistantResponse };

export type ClinicalRecord = {id:string;patientId:string;createdAt:string;status?:string};
export type ConsultationRecord = ClinicalRecord & {chiefComplaint:string;encounterType:string;startedAt?:string|null};
export type ClinicalNoteRecord = ClinicalRecord & {consultationId:string;content:string;noteType:string;signedAt?:string|null};
export type MedicalDocumentRecord = ClinicalRecord & {originalFilename:string;documentType:string;mimeType:string;fileSize:number;processingStatus:string};
export type LabOrderRecord = ClinicalRecord & {consultationId?:string|null;testName:string;testCode?:string|null};
export type LabReportRecord = ClinicalRecord & {labOrderId?:string|null;laboratoryName:string;reportDate:string;reviewStatus:string;reviewedAt?:string|null};
export type LabResultRecord = ClinicalRecord & {labReportId:string;testName:string;numericValue?:string|null;textValue?:string|null;unit?:string|null;referenceLow?:string|null;referenceHigh?:string|null;referenceText?:string|null;abnormalFlag?:string|null;extractionStatus:string;replacesResultId?:string|null};
export type AnalysisRecord = ClinicalRecord & {analysisType:string;modelProvider:string;modelIdentifier:string;modelVersion?:string|null;structuredOutput:Record<string,unknown>;reviewedAt?:string|null};
export type FindingRecord = ClinicalRecord & {analysisId:string;findingText:string;reviewStatus:string;severity?:string|null};
export type TreatmentPlanRecord = ClinicalRecord & {title:string;description:string;approvedAt?:string|null};
export type FollowupRecord = ClinicalRecord & {dueAt:string;reason:string;completedAt?:string|null};
export type PatientClinicalRecords = {
  consultations:ConsultationRecord[];notes:ClinicalNoteRecord[];documents:MedicalDocumentRecord[];
  labOrders:LabOrderRecord[];labReports:LabReportRecord[];labResults:LabResultRecord[];
  analyses:AnalysisRecord[];findings:FindingRecord[];treatmentPlans:TreatmentPlanRecord[];followups:FollowupRecord[];
  pagination:{limit:number;offset:number};
};
export type ClinicalRecordInputs = {
  consultations:{chiefComplaint:string;encounterType:string};
  notes:{consultationId:string;content:string;noteType:string;status:'signed'};
  'lab-orders':{consultationId?:string;testName:string;testCode?:string};
  'lab-reports':{labOrderId?:string;laboratoryName:string;reportDate:string};
  'lab-results':{labReportId:string;testName:string;numericValue?:string;textValue?:string;unit?:string;referenceLow?:string;referenceHigh?:string;referenceText?:string;abnormalFlag?:string;extractionStatus:'manual'};
  analyses:{labReportId:string;consultationId?:string};
  'treatment-plans':{consultationId?:string;title:string;description:string;status:'approved'};
  followups:{consultationId?:string;dueAt:string;reason:string};
};
export type PatientDirectoryEntry = {id:string;name:string;dateOfBirth?:string|null;preferredLanguage?:string};
export type PrivateMedicalDocument = {id:string;documentType:string;filename:string;mimeType:string;fileSize:number;processingStatus:string;createdAt:string};
export type MedicalDocumentUpload = {documentType:'laboratory_report'|'prescription'|'consultation_record'|'imaging_report'|'discharge_summary'|'other';filename:string;mimeType:'application/pdf'|'image/png'|'image/jpeg'|'text/plain';contentBase64:string};

export class ApiFailure extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); this.name = 'ApiFailure'; }
}
let sessionTokenGetter: (() => Promise<string | null>) | null = null;
let sessionEpoch = 0;
export function setSessionTokenGetter(getter: (() => Promise<string | null>) | null) { sessionTokenGetter = getter; sessionEpoch++; }
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const epoch = sessionEpoch;
  const token = await sessionTokenGetter?.();
  if (!token || epoch !== sessionEpoch) throw new ApiFailure('Sign in to continue.', 401, 'UNAUTHENTICATED');
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', cache: 'no-store', ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers, Authorization: `Bearer ${token}` } });
  const result = await response.json().catch(() => null) as T | ApiError | null;
  if (epoch !== sessionEpoch) throw new ApiFailure('Your session changed. Sign in again.', 401, 'SESSION_CHANGED');
  if (!response.ok) {
    const error = result && typeof result === 'object' && 'error' in result ? (result as ApiError).error : null;
    throw new ApiFailure(error?.message ?? 'The service could not complete this request. Please try again.', response.status, error?.code ?? 'REQUEST_FAILED');
  }
  return result as T;
}
export const api = {
  documents: (patientId:string,offset=0,signal?:AbortSignal) => request<{documents:PrivateMedicalDocument[];nextOffset:number|null;storageAvailable:boolean}>(`/patients/${encodeURIComponent(patientId)}/documents?limit=20&offset=${offset}`,{signal}),
  uploadDocument: (patientId:string,input:MedicalDocumentUpload,key:string) => request<{document:PrivateMedicalDocument}>(`/patients/${encodeURIComponent(patientId)}/documents`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(input)}),
  downloadDocument: (patientId:string,id:string) => request<{url:string;expiresIn:number}>(`/patients/${encodeURIComponent(patientId)}/documents/${encodeURIComponent(id)}/download`,{method:'POST',body:'{}'}),
  patients: (signal?:AbortSignal,offset=0) => request<{patients:PatientDirectoryEntry[]}>('/patients?limit=100&offset='+offset,{signal}),
  clinicalRecords: (patientId:string,offset=0,signal?:AbortSignal) => request<PatientClinicalRecords>(`/patients/${encodeURIComponent(patientId)}/clinical-records?limit=20&offset=${offset}`,{signal}),
  createClinicalRecord: <R extends keyof ClinicalRecordInputs>(patientId:string,resource:R,input:ClinicalRecordInputs[R],key=crypto.randomUUID()) => request<{record:ClinicalRecord}>(`/patients/${encodeURIComponent(patientId)}/clinical-records/${resource}`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(input)}),
  reviewClinicalRecord: (patientId:string,resource:'lab-reports'|'analyses',id:string,decision:'reviewed'|'accepted'|'rejected',key=crypto.randomUUID()) => request(`/patients/${encodeURIComponent(patientId)}/clinical-records/${resource}/${encodeURIComponent(id)}/review`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({decision})}),
  workspace: () => request<Workspace>('/workspace'),
  command: (id: string, command: Command, key = crypto.randomUUID()) => request<{episode: Episode}>(`/episodes/${id}/actions`, { method: 'POST', headers: {'Idempotency-Key': key}, body: JSON.stringify(command) }),
  assistant: (id: string, question: string) => request<AssistantResponse>(`/episodes/${id}/assistant`, {method:'POST',body:JSON.stringify({question})}),
};
