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

test('social UI edits and declines drafts, previews exact approvals, publishes once, persists history and fits mobile', async () => {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-social-browser-')));
  const run = await journal.create({ appPath: journal.dir, domain: 'example.test', accountId: 'mock', mode: 'mock', inbox: '', outbound: false, www: false, seo: { approved: true, title: 'Example business', description: 'A useful application.' }, analytics: { approved: false, publicPaths: ['/'] } });
  run.resources.url = 'https://example.test'; await journal.save(run);
  const { server, origin } = await startServer({ journal, vault: new Vault(journal.dir), provider: () => new MockProvider(journal.dir) });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin); await page.locator('#social-grow').waitFor({ state: 'visible' }); assert.match(await page.locator('#social-status').innerText(), /SIMULATION/);
    await page.locator('#template-social').click(); await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('#social-text')?.value.includes('Example business'));
    await page.locator('#social-text').fill('An edited announcement\nhttps://example.test/'); await page.locator('#save-social').click(); await page.getByRole('button', { name: 'Prepare exact post approval' }).click();
    await page.getByRole('button', { name: 'Decline post', exact: true }).click(); await page.waitForFunction(() => document.querySelector('#social-drafts')?.textContent?.includes('DECLINED'));
    await page.getByRole('button', { name: 'Prepare exact post approval' }).click(); await page.getByRole('button', { name: 'Approve and publish exact post' }).waitFor();
    assert.match(await page.locator('#social-drafts').innerText(), /Exact destination: @simulation@mastodon.social/);
    await page.getByRole('button', { name: 'Edit draft', exact: true }).click(); await page.locator('#social-text').fill('Final approved announcement\nhttps://example.test/'); await page.locator('#save-social').click();
    await page.waitForFunction(() => !document.querySelector('#social-drafts')?.textContent?.includes('Exact destination:'));
    await page.getByRole('button', { name: 'Prepare exact post approval' }).click(); await page.getByRole('button', { name: 'Approve and publish exact post' }).click();
    await page.waitForFunction(() => document.querySelector('#social-drafts h4')?.textContent?.includes('ACCEPTED'));
    assert.equal(await page.locator('#social-editor-title').innerText(), 'New draft');
    assert.equal(await page.getByRole('button', { name: 'Approve and publish exact post' }).count(), 0);
    await page.getByRole('button', { name: 'Reconcile publication (read only)' }).click(); await page.waitForFunction(() => document.querySelector('#social-drafts h4')?.textContent?.includes('OBSERVED'));
    await page.reload(); await page.locator('#social-grow').waitFor({ state: 'visible' }); assert.match(await page.locator('#social-drafts').innerText(), /Final approved announcement/);
    const download = page.waitForEvent('download'); await page.locator('#download-social').click(); assert.equal((await download).suggestedFilename(), 'launchkit-social.json');
    await mkdir('test-results', { recursive: true }); await page.locator('#social-grow').screenshot({ path: 'test-results/launchkit-social.png' });
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#social-grow').screenshot({ path: 'test-results/launchkit-social-mobile.png' }); assert.deepEqual(errors, []);
    await page.route('**/api/status', async route => { const response = await route.fetch(); const status = await response.json(); delete status.social; await route.fulfill({ response, json: status }); });
    await page.reload(); await page.locator('#grow').waitFor({ state: 'visible' }); assert.equal(await page.locator('#social-grow').isHidden(), true); assert.deepEqual(errors, []);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
