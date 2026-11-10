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

test('Revised M3c fixtures: prioritized issues, separate training controls, explicit reads, business switching and mobile reload', async () => {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-discovery-browser-')));
  const config = { appPath: journal.dir, accountId: 'fixture', mode: 'live' as const, inbox: '', outbound: false, www: false, seo: { approved: true, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } };
  const first = await journal.create({ ...config, domain: 'fixture.test' }); first.resources.url = 'https://fixture.test'; await journal.save(first);
  const second = await journal.create({ ...config, domain: 'second.test', mode: 'mock' }); second.resources.url = 'https://second.test'; await journal.save(second);
  await new BusinessSelection(journal).select(first.id);
  let reads = 0;
  const { server, origin } = await startServer({ journal, vault: new Vault(journal.dir), provider: () => new MockProvider(journal.dir), auditTools: {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    render: async () => ({ status: 'AVAILABLE', title: 'Fixture product', description: 'A fixture tool.', headings: [{ level: 1, text: 'Fixture product' }], text: 'A tool for creating reports.\nDesigned for teams.\nOnly supports sample inputs.' }),
    read: async (_domain, path) => { reads++; return { status: 200, type: path === '/' ? 'text/html' : path === '/robots.txt' ? 'text/plain' : 'text/xml', body: path === '/' ? '<html><head><title>Fixture</title><link rel="canonical" href="https://fixture.test/"></head><body><h1>Fixture product</h1><p>A tool for creating reports.</p></body></html>' : path === '/robots.txt' ? 'User-agent: *\nAllow: /\nUser-agent: OAI-SearchBot\nDisallow: /\nUser-agent: GPTBot\nDisallow: /\nSitemap: https://fixture.test/sitemap.xml' : '<urlset><url><loc>https://fixture.test/</loc></url></urlset>' }; }
  } });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin); await page.locator('#discoverability').waitFor({ state: 'visible' });
    assert.equal(reads, 0); assert.equal(await page.locator('#refresh-audit').isEnabled(), true);
    await page.locator('#refresh-audit').click();
    await page.waitForFunction(() => document.querySelector('#audit-findings')?.textContent?.includes('OAI-SearchBot'));
    assert.equal(reads, 3);
    assert.match(await page.locator('#audit-findings li').first().innerText(), /P1 · BLOCKED.*OAI-SearchBot/);
    assert.match(await page.locator('#audit-findings').innerText(), /Why it may matter:.*[\s\S]*Human review:/);
    assert.match(await page.locator('#audit-limits').innerText(), /initial HTML and restricted JavaScript-rendered/);
    assert.match(await page.locator('#audit-findings').innerText(), /Heuristic assessment/);
    assert.doesNotMatch(await page.locator('#audit-findings').innerText(), /GPTBot/);
    await page.locator('#audit-details summary').click();
    assert.match(await page.locator('#audit-observations').innerText(), /BLOCKED.*GPTBot · Training control/);
    for (const label of ['Initial HTML content', 'JavaScript-rendered content', 'Search crawler access policy', 'Model-training crawler policy']) assert.match(await page.locator('#audit-observations').innerText(), new RegExp(label));
    await mkdir('test-results', { recursive: true });
    await page.locator('#discoverability').screenshot({ path: 'test-results/launchkit-discoverability-desktop.png' });
    await page.locator(`#history button[data-run-id="${second.id}"]`).click();
    await page.waitForFunction(() => document.querySelector('#audit-title')?.textContent?.includes('second.test'));
    assert.match(await page.locator('#audit-status').innerText(), /SIMULATION/);
    assert.doesNotMatch(await page.locator('#audit-findings').innerText(), /OAI-SearchBot/);
    await page.locator(`#history button[data-run-id="${first.id}"]`).click();
    await page.waitForFunction(() => document.querySelector('#audit-findings')?.textContent?.includes('OAI-SearchBot'));
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
    await page.waitForFunction(() => document.querySelector('#audit-findings')?.textContent?.includes('OAI-SearchBot'));
    assert.equal(reads, 3); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.match(await page.locator('#audit-findings').innerText(), /https:\/\/fixture.test\/robots.txt/);
    await page.locator('#discoverability').screenshot({ path: 'test-results/launchkit-discoverability-mobile.png' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
