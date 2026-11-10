import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium, type Browser } from 'playwright';
import { Journal } from '../../src/workflow/journal.ts';

// Real child processes and DPAPI storage; official-provider responses are fixtures.
// All unexpected outbound calls and launch/mutation paths fail this test.
const serverCode = `
import {Journal} from './src/workflow/journal.ts';
import {Vault} from './src/security/tokens.ts';
import {GoogleSearch,READ_SCOPE} from './src/grow/google.ts';
import {startServer} from './src/ui/server.ts';
import {cloudDefaults} from './src/operate/cloud/types.ts';
const j=new Journal(process.env.LAUNCHKIT_REOPEN_TEST_DIR); const unlock=await j.lock();
const vault=new Vault(j.dir); await vault.load();
const json=v=>new Response(JSON.stringify(v));
globalThis.fetch=async url=>{if(String(url)==='https://api.cloudflare.com/client/v4/accounts')return json({success:true,result:[{id:'a'.repeat(32),name:'Test account'}],result_info:{total_pages:1}});throw Error('Unexpected outbound call');};
const google=new GoogleSearch(vault,async(url,init)=>{
 const path=String(url);
 if(path==='https://oauth2.googleapis.com/token')return json({access_token:'reopen-access-fixture',refresh_token:'reopen-refresh-fixture',scope:READ_SCOPE,expires_in:3600,token_type:'Bearer'});
 if(init?.method==='PUT')throw Error('Unexpected sitemap submission');
 if(path.endsWith('/sites'))return json({siteEntry:[{siteUrl:'sc-domain:example.test',permissionLevel:'siteOwner'}]});
 if(path.endsWith('/sitemaps'))return json({sitemap:[]});
 if(path.endsWith('/searchAnalytics/query'))return json({rows:[{clicks:7,impressions:70,ctr:0.1,position:4}]});
 throw Error('Unexpected Google call');
});
const cloud={report:async id=>{const r=await j.load(id);const deployed=!!r.resources.url;return {eligible:deployed,domain:r.config.domain,status:deployed?'DEPLOYED':'NOT_DEPLOYED',...(deployed?{cloud:{...cloudDefaults(),target:{runId:id},verification:{}}}:{})};},deploy:async()=>{throw Error('Unexpected deploy');},action:async()=>{throw Error('Unexpected mutation');}};
const app=await startServer({journal:j,vault,google,cloudController:cloud,provider:()=>{throw Error('Unexpected launch');}});
console.log(app.origin);
process.stdin.resume();process.stdin.on('data',async()=>{app.server.closeAllConnections();app.server.close(async()=>{await unlock();process.exit(0);});});
`;
async function start(dir: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', serverCode], { env: { ...process.env, LAUNCHKIT_REOPEN_TEST_DIR: dir }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const origin = await new Promise<string>((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(Error('Test server did not start')), 15_000);
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    child.once('error', e => { clearTimeout(timer); reject(e); }); child.once('exit', code => { clearTimeout(timer); reject(Error(`Test server exited ${code}`)); });
    child.stderr.on('data', () => { /* No provider output is needed for assertions. */ });
  });
  return { origin, close: async () => { if (child.exitCode !== null) return; const exited = once(child, 'exit'); child.stdin.write('stop'); await exited; } };
}
async function open(browser: Browser, origin: string) {
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto(origin); await page.locator('#grow').waitFor({ state: 'visible' }); return { context, page };
}

test('Connect once, restart process and reopen browser: restore credentials, production selection, Growth and cloud identity', { skip: process.platform !== 'win32' }, async () => {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-reopen-')));
  const production = await journal.create({ appPath: journal.dir, domain: 'example.test', accountId: 'a'.repeat(32), inbox: '', mode: 'live', outbound: false, www: false, seo: { approved: true, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } });
  production.status = 'LIVE_VERIFIED'; production.resources.url = 'https://example.test'; production.steps.seo.status = 'VERIFIED'; await journal.save(production);
  const draft = await journal.create({ ...production.config, accountId: '' }); draft.status = 'BLOCKED'; await journal.save(draft);
  const original = await Promise.all([production, draft].map(r => readFile(journal.path(r.id), 'utf8')));
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); let app = await start(journal.dir);
  try {
    let { context, page } = await open(browser, app.origin);
    assert.equal(await page.locator(`#history [data-run-id="${production.id}"]`).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#refresh-growth').isDisabled(), true); assert.match(await page.locator('#growth-disabled').innerText(), /Connect Google/);
    await page.locator('[name=cloudflare]').fill('reopen-cloudflare-fixture'); await page.getByRole('button', { name: 'Save connections', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#saved-connections')?.textContent?.includes('Cloudflare: saved'));
    await page.getByText('Connect Google Search Console', { exact: true }).click();
    await page.locator('[name=googleClientId]').fill('reopen-fixture.apps.googleusercontent.com'); await page.locator('[name=googleClientSecret]').fill('reopen-client-fixture');
    await page.locator('#connect-google').click(); await page.locator('#google-signin').waitFor({ state: 'visible' });
    const auth = new URL((await page.locator('#google-signin').getAttribute('href'))!);
    await page.goto(`${app.origin}/oauth/google/callback?state=${auth.searchParams.get('state')}&code=reopen-code-fixture`);
    await page.getByRole('link', { name: 'Return to LaunchKit' }).click(); await page.locator('#grow').waitFor({ state: 'visible' });
    await page.locator(`#history [data-run-id="${production.id}"]`).click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#refresh-growth')?.disabled);
    await context.close(); await app.close(); app = await start(journal.dir); ({ context, page } = await open(browser, app.origin));
    assert.match(await page.locator('#saved-connections').innerText(), /Cloudflare: saved.*Google: saved authorization restored/);
    assert.equal(await page.locator('[name=cloudflare]').inputValue(), ''); assert.equal(await page.locator('[name=googleClientSecret]').inputValue(), '');
    assert.equal(await page.locator('#refresh-growth').isEnabled(), true);
    await page.locator('#refresh-growth').click(); await page.locator('#growth-property option[value="sc-domain:example.test"]').waitFor({ state: 'attached' });
    await page.locator('#growth-property').selectOption('sc-domain:example.test'); await page.locator('#select-growth-property').click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#refresh-growth')?.disabled);
    await page.locator('#refresh-growth').click(); await page.waitForFunction(() => document.querySelector('#growth-metrics')?.textContent?.includes('70 impressions'));
    await page.waitForFunction(id => document.querySelector('#cloud-evidence')?.textContent?.includes(id), production.id);
    assert.doesNotMatch(await page.locator('#cloud-status').innerText(), /NOT DEPLOYED/);
    await page.locator(`#history [data-run-id="${draft.id}"]`).click();
    await page.waitForFunction(() => document.querySelector('#growth-disabled')?.textContent?.includes('draft without a bound'));
    assert.equal(await page.locator('#refresh-growth').isDisabled(), true);
    await page.reload(); await page.locator('#grow').waitFor({ state: 'visible' }); assert.equal(await page.locator(`#history [data-run-id="${draft.id}"]`).getAttribute('aria-pressed'), 'true');
    await page.locator(`#history [data-run-id="${production.id}"]`).click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#refresh-growth')?.disabled);
    // GET endpoints cannot change the selection, and foreign-origin writes fail.
    const blocked = await page.evaluate(async id => (await fetch('/api/selection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selectedRunId: id }) })).status, draft.id); assert.equal(blocked, 403);
    await context.close(); await app.close(); app = await start(journal.dir); ({ context, page } = await open(browser, app.origin));
    assert.equal(await page.locator(`#history [data-run-id="${production.id}"]`).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#growth-property').inputValue(), 'sc-domain:example.test'); assert.match(await page.locator('#growth-metrics').innerText(), /70 impressions/);
    assert.equal((await journal.list()).length, 2); assert.deepEqual(await Promise.all([production, draft].map(r => readFile(journal.path(r.id), 'utf8'))), original);
    await writeFile(join(journal.dir, 'ui.json'), JSON.stringify({ selectedRunId: 'deleted' })); await page.reload(); await page.locator('#grow').waitFor({ state: 'visible' });
    assert.equal(await page.locator(`#history [data-run-id="${production.id}"]`).getAttribute('aria-pressed'), 'true');
    await context.close();
  } finally { await browser.close(); await app.close(); }
});
