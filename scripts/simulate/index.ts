import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from '../../apps/api/src/app.ts';
import { runScenario,scenarioCatalog,type ScenarioRun } from '../../apps/api/src/scenarios.ts';

const args=process.argv.slice(2);
const arg=(name:string)=>args[args.indexOf(name)+1];
const seed=args.includes('--seed')?Number(arg('--seed')):2026;
if(!Number.isInteger(seed)||seed<0||seed>2147483647)throw new Error('Seed must be an integer between 0 and 2147483647.');
const selected=args.includes('--scenario')?scenarioCatalog.filter(s=>s.id===arg('--scenario')):scenarioCatalog;
if(!selected.length)throw new Error('Unknown scenario.');
const app=await buildApp();
try {
 const actor=(await app.service.user('user-admin'))!;
 const results:ScenarioRun[]=[];
 for(const scenario of selected){const result=await runScenario(app.db,actor,scenario.id,seed);results.push(result);console.log(`${result.passed?'PASS':'FAIL'} ${scenario.id}: ${result.actualState}`);}
 const dir=resolve('docs/evaluation');await mkdir(dir,{recursive:true});
 await writeFile(resolve(dir,'scenario-results.json'),JSON.stringify({syntheticOnly:true,seed,results},null,2)+'\n');
 await writeFile(resolve(dir,'scenario-results.md'),`# Synthetic workflow scenario results\n\nSeed: ${seed}. These are software correctness checks, not clinical validation. Each replay creates isolated synthetic source records and preserves earlier audit history.\n\n| Scenario | Expected | Actual | Result |\n|---|---|---|---|\n${results.map(r=>`| ${r.scenarioId} | ${r.expectedState} | ${r.actualState} | ${r.passed?'PASS':'FAIL'} |`).join('\n')}\n\n${results.filter(r=>!r.passed).map(r=>`${r.scenarioId}: ${r.invariantViolations.join('; ')}`).join('\n')}\n`);
 if(results.some(r=>!r.passed))process.exitCode=1;
} finally {await app.close();}
