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

test('M3b UI reads Bing evidence, gates exact submissions, audits public signals and survives reload on mobile', async () => {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-m3b-browser-')));
  const run = await journal.create({ appPath: journal.dir, domain: 'example.test', accountId: 'mock', mode: 'mock', inbox: '', outbound: false, www: false, seo: { approved: true, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } });
  run.resources.url = 'https://example.test'; run.steps.seo.status = 'VERIFIED'; await journal.save(run);
  const { server, origin } = await startServer({ journal, vault: new Vault(journal.dir), provider: () => new MockProvider(journal.dir) });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin); await page.locator('#bing-grow').waitFor({ state: 'visible' }); assert.match(await page.locator('#bing-status').innerText(), /SIMULATION/);
    assert.equal(await page.locator('#prepare-bing').isDisabled(), true);
    await page.locator('#refresh-bing').click(); await page.locator('#bing-property option[value="https://example.test/"]').waitFor({ state: 'attached' });
    await page.locator('#bing-property').selectOption('https://example.test/'); await page.locator('#select-bing').click(); await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#prepare-bing')?.disabled);
    await page.locator('#refresh-bing').click(); await page.waitForFunction(() => document.querySelector('#bing-metrics')?.textContent?.includes('60 impressions'));
    assert.match(await page.locator('#bing-measurement').innerText(), /Web, Chat/);
    await page.locator('#prepare-bing').click(); await page.getByRole('button', { name: 'Decline Bing submission' }).click(); await page.waitForFunction(() => !document.querySelector('#bing-approvals button'));
    await page.locator('#prepare-bing').click(); await page.getByRole('button', { name: 'Approve exact Bing sitemap submission' }).waitFor(); assert.match(await page.locator('#bing-approvals').innerText(), /https:\/\/example.test\/sitemap.xml/);
    await page.getByRole('button', { name: 'Approve exact Bing sitemap submission' }).click(); await page.waitForFunction(() => document.querySelector('#bing-sitemaps')?.textContent?.includes('Pending'));
    await page.locator('#refresh-audit').click(); await page.waitForFunction(() => document.querySelector('#audit-findings')?.textContent?.includes('content-purpose'));
    assert.match(await page.locator('#audit-limits').innerText(), /separate approval/);
    await page.reload(); await page.locator('#bing-grow').waitFor({ state: 'visible' }); assert.equal(await page.locator('#bing-property').inputValue(), 'https://example.test/');
    assert.match(await page.locator('#audit-findings').innerText(), /content-audience/);
    await page.locator('#audit-details summary').click(); assert.match(await page.locator('#audit-observations').innerText(), /robots-directives/);
    for (const [id, name] of [['download-bing', 'launchkit-bing-growth.json'], ['download-audit', 'launchkit-discoverability.json']]) { const download = page.waitForEvent('download'); await page.locator(`#${id}`).click(); assert.equal((await download).suggestedFilename(), name); }
    await mkdir('test-results', { recursive: true }); await page.locator('#bing-grow').screenshot({ path: 'test-results/launchkit-bing.png' });
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#bing-grow').screenshot({ path: 'test-results/launchkit-bing-mobile.png' }); await page.locator('#discoverability').screenshot({ path: 'test-results/launchkit-audit-mobile.png' }); assert.deepEqual(errors, []);
    // An already-running M3a server may serve updated assets from disk. Missing
    // optional capabilities must not stop saved-business or Google rendering.
    await page.route('**/api/status', async route => {
      const response = await route.fetch(); const status = await response.json(); delete status.bing;
      await route.fulfill({ response, json: status });
    });
    let unsupportedRequests = 0;
    await page.route(/\/grow\/(bing|audit)(?:\/|$)/, async route => { unsupportedRequests++; await route.fulfill({ status: 404, json: { error: 'Not found' } }); });
    await page.reload(); await page.locator('#grow').waitFor({ state: 'visible' });
    assert.match(await page.locator('#history').innerText(), /example.test/);
    assert.match(await page.locator('#notice').innerText(), /Restart LaunchKit/);
    assert.equal(await page.locator('#bing-grow').isHidden(), true); assert.equal(await page.locator('#discoverability').isHidden(), true);
    assert.equal(unsupportedRequests, 0); assert.deepEqual(errors, []);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
