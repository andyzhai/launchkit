import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cloudflare } from '../src/adapters/cloudflare.ts';
import { ensureWebAnalytics } from '../src/adapters/web-analytics.ts';
import { analyticsBlockers, inspectWebAnalytics } from '../src/verification/web-analytics.ts';
import { Journal } from '../src/workflow/journal.ts';
import { Runner } from '../src/workflow/runner.ts';
import { LiveProvider } from '../src/adapters/live.ts';
import { Vault } from '../src/security/tokens.ts';
import { startServer } from '../src/ui/server.ts';

const accountId = 'a'.repeat(32); const host = 'example.test';
const site = (overrides = {}) => ({ site_tag: 'b'.repeat(32), site_token: 'c'.repeat(32), auto_install: true, lite: true,
  ruleset: { id: 'ruleset', zone_tag: 'zone', enabled: true },
  rules: [{ id: 'rule', host, inclusive: true, is_paused: false, paths: ['*'] }], ...overrides });
const envelope = (result: unknown, status = 200, info?: unknown) => new Response(JSON.stringify({ success: status < 400, result, result_info: info, errors: status >= 400 ? [{ code: 10000, message: 'secret-api-token' }] : [] }), { status });
async function fixture() {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-analytics-')));
  const run = await journal.create({ appPath: journal.dir, mode: 'live', domain: host, accountId, inbox: '', outbound: false, www: false,
    seo: { approved: false, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } });
  run.resources = { zone: { id: 'zone' }, url: `https://${host}`, release: 'original', worker: 'lk-worker' }; run.status = 'LIVE_VERIFIED'; await journal.save(run);
  const state = { sites: [] as any[], calls: [] as { path: string; method: string; body: any }[], proxied: true, fail: '', failStatus: 403, ambiguous: false, wildcard: false, mismatch: false, page2: false, omitRules: false };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method || 'GET'; const path = url.pathname.replace('/client/v4', '');
    if (url.hostname === host) return new Response('<html>app</html>', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-transform' } });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined; state.calls.push({ path, method, body });
    if (state.fail === `${method} ${path}`) return envelope(null, state.failStatus);
    if (path === '/zones/zone') return envelope({ id: 'zone', name: host, status: 'active', account: { id: accountId } });
    if (path.endsWith('/dns_records')) return envelope([{ name: host, type: 'AAAA', proxied: state.proxied }]);
    if (path.endsWith('/list')) return envelope(state.page2 && url.searchParams.get('page') === '1' ? [] : state.sites.map(s => state.omitRules ? { ...s, rules: undefined } : s), 200, { total_pages: state.page2 ? 2 : 1 });
    if (method === 'POST') {
      assert.equal(body.auto_install, false); assert.equal(body.host, host); assert.equal(body.zone_tag, 'zone');
      const created = site({ auto_install: false }); if (state.wildcard) created.rules[0].host = '*'; state.sites.push(created);
      if (state.ambiguous) throw Error('lost response secret-api-token');
      return envelope(created);
    }
    const current = state.sites[0];
    if (method === 'PUT' && path.includes('/rule/')) { Object.assign(current.rules[0], body); return envelope(current.rules[0]); }
    if (method === 'PUT') { assert.deepEqual(body, { auto_install: true, enabled: true, zone_tag: 'zone' }); current.auto_install = true; current.ruleset.enabled = true; }
    return envelope(state.mismatch ? { ...current, rules: [{ host: 'unrelated.test' }] } : current);
  };
  const cf = new Cloudflare(accountId, { cloudflare: 'secret-api-token' }, transport);
  const provider = { step: async () => ({}) }; const runner = new Runner(journal, provider); const ctx = runner.context(run);
  const inspect = async () => ({ beaconPresent: true, browserTrackingVerified: false, blockers: ['Tracking unverified.'], checkedAt: new Date().toISOString() });
  return { journal, run, ctx, cf, state, transport, inspect, runner };
}

test('registers a new exact-host site, verifies configuration, and repeated setup never duplicates it', async () => {
  const t = await fixture();
  const first = await ensureWebAnalytics(t.ctx, t.cf, t.inspect); const again = await ensureWebAnalytics(t.ctx, t.cf, t.inspect);
  assert.equal(first.status, 'enabled'); assert.equal(again.siteId, first.siteId); assert.equal(first.configurationVerified, true);
  assert.equal(first.browserTrackingVerified, false); assert.match(first.message, /Browser tracking unverified/); assert.match(first.actionURL, /web-analytics\/overview\?siteTag=/);
  assert.equal(t.state.calls.filter(c => c.method === 'POST').length, 1); assert.equal(t.state.calls.filter(c => c.method === 'PUT').length, 1);
  assert.ok(!JSON.stringify(first).includes('site_token')); assert.ok(!JSON.stringify(first).includes('secret-api-token'));
});
test('reuses a paginated existing site without mutation and preserves rules and regional settings', async () => {
  const t = await fixture(); t.state.sites = [site()]; t.state.page2 = true; const before = structuredClone(t.state.sites);
  const result = await ensureWebAnalytics(t.ctx, t.cf, t.inspect);
  assert.equal(result.status, 'enabled'); assert.deepEqual(t.state.sites, before); assert.ok(t.state.calls.every(c => c.method === 'GET'));
});
test('real Cloudflare list summaries without rules are resolved through detail GET before reuse', async () => {
  const t = await fixture(); t.state.sites = [site()]; t.state.omitRules = true;
  assert.equal((await ensureWebAnalytics(t.ctx, t.cf, t.inspect)).status, 'enabled');
  assert.ok(t.state.calls.every(c => c.method === 'GET')); assert.deepEqual(t.run.operations, {});
});
test('incomplete detail rules cannot trigger a duplicate registration', async () => {
  const t = await fixture(); t.state.sites = [site({ rules: undefined })];
  assert.equal((await ensureWebAnalytics(t.ctx, t.cf, t.inspect)).status, 'attention');
  assert.ok(t.state.calls.every(c => c.method === 'GET'));
});
test('enables a disabled exact-host site with only the required fields', async () => {
  const t = await fixture(); t.state.sites = [site({ auto_install: false, ruleset: { id: 'ruleset', zone_tag: 'zone', enabled: false } })];
  assert.equal((await ensureWebAnalytics(t.ctx, t.cf, t.inspect)).status, 'enabled'); assert.equal(t.state.sites[0].lite, true);
  assert.equal(t.state.calls.filter(c => c.method === 'POST').length, 0);
});
test('narrows newly created wildcard defaults before enabling automatic installation', async () => {
  const t = await fixture(); t.state.wildcard = true;
  assert.equal((await ensureWebAnalytics(t.ctx, t.cf, t.inspect)).status, 'enabled');
  const writes = t.state.calls.filter(c => c.method !== 'GET'); assert.ok(writes[1].path.includes('/rule/')); assert.equal(writes[1].body.host, host);
});
test('preserves existing wildcard, unrelated, paused, and duplicate configurations without writes', async () => {
  for (const sites of [[site({ rules: [{ host: '*' }] })], [site({ rules: [{ host: 'shop.example.test' }] })], [site({ rules: [{ host, inclusive: true, is_paused: true }] })], [site(), site()]]) {
    const t = await fixture(); t.state.sites = sites; assert.equal((await ensureWebAnalytics(t.ctx, t.cf, t.inspect)).status, 'attention');
    assert.ok(t.state.calls.every(c => c.method === 'GET'));
  }
});
test('rechecks preserve later user changes to a rule even when LaunchKit originally created the site', async () => {
  for (const wildcard of [true, false]) {
  const t = await fixture(); t.state.wildcard = wildcard;
  await ensureWebAnalytics(t.ctx, t.cf, t.inspect);
  const count = t.state.calls.filter(c => c.method !== 'GET').length;
  t.state.sites[0].auto_install = false; t.state.sites[0].rules[0].host = '*';
  assert.equal((await ensureWebAnalytics(t.ctx, t.cf, t.inspect)).status, 'attention');
  t.state.sites[0].rules[0].host = host; t.state.sites[0].rules[0].is_paused = true;
  assert.equal((await ensureWebAnalytics(t.ctx, t.cf, t.inspect)).status, 'attention');
  assert.equal(t.state.calls.filter(c => c.method !== 'GET').length, count);
  }
});
test('reports non-proxied and unsupported hostnames without registering analytics', async () => {
  const t = await fixture(); t.state.proxied = false;
  const result = await ensureWebAnalytics(t.ctx, t.cf, t.inspect); assert.equal(result.status, 'unsupported'); assert.match(result.message, /no Cloudflare-proxied/);
  assert.ok(t.state.calls.every(c => c.method === 'GET')); t.run.resources.url = undefined;
  assert.equal((await ensureWebAnalytics(t.ctx, t.cf, t.inspect)).status, 'unsupported');
});
test('read and write denials name the required permission and never leak provider error bodies', async () => {
  for (const [method, path, permission] of [['GET', '/list', 'Account Settings Read'], ['POST', '', 'Account Settings Write']]) {
    const t = await fixture(); t.state.fail = `${method} /accounts/${accountId}/rum/site_info${path}`;
    const result = await ensureWebAnalytics(t.ctx, t.cf, t.inspect); assert.equal(result.status, 'attention'); assert.equal(result.requiredPermission, permission);
    assert.match(result.message, /selected account/); assert.ok(!JSON.stringify(result).includes('secret-api-token'));
  }
});
test('an ambiguous create is reconciled, and a hidden unresolved site never causes a second POST', async () => {
  const t = await fixture(); t.state.ambiguous = true;
  assert.equal((await ensureWebAnalytics(t.ctx, t.cf, t.inspect)).status, 'attention');
  const created = t.state.sites; t.state.sites = [];
  assert.match((await ensureWebAnalytics(t.ctx, t.cf, t.inspect)).message, /unresolved outcome/);
  t.state.sites = created; assert.equal((await ensureWebAnalytics(t.ctx, t.cf, t.inspect)).status, 'enabled');
  assert.equal(t.state.calls.filter(c => c.method === 'POST').length, 1);
});
test('incorrect hostname in detail response is never reported enabled', async () => {
  const t = await fixture(); t.state.sites = [site()]; t.state.mismatch = true;
  const result = await ensureWebAnalytics(t.ctx, t.cf, t.inspect); assert.equal(result.configurationVerified, false); assert.equal(result.status, 'attention');
});
test('HTTP probes detect no-transform, header/meta CSP and absent beacon separately from configuration', async () => {
  const blockers = analyticsBlockers(new Headers({ 'Cache-Control': 'public, no-transform', 'Content-Security-Policy': "script-src 'self'; connect-src 'none'" }), '', `https://${host}`);
  assert.equal(blockers.length, 3);
  assert.equal(analyticsBlockers(new Headers(), `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">`, `https://${host}`).length, 1);
  assert.equal(analyticsBlockers(new Headers({ 'Content-Security-Policy': "script-src https://static.cloudflareinsights.com; connect-src 'self'" }), '', `https://${host}`).length, 0);
  const t = await fixture(); const result = await inspectWebAnalytics(`https://${host}`, undefined, t.transport);
  assert.equal(result.beaconPresent, false); assert.equal(result.browserTrackingVerified, false); assert.match(result.blockers.join(' '), /no-transform/);
});
test('live workflow defaults to analytics despite legacy opt-out and API failure cannot fail application deployment', async mock => {
  const t = await fixture(); t.state.fail = `POST /accounts/${accountId}/rum/site_info`; t.state.failStatus = 503;
  mock.mock.method(globalThis, 'fetch', t.transport);
  const vault = new Vault(t.journal.dir); vault.values.cloudflare = 'secret-api-token'; const live = new LiveProvider(t.journal.dir, vault);
  const runner = new Runner(t.journal, { step: (name, ctx) => name === 'analytics' ? live.step(name, ctx) : Promise.resolve({ checked: name }) });
  const result = await runner.execute(t.run.id);
  assert.equal(result.status, 'LIVE_PARTIALLY_CONFIGURED'); assert.equal(result.steps.verify.status, 'VERIFIED'); assert.equal(result.steps.binding.status, 'VERIFIED');
  assert.equal(result.steps.analytics.status, 'WAITING_USER'); assert.equal(result.resources.release, 'original');
});
test('existing-deployment API uses saved credentials, authenticates requests and only runs analytics', async mock => {
  const t = await fixture(); const nativeFetch = globalThis.fetch;
  mock.mock.method(globalThis, 'fetch', ((input: any, init: any) => new URL(String(input)).hostname === '127.0.0.1' ? nativeFetch(input, init) : t.transport(input, init)) as typeof fetch);
  const vault = new Vault(t.journal.dir); vault.values.cloudflare = 'secret-api-token'; const live = new LiveProvider(t.journal.dir, vault); const visited: string[] = [];
  const { server, origin } = await startServer({ journal: t.journal, vault, provider: () => ({ step: (name, ctx) => { visited.push(name); return live.step(name, ctx); } }) });
  try {
    const page = await fetch(origin); const html = await page.text();
    assert.match(html, /configure-analytics/);
    const headers = { Cookie: page.headers.get('set-cookie')!.split(';')[0], 'X-LaunchKit-Token': html.match(/name="launchkit-session" content="([^"]+)"/)![1], 'Content-Type': 'application/json', Origin: origin };
    const path = `${origin}/api/runs/${t.run.id}/analytics`;
    assert.equal((await fetch(path, { method: 'POST', body: '{}' })).status, 403);
    for (let i = 0; i < 2; i++) { const res = await fetch(path, { method: 'POST', headers, body: '{}' }); assert.equal(res.status, 200); const step = await res.json(); assert.equal(step.status, 'VERIFIED'); assert.equal(step.evidence.configurationVerified, true); assert.equal(step.evidence.browserTrackingVerified, false); }
    assert.deepEqual(visited, ['analytics', 'analytics']); const saved = await t.journal.load(t.run.id); assert.equal(saved.resources.release, 'original'); assert.equal(saved.status, 'LIVE_VERIFIED');
    assert.equal(t.state.calls.filter(c => c.method === 'POST').length, 1);
    assert.ok(!(await readFile(t.journal.path(t.run.id), 'utf8')).includes('secret-api-token'));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
