import { describe, expect, it, vi } from 'vitest';
import { predictOperationalRisk } from '../../packages/ai/src/risk.ts';
const features={days_waiting:4,prior_no_shows:1,contact_attempts:2,referral_rejected:false,patient_acknowledged:true,transport_barrier:false};
const options={url:'http://127.0.0.1:8001',key:'synthetic-test-service-key-with-minimum32'};
const validResponse={probability:0.42,model:'logistic_regression',version:'synthetic-logreg-v1-test',fallback:false,explanation_method:'Exact linear log odds, not SHAP',factors:[],synthetic_only:true,operational_only:true,clinical_validation:false};
describe('operational risk adapter safety',()=>{
 it.each([{}, {...features,transport_barrier:undefined},{...features,days_waiting:7.5},{...features,clinicalUrgency:'urgent'}])('never fabricates missing or invalid features',async input=>{
  const fetcher=vi.fn<typeof fetch>();
  expect((await predictOperationalRisk(input,{...options,fetcher})).status).toBe('insufficient_data');
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('does not call an unconfigured private service',async()=>{
  const fetcher=vi.fn<typeof fetch>();
  expect((await predictOperationalRisk(features,{...options,key:'',fetcher})).status).toBe('unavailable');
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('authenticates a bounded request and exposes real explanation metadata',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(validResponse)));
  const result=await predictOperationalRisk(features,{...options,fetcher});
  expect(result.status).toBe('available');
  if(result.status==='available'){expect(result.probability).toBe(0.42);expect(result.fallback).toBe(false);expect(result.version).toBe(validResponse.version);}
  const init=fetcher.mock.calls[0]?.[1];
  expect(init?.headers).toMatchObject({'X-Internal-Key':options.key});
  expect(JSON.parse(String(init?.body))).toEqual(features);
  expect(init?.signal).toBeInstanceOf(AbortSignal);
 });
 it('preserves the provider baseline fallback label',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({...validResponse,fallback:true,model:'deterministic_baseline'})));
  const result=await predictOperationalRisk(features,{...options,fetcher});
  expect(result.status==='available'&&result.fallback).toBe(true);
 });
 it.each([{...validResponse,probability:2},{...validResponse,clinical_validation:true},{...validResponse,operational_only:false},{probability:0.4,model:'unknown'}])('rejects untrusted or unsafe provider output',async body=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
  expect((await predictOperationalRisk(features,{...options,fetcher})).status).toBe('unavailable');
 });
 it('provider failure returns an explicit unavailable result without modifying input',async()=>{
  const before=structuredClone(features);
  const fetcher=vi.fn<typeof fetch>().mockRejectedValue(new Error('provider failed'));
  expect((await predictOperationalRisk(features,{...options,fetcher})).status).toBe('unavailable');
  expect(features).toEqual(before);
 });
});
