import { login } from './auth';
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('an interrupted action retries its original idempotency key without duplicating a reminder', async ({ page }) => {
  await login(page,'clinician');
  const intake = await page.request.post('/api/fhir/ingest', { data: { source:'ui-reliability-test', eventId:randomUUID(), resource: {
    resourceType:'Observation', id:randomUUID(), meta:{versionId:'1'}, status:'final',
    subject:{reference:'Patient/patient-001'}, code:{coding:[{system:'http://loinc.org',code:'4548-4'}],text:'Synthetic screening result for interruption recovery verification.'},
    effectiveDateTime:new Date().toISOString(), extension:[{url:'https://careloop.demo/fhir/StructureDefinition/follow-up-required',valueBoolean:true}],
  } } });
  const result = await intake.json(); expect(result.status).toBe('IMPORTED'); const episodeId:string = result.episodeId;
  const initial = (await (await page.request.get(`/api/episodes/${episodeId}`)).json()).episode;
  const review = await page.request.post(`/api/episodes/${episodeId}/actions`, { headers:{'Idempotency-Key':randomUUID()}, data:{
    type:'review', expectedVersion:initial.version, note:'Synthetic clinician review authorizes administrative follow-up.',
    patientExplanation:'Please review this synthetic result with your care team.', urgency:'ROUTINE', dueAt:new Date(Date.now()+86400000).toISOString(),
  } });
  expect(review.ok()).toBe(true);
  await page.goto('/'); await expect(page.locator('.sidebar')).toBeVisible();
  await page.getByRole('button',{name:/^Care episodes/}).click();
  await page.getByLabel('Search patients or episodes').fill(episodeId);
  await page.getByRole('row').filter({hasText:episodeId.slice(0,12)}).getByRole('button',{name:/Open episode/}).click();
  await page.getByRole('button',{name:'Send reminder',exact:true}).click();
  let interrupted = false; const observedKeys:string[] = [];
  await page.route(`**/api/episodes/${episodeId}/actions`, async route => {
    if(route.request().postDataJSON().type==='send_message') {
      observedKeys.push(route.request().headers()['idempotency-key']!);
      if(!interrupted) { interrupted=true; const upstream=await route.fetch();expect(upstream.ok()).toBe(true);await route.abort('failed');return; }
    }
    await route.continue();
  });
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Confirm action',exact:true}).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button',{name:'Confirm action',exact:true}).click();
  await expect(dialog).not.toBeVisible();
  const saved=(await(await page.request.get(`/api/episodes/${episodeId}`)).json()).episode;
  expect(saved.communications).toHaveLength(1);
  expect(observedKeys).toHaveLength(2);
  expect(observedKeys[0]).toBe(observedKeys[1]);
});
