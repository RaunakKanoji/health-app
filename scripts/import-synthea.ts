import { readFileSync } from 'node:fs';
import { buildApp } from '../apps/api/src/app.ts';
import { supportedResourceTypes } from '../packages/fhir/src/index.ts';

type Resource={resourceType:string;id:string;[key:string]:unknown};
const file=process.argv[2]??'data/fixtures/synthea-r4-bundle.json';
const bundle=JSON.parse(readFileSync(file,'utf8')) as {resourceType:string;entry?:{fullUrl?:string;resource:Resource}[]};
if(bundle.resourceType!=='Bundle'||!Array.isArray(bundle.entry))throw new Error('Expected a synthetic FHIR R4 Bundle.');
const app=await buildApp();
try {
 const actor=(await app.service.user('user-clinician'))!;
 const entries=[...bundle.entry].sort((a,b)=>Number(b.resource.resourceType==='Patient')-Number(a.resource.resourceType==='Patient'));
 const references=new Map(entries.filter(e=>e.fullUrl).map(e=>[e.fullUrl!,`${e.resource.resourceType}/${e.resource.id}`]));
 const normalize=(value:unknown):unknown=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,child])=>[key,key==='reference'&&typeof child==='string'?references.get(child)??child:normalize(child)])):value;
 const totals={imported:0,duplicate:0,deadLetter:0,unsupported:0};
 for(const entry of entries){
  if(!(supportedResourceTypes as readonly string[]).includes(entry.resource.resourceType)){totals.unsupported++;continue;}
  const normalized=normalize(entry.resource) as Resource;
  // Keep original fields in a provenance extension when references require normalization.
  const resource=JSON.stringify(normalized)===JSON.stringify(entry.resource)?normalized:{...normalized,extension:[...((normalized.extension as unknown[])??[]),{url:'https://careloop.demo/fhir/StructureDefinition/original-resource',valueString:JSON.stringify(entry.resource)}]};
  const result=await app.service.ingest(actor,{source:'official-synthea-fixture',eventId:`${resource.resourceType}:${resource.id}:1`,resource});
  if(result.status==='IMPORTED')totals.imported++;else if(result.status==='DUPLICATE')totals.duplicate++;else totals.deadLetter++;
 }
 console.log(JSON.stringify({syntheticOnly:true,...totals,note:'Unsupported resource types remain in the original Bundle; no clinical follow-up is inferred from values.'},null,2));
}finally{await app.close();}
