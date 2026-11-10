import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { workerSource } from '../../src/adapters/wrangler.ts';
import type { LaunchConfig } from '../../src/workflow/types.ts';
test('A13 actual browser payload contains no parent content, filename, query, hash or referrer', async () => {
  const config: LaunchConfig = { appPath: '/', domain: 'business.test', accountId: '', inbox: '', mode: 'mock', www: false, outbound: false, seo: { approved: false, title: '', description: '' }, analytics: { approved: true, publicPaths: ['/'] } };
  const worker = (await import(`data:text/javascript;base64,${Buffer.from(workerSource(config, 'release', '0'.repeat(32))).toString('base64')}`)).default;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext(); const payloads: any[] = [];
    await context.route('https://business.test/**', async route => {
      const response = await worker.fetch(new Request(route.request().url()), { ASSETS: { fetch: async () => new Response('<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; connect-src \'self\'; frame-src \'self\'"></head><body>PRIVATE_CONTENT private-file.pdf secret-hash<script src="/__launchkit/page.js" defer></script></body></html>', { headers: { 'Content-Type': 'text/html' } }) } });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    await context.route('https://static.cloudflareinsights.com/**', route => route.fulfill({ contentType: 'text/javascript', body: `let parentReadable=false;try{parentReadable=!!parent.document.body}catch{};navigator.sendBeacon('https://cloudflareinsights.com/cdn-cgi/rum',JSON.stringify({location:location.href,referrer:document.referrer,parentReadable,title:document.title}));` }));
    await context.route('https://cloudflareinsights.com/**', async route => { if (route.request().method() === 'POST') payloads.push(JSON.parse(route.request().postData()!)); await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' } }); });
    const page = await context.newPage(); await page.goto('https://business.test/');
    await page.waitForFunction(() => !!document.querySelector('iframe'));
    await page.waitForTimeout(500); assert.equal(payloads.length, 1); assert.equal(payloads[0].parentReadable, false); assert.equal(payloads[0].referrer, ''); assert.equal(payloads[0].location, 'https://business.test/__launchkit/metrics/0');
    assert.ok(!JSON.stringify(payloads).match(/PRIVATE_CONTENT|private-file|secret-hash/));
    for (const suffix of ['?private-query', '#private-hash', 'private-path']) { await page.goto(`https://business.test/${suffix}`); await page.waitForTimeout(200); assert.equal(await page.locator('iframe').count(), 0); }
    assert.equal(payloads.length, 1);
  } finally { await browser.close(); }
});
