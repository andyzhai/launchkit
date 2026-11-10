import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Journal } from '../../src/workflow/journal.ts';
import { Vault } from '../../src/security/tokens.ts';
import { MockProvider } from '../../src/adapters/mock.ts';
import { startServer } from '../../src/ui/server.ts';
import { BusinessSelection } from '../../src/ui/selection.ts';

test('Title improvement browser: exact preview, replacement approval, simulation verification, reload and mobile isolation', async () => {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-improvement-browser-')));
  const config = { appPath: journal.dir, accountId: 'fixture', mode: 'mock' as const, inbox: '', outbound: false, www: false, seo: { approved: true, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } };
  const first = await journal.create({ ...config, domain: 'first.test' }); first.resources.url = 'https://first.test'; first.status = 'LIVE_VERIFIED'; await journal.save(first);
  const second = await journal.create({ ...config, domain: 'second.test' }); second.resources.url = 'https://second.test'; second.status = 'LIVE_VERIFIED'; await journal.save(second);
  await new BusinessSelection(journal).select(first.id);
  const { server, origin } = await startServer({ journal, vault: new Vault(journal.dir), provider: () => new MockProvider(journal.dir) });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin); await page.locator('#refresh-audit').click();
    await page.waitForFunction(() => document.querySelector('#audit-status')?.textContent?.includes('Saved observations'));
    await page.locator('#improvement-title').fill('First proposed name'); await page.locator('#prepare-improvement').click();
    await page.getByRole('button', { name: 'Approve exact preview and simulate publish' }).waitFor();
    await page.locator('#improvement-title').fill('Final proposed name'); assert.equal(await page.getByRole('button', { name: 'Approve exact preview and simulate publish' }).isDisabled(), true); await page.locator('#prepare-improvement').click();
    await page.waitForFunction(() => document.querySelector('#improvement-history')?.textContent?.includes('STALE'));
    assert.equal(await page.getByRole('button', { name: 'Approve exact preview and simulate publish' }).count(), 1);
    assert.match(await page.locator('#improvement-history').innerText(), /Before: <title>Simulation<\/title>[\s\S]*After:  <title>Final proposed name<\/title>/);
    await mkdir('test-results', { recursive: true });
    await page.locator('#discoverability').screenshot({ path: 'test-results/launchkit-improvement-desktop.png' });
    await page.getByRole('button', { name: 'Approve exact preview and simulate publish' }).click();
    await page.waitForFunction(() => document.querySelector('#improvement-history h4')?.textContent?.includes('PUBLISHED'));
    await page.reload(); await page.getByRole('button', { name: 'Verify public release and audit (read-only)', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#improvement-history h4')?.textContent?.includes('VERIFIED'));
    await page.locator('#improvement-history details').first().locator('summary').click(); assert.match(await page.locator('#improvement-history').innerText(), /CORRECTED/);
    await page.locator(`#history button[data-run-id="${second.id}"]`).click();
    await page.waitForFunction(() => document.querySelector('#audit-title')?.textContent?.includes('second.test'));
    assert.equal(await page.locator('#improvement-title').inputValue(), ''); assert.equal(await page.locator('#improvement-history').innerText(), '');
    await page.locator(`#history button[data-run-id="${first.id}"]`).click(); await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
    await page.waitForFunction(() => document.querySelector('#improvement-history')?.textContent?.includes('VERIFIED'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#discoverability').screenshot({ path: 'test-results/launchkit-improvement-mobile.png' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
