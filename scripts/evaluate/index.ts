import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createDatabase, type Db } from '../../packages/db/src/index.ts';
import { readConfig } from '../../packages/config/src/index.ts';
import { closureGaps } from '../../packages/domain/src/index.ts';
import type { Episode } from '../../packages/contracts/src/careloop.ts';
import type { ScenarioRun } from '../../apps/api/src/scenarios.ts';

export function distribution(values:number[]){
 const data=values.filter(v=>Number.isFinite(v)&&v>=0).sort((a,b)=>a-b);
 const percentile=(p:number)=>data.length?data[Math.min(data.length-1,Math.floor((data.length-1)*p))]!:null;
 return {observedN:data.length,meanHours:data.length?data.reduce((a,b)=>a+b,0)/data.length:null,medianHours:percentile(0.5),p90Hours:percentile(0.9)};
}
function rate(numerator:number,denominator:number){return {numerator,denominator,rate:denominator?numerator/denominator:null};}
function elapsedHours(from:string,to:string|null|undefined){return to?(Date.parse(to)-Date.parse(from))/3600000:null;}
const nonNull=(value:number|null):value is number=>value!==null&&Number.isFinite(value)&&value>=0;

/** B: a paired thought experiment with explicit scheduler assumptions, never observed baseline data. */
export function simulateOperations(seed=2026,n=500){
 let state=seed>>>0||1;
 const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};
 const horizon=30*24;
 const participants=Array.from({length:n},()=>({
  reviewAvailability:2+random()*46,patientLatency:2+random()*94,acknowledges:random()>=0.08,
  providerLatency:8+random()*88,rejected:random()<0.15,recoveryLatency:8+random()*64,
  appointmentAvailability:24*(3+random()*32),noShow:random()<0.12,documentationMissing:random()<0.08,
 }));
 const run=(pollHours:number,automaticTracking:boolean)=>{
  const atBatch=(hours:number)=>Math.ceil(hours/pollHours)*pollHours;
  const records=participants.map(p=>{
   const review=atBatch(p.reviewAvailability),notification=review+0.25;
   const acknowledgement=p.acknowledges?notification+p.patientLatency:null;
   const acceptance=acknowledgement===null?null:atBatch(acknowledgement+p.providerLatency+(p.rejected?p.recoveryLatency:0));
   const encounter=acceptance===null?null:acceptance+p.appointmentAvailability+(p.noShow?7*24:0);
   const evidence=encounter===null||p.documentationMissing?null:atBatch(encounter+12);
   const closure=evidence===null?null:evidence+0.75;
   const observed=(value:number|null)=>value!==null&&value<=horizon?value:null;
   const careObserved=observed(encounter),closureObserved=observed(closure);
   const milestones=[review,notification,acknowledgement,acceptance,encounter,evidence,closure].map(observed);
   const manualChecks=automaticTracking?0:Math.ceil(Math.min(closure??horizon,horizon)/24);
   const humanActions=1+(acknowledgement!==null?1:0)+(acceptance!==null?2:0)+(careObserved!==null?2:0)+(closureObserved!==null?2:0)+(acceptance!==null&&p.rejected?1:0)+(acceptance!==null&&acceptance+p.appointmentAvailability<=horizon&&p.noShow?1:0)+manualChecks;
   return {milestones,humanActions,manualChecks,closed:closureObserved!==null,complete:careObserved!==null};
  });
  const timing=Object.fromEntries(['clinicianReview','notification','patientAcknowledgement','referralAcceptance','completedEncounter','evidenceAvailable','verifiedClosure'].map((name,index)=>[name,distribution(records.flatMap(r=>r.milestones[index]!==null&&r.milestones[index]!==undefined?[r.milestones[index]!]:[]))]));
  return {episodes:n,horizonHours:horizon,verifiedClosure:rate(records.filter(r=>r.closed).length,n),appointmentCompletion:rate(records.filter(r=>r.complete).length,n),unresolved:n-records.filter(r=>r.closed).length,timing,humanActionCount:records.reduce((sum,r)=>sum+r.humanActions,0),manualCheckCount:records.reduce((sum,r)=>sum+r.manualChecks,0),clinicalOutcomeMeasured:false};
 };
 return {
  classification:'B_assumed_operational_simulation',syntheticOnly:true,observedBaseline:false,seed,
  assumptions:{episodes:n,horizonHours:horizon,baselineBatchHours:24,assistedBatchHours:2,baselineManualCheck:'one daily case check while open',assistedManualCheck:'none; assume event-driven tracking, with human actions still required',sameAcrossArms:['patient response delays and decision to acknowledge','provider availability and rejection','appointment access and no-show','documentation availability','human clinical approvals'],noAutomaticClosure:true},
  baseline:run(24,false),careloopAssisted:run(2,true),
  interpretation:'Differences are consequences of specified scheduler/manual-check assumptions, not measured effects of CareLoop or clinical benefit. This model is separate from the persisted workflow engine and cannot validate its performance.',
 };
}

export async function evaluate(db:Db,organizationId='org-screening',seed=2026){
 const [episodeQuery,scenarioQuery,usersQuery,eventQuery,closureQuery]=await Promise.all([
  db.pool.query<{snapshot:Episode}>('SELECT snapshot FROM care_episodes WHERE organization_id=$1 ORDER BY id',[organizationId]),
  db.pool.query<{results:ScenarioRun}>('SELECT results FROM scenario_runs WHERE organization_id=$1 ORDER BY created_at,id',[organizationId]),
  db.pool.query<{id:string;role:string}>('SELECT id,role FROM users WHERE organization_id=$1',[organizationId]),
  db.pool.query<{type:string;role:string}>('SELECT e.type,u.role FROM episode_events e JOIN users u ON u.id=e.actor_id WHERE e.organization_id=$1',[organizationId]),
  db.pool.query<{count:number}>('SELECT count(*)::int AS count FROM closure_decisions WHERE organization_id=$1',[organizationId]),
 ]);
 const episodes=episodeQuery.rows.map(row=>row.snapshot);
 const runs=scenarioQuery.rows.map(row=>row.results);
 const latest=new Map<string,ScenarioRun>();for(const run of runs)latest.set(run.scenarioId,run);
 const scenarios=[...latest.values()].sort((a,b)=>a.scenarioId.localeCompare(b.scenarioId));
 const clinicianIds=new Set(usersQuery.rows.filter(u=>u.role==='clinician').map(u=>u.id));
 const reviews=episodes.filter(e=>e.review),referrals=episodes.flatMap(e=>e.referrals),appointments=episodes.flatMap(e=>e.appointments);
 const closed=episodes.filter(e=>e.phase==='CLOSED');
 const correct=closed.filter(e=>e.closure&&clinicianIds.has(e.closure.clinicianId)&&closureGaps(e).length===0);
 const evidenceReady=episodes.filter(e=>!closureGaps(e).some(gap=>gap.startsWith('Clinician-verified')));
 const eventMilestones={notification:'message_delivered',clinicianReview:'review',patientAcknowledgement:'acknowledge',referralAcceptance:'accept_referral',completedEncounter:'complete_appointment',evidenceAvailable:'add_evidence',verifiedClosure:'close'};
 const timing=Object.fromEntries(Object.entries(eventMilestones).map(([name,type])=>{
  const values=episodes.map(e=>elapsedHours(e.createdAt,e.events.find(event=>event.type===type)?.at)).filter(nonNull);
  return [name,{...distribution(values),eligibleEpisodes:episodes.length,missingMilestoneEpisodes:episodes.length-values.length,definition:'Hours from result intake to first recorded milestone; missing is not zero. Prior-revision milestones remain historical facts.'}];
 }));
 const positives=scenarios.filter(run=>run.scenarioId==='overdue-critical-review');
 const negatives=scenarios.filter(run=>run.scenarioId!=='overdue-critical-review');
 const alerted=(run:ScenarioRun)=>run.events.some(event=>event.type==='mark_overdue');
 const tp=positives.filter(alerted).length,fp=negatives.filter(alerted).length;
 const humanEvents=eventQuery.rows.filter(event=>!['result_received','message_delivered','message_failed','message_cancelled','mark_overdue','correct_result'].includes(event.type)&&event.role!=='patient');
 return {
  title:'CareLoop synthetic workflow evaluation',organizationId,syntheticOnly:true,clinicalValidation:false,
  A_softwareAndPersistedWorkflow:{
   scenarioRunsTotal:runs.length,latestScenarioCoverage:scenarios.length,scenarioPassRate:rate(scenarios.filter(run=>run.passed).length,scenarios.length),
   scenarios:scenarios.map(run=>({scenarioId:run.scenarioId,seed:run.seed,passed:run.passed,expectedState:run.expectedState,actualState:run.actualState,simulatedDurationHours:run.simulatedDurationHours,invariantViolations:run.invariantViolations})),
   snapshotMetrics:{
    episodes:episodes.length,activeEpisodes:episodes.filter(e=>e.phase!=='CLOSED').length,unresolved:episodes.length-closed.length,
    patientAcknowledgement:rate(reviews.filter(e=>e.acknowledgedAt).length,reviews.length),
    referralAcceptance:rate(referrals.filter(r=>r.status==='ACCEPTED').length,referrals.length),
    appointmentCompletion:rate(appointments.filter(a=>a.status==='COMPLETED').length,appointments.length),
    evidenceAvailability:rate(evidenceReady.length,episodes.length),verifiedClosure:rate(closed.length,episodes.length),
    currentClosureCorrectness:rate(correct.length,closed.length),historicalClosureDecisions:closureQuery.rows[0]?.count??0,
    humanWorkload:{recordedStaffActions:humanEvents.length,patientActions:eventQuery.rows.filter(event=>event.role==='patient').length,definition:'Persisted staff transition count, not staff minutes or measured cognitive workload.'},
   },
   timing,
   deadlineAlertCorrectness:{truePositive:tp,falseNegative:positives.length-tp,falsePositive:fp,trueNegative:negatives.length-fp,falsePositiveRate:rate(fp,negatives.length),scope:'Latest stored scenario run only. overdue-critical-review is labeled positive; other scenarios are protocol negatives at their recorded end time. This is deadline-rule software correctness, not real clinical alert validity.'},
   observationWindows:'Current snapshot rates include unresolved episodes in their stated denominators. Time-to-milestone distributions include only observed milestones and are not survival estimates. Original seeded and scenario clocks are synthetic; source timestamps may differ from wall time. Recorded scenario end states are immutable report facts even if a later worker tick changes the live episode.',
  },
  B_assumedOperationalSimulation:simulateOperations(seed),
  C_predictiveModel:{report:'model-results.json',methodology:'model-methodology.md',separateFromWorkflowMetrics:true},
  D_clinicalValidation:{performed:false,claim:'No clinical validation, clinical benefit, regulatory approval or production suitability is asserted.'},
 };
}
export type WorkflowEvaluation=Awaited<ReturnType<typeof evaluate>>;
export function renderWorkflowMarkdown(report:WorkflowEvaluation):string{
 const a=report.A_softwareAndPersistedWorkflow,m=a.snapshotMetrics,b=report.B_assumedOperationalSimulation;
 const pct=(value:ReturnType<typeof rate>)=>`${value.numerator}/${value.denominator} (${value.rate===null?'undefined':`${(value.rate*100).toFixed(1)}%`})`;
 const hour=(value:number|null)=>value===null?'unobserved':value.toFixed(2);
 const lines=['# CareLoop synthetic workflow evaluation','','**No clinical validation or production approval. All records and clocks are synthetic.**','',`Organization scope: \`${report.organizationId}\`.`, '',
  '## A. Software correctness and persisted workflow facts','',`Latest scenarios passed: ${pct(a.scenarioPassRate)}; historical run count: ${a.scenarioRunsTotal}.`, '',
  '| Scenario | Expected | Recorded actual | Result |','|---|---|---|---|',
  ...a.scenarios.map(s=>`| ${s.scenarioId} | ${s.expectedState} | ${s.actualState} | ${s.passed?'PASS':'FAIL'} |`),'',
  '| Metric | Numerator / denominator |','|---|---|',
  `| Patient acknowledgement / clinically reviewed episodes | ${pct(m.patientAcknowledgement)} |`,
  `| Accepted / issued referrals | ${pct(m.referralAcceptance)} |`,
  `| Completed / recorded appointments | ${pct(m.appointmentCompletion)} |`,
  `| Episodes with required verified evidence / all episodes | ${pct(m.evidenceAvailability)} |`,
  `| Closed / all episodes | ${pct(m.verifiedClosure)} |`,
  `| Current closures satisfying evidence and clinician role / closed episodes | ${pct(m.currentClosureCorrectness)} |`,'',
  `Unresolved episodes: **${m.unresolved}** of ${m.episodes}. Recorded staff actions: **${m.humanWorkload.recordedStaffActions}**; these are event counts, not measured staff minutes. Historical closure decisions: ${m.historicalClosureDecisions}.`,'',
  '| First milestone from intake | Observed N | Missing N | Median hours | P90 hours |','|---|---:|---:|---:|---:|',
  ...Object.entries(a.timing).map(([name,t])=>`| ${name} | ${t.observedN} | ${t.missingMilestoneEpisodes} | ${hour(t.medianHours)} | ${hour(t.p90Hours)} |`),'',a.observationWindows,'',
  `Deadline-rule false positives in labeled scenario negatives: ${pct(a.deadlineAlertCorrectness.falsePositiveRate)}. True positives ${a.deadlineAlertCorrectness.truePositive}; false negatives ${a.deadlineAlertCorrectness.falseNegative}. This is a software fixture check, not clinical alert validity.`,'',
  '## B. Assumed paired operational simulation','',b.interpretation,'',
  `Seed ${b.seed}; ${b.assumptions.episodes} paired synthetic episodes; ${b.assumptions.horizonHours}-hour horizon. Baseline processes administrative batches every ${b.assumptions.baselineBatchHours} hours and performs a daily manual check. Assisted operations assume ${b.assumptions.assistedBatchHours}-hour batches and automatic tracking. Patient/provider delays, access barriers and human approvals are identical across arms.`,'',
  '| Simulated measure | Assumed baseline | Assumed assisted |','|---|---:|---:|',
  `| Completed appointments | ${pct(b.baseline.appointmentCompletion)} | ${pct(b.careloopAssisted.appointmentCompletion)} |`,
  `| Verified closures | ${pct(b.baseline.verifiedClosure)} | ${pct(b.careloopAssisted.verifiedClosure)} |`,
  `| Unresolved at horizon | ${b.baseline.unresolved} | ${b.careloopAssisted.unresolved} |`,
  `| Modeled human action count | ${b.baseline.humanActionCount} | ${b.careloopAssisted.humanActionCount} |`,
  `| Assumed manual check count | ${b.baseline.manualCheckCount} | ${b.careloopAssisted.manualCheckCount} |`,'',
  'These differences were generated by specified assumptions. No observed baseline comparison or measured clinical effect exists. JSON includes every milestone distribution and all assumptions. Neither simulated arm closes episodes without assumed encounter, evidence and human approval.','',
  '## C. Predictive model performance','',
  'See [model-results.md](model-results.md) for the independent synthetic logistic/baseline evaluation and subgroup/calibration details.','',
  '## D. Clinical validation','',report.D_clinicalValidation.claim,''];
 return lines.join('\n');
}

async function main(){
 const config=readConfig();const db=createDatabase(config.DATABASE_URL);
 try{
  const report=await evaluate(db,process.env.EVALUATION_ORGANIZATION_ID??'org-screening',2026);
  await mkdir('docs/evaluation',{recursive:true});
  await writeFile('docs/evaluation/workflow-results.json',JSON.stringify(report,null,2)+'\n');
  await writeFile('docs/evaluation/workflow-results.md',renderWorkflowMarkdown(report));
  process.stdout.write(`Synthetic evaluation: ${report.A_softwareAndPersistedWorkflow.scenarioPassRate.numerator}/${report.A_softwareAndPersistedWorkflow.scenarioPassRate.denominator} latest scenarios pass; reports saved to docs/evaluation.\n`);
 }finally{await db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
