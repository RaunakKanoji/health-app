import { login } from './auth';
import { test,expect,type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { Episode } from '../../packages/contracts/src/careloop.ts';

const localTime=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;

async function open(page:Page,id:string){
 await page.getByRole('button',{name:/^Care episodes/}).click();
 await page.getByLabel('Search patients or episodes').fill(id);
 await page.getByRole('row').filter({hasText:id.slice(0,12)}).getByRole('button',{name:/Open episode/}).click();
 await expect(page.getByRole('button',{name:'Back to workspace'})).toBeVisible();
}
async function confirm(page:Page,note?:string,clinical=false,label='Confirm action'){
 const dialog=page.getByRole('dialog');
 if(note)await dialog.getByRole('textbox').last().fill(note);
 if(clinical)await dialog.getByRole('checkbox').check();
 await dialog.getByRole('button',{name:label,exact:true}).click();
 await expect(dialog).not.toBeVisible();
}
test.describe.serial('Complete synthetic result-to-verified-care story',()=>{
 let page:Page;let episodeId:string;
 test.beforeAll(async({browser})=>{page=await browser.newPage({viewport:{width:1440,height:1000}});await mkdir('docs/demo/screenshots',{recursive:true});});
 test.afterAll(async()=>{await page.close();});
 test('1. new screening intake creates a persisted owned episode',async()=>{
  await page.goto('/');await expect(page.getByRole('heading',{name:'Welcome to CareLoop'})).toBeVisible();
  await page.screenshot({path:'docs/demo/screenshots/login.png',fullPage:true});
  await login(page,'clinician');await page.screenshot({path:'docs/demo/screenshots/overview.png',fullPage:true});
  await page.getByRole('button',{name:'New screening result',exact:true}).click();
  await page.getByLabel('Synthetic patient').selectOption('patient-001');
  await page.getByLabel('Source result description').fill('Synthetic end-to-end screening result requires clinician review and follow-up.');
  const response=page.waitForResponse(r=>r.url().endsWith('/api/fhir/ingest')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Receive screening result'}).click();
  const result=await(await response).json();expect(result.status).toBe('IMPORTED');episodeId=result.episodeId;
  await expect(page.getByRole('dialog')).not.toBeVisible();await open(page,episodeId);
  await expect(page.getByText('Nadia Al Farsi',{exact:true}).first()).toBeVisible();
  const saved=await page.request.get(`/api/episodes/${episodeId}`);expect((await saved.json()).episode.phase).toBe('RESULT_RECEIVED');
 });
 test('2. authenticated clinician approves review and queues a neutral message',async()=>{
  await page.getByRole('button',{name:'Review result',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByLabel('Clinical disposition / review note').fill('Synthetic clinician reviewed the screening source and authorized follow-up.');
  await dialog.getByLabel('Approved explanation for the patient').fill('Please discuss your synthetic screening result with your care team at a follow-up visit.');
  await dialog.getByLabel('Clinician-approved follow-up due').fill(localTime(new Date(Date.now()+2*86400000)));
  await dialog.getByLabel('Clinical urgency').selectOption('ROUTINE');
  await dialog.getByRole('checkbox').check();await dialog.getByRole('button',{name:'Approve clinical review'}).click();await expect(dialog).not.toBeVisible();
  await page.getByRole('button',{name:'Send reminder',exact:true}).click();await confirm(page);
  await expect.poll(async()=>{const r=await page.request.get(`/api/episodes/${episodeId}`);return(await r.json()).episode.communications[0].status;},{timeout:15000}).toBe('DELIVERED');
 });
 test('3. patient explicitly acknowledges through the English and Hindi portal',async()=>{
  await login(page,'patient');if(await page.getByRole('button',{name:'English',exact:true}).isVisible())await page.getByRole('button',{name:'English',exact:true}).click();
  await page.locator('.patient-episode-select select').selectOption(episodeId);
  await page.getByRole('button',{name:'I have read my next steps',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'I have read my next steps',exact:true}).click();
  await expect(page.getByText('You have acknowledged your next steps',{exact:false})).toBeVisible();
  await page.screenshot({path:'docs/demo/screenshots/patient.png',fullPage:true});
 });
 test('4. clinician authorizes referral and receiving provider explicitly accepts',async()=>{
  await login(page,'clinician');await open(page,episodeId);
  await page.getByRole('button',{name:'Authorize referral',exact:true}).click();
  await page.getByLabel('Receiving organization').selectOption('org-receiver');
  await confirm(page,'Synthetic follow-up consultation is authorized.',true);
  await login(page,'receiver');await open(page,episodeId);
  await page.getByRole('button',{name:'Accept referral',exact:true}).click();await confirm(page,'Synthetic receiving clinic accepts responsibility for consultation.');
  await expect(page.locator('.referral-header').getByText('Accepted',{exact:true})).toBeVisible();
 });
 test('5. appointment and actual completed encounter remain separate actions',async()=>{
  await page.getByRole('button',{name:'Record appointment',exact:true}).click();
  await page.getByLabel('Appointment date and time').fill(localTime(new Date(Date.now()-300000)));
  await page.getByLabel('Location / service').fill('Synthetic follow-up clinic');await confirm(page);
  let result=await(await page.request.get(`/api/episodes/${episodeId}`)).json();expect(result.episode.appointments.at(-1).status).toBe('SCHEDULED');expect(result.episode.closure).toBeNull();
  await page.getByRole('button',{name:'Record attendance',exact:true}).click();await confirm(page,'Synthetic follow-up encounter actually completed and documented.');
  result=await(await page.request.get(`/api/episodes/${episodeId}`)).json();expect(result.episode.appointments.at(-1).status).toBe('COMPLETED');expect(result.episode.closure).toBeNull();
 });
 test('6. receiving provider submits both pieces of current encounter evidence',async()=>{
  for(const kind of ['encounter_note','followup_report']){
   await page.getByRole('button',{name:'Add evidence',exact:true}).click();
   await page.getByLabel('Evidence type').selectOption(kind);await page.getByLabel('Document title').fill(`Synthetic ${kind}`);
   await page.getByLabel('Clinical evidence text').fill('Synthetic clinician-authored documentation demonstrating completed follow-up and recorded outcome.');await confirm(page);
  }
  const ep:Episode=(await(await page.request.get(`/api/episodes/${episodeId}`)).json()).episode;expect(ep.evidence).toHaveLength(2);expect(ep.evidence.every(e=>e.verifiedBy===null)).toBe(true);
 });
 test('7. clinician verifies evidence, signs closure, and persisted metrics update',async()=>{
  await login(page,'clinician');await open(page,episodeId);
  await expect(page.getByRole('button',{name:'Review & approve closure',exact:true})).toBeDisabled();
  for(let i=0;i<2;i++){await page.getByRole('button',{name:'Verify evidence',exact:true}).first().click();await confirm(page,'Synthetic evidence checked against this result and completed encounter.',true);}
  const before=(await(await page.request.get('/api/metrics')).json()).verifiedClosure.numerator;
  await page.getByRole('button',{name:'Review & approve closure',exact:true}).click();await confirm(page,'I confirm the intended follow-up occurred and verified evidence supports closure.',true,'Approve closure');
  await expect(page.getByText('Clinician-approved closure',{exact:true})).toBeVisible();
  const after=(await(await page.request.get('/api/metrics')).json()).verifiedClosure.numerator;expect(after).toBe(before+1);
  await page.screenshot({path:'docs/demo/screenshots/verified-episode.png',fullPage:true});
  await page.reload();await open(page,episodeId);await expect(page.getByText('Clinician-approved closure',{exact:true})).toBeVisible();
 });
 test('8. rejected referral remains open and can be recovered by its owner',async()=>{
  await login(page,'admin');
  const run=await page.request.post('/api/scenarios/run',{data:{scenarioId:'referral-rejection',seed:2019}});const result=await run.json();expect(result.passed).toBe(true);expect(result.actualState).toBe('BLOCKED');
  // Historical replays may already be due on the wall clock. Settle the worker
  // before opening an editable version so its escalation cannot race confirmation.
  const tick=await page.request.post('/api/admin/tick',{data:{}});expect(tick.ok()).toBe(true);
  await login(page,'clinician');await open(page,result.episodeId);await expect(page.getByText('Returned to Nadia Al Farsi.',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Authorize referral',exact:true}).click();await page.getByLabel('Receiving organization').selectOption('org-receiver');await confirm(page,'Synthetic alternate referral route arranged by clinician.',true);
  const saved=await(await page.request.get(`/api/episodes/${result.episodeId}`)).json();expect(saved.episode.closure).toBeNull();expect(saved.episode.referrals.at(-1).status).toBe('REQUESTED');
 });
 test('9. overdue escalation scenario stays open and is visible in the lab',async()=>{
  await login(page,'admin');await page.getByRole('button',{name:'Demonstration lab',exact:true}).click();
  await page.getByLabel('Simulation seed').fill('2026');await page.locator('.scenario-item').filter({hasText:'Overdue review escalation'}).getByRole('button',{name:'Run',exact:true}).click();
  await expect(page.getByText('Scenario passed',{exact:true})).toBeVisible();await expect(page.locator('.metadata-list').getByText('Overdue',{exact:true})).toHaveCount(2);
  await page.screenshot({path:'docs/demo/screenshots/scenario-lab.png',fullPage:true});
 });
 test('10. mobile Hindi portal and server prevent unauthorized access',async()=>{
  await login(page,'patient');await page.setViewportSize({width:390,height:844});
  if(await page.getByRole('button',{name:'हिन्दी',exact:true}).isVisible())await page.getByRole('button',{name:'हिन्दी',exact:true}).click();
  await expect(page.locator('.patient-app')).toHaveAttribute('dir','ltr');await expect(page.locator('.patient-app')).toHaveAttribute('lang','hi');
  await page.screenshot({path:'docs/demo/screenshots/patient-hindi-mobile.png',fullPage:true});
  expect((await page.request.get('/api/episodes/episode-002')).status()).toBe(404);
  const result=await page.request.post(`/api/episodes/${episodeId}/actions`,{headers:{'Idempotency-Key':'forbidden-e2e-closure'},data:{type:'close',expectedVersion:1,note:'Unauthorized patient closure attempt.'}});expect([403,409]).toContain(result.status());
  const size=await page.locator('.patient-app').boundingBox();expect(size!.width).toBeLessThanOrEqual(390);
 });
});
