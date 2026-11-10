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

test('Growth UI discovers, selects, reports, approves exact sitemap, restores evidence and fits mobile', async () => {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-grow-browser-')));
  const run = await journal.create({ appPath: journal.dir, domain: 'example.test', accountId: 'mock', inbox: '', mode: 'mock', outbound: false, www: false, seo: { approved: true, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } });
  run.resources.url = 'https://example.test'; run.steps.seo.status = 'VERIFIED'; run.status = 'LIVE_VERIFIED'; await journal.save(run);
  const { server, origin } = await startServer({ journal, vault: new Vault(journal.dir), provider: () => new MockProvider(journal.dir) });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin); await page.locator('#grow').waitFor({ state: 'visible' }); assert.match(await page.locator('#growth-status').innerText(), /SIMULATION/);
    await page.locator('#refresh-growth').click(); await page.locator('#growth-property option[value="https://example.test/"]').waitFor({ state: 'attached' });
    await page.locator('#growth-property').selectOption('https://example.test/'); await page.locator('#select-growth-property').click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#prepare-sitemap')?.disabled);
    await page.locator('#refresh-growth').click(); await page.waitForFunction(() => document.querySelector('#growth-metrics')?.textContent?.includes('240 impressions'));
    assert.match(await page.locator('#growth-indexing').innerText(), /UNAVAILABLE/);
    await page.locator('#prepare-sitemap').click(); await page.getByRole('button', { name: 'Approve exact sitemap submission' }).waitFor();
    assert.match(await page.locator('#growth-approvals').innerText(), /https:\/\/example.test\/sitemap.xml/);
    await page.getByRole('button', { name: 'Decline sitemap submission' }).click(); await page.waitForFunction(() => !document.querySelector('#growth-approvals button'));
    await page.locator('#prepare-sitemap').click(); await page.getByRole('button', { name: 'Approve exact sitemap submission' }).click();
    await page.waitForFunction(() => document.querySelector('#growth-sitemaps')?.textContent?.includes('PROCESSING PENDING'));
    await page.reload(); await page.locator('#grow').waitFor({ state: 'visible' }); assert.equal(await page.locator('#growth-property').inputValue(), 'https://example.test/');
    assert.match(await page.locator('#growth-metrics').innerText(), /12 clicks/);
    const download = page.waitForEvent('download'); await page.locator('#download-growth').click(); assert.equal((await download).suggestedFilename(), 'launchkit-growth.json');
    await mkdir('test-results', { recursive: true }); await page.locator('#grow').screenshot({ path: 'test-results/launchkit-grow.png' });
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#grow').screenshot({ path: 'test-results/launchkit-grow-mobile.png' }); assert.deepEqual(errors, []);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
