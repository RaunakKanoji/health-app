import {describe,it,expect} from 'vitest';
import {validateResource,pathwayFor,hasActionableSourceFlag,supportedResourceTypes} from '../packages/fhir/src/index.ts';
import {hash} from '../packages/workflows/src/service.ts';
const code={coding:[{system:'http://loinc.org',code:'4548-4'}]},reference={reference:'Patient/synthetic'};
const resources:Record<string,unknown>={
 Patient:{name:[{text:'Synthetic Patient'}],birthDate:'1970-01-01'},Practitioner:{name:[{text:'Synthetic Clinician'}]},Organization:{name:'Synthetic Clinic'},
 Observation:{status:'final',code,subject:reference},DiagnosticReport:{status:'final',code,subject:reference},
 ServiceRequest:{status:'active',intent:'order',subject:reference},Task:{status:'requested',intent:'order'},Appointment:{status:'booked',participant:[{status:'accepted'}]},
 Encounter:{status:'finished',class:{system:'http://terminology.hl7.org/CodeSystem/v3-ActCode',code:'AMB'}},Communication:{status:'completed'},
 Consent:{status:'active',scope:{coding:[{code:'patient-privacy'}]},category:[{coding:[{code:'59284-0'}]}]},
 DocumentReference:{status:'current',content:[{attachment:{contentType:'text/plain',url:'https://example.invalid/synthetic.txt'}}]},
 Provenance:{target:[reference],recorded:'2026-10-27T09:00:00Z',agent:[{who:{reference:'Practitioner/demo'}}]},
 AuditEvent:{type:{code:'rest'},recorded:'2026-10-27T09:00:00Z',agent:[{requestor:true}],source:{observer:{reference:'Organization/demo'}}},
};
describe('bounded FHIR R4 adapter validation',()=>{
 it.each(supportedResourceTypes)('accepts supported %s and retains original provenance',resourceType=>{const input={resourceType,id:'synthetic-source',meta:{versionId:'1',lastUpdated:'2026-10-27T09:00:00Z'},...(resources[resourceType] as object)};expect(validateResource(input)).toEqual(input);});
 it.each(supportedResourceTypes)('rejects invalid source identity for %s',resourceType=>{expect(()=>validateResource({resourceType,id:'../../bad',...(resources[resourceType] as object)})).toThrow();});
 it.each(['Observation','DiagnosticReport','ServiceRequest','Task','Appointment','Encounter','Communication','Consent','DocumentReference'])('rejects invalid %s status',resourceType=>{expect(()=>validateResource({resourceType,id:'synthetic',...(resources[resourceType] as object),status:'invented'})).toThrow();});
 it('does not infer clinical pathways from a code in the wrong coding system',()=>{expect(pathwayFor(validateResource({resourceType:'Observation',id:'synthetic',status:'final',subject:reference,code:{coding:[{system:'https://example.invalid/codes',code:'4548-4'}]}}))).toBeNull();});
 it('does not infer actionable follow-up from numeric values or code alone',()=>{expect(hasActionableSourceFlag(validateResource({resourceType:'Observation',id:'synthetic',status:'final',subject:reference,code,valueQuantity:{value:999,unit:'%'}}))).toBe(false);});
 it('requires an explicit source flag using known coding system',()=>{const r=validateResource({resourceType:'Observation',id:'synthetic',status:'final',subject:reference,code,interpretation:[{coding:[{system:'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',code:'A'}]}]});expect(hasActionableSourceFlag(r)).toBe(true);});
 it('canonical hash is invariant to JSONB object order but preserves array order',()=>{expect(hash({a:1,b:{c:2,d:3}})).toBe(hash({b:{d:3,c:2},a:1}));expect(hash([1,2])).not.toBe(hash([2,1]));});
});
