import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, foreignKey, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { observations, patients, users } from './identity.ts';

const base=()=>({
 id:uuid('id').primaryKey().defaultRandom(),organizationId:text('organization_id').notNull(),patientId:text('patient_id').notNull(),
 synthetic:boolean('synthetic').notNull().default(true),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
});
type Scope={organizationId:AnyPgColumn;patientId:AnyPgColumn;id:AnyPgColumn;synthetic:AnyPgColumn};
const scope=(name:string,table:Scope)=>[
 unique().on(table.organizationId,table.patientId,table.id),
 foreignKey({columns:[table.organizationId,table.patientId],foreignColumns:[patients.organizationId,patients.id]}),
 check(`${name}_synthetic_check`,sql`${table.synthetic}`),
];
const author=(table:Scope,column:AnyPgColumn)=>foreignKey({columns:[table.organizationId,column],foreignColumns:[users.organizationId,users.id]});
const patientReference=(table:Scope,column:AnyPgColumn,target:Scope)=>foreignKey({columns:[table.organizationId,table.patientId,column],foreignColumns:[target.organizationId,target.patientId,target.id]});

export const consultations=pgTable('consultations',{
 ...base(),clinicianId:text('clinician_id').notNull(),status:text('status').$type<'scheduled'|'in_progress'|'completed'|'cancelled'>().notNull().default('in_progress'),
 encounterType:text('encounter_type').notNull(),chiefComplaint:text('chief_complaint').notNull(),scheduledAt:timestamp('scheduled_at',{withTimezone:true}),startedAt:timestamp('started_at',{withTimezone:true}),completedAt:timestamp('completed_at',{withTimezone:true}),
},table=>[
 ...scope('consultations',table),author(table,table.clinicianId),
 check('consultations_status_check',sql`${table.status} IN ('scheduled','in_progress','completed','cancelled')`),
 check('consultations_completion_check',sql`(${table.status}='completed')=(${table.completedAt} IS NOT NULL)`),
 index('consultations_patient_time_idx').on(table.organizationId,table.patientId,table.createdAt.desc(),table.id),
 index('consultations_clinician_status_idx').on(table.organizationId,table.clinicianId,table.status,table.scheduledAt),
]);

export const clinicalNotes=pgTable('clinical_notes',{
 ...base(),consultationId:uuid('consultation_id').notNull(),authorId:text('author_id').notNull(),noteType:text('note_type').notNull(),content:text('content').notNull(),
 status:text('status').$type<'draft'|'signed'>().notNull().default('draft'),signedAt:timestamp('signed_at',{withTimezone:true}),revision:integer('revision').notNull().default(1),supersedesNoteId:uuid('supersedes_note_id').unique(),
},table=>[
 ...scope('clinical_notes',table),author(table,table.authorId),patientReference(table,table.consultationId,consultations),
 unique().on(table.organizationId,table.patientId,table.consultationId,table.id),
 foreignKey({columns:[table.organizationId,table.patientId,table.consultationId,table.supersedesNoteId],foreignColumns:[table.organizationId,table.patientId,table.consultationId,table.id]}),
 check('clinical_notes_status_check',sql`${table.status} IN ('draft','signed')`),
 check('clinical_notes_signature_check',sql`(${table.status}='signed')=(${table.signedAt} IS NOT NULL)`),
 check('clinical_notes_revision_check',sql`${table.revision}>0`),
 index('clinical_notes_consultation_idx').on(table.organizationId,table.patientId,table.consultationId,table.createdAt.desc()),
]);

export const medicalDocuments=pgTable('medical_documents',{
 ...base(),uploadedBy:text('uploaded_by').notNull(),documentType:text('document_type').notNull(),originalFilename:text('original_filename').notNull(),
 storageProvider:text('storage_provider').notNull(),storageKey:text('storage_key').notNull(),mimeType:text('mime_type').notNull(),fileSize:bigint('file_size',{mode:'number'}).notNull(),checksum:text('checksum').notNull(),
 processingStatus:text('processing_status').$type<'pending'|'ready'|'failed'>().notNull().default('pending'),
},table=>[
 ...scope('medical_documents',table),author(table,table.uploadedBy),unique().on(table.storageProvider,table.storageKey),
 check('medical_documents_mime_type_check',sql`${table.mimeType} IN ('application/pdf','image/png','image/jpeg','text/plain')`),
 check('medical_documents_file_size_check',sql`${table.fileSize}>0 AND ${table.fileSize}<=10485760`),
 check('medical_documents_checksum_check',sql`${table.checksum} ~ '^[0-9a-f]{64}$'`),
 check('medical_documents_processing_status_check',sql`${table.processingStatus} IN ('pending','ready','failed')`),
 index('medical_documents_patient_time_idx').on(table.organizationId,table.patientId,table.createdAt.desc(),table.id),
]);

export const labOrders=pgTable('lab_orders',{
 ...base(),consultationId:uuid('consultation_id'),orderedBy:text('ordered_by').notNull(),testName:text('test_name').notNull(),testCode:text('test_code'),
 status:text('status').$type<'ordered'|'completed'|'cancelled'>().notNull().default('ordered'),orderedAt:timestamp('ordered_at',{withTimezone:true}).notNull().defaultNow(),completedAt:timestamp('completed_at',{withTimezone:true}),
},table=>[
 ...scope('lab_orders',table),author(table,table.orderedBy),patientReference(table,table.consultationId,consultations),
 check('lab_orders_status_check',sql`${table.status} IN ('ordered','completed','cancelled')`),
 check('lab_orders_completion_check',sql`(${table.status}='completed')=(${table.completedAt} IS NOT NULL)`),
 index('lab_orders_patient_time_idx').on(table.organizationId,table.patientId,table.createdAt.desc(),table.id),index('lab_orders_consultation_idx').on(table.consultationId),
]);

export const labReports=pgTable('lab_reports',{
 ...base(),labOrderId:uuid('lab_order_id'),documentId:uuid('document_id'),createdBy:text('created_by').notNull(),laboratoryName:text('laboratory_name').notNull(),reportDate:date('report_date').notNull(),
 processingStatus:text('processing_status').$type<'pending'|'processed'|'failed'>().notNull().default('pending'),
 reviewStatus:text('review_status').$type<'pending'|'reviewed'|'rejected'>().notNull().default('pending'),reviewedBy:text('reviewed_by'),reviewedAt:timestamp('reviewed_at',{withTimezone:true}),
},table=>[
 ...scope('lab_reports',table),author(table,table.createdBy),author(table,table.reviewedBy),patientReference(table,table.labOrderId,labOrders),patientReference(table,table.documentId,medicalDocuments),
 check('lab_reports_processing_status_check',sql`${table.processingStatus} IN ('pending','processed','failed')`),
 check('lab_reports_review_status_check',sql`${table.reviewStatus} IN ('pending','reviewed','rejected')`),
 index('lab_reports_patient_time_idx').on(table.organizationId,table.patientId,table.reportDate.desc(),table.id),
 index('lab_reports_order_idx').on(table.labOrderId),index('lab_reports_document_idx').on(table.documentId),index('lab_reports_review_queue_idx').on(table.organizationId,table.reviewStatus,table.createdAt),
]);

export const labResults=pgTable('lab_results',{
 ...base(),labReportId:uuid('lab_report_id').notNull(),recordedBy:text('recorded_by').notNull(),testName:text('test_name').notNull(),testCode:text('test_code'),
 numericValue:numeric('numeric_value'),textValue:text('text_value'),unit:text('unit'),referenceLow:numeric('reference_low'),referenceHigh:numeric('reference_high'),referenceText:text('reference_text'),abnormalFlag:text('abnormal_flag'),
 collectedAt:timestamp('collected_at',{withTimezone:true}),resultedAt:timestamp('resulted_at',{withTimezone:true}),sourcePage:integer('source_page'),
 extractionStatus:text('extraction_status').$type<'manual'|'ai_extracted'|'imported'|'verified'>().notNull().default('manual'),replacesResultId:uuid('replaces_result_id').unique(),verifiedBy:text('verified_by'),verifiedAt:timestamp('verified_at',{withTimezone:true}),
},table=>[
 ...scope('lab_results',table),author(table,table.recordedBy),author(table,table.verifiedBy),patientReference(table,table.labReportId,labReports),
 unique().on(table.organizationId,table.patientId,table.labReportId,table.id),
 foreignKey({columns:[table.organizationId,table.patientId,table.labReportId,table.replacesResultId],foreignColumns:[table.organizationId,table.patientId,table.labReportId,table.id]}),
 check('lab_results_value_check',sql`num_nonnulls(${table.numericValue},${table.textValue})=1`),
 check('lab_results_reference_check',sql`${table.referenceLow} IS NULL OR ${table.referenceHigh} IS NULL OR ${table.referenceLow}<=${table.referenceHigh}`),
 check('lab_results_extraction_status_check',sql`${table.extractionStatus} IN ('manual','ai_extracted','imported','verified')`),
 index('lab_results_report_idx').on(table.organizationId,table.patientId,table.labReportId,table.createdAt,table.id),
]);

export const aiAnalyses=pgTable('ai_analyses',{
 ...base(),consultationId:uuid('consultation_id'),createdBy:text('created_by').notNull(),analysisType:text('analysis_type').notNull(),modelProvider:text('model_provider').notNull(),
 modelIdentifier:text('model_identifier').notNull(),modelVersion:text('model_version').notNull(),inputContextVersion:text('input_context_version').notNull(),structuredOutput:jsonb('structured_output').$type<Record<string,unknown>>().notNull(),
 status:text('status').$type<'pending_review'|'reviewed'|'rejected'|'superseded'>().notNull().default('pending_review'),reviewedBy:text('reviewed_by'),reviewedAt:timestamp('reviewed_at',{withTimezone:true}),supersedesAnalysisId:uuid('supersedes_analysis_id').unique(),
},table=>[
 ...scope('ai_analyses',table),author(table,table.createdBy),author(table,table.reviewedBy),patientReference(table,table.consultationId,consultations),patientReference(table,table.supersedesAnalysisId,table),
 check('ai_analyses_status_check',sql`${table.status} IN ('pending_review','reviewed','rejected','superseded')`),
 check('ai_analyses_output_check',sql`jsonb_typeof(${table.structuredOutput})='object'`),
 index('ai_analyses_patient_time_idx').on(table.organizationId,table.patientId,table.createdAt.desc(),table.id),index('ai_analyses_consultation_idx').on(table.consultationId),
]);

export const aiFindings=pgTable('ai_findings',{
 ...base(),analysisId:uuid('analysis_id').notNull(),findingType:text('finding_type').notNull(),findingText:text('finding_text').notNull(),severity:text('severity').$type<'info'|'low'|'moderate'|'high'>().notNull().default('info'),confidence:numeric('confidence'),
 reviewStatus:text('review_status').$type<'pending'|'accepted'|'rejected'>().notNull().default('pending'),reviewedBy:text('reviewed_by'),reviewedAt:timestamp('reviewed_at',{withTimezone:true}),
},table=>[
 ...scope('ai_findings',table),author(table,table.reviewedBy),patientReference(table,table.analysisId,aiAnalyses),
 check('ai_findings_confidence_check',sql`${table.confidence}>=0 AND ${table.confidence}<=1`),
 check('ai_findings_severity_check',sql`${table.severity} IN ('info','low','moderate','high')`),
 check('ai_findings_review_status_check',sql`${table.reviewStatus} IN ('pending','accepted','rejected')`),
 index('ai_findings_analysis_idx').on(table.organizationId,table.patientId,table.analysisId),
]);

export const aiAnalysisSources=pgTable('ai_analysis_sources',{
 ...base(),analysisId:uuid('analysis_id').notNull(),consultationId:uuid('consultation_id'),labReportId:uuid('lab_report_id'),documentId:uuid('document_id'),observationId:text('observation_id'),sourceVersion:text('source_version').notNull(),
},table=>[
 ...scope('ai_analysis_sources',table),patientReference(table,table.analysisId,aiAnalyses),patientReference(table,table.consultationId,consultations),patientReference(table,table.labReportId,labReports),patientReference(table,table.documentId,medicalDocuments),
 foreignKey({columns:[table.organizationId,table.patientId,table.observationId],foreignColumns:[observations.organizationId,observations.patientId,observations.id]}),
 check('ai_analysis_sources_reference_check',sql`num_nonnulls(${table.consultationId},${table.labReportId},${table.documentId},${table.observationId})=1`),
 uniqueIndex('ai_sources_consultation_unique').on(table.analysisId,table.consultationId).where(sql`${table.consultationId} IS NOT NULL`),
 uniqueIndex('ai_sources_report_unique').on(table.analysisId,table.labReportId).where(sql`${table.labReportId} IS NOT NULL`),
 uniqueIndex('ai_sources_document_unique').on(table.analysisId,table.documentId).where(sql`${table.documentId} IS NOT NULL`),
 uniqueIndex('ai_sources_observation_unique').on(table.analysisId,table.observationId).where(sql`${table.observationId} IS NOT NULL`),
 index('ai_sources_patient_analysis_idx').on(table.organizationId,table.patientId,table.analysisId),
]);

export const treatmentPlans=pgTable('treatment_plans',{
 ...base(),consultationId:uuid('consultation_id'),clinicianId:text('clinician_id').notNull(),title:text('title').notNull(),description:text('description').notNull(),
 status:text('status').$type<'draft'|'approved'|'completed'|'cancelled'>().notNull().default('draft'),startDate:date('start_date'),endDate:date('end_date'),approvedBy:text('approved_by'),approvedAt:timestamp('approved_at',{withTimezone:true}),
},table=>[
 ...scope('treatment_plans',table),author(table,table.clinicianId),author(table,table.approvedBy),patientReference(table,table.consultationId,consultations),
 check('treatment_plans_status_check',sql`${table.status} IN ('draft','approved','completed','cancelled')`),
 check('treatment_plans_approval_check',sql`${table.status} NOT IN ('approved','completed') OR (${table.approvedBy} IS NOT NULL AND ${table.approvedAt} IS NOT NULL)`),
 index('treatment_plans_patient_status_idx').on(table.organizationId,table.patientId,table.status,table.createdAt.desc(),table.id),index('treatment_plans_consultation_idx').on(table.consultationId),
]);

export const followups=pgTable('followups',{
 ...base(),consultationId:uuid('consultation_id'),clinicianId:text('clinician_id').notNull(),dueAt:timestamp('due_at',{withTimezone:true}).notNull(),scheduledAt:timestamp('scheduled_at',{withTimezone:true}),
 status:text('status').$type<'pending'|'scheduled'|'completed'|'cancelled'>().notNull().default('pending'),reason:text('reason').notNull(),completedAt:timestamp('completed_at',{withTimezone:true}),
},table=>[
 ...scope('followups',table),author(table,table.clinicianId),patientReference(table,table.consultationId,consultations),
 check('followups_status_check',sql`${table.status} IN ('pending','scheduled','completed','cancelled')`),
 check('followups_completion_check',sql`(${table.status}='completed')=(${table.completedAt} IS NOT NULL)`),
 index('followups_patient_due_idx').on(table.organizationId,table.patientId,table.dueAt,table.id),index('followups_clinician_status_idx').on(table.organizationId,table.clinicianId,table.status,table.dueAt),index('followups_consultation_idx').on(table.consultationId),
]);

export const clinicalRecordCommands=pgTable('clinical_record_commands',{
 ...base(),actorId:text('actor_id').notNull(),idempotencyKey:text('idempotency_key').notNull(),fingerprint:text('fingerprint').notNull(),response:jsonb('response').$type<Record<string,unknown>>().notNull(),
},table=>[
 ...scope('clinical_record_commands',table),author(table,table.actorId),unique().on(table.organizationId,table.actorId,table.idempotencyKey),
 check('clinical_record_commands_key_check',sql`length(${table.idempotencyKey}) BETWEEN 1 AND 200`),index('clinical_commands_patient_idx').on(table.organizationId,table.patientId,table.createdAt),
]);

export type ConsultationRow=typeof consultations.$inferSelect;
export type ClinicalNoteRow=typeof clinicalNotes.$inferSelect;
export type MedicalDocumentRow=typeof medicalDocuments.$inferSelect;
export type LabOrderRow=typeof labOrders.$inferSelect;
export type LabReportRow=typeof labReports.$inferSelect;
export type LabResultRow=typeof labResults.$inferSelect;
export type AiAnalysisRow=typeof aiAnalyses.$inferSelect;
export type AiFindingRow=typeof aiFindings.$inferSelect;
export type TreatmentPlanRow=typeof treatmentPlans.$inferSelect;
export type FollowupRow=typeof followups.$inferSelect;
