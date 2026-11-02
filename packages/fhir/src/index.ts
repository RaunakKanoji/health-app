import { z } from 'zod';
export const supportedResourceTypes=['Patient','Practitioner','Organization','Observation','DiagnosticReport','ServiceRequest','Task','Appointment','Encounter','Communication','Consent','DocumentReference','Provenance','AuditEvent'] as const;
const reference=z.object({reference:z.string().min(1)}).passthrough();
const coding=z.object({system:z.string().url().optional(),code:z.string().min(1),display:z.string().optional()}).passthrough();
const base=z.object({resourceType:z.enum(supportedResourceTypes),id:z.string().regex(/^[A-Za-z0-9.-]{1,64}$/),meta:z.object({versionId:z.string().max(64).optional(),lastUpdated:z.string().datetime({offset:true}).optional(),tag:z.array(coding).optional()}).passthrough().optional()}).passthrough();
export type FhirResource=z.infer<typeof base>;
export function validateResource(input:unknown):FhirResource {
 const r=base.parse(input);
 if(r.resourceType==='Patient')z.object({name:z.array(z.object({family:z.string().optional(),given:z.array(z.string()).optional(),text:z.string().optional()})).min(1),birthDate:z.string().date()}).parse(r);
 if(r.resourceType==='Observation')z.object({status:z.enum(['registered','preliminary','final','amended','corrected','cancelled','entered-in-error','unknown']),code:z.object({coding:z.array(coding).min(1)}),subject:reference}).parse(r);
 if(r.resourceType==='DiagnosticReport')z.object({status:z.enum(['registered','partial','preliminary','final','amended','corrected','appended','cancelled','entered-in-error','unknown']),code:z.object({coding:z.array(coding).min(1)}),subject:reference}).parse(r);
 if(r.resourceType==='ServiceRequest')z.object({status:z.enum(['draft','active','on-hold','revoked','completed','entered-in-error','unknown']),intent:z.string().min(1),subject:reference}).parse(r);
 if(r.resourceType==='Task')z.object({status:z.enum(['draft','requested','received','accepted','rejected','ready','cancelled','in-progress','on-hold','failed','completed','entered-in-error']),intent:z.string().min(1)}).parse(r);
 if(r.resourceType==='Appointment')z.object({status:z.enum(['proposed','pending','booked','arrived','fulfilled','cancelled','noshow','entered-in-error','checked-in','waitlist']),participant:z.array(z.object({status:z.enum(['accepted','declined','tentative','needs-action'])})).min(1)}).parse(r);
 if(r.resourceType==='Encounter')z.object({status:z.enum(['planned','arrived','triaged','in-progress','onleave','finished','cancelled','entered-in-error','unknown']),class:coding}).parse(r);
 if(r.resourceType==='Communication')z.object({status:z.enum(['preparation','in-progress','not-done','on-hold','stopped','completed','entered-in-error','unknown'])}).parse(r);
 if(r.resourceType==='Consent')z.object({status:z.enum(['draft','proposed','active','rejected','inactive','entered-in-error']),scope:z.object({coding:z.array(coding).min(1)}),category:z.array(z.object({coding:z.array(coding).min(1)})).min(1)}).parse(r);
 if(r.resourceType==='DocumentReference')z.object({status:z.enum(['current','superseded','entered-in-error']),content:z.array(z.object({attachment:z.object({contentType:z.string().optional(),url:z.string().optional(),data:z.string().optional()}).passthrough()})).min(1)}).parse(r);
 if(r.resourceType==='Organization')z.object({name:z.string().min(1)}).parse(r);
 if(r.resourceType==='Provenance')z.object({target:z.array(reference).min(1),recorded:z.string().datetime({offset:true}),agent:z.array(z.object({who:reference})).min(1)}).parse(r);
 if(r.resourceType==='AuditEvent')z.object({type:coding,recorded:z.string().datetime({offset:true}),agent:z.array(z.object({requestor:z.boolean()})).min(1),source:z.object({observer:reference})}).parse(r);
 return r;
}
export function resourcePatientId(resource:FhirResource):string|null {const subject=resource.subject as {reference?:string}|undefined;return subject?.reference?.replace(/^Patient\//,'')??null;}
export function pathwayFor(resource:FhirResource):'diabetes'|'colorectal'|'hypertension'|null {
 const codes=((resource.code as {coding?:{code:string;system?:string}[]}|undefined)?.coding??[]).filter(c=>c.system==='http://loinc.org').map(c=>c.code);
 if(codes.some(c=>['4548-4','1558-6'].includes(c)))return 'diabetes';
 if(codes.some(c=>['2335-8','12503-9','29771-3'].includes(c)))return 'colorectal';
 if(codes.some(c=>['85354-9','8480-6','8462-4'].includes(c)))return 'hypertension';
 return null;
}
export function resultSummary(resource:FhirResource):string {const conclusion=typeof resource.conclusion==='string'?resource.conclusion:null;const text=(resource.code as {text?:string}|undefined)?.text;return (conclusion??text??`Imported ${resource.resourceType}; clinician interpretation required.`).slice(0,4000);}

export function hasActionableSourceFlag(resource:FhirResource):boolean {
 const extensions=resource.extension as {url?:string;valueBoolean?:boolean}[]|undefined;
 const interpretations=resource.interpretation as {coding?:{system?:string;code?:string}[]}[]|undefined;
 return extensions?.some(e=>e.url==='https://careloop.demo/fhir/StructureDefinition/follow-up-required'&&e.valueBoolean===true)===true||interpretations?.some(i=>i.coding?.some(c=>c.system==='http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation'&&['A','H','L','HH','LL'].includes(c.code??'')))===true;
}
