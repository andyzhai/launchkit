import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Journal } from '../src/workflow/journal.ts';
import { Vault } from '../src/security/tokens.ts';
import { GoogleSearch, READ_SCOPE, WRITE_SCOPE, searchWindow } from '../src/grow/google.ts';
import { Growth, MockSearch, covers } from '../src/grow/controller.ts';
import { clean } from '../src/security/redaction.ts';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function memoryVault() { const vault = new Vault('unused'); vault.connect = async input => { vault.values = { ...vault.values, ...input }; }; return vault; }
const client = { clientId: 'launchkit-test.apps.googleusercontent.com', clientSecret: 'test-client-value' };
function callback(url: string, code = 'test-code-value') { const auth = new URL(url); return new URL(`${auth.searchParams.get('redirect_uri')}?${new URLSearchParams({ state: auth.searchParams.get('state')!, code })}`); }
const tokenData = { access_token: 'test-access-value', refresh_token: 'test-refresh-value', expires_in: 3600, token_type: 'Bearer', scope: READ_SCOPE };

test('Google OAuth uses one-time expiring state, loopback redirect and S256 PKCE; credentials never enter reports', async () => {
  let now = 1000; const vault = memoryVault(); let exchanges = 0; let challenge = '';
  const google = new GoogleSearch(vault, async (url, init) => {
    exchanges++; assert.equal(url, 'https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(String(init?.body));
    assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), challenge);
    assert.equal(body.get('redirect_uri'), 'http://127.0.0.1:4317/oauth/google/callback');
    assert.equal(init?.redirect, 'error'); return json(tokenData);
  }, () => now);
  assert.throws(() => google.begin('https://evil.test', client), /local operator/);
  const start = google.begin('http://127.0.0.1:4317', client); const auth = new URL(start.url); challenge = auth.searchParams.get('code_challenge')!;
  assert.equal(auth.origin, 'https://accounts.google.com'); assert.equal(auth.searchParams.get('scope'), READ_SCOPE); assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  const wrong = callback(start.url); wrong.searchParams.set('state', 'wrong'); await assert.rejects(google.callback(wrong), /does not match/); assert.equal(exchanges, 0);
  await google.callback(callback(start.url)); assert.equal(google.connected(), true); assert.equal(google.writable(), false);
  await assert.rejects(google.callback(callback(start.url)), /does not match/); assert.equal(exchanges, 1);
  assert.equal(await google.accessToken(), tokenData.access_token); assert.equal(exchanges, 1);
  assert.doesNotMatch(JSON.stringify(google.status()), /test-access|test-refresh|test-client/);
  assert.doesNotMatch(JSON.stringify(clean(tokenData)), /test-access-value|test-refresh-value/);
  const expired = google.begin('http://127.0.0.1:4317', client); now += 600_001; await assert.rejects(google.callback(callback(expired.url)), /expired/);
  const denied = google.begin('http://127.0.0.1:4317', client); const denial = callback(denied.url); denial.searchParams.set('error', 'access_denied'); await assert.rejects(google.callback(denial), /cancelled or denied/);
  assert.equal(exchanges, 1);
});

test('Google rejects missing consent/offline access and refreshes expired tokens without exposing provider bodies', async () => {
  const vault = memoryVault(); const google = new GoogleSearch(vault, async () => json({ ...tokenData, scope: READ_SCOPE }));
  const start = google.begin('http://127.0.0.1:4317', { ...client, manageSitemaps: true });
  assert.equal(new URL(start.url).searchParams.get('scope'), WRITE_SCOPE);
  await assert.rejects(google.callback(callback(start.url)), /requested scope/); assert.equal(google.connected(), false);
  google.transport = async () => json({ ...tokenData, refresh_token: undefined });
  await assert.rejects(google.callback(callback(google.begin('http://127.0.0.1:4317', client).url)), /offline/);
  vault.values = { googleClientId: client.clientId, googleRefreshToken: 'saved-refresh', googleScope: READ_SCOPE };
  let calls = 0; google.transport = async (_url, init) => { calls++; const body = new URLSearchParams(String(init?.body)); assert.equal(body.get('grant_type'), 'refresh_token'); return json(tokenData); };
  await google.accessToken(); await google.accessToken(); assert.equal(calls, 1);
  google.access!.expires = 0; google.transport = async () => json({ error: 'invalid_grant', detail: 'sensitive-provider-body' }, 400);
  await assert.rejects(google.accessToken(), e => /Reconnect/.test(String(e)) && !/sensitive-provider-body/.test(String(e)));
});

test('Search Console REST contracts encode properties and sitemap paths, aggregate final metrics and exclude deprecated indexing', async () => {
  const vault = memoryVault(); vault.values = { googleClientId: client.clientId, googleRefreshToken: 'adapter-refresh', googleScope: WRITE_SCOPE };
  const calls: { url: string; init?: RequestInit }[] = [];
  const google = new GoogleSearch(vault, async (url, init) => {
    calls.push({ url: String(url), init }); assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer adapter-access');
    if (String(url).endsWith('/sites')) return json({ siteEntry: [{ siteUrl: 'sc-domain:example.test', permissionLevel: 'siteOwner' }] });
    if (String(url).endsWith('/searchAnalytics/query')) return json({ rows: [{ clicks: 4, impressions: 20, ctr: 0.2, position: 3 }] });
    if (init?.method === 'PUT') return new Response(null, { status: 204 });
    return json({ sitemap: [{ path: 'https://example.test/sitemap.xml', errors: '2', warnings: '0', isPending: true, contents: [{ indexed: '99999' }] }] });
  });
  google.access = { value: 'adapter-access', expires: Date.now() + 3_600_000, identity: google.identity() };
  assert.equal((await google.sites())[0].permissionLevel, 'siteOwner');
  const maps = await google.sitemaps('sc-domain:example.test'); assert.equal(maps[0].errors, 2); assert.doesNotMatch(JSON.stringify(maps), /indexed/);
  const window = searchWindow(new Date('2026-10-28T02:00:00Z')); assert.deepEqual(window, { startDate: '2026-09-27', endDate: '2026-10-24' });
  assert.equal((await google.performance('sc-domain:example.test', window))?.clicks, 4);
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), { ...window, type: 'web', dataState: 'final', aggregationType: 'byProperty', rowLimit: 1 });
  await google.submit('sc-domain:example.test', 'https://example.test/sitemap.xml');
  assert.equal(calls.at(-1)?.url, 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.test/sitemaps/https%3A%2F%2Fexample.test%2Fsitemap.xml'); assert.equal(calls.at(-1)?.init?.body, undefined);
  google.transport = async () => json({}); assert.equal(await google.performance('x', window), undefined);
  google.transport = async () => json({ rows: [{ clicks: null }] }); await assert.rejects(google.performance('x', window), /invalid search metrics/);
  for (const status of [401, 403, 429, 503]) { google.access = { value: 'adapter-access', expires: Date.now() + 3_600_000, identity: google.identity() }; google.transport = async () => json({ secret: 'private-error' }, status); await assert.rejects(google.sites(), e => !/private-error/.test(String(e))); }
});

async function fixture() {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-grow-')));
  const run = await journal.create({ appPath: journal.dir, domain: 'example.test', accountId: 'mock', inbox: '', mode: 'mock', outbound: false, www: false, seo: { approved: true, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } });
  run.resources.url = 'https://example.test'; run.steps.seo.status = 'VERIFIED'; run.status = 'LIVE_VERIFIED'; await journal.save(run);
  const provider = new MockSearch(run.config.domain); const grow = new Growth(journal, () => provider, () => new Date('2026-10-28T12:00:00Z'));
  return { journal, run, provider, grow };
}

test('Growth discovers only accessible covering properties, isolates launch state, and reports partial/no data honestly', async () => {
  assert.equal(covers('sc-domain:example.test', 'www.example.test'), true); assert.equal(covers('sc-domain:example.test', 'evilexample.test'), false);
  for (const site of ['https://example.test/private/', 'https://evil.test/', 'http://example.test/', 'sc-domain:com']) assert.equal(covers(site, 'example.test'), false);
  const { journal, run, provider, grow } = await fixture(); const before = await readFile(journal.path(run.id), 'utf8');
  provider.sites = async () => [{ siteUrl: 'https://example.test/', permissionLevel: 'siteOwner' }, { siteUrl: 'sc-domain:example.test', permissionLevel: 'siteUnverifiedUser' }, { siteUrl: 'https://evil.test/', permissionLevel: 'siteOwner' }];
  await grow.refresh(run.id); let report = await grow.report(run.id); assert.equal(report.properties?.status === 'AVAILABLE' && report.properties.data.length, 1); assert.equal(report.property, undefined);
  await assert.rejects(grow.select(run.id, 'https://evil.test/'), /accessible property/);
  await grow.select(run.id, 'https://example.test/'); await grow.refresh(run.id); report = await grow.report(run.id);
  assert.equal(report.performance?.status, 'AVAILABLE'); assert.equal(report.simulated, true); assert.match(report.indexing, /UNAVAILABLE/);
  provider.sitemaps = async () => { throw Error('Sitemap access unavailable'); }; await grow.refresh(run.id); report = await grow.report(run.id); assert.equal(report.sitemaps?.status, 'UNAVAILABLE'); assert.equal(report.performance?.status, 'AVAILABLE');
  // Use the interface return type to exercise Google's valid empty result.
  const empty = new Growth(journal, () => ({ ...provider, identity: () => provider.identity(), connected: () => true, writable: () => true, sites: () => provider.sites(), sitemaps: async () => [], performance: async () => undefined, submit: async () => {} }));
  await empty.refresh(run.id); assert.equal((await empty.report(run.id)).performance?.status, 'NO_DATA');
  provider.sites = async () => []; await grow.refresh(run.id); report = await grow.report(run.id); assert.equal(report.property, undefined); assert.match(report.nextActions.join(' '), /verify/);
  assert.equal(await readFile(journal.path(run.id), 'utf8'), before);
});

test('Sitemap submission persists exact approval and intent, verifies by reinspection and never repeats a submission', async () => {
  const { run, provider, grow } = await fixture(); await grow.select(run.id, 'https://example.test/');
  let submissions = 0; const submit = provider.submit.bind(provider);
  provider.submit = async (site, sitemap) => { submissions++; const state = await grow.load(run.id); assert.equal(state.submissions[0].status, 'INTENT'); assert.ok(state.submissions[0].approvedAt); await submit(site, sitemap); };
  const prepared = await grow.prepare(run.id); assert.equal(submissions, 0); assert.equal(prepared.submissions[0].sitemap, 'https://example.test/sitemap.xml');
  await grow.refresh(run.id); assert.equal(submissions, 0);
  await assert.rejects(grow.decide(run.id, 'wrong', 'approved'), /no longer matches/);
  await grow.decide(run.id, prepared.submissions[0].id, 'approved'); assert.equal(submissions, 1); assert.equal((await grow.load(run.id)).submissions[0].status, 'OBSERVED');
  await grow.decide(run.id, prepared.submissions[0].id, 'approved'); await grow.prepare(run.id); assert.equal(submissions, 1); assert.equal((await grow.load(run.id)).submissions.length, 1);
});

test('Unknown/crashed sitemap outcomes survive restart, reconcile read-only, and reject stale account/permission approvals', async () => {
  const { journal, run, provider, grow } = await fixture(); await grow.select(run.id, 'https://example.test/'); const action = (await grow.prepare(run.id)).submissions[0];
  let submissions = 0; provider.submit = async () => { submissions++; throw Error('Connection lost after submission'); };
  await grow.decide(run.id, action.id, 'approved'); assert.equal((await grow.load(run.id)).submissions[0].status, 'UNKNOWN');
  const resumed = new Growth(journal, () => provider); await resumed.decide(run.id, action.id, 'approved'); assert.equal(submissions, 1);
  const state = await resumed.load(run.id); state.submissions[0].status = 'INTENT'; await resumed.save(state); await resumed.decide(run.id, action.id, 'approved'); assert.equal(submissions, 1);
  provider.maps = [{ path: action.sitemap }]; await resumed.refresh(run.id); assert.equal((await resumed.load(run.id)).submissions[0].status, 'OBSERVED'); assert.equal(submissions, 1);
  provider.identity = () => 'another-account'; await assert.rejects(resumed.decide(run.id, action.id, 'approved'), /no longer matches/); assert.equal((await resumed.report(run.id)).performance, undefined);
  await resumed.select(run.id, 'https://example.test/'); const next = (await resumed.prepare(run.id)).submissions.at(-1)!;
  provider.sites = async () => [{ siteUrl: 'https://example.test/', permissionLevel: 'siteRestrictedUser' }]; await assert.rejects(resumed.decide(run.id, next.id, 'approved'), /owner\/full-user/);
});

test('Decline, missing verified SEO, read-only scope, existing sitemap and controller concurrency are enforced', async () => {
  const { journal, run, provider, grow } = await fixture(); await grow.select(run.id, 'https://example.test/');
  provider.writable = () => false; await assert.rejects(grow.prepare(run.id), /consent/); provider.writable = () => true;
  run.steps.seo.status = 'NOT_STARTED'; await journal.save(run); await assert.rejects(grow.prepare(run.id), /Verify/); run.steps.seo.status = 'VERIFIED'; await journal.save(run);
  const action = (await grow.prepare(run.id)).submissions[0]; await grow.decide(run.id, action.id, 'denied'); await assert.rejects(grow.decide(run.id, action.id, 'approved'), /declined/);
  const next = (await grow.prepare(run.id)).submissions.at(-1)!; provider.maps = [{ path: next.sitemap }]; provider.submit = async () => assert.fail('Existing sitemap must not be resubmitted'); await grow.decide(run.id, next.id, 'approved');
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); provider.sites = async () => { await wait; return []; };
  const refreshing = grow.refresh(run.id); await assert.rejects(grow.prepare(run.id), /in progress/); release(); await refreshing;
});

test('An interrupted metrics refresh cannot associate previous metrics with a new window', async () => {
  const { run, provider, grow } = await fixture(); await grow.select(run.id, 'https://example.test/'); await grow.refresh(run.id);
  const old = await grow.load(run.id); assert.equal(old.performance?.status, 'AVAILABLE');
  grow.now = () => new Date('2026-11-28T12:00:00Z');
  let entered!: () => void; let release!: () => void; const arrived = new Promise<void>(resolve => { entered = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
  provider.performance = async () => { entered(); await wait; throw Error('Interrupted read'); };
  const pending = grow.refresh(run.id); await arrived;
  try { const saved = await grow.load(run.id); assert.notDeepEqual(saved.window, old.window); assert.equal(saved.performance?.status, 'UNAVAILABLE'); assert.match(JSON.stringify(saved.performance), /has not completed/); }
  finally { release(); await pending; }
});

test('Reconnecting cannot bypass an unresolved sitemap intent; new authorized reads can reconcile it', async () => {
  const { run, provider, grow } = await fixture(); await grow.select(run.id, 'https://example.test/'); const action = (await grow.prepare(run.id)).submissions[0];
  provider.submit = async () => { throw Error('Unknown provider outcome'); }; await grow.decide(run.id, action.id, 'approved');
  provider.identity = () => 'reconnected-account'; await grow.select(run.id, 'https://example.test/');
  await assert.rejects(grow.prepare(run.id), /earlier connection/);
  provider.maps = [{ path: action.sitemap }]; await grow.refresh(run.id); assert.equal((await grow.load(run.id)).submissions[0].status, 'OBSERVED');
});

test('Windows vault protects/restores Google credentials and invalid updates leave existing connections intact', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launchkit-google-vault-')); const vault = new Vault(dir);
  await vault.connect({ cloudflare: 'preserved-cloudflare-value', googleClientId: client.clientId, googleClientSecret: 'protected-google-client', googleRefreshToken: 'protected-google-refresh', googleScope: READ_SCOPE });
  assert.doesNotMatch(await readFile(join(dir, 'connections.dpapi'), 'utf8'), /protected-google|preserved-cloudflare/);
  await assert.rejects(vault.connect({ cloudflare: 'unwanted-new-value', googleRefreshToken: 'invalid whitespace' }), /Invalid credential/);
  assert.equal(vault.values.cloudflare, 'preserved-cloudflare-value');
  await vault.connect({ cloudflare: '' }); assert.equal(vault.values.cloudflare, 'preserved-cloudflare-value');
  const restored = new Vault(dir); await restored.load(); assert.equal(restored.values.googleRefreshToken, 'protected-google-refresh'); assert.equal(restored.values.googleScope, READ_SCOPE);
  assert.doesNotMatch(JSON.stringify(clean(restored.values)), /protected-google-refresh|protected-google-client/);
});
