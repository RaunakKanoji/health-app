import { z } from 'zod';

const id=z.string().uuid();
const text=(max=2000)=>z.string().trim().min(1).max(max);
const numeric=z.string().regex(/^-?\d{1,12}(\.\d{1,8})?$/,'Use a decimal measurement.');
export const clinicalPagination=z.object({limit:z.coerce.number().int().min(1).max(100).default(20),offset:z.coerce.number().int().min(0).max(10000).default(0)}).strict();
export const clinicalInputs={
 consultations:z.object({chiefComplaint:text(),encounterType:text(100).default('consultation'),status:z.enum(['scheduled','in_progress','completed','cancelled']).default('in_progress'),scheduledAt:z.iso.datetime().optional()}).strict(),
 notes:z.object({consultationId:id,content:text(12000),noteType:text(100).default('clinical'),status:z.enum(['draft','signed']).default('draft'),supersedesNoteId:id.optional()}).strict(),
 'lab-orders':z.object({consultationId:id.optional(),testName:text(200),testCode:text(100).optional()}).strict(),
 'lab-reports':z.object({labOrderId:id.optional(),documentId:id.optional(),laboratoryName:text(200),reportDate:z.iso.date()}).strict(),
 'lab-results':z.object({labReportId:id,testName:text(200),testCode:text(100).optional(),numericValue:numeric.optional(),textValue:text(2000).optional(),unit:text(100).optional(),referenceLow:numeric.optional(),referenceHigh:numeric.optional(),referenceText:text(1000).optional(),abnormalFlag:text(100).optional(),extractionStatus:z.literal('manual').default('manual'),sourcePage:z.number().int().positive().max(10000).optional(),collectedAt:z.iso.datetime().optional(),resultedAt:z.iso.datetime().optional(),replacesResultId:id.optional()}).strict().refine(v=>(v.numericValue!==undefined)!==(v.textValue!==undefined),{message:'Supply exactly one numeric or text value.'}).refine(v=>v.referenceLow===undefined||v.referenceHigh===undefined||Number(v.referenceLow)<=Number(v.referenceHigh),{message:'Reference range is reversed.'}),
 analyses:z.object({labReportId:id,consultationId:id.optional()}).strict(),
 'treatment-plans':z.object({consultationId:id.optional(),title:text(200),description:text(8000),status:z.enum(['draft','approved']).default('draft'),startDate:z.iso.date().optional(),endDate:z.iso.date().optional()}).strict().refine(v=>!v.startDate||!v.endDate||v.startDate<=v.endDate,{message:'End date precedes start date.'}),
 followups:z.object({consultationId:id.optional(),dueAt:z.iso.datetime(),scheduledAt:z.iso.datetime().optional(),reason:text(2000)}).strict(),
} as const;
export type ClinicalResource=keyof typeof clinicalInputs;
export type ClinicalInput<K extends ClinicalResource>=z.infer<(typeof clinicalInputs)[K]>;
export const clinicalContextOptions=z.object({includeConsultations:z.boolean().default(true),includeLabResults:z.boolean().default(true),includeTreatments:z.boolean().default(true),includeAIHistory:z.boolean().default(false)}).strict();
export type ClinicalContextOptions=z.input<typeof clinicalContextOptions>;
export type ClinicalRow={id:string;patientId:string;createdAt:string;[field:string]:unknown};
export type { ClinicalRecords, ClinicalRecordMap, ClinicalCommandResponse, AnalysisSourceReference } from './clinical-record-dtos.ts';
