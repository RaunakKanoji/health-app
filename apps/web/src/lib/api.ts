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
let sessionIdentity: string | symbol | null = null;
export function setSessionTokenGetter(getter: (() => Promise<string | null>) | null, identity?: string) {
  const nextIdentity = getter ? identity ?? Symbol() : null;
  sessionTokenGetter = getter;
  if (nextIdentity !== sessionIdentity) { sessionIdentity = nextIdentity; sessionEpoch++; }
}
export type ApiRequestOptions = RequestInit & { timeoutMs?: number };
export async function request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const epoch = sessionEpoch;
  const readOnly = ['GET', 'HEAD'].includes((options.method ?? 'GET').toUpperCase());
  const { timeoutMs = readOnly ? 15000 : 60000, signal: callerSignal, ...init } = options;
  const controller = new AbortController();
  const cancel = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) cancel();
  else callerSignal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(new ApiFailure(
    readOnly ? 'Loading took too long. Please check your connection and try again.' : 'The request timed out. Refresh to check whether your change was saved before trying again.',
    408, 'REQUEST_TIMEOUT',
  )), timeoutMs);
  const checkCurrent = () => {
    controller.signal.throwIfAborted();
    if (epoch !== sessionEpoch) throw new ApiFailure('Your session changed. Sign in again.', 401, 'SESSION_CHANGED');
  };
  let stopListening = () => {};
  // Token acquisition is not abortable. Race the entire operation, then recheck
  // cancellation before fetch so a late token can never send an abandoned request.
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) rejectAbort();
    else {
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      stopListening = () => controller.signal.removeEventListener('abort', rejectAbort);
    }
  });
  const perform = async (): Promise<T> => {
    checkCurrent();
    const token = await sessionTokenGetter?.();
    checkCurrent();
    if (!token) throw new ApiFailure('Sign in to continue.', 401, 'UNAUTHENTICATED');
    const headers = new Headers(init.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`/api${path}`, { credentials: 'same-origin', cache: 'no-store', ...init, headers, signal: controller.signal });
    checkCurrent();
    const result = response.status === 204 ? null : await response.json().catch(() => null) as T | ApiError | null;
    checkCurrent();
    if (!response.ok) {
      const error = result && typeof result === 'object' && 'error' in result ? (result as ApiError).error : null;
      throw new ApiFailure(error?.message ?? 'The service could not complete this request. Please try again.', response.status, error?.code ?? 'REQUEST_FAILED');
    }
    if (result === null && response.status !== 204) throw new ApiFailure('The service returned an invalid response. Please try again.', 502, 'INVALID_RESPONSE');
    return result as T;
  }
  try { return await Promise.race([perform(), aborted]); }
  finally { clearTimeout(timeout); stopListening(); callerSignal?.removeEventListener('abort', cancel); }
}
export const api = {
  documents: (patientId:string,offset=0,signal?:AbortSignal) => request<{documents:PrivateMedicalDocument[];nextOffset:number|null;storageAvailable:boolean}>(`/patients/${encodeURIComponent(patientId)}/documents?limit=20&offset=${offset}`,{signal}),
  uploadDocument: (patientId:string,input:MedicalDocumentUpload,key:string) => request<{document:PrivateMedicalDocument}>(`/patients/${encodeURIComponent(patientId)}/documents`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(input)}),
  downloadDocument: (patientId:string,id:string) => request<{url:string;expiresIn:number}>(`/patients/${encodeURIComponent(patientId)}/documents/${encodeURIComponent(id)}/download`,{method:'POST',body:'{}'}),
  patients: (signal?:AbortSignal,offset=0) => request<{patients:PatientDirectoryEntry[]}>('/patients?limit=100&offset='+offset,{signal}),
  clinicalRecords: (patientId:string,offset=0,signal?:AbortSignal) => request<PatientClinicalRecords>(`/patients/${encodeURIComponent(patientId)}/clinical-records?limit=20&offset=${offset}`,{signal}),
  createClinicalRecord: <R extends keyof ClinicalRecordInputs>(patientId:string,resource:R,input:ClinicalRecordInputs[R],key=crypto.randomUUID()) => request<{record:ClinicalRecord}>(`/patients/${encodeURIComponent(patientId)}/clinical-records/${resource}`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(input)}),
  reviewClinicalRecord: (patientId:string,resource:'lab-reports'|'analyses',id:string,decision:'reviewed'|'accepted'|'rejected',key=crypto.randomUUID()) => request(`/patients/${encodeURIComponent(patientId)}/clinical-records/${resource}/${encodeURIComponent(id)}/review`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({decision})}),
  workspace: (signal?: AbortSignal) => request<Workspace>('/workspace', { signal }),
  command: (id: string, command: Command, key = crypto.randomUUID()) => request<{episode: Episode}>(`/episodes/${id}/actions`, { method: 'POST', headers: {'Idempotency-Key': key}, body: JSON.stringify(command) }),
  assistant: (id: string, question: string) => request<AssistantResponse>(`/episodes/${id}/assistant`, {method:'POST',body:JSON.stringify({question})}),
};
