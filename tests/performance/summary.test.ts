import { expect, it } from 'vitest';
import { latencySummary } from '../../scripts/evaluate/performance.ts';
it('reports nearest-rank percentiles without silently replacing absent measurements',()=>{
 const samples=Array.from({length:60},(_,i)=>60-i);
 expect(latencySummary(samples)).toEqual({sampleCount:60,minMs:1,p50Ms:30,p95Ms:57,maxMs:60,meanMs:30.5});
 expect(samples[0]).toBe(60);
 expect(()=>latencySummary([])).toThrow('At least one');
});
