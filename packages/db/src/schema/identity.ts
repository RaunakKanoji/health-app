import { bigint, boolean, date, foreignKey, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import type { Role } from '../../../contracts/src/careloop.ts';
import { organizations } from './core.ts';

export const users=pgTable('users',{
 id:text('id').primaryKey(),organizationId:text('organization_id').notNull().references(()=>organizations.id),
 email:text('email').notNull().unique(),name:text('name').notNull(),passwordHash:text('password_hash'),
 role:text('role').$type<Role>().notNull(),patientId:text('patient_id'),clerkUserId:text('clerk_user_id').unique(),
 accountStatus:text('account_status').$type<'active'|'suspended'|'deleted'>().notNull().default('active'),
 onboardingCompleted:boolean('onboarding_completed').notNull().default(true),
 clerkUpdatedAt:bigint('clerk_updated_at',{mode:'number'}).notNull().default(0),
 createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},table=>[unique('users_org_id_unique').on(table.organizationId,table.id)]);

export const patients=pgTable('patients',{
 id:text('id').primaryKey(),organizationId:text('organization_id').notNull().references(()=>organizations.id),
 name:text('name').notNull(),birthDate:date('birth_date').notNull(),language:text('language').notNull().default('en'),
 synthetic:boolean('synthetic').notNull().default(true),
 createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},table=>[unique().on(table.organizationId,table.id)]);

export const clinicianProfiles=pgTable('clinician_profiles',{
 userId:text('user_id').primaryKey().references(()=>users.id),professionalName:text('professional_name').notNull(),specialty:text('specialty').notNull(),
 registrationIdentifier:text('registration_identifier').notNull(),institution:text('institution').notNull().default(''),
 verificationStatus:text('verification_status').$type<'pending'|'approved'|'rejected'>().notNull().default('pending'),reviewReason:text('review_reason'),
 approvedAt:timestamp('approved_at',{withTimezone:true}),approvedBy:text('approved_by').references(()=>users.id),
 createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
});

export const clinicianPatientRelationships=pgTable('clinician_patient_relationships',{
 id:text('id').primaryKey(),organizationId:text('organization_id').notNull().references(()=>organizations.id),
 clinicianId:text('clinician_id').notNull().references(()=>users.id),patientId:text('patient_id').notNull().references(()=>patients.id),
 relationshipStatus:text('relationship_status').$type<'active'|'revoked'>().notNull().default('active'),authorizationBasis:text('authorization_basis').notNull(),
 authorizedBy:text('authorized_by').notNull().references(()=>users.id),authorizedAt:timestamp('authorized_at',{withTimezone:true}).notNull().defaultNow(),revokedAt:timestamp('revoked_at',{withTimezone:true}),
 createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},table=>[
 unique().on(table.clinicianId,table.patientId),
 foreignKey({columns:[table.organizationId,table.clinicianId],foreignColumns:[users.organizationId,users.id]}),
 foreignKey({columns:[table.organizationId,table.patientId],foreignColumns:[patients.organizationId,patients.id]}),
 foreignKey({columns:[table.organizationId,table.authorizedBy],foreignColumns:[users.organizationId,users.id]}),
]);

export const observations=pgTable('observations',{
 id:text('id').primaryKey(),organizationId:text('organization_id').notNull().references(()=>organizations.id),
 patientId:text('patient_id').notNull().references(()=>patients.id),resultId:text('result_id'),sourceResourceId:text('source_resource_id'),
 coding:jsonb('coding').$type<Record<string,unknown>>().notNull(),value:jsonb('value').$type<Record<string,unknown>|null>(),
 effectiveAt:timestamp('effective_at',{withTimezone:true}),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},table=>[
 unique('observations_patient_identity_unique').on(table.organizationId,table.patientId,table.id),
 foreignKey({columns:[table.organizationId,table.patientId],foreignColumns:[patients.organizationId,patients.id]}),
]);
