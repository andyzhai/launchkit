import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { inspectWebAnalytics } from '../../src/verification/web-analytics.ts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../../src/workflow/journal.ts';
import { Vault } from '../../src/security/tokens.ts';
import { startServer } from '../../src/ui/server.ts';

test('automatic analytics browser verification requires script load and a successful same-site collection for the correct token', async t => {
  const token = 'a'.repeat(32); const url = 'https://analytics.example.test';
  const html = '<html><body><script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script></body></html>';
  const launch = chromium.launch.bind(chromium);
  for (const correct of [true, false]) {
    const browser = await launch({ channel: 'chrome', headless: true });
    const newPage = browser.newPage.bind(browser);
    t.mock.method(chromium, 'launch', async () => browser);
    t.mock.method(browser, 'newPage', async (options: Parameters<typeof browser.newPage>[0]) => {
      const page = await newPage(options);
      await page.route('**/*', async route => {
        const target = new URL(route.request().url());
        if (target.hostname === 'static.cloudflareinsights.com') return route.fulfill({ contentType: 'text/javascript', body: `navigator.sendBeacon('/cdn-cgi/rum', JSON.stringify({siteToken:'${correct ? token : 'b'.repeat(32)}'}));` });
        if (target.origin === url && target.pathname === '/cdn-cgi/rum') return route.fulfill({ status: 204 });
        if (target.origin === url && target.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
        return route.abort();
      });
      return page;
    });
    const result = await inspectWebAnalytics(url, token, async () => new Response(html, { headers: { 'Content-Type': 'text/html' } }));
    assert.equal(result.beaconPresent, true); assert.equal(result.browserTrackingVerified, correct);
    t.mock.restoreAll();
  }
});

test('existing-deployment UI displays enabled configuration, unverified tracking and dashboard link without launching', async () => {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-analytics-ui-')));
  const run = await journal.create({ appPath: journal.dir, domain: 'example.test', accountId: 'a'.repeat(32), inbox: '', mode: 'live', outbound: false, www: false,
    seo: { approved: false, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } });
  run.resources = { url: 'https://example.test', zone: { id: 'zone' }, release: 'original' }; run.status = 'LIVE_VERIFIED'; await journal.save(run);
  const visited: string[] = []; const dashboard = `https://dash.cloudflare.com/${run.config.accountId}/web-analytics/overview?siteTag=site`;
  const { server, origin } = await startServer({ journal, vault: new Vault(journal.dir), provider: () => ({ step: async name => {
    visited.push(name); return { status: 'enabled', configurationVerified: true, browserTrackingVerified: false, message: 'Cloudflare Web Analytics: Enabled. Browser tracking unverified. CSP may block the beacon.', actionURL: dashboard };
  } }) });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage(); await page.goto(origin);
    await page.locator('#configure-analytics').click();
    await page.waitForFunction(() => document.querySelector('#steps')?.textContent?.includes('Cloudflare Web Analytics: Enabled'));
    const step = page.locator('#steps li').filter({ hasText: 'Cloudflare Web Analytics: Enabled' });
    assert.match(await step.innerText(), /Browser tracking unverified/);
    assert.equal(await step.locator('a').getAttribute('href'), dashboard);
    assert.deepEqual(visited, ['analytics']); assert.equal((await journal.load(run.id)).resources.release, 'original');
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
