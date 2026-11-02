import {sql} from 'drizzle-orm';
import {bigint,check,date,foreignKey,index,integer,jsonb,numeric,pgTable,text,timestamp,unique,uuid,type AnyPgColumn} from 'drizzle-orm/pg-core';
import {users} from './identity.ts';
import {medicalDocuments,consultations} from './longitudinal.ts';

// SQL migration 0007 additionally owns immutable-source triggers, generated search, and the circular current-version foreign key.
const scoped=()=>({id:uuid('id').primaryKey().defaultRandom(),organizationId:text('organization_id').notNull(),patientId:text('patient_id').notNull(),documentId:uuid('document_id').notNull()});
const created=()=>timestamp('created_at',{withTimezone:true}).notNull().defaultNow();
type Scope={organizationId:AnyPgColumn;patientId:AnyPgColumn;documentId:AnyPgColumn};
type VersionScope=Scope&{documentVersionId:AnyPgColumn};
const documentReference=(table:Scope)=>foreignKey({columns:[table.organizationId,table.patientId,table.documentId],foreignColumns:[medicalDocuments.organizationId,medicalDocuments.patientId,medicalDocuments.id]});
const author=(table:Scope,column:AnyPgColumn)=>foreignKey({columns:[table.organizationId,column],foreignColumns:[users.organizationId,users.id]});
const versionReference=(table:VersionScope)=>foreignKey({columns:[table.organizationId,table.patientId,table.documentId,table.documentVersionId],foreignColumns:[documentVersions.organizationId,documentVersions.patientId,documentVersions.documentId,documentVersions.id]});

export const documentVersions=pgTable('document_versions',{
 ...scoped(),versionNumber:integer('version_number').notNull(),storageProvider:text('storage_provider').notNull(),storageBucket:text('storage_bucket').notNull(),storageKey:text('storage_key').notNull(),checksumSha256:text('checksum_sha256').notNull(),fileSize:bigint('file_size',{mode:'number'}).notNull(),mimeType:text('mime_type').notNull(),createdBy:text('created_by').notNull(),changeReason:text('change_reason').notNull(),createdAt:created(),
},table=>[documentReference(table),author(table,table.createdBy),unique().on(table.documentId,table.versionNumber),unique().on(table.storageProvider,table.storageKey),unique().on(table.organizationId,table.patientId,table.documentId,table.id),check('document_versions_version_number_check',sql`${table.versionNumber}>0`),check('document_versions_file_size_check',sql`${table.fileSize}>0 AND ${table.fileSize}<=15728640`)]);

export const documentUploadSessions=pgTable('document_upload_sessions',{
 ...scoped(),versionId:uuid('version_id').notNull(),versionNumber:integer('version_number').notNull(),createdBy:text('created_by').notNull(),storageProvider:text('storage_provider').notNull(),storageBucket:text('storage_bucket').notNull(),stagingKey:text('staging_key').notNull(),finalStorageKey:text('final_storage_key').notNull(),filename:text('filename').notNull(),mimeType:text('mime_type').notNull(),declaredSize:bigint('declared_size',{mode:'number'}).notNull(),declaredChecksum:text('declared_checksum'),changeReason:text('change_reason').notNull(),status:text('status').$type<'pending'|'completed'|'cancelled'|'expired'>().notNull().default('pending'),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),completedAt:timestamp('completed_at',{withTimezone:true}),createdAt:created(),
},table=>[documentReference(table),author(table,table.createdBy),unique().on(table.documentId,table.versionNumber),unique().on(table.storageProvider,table.stagingKey),unique().on(table.storageProvider,table.finalStorageKey),index('document_upload_expiry_idx').on(table.status,table.expiresAt)]);

export const documentProcessingJobs=pgTable('document_processing_jobs',{
 ...scoped(),documentVersionId:uuid('document_version_id').notNull(),processingType:text('processing_type').notNull().default('extract'),status:text('status').$type<'pending'|'processing'|'completed'|'failed'|'retry_pending'|'cancelled'>().notNull().default('pending'),attempts:integer('attempts').notNull().default(0),maxAttempts:integer('max_attempts').notNull().default(3),provider:text('provider'),providerJobId:text('provider_job_id'),leaseToken:uuid('lease_token'),leaseExpiresAt:timestamp('lease_expires_at',{withTimezone:true}),availableAt:timestamp('available_at',{withTimezone:true}).notNull().defaultNow(),startedAt:timestamp('started_at',{withTimezone:true}),completedAt:timestamp('completed_at',{withTimezone:true}),failureCode:text('failure_code'),sanitizedFailureMessage:text('sanitized_failure_message'),createdAt:created(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},table=>[versionReference(table),unique().on(table.documentVersionId,table.processingType),index('document_jobs_claim_idx').on(table.status,table.availableAt,table.leaseExpiresAt),index('document_jobs_patient_idx').on(table.organizationId,table.patientId,table.documentId)]);

export const documentExtractions=pgTable('document_extractions',{
 ...scoped(),documentVersionId:uuid('document_version_id').notNull(),extractionVersion:integer('extraction_version').notNull().default(1),extractorName:text('extractor_name').notNull(),extractorModelVersion:text('extractor_model_version').notNull(),detectedDocumentType:text('detected_document_type'),detectedLanguage:text('detected_language'),extractedTextReference:text('extracted_text_reference'),structuredOutput:jsonb('structured_output').$type<Record<string,unknown>>().notNull(),extractionConfidence:numeric('extraction_confidence'),extractionStatus:text('extraction_status').$type<'completed'|'partial'|'manual_review_required'>().notNull(),createdAt:created(),
},table=>[versionReference(table),unique().on(table.documentVersionId,table.extractionVersion),unique().on(table.organizationId,table.patientId,table.documentId,table.documentVersionId,table.id)]);

export const clinicalObservations=pgTable('clinical_observations',{
 ...scoped(),documentVersionId:uuid('document_version_id').notNull(),encounterId:uuid('encounter_id'),extractionId:uuid('extraction_id').notNull(),sourceIndex:integer('source_index').notNull(),testName:text('test_name').notNull(),standardizedCode:text('standardized_code'),originalValue:text('original_value').notNull(),numericValue:numeric('numeric_value'),textValue:text('text_value'),originalUnit:text('original_unit'),unit:text('unit'),normalizedUnit:text('normalized_unit'),referenceRangeLow:numeric('reference_range_low'),referenceRangeHigh:numeric('reference_range_high'),referenceRangeText:text('reference_range_text'),resultFlag:text('result_flag'),specimenType:text('specimen_type'),method:text('method'),observedAt:date('observed_at'),sourcePage:integer('source_page'),sourceLocation:jsonb('source_location').$type<Record<string,unknown>>(),sourceText:text('source_text').notNull(),originalSource:jsonb('original_source').$type<Record<string,unknown>>().notNull().default({}),confidence:numeric('confidence'),validationWarnings:jsonb('validation_warnings').$type<string[]>().notNull().default([]),verificationStatus:text('verification_status').$type<'unverified'|'verified'|'rejected'|'unable_to_verify'>().notNull().default('unverified'),verifiedBy:text('verified_by'),verifiedAt:timestamp('verified_at',{withTimezone:true}),createdAt:created(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},table=>[author(table,table.verifiedBy),foreignKey({columns:[table.organizationId,table.patientId,table.documentId,table.documentVersionId,table.extractionId],foreignColumns:[documentExtractions.organizationId,documentExtractions.patientId,documentExtractions.documentId,documentExtractions.documentVersionId,documentExtractions.id]}),foreignKey({columns:[table.organizationId,table.patientId,table.encounterId],foreignColumns:[consultations.organizationId,consultations.patientId,consultations.id]}),unique().on(table.extractionId,table.sourceIndex),unique().on(table.organizationId,table.patientId,table.documentId,table.id),index('clinical_observations_patient_idx').on(table.organizationId,table.patientId,table.verificationStatus,table.observedAt)]);

export const documentObservationCorrections=pgTable('document_observation_corrections',{
 ...scoped(),observationId:uuid('observation_id').notNull(),actorId:text('actor_id').notNull(),reason:text('reason').notNull(),beforeValue:jsonb('before_value').$type<Record<string,unknown>>().notNull(),afterValue:jsonb('after_value').$type<Record<string,unknown>>().notNull(),createdAt:created(),
},table=>[author(table,table.actorId),foreignKey({columns:[table.organizationId,table.patientId,table.documentId,table.observationId],foreignColumns:[clinicalObservations.organizationId,clinicalObservations.patientId,clinicalObservations.documentId,clinicalObservations.id]})]);

export const clinicalDocumentReviews=pgTable('clinical_document_reviews',{
 ...scoped(),documentVersionId:uuid('document_version_id').notNull(),reviewerId:text('reviewer_id').notNull(),status:text('status').$type<'pending_review'|'in_review'|'approved'|'corrections_required'|'rejected'>().notNull(),reviewNotes:text('review_notes').notNull(),reviewedAt:timestamp('reviewed_at',{withTimezone:true}).notNull().defaultNow(),createdAt:created(),
},table=>[versionReference(table),author(table,table.reviewerId),index('clinical_document_reviews_document_idx').on(table.documentId,table.createdAt.desc())]);

export const documentTimelineEvents=pgTable('document_timeline_events',{
 ...scoped(),documentVersionId:uuid('document_version_id'),eventType:text('event_type').notNull(),eventKey:text('event_key').notNull().unique(),actorId:text('actor_id'),createdAt:created(),
},table=>[documentReference(table),versionReference(table),author(table,table.actorId),index('document_timeline_patient_idx').on(table.organizationId,table.patientId,table.createdAt.desc())]);

export const documentSecurityChecks=pgTable('document_security_checks',{
 ...scoped(),documentVersionId:uuid('document_version_id').notNull(),provider:text('provider').notNull(),verdict:text('verdict').$type<'safe'|'infected'>().notNull(),checksumSha256:text('checksum_sha256').notNull(),scannedAt:timestamp('scanned_at',{withTimezone:true}).notNull().defaultNow(),
},table=>[versionReference(table),index('document_security_checks_version_idx').on(table.documentVersionId,table.verdict)]);

export type DocumentVersionRow=typeof documentVersions.$inferSelect;
export type DocumentProcessingJobRow=typeof documentProcessingJobs.$inferSelect;
export type DocumentExtractionRow=typeof documentExtractions.$inferSelect;
export type ClinicalObservationRow=typeof clinicalObservations.$inferSelect;
