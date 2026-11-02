import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const reportDirectory = 'docs/evaluation/accessibility';
async function assertAccessible(page: Page, name: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  await mkdir(reportDirectory, { recursive: true });
  const violations = results.violations.filter(item => ['critical', 'serious'].includes(item.impact ?? ''));
  await writeFile(`${reportDirectory}/${name}.json`, JSON.stringify({
    scope: name, standard: 'WCAG 2.1 A and AA; automated checks only',
    limitation: 'Axe cannot certify accessibility. Manual keyboard and assistive-technology review remains necessary.',
    seriousOrCriticalViolations: violations.map(item => ({ id: item.id, impact: item.impact, help: item.help, nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })),
    otherViolations: results.violations.filter(item => !['critical', 'serious'].includes(item.impact ?? '')).map(item => ({ id: item.id, impact: item.impact, help: item.help })),
    passedRuleCount: results.passes.length,
  }, null, 2));
  expect(violations, JSON.stringify(violations.map(item => ({ id:item.id, nodes:item.nodes.map(node=>({target:node.target,summary:node.failureSummary}))})), null, 2)).toEqual([]);
}
async function login(page: Page, role: string) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(`${role}@careloop.demo`);
  await page.getByLabel('Password', { exact: true }).fill('CareLoop-Demo-2026!');
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await expect(page.locator(role === 'patient' ? '.patient-app' : '.sidebar')).toBeVisible();
}

test.describe('Accessible synthetic care workspaces', () => {
  test.beforeAll(async () => { await mkdir('docs/demo/screenshots', { recursive: true }); });
  test('login has readable contrast, labeled controls and accessible navigation', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome to CareLoop' })).toBeVisible();
    await assertAccessible(page, 'login');
    await page.screenshot({ path: 'docs/demo/screenshots/login.png', fullPage: true });
  });
  test('clinician overview and intake dialog expose accessible controls', async ({ page }) => {
    await login(page, 'clinician');
    await expect(page.getByRole('heading', { name: 'Care overview', exact: true })).toBeVisible();
    await assertAccessible(page, 'clinician-overview');
    await page.screenshot({ path: 'docs/demo/screenshots/overview.png', fullPage: true });
    await page.getByRole('button', { name: 'New screening result', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await assertAccessible(page, 'intake-dialog');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'New screening result', exact: true })).toBeFocused();
  });
  for (const language of ['en', 'ar'] as const) {
    test(`patient ${language} mobile portal has accessible language, controls and contrast`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await login(page, 'patient');
      const root = page.locator('.patient-app');
      if (await root.getAttribute('lang') !== language) {
        await page.getByRole('button', { name: language === 'en' ? 'English' : 'العربية', exact: true }).click();
      }
      await expect(root).toHaveAttribute('lang', language);
      await expect(root).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
      await assertAccessible(page, `patient-${language}-mobile`);
      await page.screenshot({ path: `docs/demo/screenshots/patient-${language === 'ar' ? 'arabic' : 'english'}-mobile.png`, fullPage: true });
      await page.getByRole('button', { name: language === 'ar' ? 'الخصوصية والتفضيلات' : 'Privacy & preferences', exact: true }).click();
      await page.getByRole('button', { name: language === 'ar' ? 'تحديث التفضيلات' : 'Update preferences', exact: true }).click();
      await assertAccessible(page, `patient-${language}-preferences`);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).not.toBeVisible();
    });
  }
});
