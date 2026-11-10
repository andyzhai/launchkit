import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { Journal } from '../../src/workflow/journal.ts';
import { Vault } from '../../src/security/tokens.ts';
import { MockProvider } from '../../src/adapters/mock.ts';
import { startServer } from '../../src/ui/server.ts';
test('A01/A02 browser Launch button completes simulation and reload restores report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launchkit-browser-')); const journal = new Journal(dir);
  const { server, origin } = await startServer({ journal, vault: new Vault(dir), provider: () => new MockProvider(dir) });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } }); await page.goto(origin);
    await page.locator('[name=appPath]').fill(resolve('tests/fixtures/vite-app')); await page.locator('[name=domain]').fill('example.test'); await page.locator('[name=mode]').selectOption('mock');
    await page.locator('summary').first().click();
    await page.getByRole('button', { name: 'Launch ↗', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#run-status')?.textContent?.includes('SIMULATION — LIVE VERIFIED'), { timeout: 15_000 });
    const run = (await journal.list())[0]; assert.equal(run.status, 'LIVE_VERIFIED'); assert.equal(run.config.domain, 'example.test');
    await page.reload(); await page.waitForFunction(() => document.querySelector('#run-status')?.textContent?.includes('LIVE VERIFIED'));
    await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/launchkit-ui.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', { name: 'Resume / recheck' }).click();
    await page.waitForFunction(() => document.querySelector('#run-status')?.textContent?.includes('LIVE VERIFIED'));
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
