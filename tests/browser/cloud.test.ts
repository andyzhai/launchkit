import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { Journal } from '../../src/workflow/journal.ts';
import { Vault } from '../../src/security/tokens.ts';
import { MockProvider } from '../../src/adapters/mock.ts';
import { startServer } from '../../src/ui/server.ts';
import { cloudDefaults } from '../../src/operate/cloud/types.ts';

test('cloud UI configures and disables monitoring, distinguishes pending delivery and stale observations', async () => {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-cloud-ui-')));
  const run = await journal.create({ appPath: journal.dir, domain: 'example.test', inbox: 'owner@example.test', accountId: 'a'.repeat(32), mode: 'live', outbound: false, www: false, analytics: { approved: false, publicPaths: ['/'] }, seo: { approved: false, title: '', description: '' } });
  run.resources.url = 'https://example.test'; run.status = 'LIVE_VERIFIED'; await journal.save(run);
  let deployed = false; let verificationRequested = false; let releasePending = true; const state = cloudDefaults();
  const report = async (): Promise<any> => ({ eligible: true, domain: run.config.domain, recipient: run.config.inbox, status: deployed ? 'DEPLOYED' : 'NOT_DEPLOYED', ...(deployed ? { releasePending, cloud: { ...state, stale: true, scheduleMissing: true, verification: { scheduledCheck: false, notificationVerified: false, operational: false } } } : {}) });
  const cloudController: any = {
    report,
    deploy: async (_id: string, body: any) => { assert.equal(body.authorized, true); deployed = true; state.settings = body; return report(); },
    action: async (_id: string, action: string, body: any) => { if (action === 'configure') state.settings = body; if (action === 'verification') verificationRequested = true; if (action === 'release') releasePending = false; return report(); }
  };
  const { server, origin } = await startServer({ journal, vault: new Vault(journal.dir), provider: () => new MockProvider(journal.dir), cloudController });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await page.waitForFunction(() => document.querySelector('#cloud-status')?.textContent === 'NOT DEPLOYED');
    await page.locator('[name=cloudEnabled]').check(); await page.locator('[name=cloudNotifications]').check(); await page.locator('[name=cloudAuthorized]').check();
    await page.getByRole('button', { name: 'Deploy / update cloud monitor' }).click();
    await page.getByRole('button', { name: 'Refresh cloud status' }).click();
    await page.waitForFunction(() => document.querySelector('#cloud-status')?.textContent?.includes('MISSING OBSERVATIONS'));
    assert.match(await page.locator('#cloud-verification').innerText(), /not yet confirmed/);
    assert.match(await page.locator('#cloud-release').innerText(), /earlier release/);
    await page.getByRole('button', { name: 'Retry release sync' }).click();
    await page.waitForFunction(() => (document.querySelector('#sync-cloud-release') as HTMLButtonElement)?.hidden); assert.equal(releasePending, false);
    await page.getByRole('button', { name: 'Verify notifications on next schedules (2 emails)' }).click();
    await page.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('Verification drill armed')); assert.equal(verificationRequested, true);
    await page.getByRole('button', { name: 'Disable cloud monitoring' }).click();
    await page.waitForFunction(() => document.querySelector('#cloud-status')?.textContent?.includes('Disabled')); assert.equal(state.settings.enabled, false); assert.equal(state.settings.notifications, false);
    await mkdir('test-results', { recursive: true }); await page.locator('#cloud-operate').screenshot({ path: 'test-results/cloud-monitor-ui.png' });
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.deepEqual(errors, []);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
