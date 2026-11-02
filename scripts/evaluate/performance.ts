import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, arch, totalmem } from 'node:os';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { testApplication, signIn } from '../../tests/helpers.ts';
import type { CareLoopApp } from '../../apps/api/src/app.ts';

export function latencySummary(samples:number[]){
 if(samples.length===0)throw new Error('At least one latency sample is required.');
 const sorted=[...samples].sort((a,b)=>a-b);
 const percentile=(fraction:number)=>sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)]!;
 return {sampleCount:samples.length,minMs:sorted[0]!,p50Ms:percentile(0.5),p95Ms:percentile(0.95),maxMs:sorted.at(-1)!,meanMs:samples.reduce((sum,value)=>sum+value,0)/samples.length};
}
async function sampleRoute(app:CareLoopApp,cookie:string,path:string,concurrency:number,count:number,warmup:number){
 for(let i=0;i<warmup;i++){
  const response=await app.inject({url:path,headers:{cookie}});
  if(response.statusCode!==200)throw new Error(`Warm-up failed for ${path}: HTTP ${response.statusCode}`);
 }
 const durations:number[]=[],bytes:number[]=[];
 let assigned=0,failed=0;const started=performance.now();
 await Promise.all(Array.from({length:concurrency},async()=>{
  while(assigned<count){
   assigned++;const begin=performance.now();
   const response=await app.inject({url:path,headers:{cookie}});
   durations.push(performance.now()-begin);bytes.push(Buffer.byteLength(response.body));
   if(response.statusCode!==200)failed++;
  }
 }));
 const elapsed=performance.now()-started;
 return {path,concurrency,warmupRequests:warmup,...latencySummary(durations),failedRequests:failed,successfulRequests:count-failed,wallDurationMs:elapsed,achievedRequestsPerSecond:count/(elapsed/1000),meanResponseBytes:bytes.reduce((sum,n)=>sum+n,0)/bytes.length};
}

export async function benchmark(){
 if(process.env.DEMO_MODE!=='true')throw new Error('Explicit DEMO_MODE=true is required for the isolated synthetic benchmark.');
 const context=await testApplication();
 try{
  const cookie=await signIn(context.app,'clinician');
  const cardinality=(await context.app.db.pool.query<{episodes:number;events:number;organizations:number}>('SELECT (SELECT count(*)::int FROM care_episodes) AS episodes,(SELECT count(*)::int FROM episode_events) AS events,(SELECT count(*)::int FROM organizations) AS organizations')).rows[0]!;
  const measurements=[];
  for(const concurrency of [1,4])for(const path of ['/api/workspace','/api/metrics'])measurements.push(await sampleRoute(context.app,cookie,path,concurrency,60,5));
  return {
   classification:'A_local_synthetic_software_performance',syntheticOnly:true,clinicalValidation:false,
   execution:{measuredAt:new Date().toISOString(),node:process.version,platform:platform(),architecture:arch(),logicalCpuCount:cpus().length,memoryGiB:Math.round(totalmem()/1024**3),database:'local PostgreSQL over loopback',isolation:'temporary test schema created, migrated, seeded and dropped by this command'},
   dataset:cardinality,
   method:{transport:'Fastify in-process inject; real authentication, handlers, SQL and serialization',sampleCountPerRouteAndConcurrency:60,warmupRequestsPerRouteAndConcurrency:5,concurrencyLevels:[1,4],percentiles:'nearest rank of measured request latency; p95 is the 57th sorted sample of 60',measuredOperations:'Read-only authenticated workspace and metrics requests after synthetic setup',excluded:['network transit for HTTP','TLS','reverse proxy','Next.js rendering','browser rendering','cloud PostgreSQL latency','seed, migration and login time'],fixedTimingPromise:false},
   measurements,
   interpretation:'Local diagnostic benchmark only. Reproduction fixes the dataset and request schedule, not elapsed latency. Shared machine load, cache state and runtime versions affect timing. This is not a capacity test, production SLA, clinical performance result or guarantee.',
  };
 }finally{await context.close();}
}
export type PerformanceReport=Awaited<ReturnType<typeof benchmark>>;
export function renderPerformance(report:PerformanceReport){
 return [
  '# Local synthetic API performance','', '**Diagnostic measurement only; no production capacity or clinical-performance claim.**','',
  `Measured at ${report.execution.measuredAt}. Node ${report.execution.node}; ${report.execution.platform}/${report.execution.architecture}; ${report.execution.logicalCpuCount} logical CPUs; ${report.execution.memoryGiB} GiB RAM.`, '',
  `Dataset: ${report.dataset.episodes} synthetic episodes, ${report.dataset.events} persisted events and ${report.dataset.organizations} organizations in an isolated temporary PostgreSQL schema. The schema is dropped after measurement.`, '',
  'Requests use Fastify in-process injection with real session authentication, endpoint handlers, PostgreSQL queries and JSON serialization. HTTP network/TLS, proxy, web rendering, login and setup are excluded. Each row has five warm-up requests and 60 measured requests. Percentiles use nearest rank.', '',
  '| Endpoint | Concurrency | N | p50 ms | p95 ms | Mean ms | Failed | Requests/s |','|---|---:|---:|---:|---:|---:|---:|---:|',
  ...report.measurements.map(row=>`| ${row.path} | ${row.concurrency} | ${row.sampleCount} | ${row.p50Ms.toFixed(2)} | ${row.p95Ms.toFixed(2)} | ${row.meanMs.toFixed(2)} | ${row.failedRequests} | ${row.achievedRequestsPerSecond.toFixed(1)} |`),'',
  report.interpretation,'',
  'Reproduce from the application root after starting local PostgreSQL:', '',
  '```sh','pnpm exec tsx --env-file=.env scripts/evaluate/performance.ts','```','',
  'The benchmark creates only a temporary isolated synthetic schema and reads its seeded episodes during timing. The JSON artifact contains sample counts, response sizes, timings, environment and method. Latency is expected to vary between runs.','',
 ].join('\n');
}
async function main(){
 const report=await benchmark();await mkdir('docs/evaluation',{recursive:true});
 await writeFile('docs/evaluation/performance-results.json',JSON.stringify(report,null,2)+'\n');
 await writeFile('docs/evaluation/performance-results.md',renderPerformance(report));
 process.stdout.write(`Local benchmark: ${report.measurements.reduce((n,row)=>n+row.sampleCount,0)} measured requests, ${report.measurements.reduce((n,row)=>n+row.failedRequests,0)} failures. Reports saved to docs/evaluation.\n`);
 if(report.measurements.some(row=>row.failedRequests>0))process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
