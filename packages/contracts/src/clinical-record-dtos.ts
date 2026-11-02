import type {
 aiAnalyses, aiFindings, clinicalNotes, consultations, followups, labOrders,
 labReports, labResults, medicalDocuments, treatmentPlans,
} from '../../db/src/schema/longitudinal.ts';

/** Database timestamps are serialized at the API boundary; numeric measurements stay decimal strings. */
type WireValue<T>=T extends Date?string:T extends bigint?string:T extends readonly (infer Item)[]?WireValue<Item>[]:T extends object?{[Key in keyof T]:WireValue<T[Key]>}:T;
type WireRow<T>=WireValue<T>;
export type ClinicalJsonValue=null|boolean|number|string|ClinicalJsonValue[]|{[key:string]:ClinicalJsonValue};
export type ClinicalJsonObject={[key:string]:ClinicalJsonValue};

type Consultation=typeof consultations.$inferSelect;
type Note=typeof clinicalNotes.$inferSelect;
type Document=typeof medicalDocuments.$inferSelect;
type Order=typeof labOrders.$inferSelect;
type Report=typeof labReports.$inferSelect;
type Result=typeof labResults.$inferSelect;
type Analysis=Omit<typeof aiAnalyses.$inferSelect,'structuredOutput'>&{structuredOutput:ClinicalJsonObject};
type Finding=typeof aiFindings.$inferSelect;
type Treatment=typeof treatmentPlans.$inferSelect;
type Followup=typeof followups.$inferSelect;

export type ConsultationRecord=WireRow<Pick<Consultation,
 'id'|'patientId'|'clinicianId'|'status'|'encounterType'|'chiefComplaint'|'scheduledAt'|'startedAt'|'completedAt'|'createdAt'>>;
export type ClinicalNoteRecord=WireRow<Pick<Note,
 'id'|'patientId'|'consultationId'|'authorId'|'noteType'|'content'|'status'|'signedAt'|'revision'|'supersedesNoteId'|'createdAt'>>;
export type MedicalDocumentRecord=WireRow<Pick<Document,
 'id'|'patientId'|'uploadedBy'|'documentType'|'originalFilename'|'mimeType'|'fileSize'|'checksum'|'processingStatus'|'createdAt'>>;
export type LabOrderRecord=WireRow<Pick<Order,
 'id'|'patientId'|'consultationId'|'orderedBy'|'testName'|'testCode'|'status'|'orderedAt'|'completedAt'|'createdAt'>>;
export type LabReportRecord=WireRow<Pick<Report,
 'id'|'patientId'|'labOrderId'|'documentId'|'laboratoryName'|'reportDate'|'processingStatus'|'reviewStatus'|'reviewedBy'|'reviewedAt'|'createdAt'>>;
export type LabResultRecord=WireRow<Pick<Result,
 'id'|'patientId'|'labReportId'|'testName'|'testCode'|'numericValue'|'textValue'|'unit'|'referenceLow'|'referenceHigh'|'referenceText'|'abnormalFlag'|'extractionStatus'|'sourcePage'|'collectedAt'|'resultedAt'|'replacesResultId'|'verifiedBy'|'verifiedAt'|'createdAt'>>;
export type AnalysisSourceReference={id:string;resourceType:'lab_report'|'consultation'|'document'|'observation';resourceId:string;sourceVersion:string};
export type AiAnalysisRecord=WireRow<Pick<Analysis,
 'id'|'patientId'|'consultationId'|'analysisType'|'modelProvider'|'modelIdentifier'|'modelVersion'|'inputContextVersion'|'structuredOutput'|'status'|'reviewedBy'|'reviewedAt'|'supersedesAnalysisId'|'createdAt'>>&{sources:AnalysisSourceReference[]};
export type AiFindingRecord=WireRow<Pick<Finding,
 'id'|'patientId'|'analysisId'|'findingType'|'findingText'|'severity'|'confidence'|'reviewStatus'|'reviewedBy'|'reviewedAt'|'createdAt'>>;
export type TreatmentPlanRecord=WireRow<Pick<Treatment,
 'id'|'patientId'|'consultationId'|'clinicianId'|'title'|'description'|'status'|'startDate'|'endDate'|'approvedBy'|'approvedAt'|'createdAt'>>;
export type FollowupRecord=WireRow<Pick<Followup,
 'id'|'patientId'|'consultationId'|'clinicianId'|'dueAt'|'scheduledAt'|'status'|'reason'|'completedAt'|'createdAt'>>;

export type ClinicalRecordMap={
 consultations:ConsultationRecord[];
 notes:ClinicalNoteRecord[];
 documents:MedicalDocumentRecord[];
 labOrders:LabOrderRecord[];
 labReports:LabReportRecord[];
 labResults:LabResultRecord[];
 analyses:AiAnalysisRecord[];
 findings:AiFindingRecord[];
 treatmentPlans:TreatmentPlanRecord[];
 followups:FollowupRecord[];
};
export type ClinicalRecords=ClinicalRecordMap&{pagination:{limit:number;offset:number}};
export type ClinicalReadRecord=ClinicalRecordMap[keyof ClinicalRecordMap][number];

/** Command responses currently return their full newly persisted row. */
export type ClinicalResourceRecordMap={
 consultations:WireRow<Consultation>;
 notes:WireRow<Note>;
 'lab-orders':WireRow<Order>;
 'lab-reports':WireRow<Report>;
 'lab-results':WireRow<Result>;
 analyses:WireRow<Analysis>;
 'treatment-plans':WireRow<Treatment>;
 followups:WireRow<Followup>;
};
export type ClinicalWriteRecord=ClinicalResourceRecordMap[keyof ClinicalResourceRecordMap];
export type ClinicalCommandResponse<Resource extends keyof ClinicalResourceRecordMap=keyof ClinicalResourceRecordMap>={record:ClinicalResourceRecordMap[Resource]};
