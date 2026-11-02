import type {ClinicalObservation,DocumentDetailResponse,ManagedDocument} from '../../contracts/src/documents.ts';

const extensionBase='https://careloop.example/fhir/StructureDefinition/';
const reference=(kind:string,id:string)=>({reference:`${kind}/${id}`});
/** R4 mapping boundary, not a FHIR server or a terminology normalization service. */
export function patientResource(patient:{id:string;name:string;dateOfBirth?:string}){
 return {resourceType:'Patient',id:patient.id,name:[{text:patient.name}],...(patient.dateOfBirth?{birthDate:patient.dateOfBirth}:{})};
}
export function practitionerResource(clinician:{id:string;name:string}){
 return {resourceType:'Practitioner',id:clinician.id,name:[{text:clinician.name}]};
}
export function encounterResource(encounter:{id:string;patientId:string;status:'scheduled'|'in_progress'|'completed'|'cancelled';classCoding:{system:string;code:string};clinicianId?:string}){
 const statuses={scheduled:'planned',in_progress:'in-progress',completed:'finished',cancelled:'cancelled'};
 return {resourceType:'Encounter',id:encounter.id,status:statuses[encounter.status],class:encounter.classCoding,subject:reference('Patient',encounter.patientId),...(encounter.clinicianId?{participant:[{individual:reference('Practitioner',encounter.clinicianId)}]}:{})};
}
export function documentReferenceResource(document:ManagedDocument){
 return {resourceType:'DocumentReference',id:document.id,status:'current',docStatus:document.clinicalReviewStatus==='approved'?'final':'preliminary',subject:reference('Patient',document.patientId),date:document.createdAt,type:{text:document.documentType},description:document.description||document.title,content:[{attachment:{contentType:document.mimeType,size:document.fileSize,title:document.title}}],...(document.encounterId?{context:{encounter:[reference('Encounter',document.encounterId)]}}:{}),extension:[{url:`${extensionBase}authenticated-retrieval-endpoint`,valueString:`/api/patients/${encodeURIComponent(document.patientId)}/documents/${document.id}/download-managed`},{url:`${extensionBase}source-sha256`,valueString:document.checksumSha256},...(document.currentVersionId?[{url:`${extensionBase}document-version`,valueString:document.currentVersionId}]:[])]};
}
export function observationResource(observation:ClinicalObservation){
 if(observation.verificationStatus!=='verified')throw new Error('Only verified observations may be mapped as final.');
 // No inferred LOINC or UCUM: raw terminology and units remain display text.
 const quantity=(value:string)=>({value:Number(value),...(observation.unit?{unit:observation.unit}:{})});
 return {resourceType:'Observation',id:observation.id,status:'final',code:{text:observation.testName},subject:reference('Patient',observation.patientId),derivedFrom:[reference('DocumentReference',observation.documentId)],...(observation.encounterId?{encounter:reference('Encounter',observation.encounterId)}:{}),...(observation.observedAt?{effectiveDateTime:observation.observedAt}:{}),...(observation.verifiedBy?{performer:[reference('Practitioner',observation.verifiedBy)]}:{}),...(observation.numericValue!==null?{valueQuantity:quantity(observation.numericValue)}:observation.textValue!==null?{valueString:observation.textValue}:{}),...(observation.referenceRangeLow!==null||observation.referenceRangeHigh!==null||observation.referenceRangeText?{referenceRange:[{...(observation.referenceRangeLow!==null?{low:quantity(observation.referenceRangeLow)}:{}),...(observation.referenceRangeHigh!==null?{high:quantity(observation.referenceRangeHigh)}:{}),...(observation.referenceRangeText?{text:observation.referenceRangeText}:{})}]}:{}),extension:[{url:`${extensionBase}document-version`,valueString:observation.documentVersionId},{url:`${extensionBase}source-text`,valueString:observation.sourceText},{url:`${extensionBase}original-value`,valueString:observation.originalValue},...(observation.numericValue!==null?[{url:`${extensionBase}exact-decimal`,valueString:observation.numericValue}]:[]),...(observation.sourcePage?[{url:`${extensionBase}source-page`,valueInteger:observation.sourcePage}]:[])]};
}
export function documentFhirBundle(detail:DocumentDetailResponse){
 const doc=detail.document;
 if(doc.deletedAt||doc.securityStatus!=='safe')throw new Error('Only active security-validated documents may be mapped.');
 const observations=doc.clinicalReviewStatus==='approved'?detail.observations.filter(o=>o.documentVersionId===doc.currentVersionId&&o.verificationStatus==='verified'):[];
 const resources:Record<string,unknown>[]=[documentReferenceResource(doc),...observations.map(observationResource)];
 if(['laboratory_report','imaging_report'].includes(doc.documentType))resources.push({resourceType:'DiagnosticReport',id:doc.id,status:doc.clinicalReviewStatus==='approved'?'final':'preliminary',code:{text:doc.title},subject:reference('Patient',doc.patientId),...(doc.documentDate?{effectiveDateTime:doc.documentDate}:{}),result:observations.map(o=>reference('Observation',o.id)),extension:[{url:`${extensionBase}source-document`,valueReference:reference('DocumentReference',doc.id)}]});
 return {resourceType:'Bundle',type:'collection',entry:resources.map(resource=>({resource}))};
}
