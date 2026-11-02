import { describe, expect, it } from 'vitest';
import { distribution, simulateOperations } from '../../scripts/evaluate/index.ts';
describe('evaluation arithmetic and reproducibility',()=>{
 it('retains absent observed timings as null rather than zero',()=>{
  expect(distribution([])).toEqual({observedN:0,meanHours:null,medianHours:null,p90Hours:null});
  expect(distribution([2,4,6])).toMatchObject({observedN:3,meanHours:4,medianHours:4});
 });
 it('reproduces a paired assumption-based simulation without calling it an observed baseline',()=>{
  const a=simulateOperations(2026,100),b=simulateOperations(2026,100);
  expect(a).toEqual(b);expect(a.observedBaseline).toBe(false);expect(a.assumptions.noAutomaticClosure).toBe(true);
  expect(a.baseline.verifiedClosure.denominator).toBe(a.careloopAssisted.verifiedClosure.denominator);
  expect(a.baseline.verifiedClosure.numerator+a.baseline.unresolved).toBe(100);
  expect(a.careloopAssisted.verifiedClosure.numerator+a.careloopAssisted.unresolved).toBe(100);
  expect(a.baseline.manualCheckCount).toBeGreaterThan(0);expect(a.careloopAssisted.manualCheckCount).toBe(0);
  expect(a.baseline.clinicalOutcomeMeasured).toBe(false);
 });
});
