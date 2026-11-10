import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BingSearch, MockBing, bingCovers, bingDate, type BingMetrics } from '../src/grow/bing.ts';
import { Growth } from '../src/grow/controller.ts';
import { Vault } from '../src/security/tokens.ts';
import { clean } from '../src/security/redaction.ts';
import { Journal } from '../src/workflow/journal.ts';
const json = (d: unknown, status = 200) => new Response(JSON.stringify({ d }), { status });

test('Bing REST contracts preserve provider dates, verification, feed statuses and exact POST payload', async () => {
  const vault = new Vault('unused'); vault.values.bingApiKey = 'bing-fixture-secret';
  const calls: { url: URL; init?: RequestInit }[] = [];
  const bing = new BingSearch(vault, async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    assert.equal(url.origin, 'https://ssl.bing.com'); assert.equal(url.searchParams.get('apikey'), vault.values.bingApiKey); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    switch (url.pathname.split('/').at(-1)) {
      case 'GetUserSites': return json([{ Url: 'https://example.test', IsVerified: true, AuthenticationCode: 'private-verification-code' }, { Url: 'https://other.test', IsVerified: false }]);
      case 'GetFeeds': return json([{ Url: 'https://example.test/sitemap.xml', Status: 'Success', UrlCount: 4, LastCrawled: '/Date(1315781995040-0700)/' }]);
      case 'GetRankAndTrafficStats': return json([{ Date: '/Date(1316156400000-0700)/', Clicks: 0, Impressions: 0 }]);
      default: return json(null);
    }
  });
  assert.deepEqual(await bing.sites(), [{ siteUrl: 'https://example.test', permissionLevel: 'verified' }, { siteUrl: 'https://other.test', permissionLevel: 'unverified' }]);
  const maps = await bing.sitemaps('https://example.test'); assert.equal(maps[0].providerStatus, 'Success'); assert.equal(maps[0].urlCount, 4); assert.equal(maps[0].lastSubmitted, undefined); assert.equal(maps[0].isPending, undefined);
  assert.deepEqual(await bing.performance('https://example.test'), { rows: [{ date: '2011-09-16T07:00:00.000Z', clicks: 0, impressions: 0 }] });
  assert.deepEqual([...calls.at(-1)!.url.searchParams.keys()].sort(), ['apikey', 'siteUrl']);
  await bing.submit('https://example.test', 'https://example.test/sitemap.xml');
  assert.equal(calls.at(-1)!.init?.method, 'POST'); assert.deepEqual(JSON.parse(String(calls.at(-1)!.init?.body)), { siteUrl: 'https://example.test', feedUrl: 'https://example.test/sitemap.xml' });
  assert.doesNotMatch(JSON.stringify(clean({ url: calls[0].url.href, status: bing.status() })), /bing-fixture-secret/);
  assert.equal(bingDate('/Date(1316156400000-0700)/'), '2011-09-16T07:00:00.000Z');
  assert.throws(() => bingDate('not-a-date'), /invalid date/);
});

test('Bing rejects malformed and failed evidence without exposing secrets; empty rows differ from zeros', async () => {
  const vault = new Vault('unused'); const bing = new BingSearch(vault, async () => assert.fail('No credential must not send'));
  await assert.rejects(bing.sites(), /Connect/); vault.values.bingApiKey = 'failure-test-key';
  bing.transport = async () => json([]); assert.equal(await bing.performance('https://example.test'), undefined);
  for (const bad of [undefined, null, {}, [{ Clicks: -1, Impressions: 1, Date: '/Date(0)/' }], [{ Clicks: 1, Impressions: null, Date: '/Date(0)/' }], [{ Clicks: 1, Impressions: 1, Date: 'yesterday' }]]) {
    bing.transport = async () => json(bad); await assert.rejects(bing.performance('https://example.test'), /invalid|unsuccessful/);
  }
  bing.transport = async () => json([{ Date: '/Date(0)/', Clicks: 1, Impressions: 1 }, { Date: '/Date(0)/', Clicks: 1, Impressions: 1 }]); await assert.rejects(bing.performance('x'), /duplicate/);
  for (const status of [401, 403, 429, 500]) { bing.transport = async () => new Response('failure-test-key private body', { status }); await assert.rejects(bing.sites(), e => !/failure-test-key|private body/.test(String(e))); }
  bing.transport = async () => { throw Error('https://ssl.bing.com/?apikey=failure-test-key'); }; await assert.rejects(bing.sites(), e => !/failure-test-key/.test(String(e)));
  bing.transport = async () => json({ ErrorCode: 1 }); await assert.rejects(bing.submit('x', 'y'), /unsuccessful/);
});

async function fixture() {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-bing-')));
  const run = await journal.create({ appPath: journal.dir, domain: 'example.test', accountId: 'mock', mode: 'mock', inbox: '', outbound: false, www: false, seo: { approved: true, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } });
  run.resources.url = 'https://example.test'; run.steps.seo.status = 'VERIFIED'; await journal.save(run);
  const provider = new MockBing(run.config.domain); const grow = new Growth<BingMetrics>(journal, () => provider, undefined, 'bing');
  return { journal, run, provider, grow };
}
test('Bing discovers exact verified HTTPS roots, keeps independent evidence and invalidates revoked access', async () => {
  assert.equal(bingCovers('https://example.test', 'example.test'), true); assert.equal(bingCovers('https://example.test/', 'example.test'), true);
  for (const site of ['http://example.test', 'https://www.example.test/', 'https://example.test/path', 'https://example.test/?x=1', 'https://example.test.evil/']) assert.equal(bingCovers(site, 'example.test'), false);
  const { journal, run, provider, grow } = await fixture(); const original = await readFile(journal.path(run.id), 'utf8');
  provider.sites = async () => [{ siteUrl: 'https://example.test/', permissionLevel: 'verified' }, { siteUrl: 'https://example.test', permissionLevel: 'unverified' }, { siteUrl: 'http://example.test/', permissionLevel: 'verified' }];
  await grow.refresh(run.id); assert.equal((await grow.load(run.id)).properties?.status, 'AVAILABLE');
  await assert.rejects(grow.select(run.id, 'https://example.test'), /accessible/);
  await grow.select(run.id, 'https://example.test/'); await grow.refresh(run.id);
  let report = await grow.report(run.id); assert.equal(report.window, undefined); assert.match(report.measurement, /Web, Chat/); assert.equal(report.performance?.status, 'AVAILABLE');
  provider.sitemaps = async () => { throw Error('Feeds unavailable'); }; await grow.refresh(run.id); report = await grow.report(run.id); assert.equal(report.sitemaps?.status, 'UNAVAILABLE'); assert.equal(report.performance?.status, 'AVAILABLE');
  provider.sites = async () => []; await grow.refresh(run.id); report = await grow.report(run.id); assert.equal(report.property, undefined); assert.equal(report.performance?.status, 'UNAVAILABLE');
  assert.equal((await new Growth(journal, () => { throw Error('report not requested'); }).load(run.id)).submissions.length, 0);
  assert.equal(await readFile(journal.path(run.id), 'utf8'), original);
});

test('Bing durable intent survives crashes and key rotation; read reconciliation cannot resubmit', async () => {
  const { journal, run, provider, grow } = await fixture(); await grow.select(run.id, 'https://example.test/');
  const action = (await grow.prepare(run.id)).submissions[0]; let sends = 0;
  provider.submit = async () => { sends++; const state = await grow.load(run.id); assert.equal(state.submissions[0].status, 'INTENT'); assert.ok(state.submissions[0].approvedAt); throw Error('lost response'); };
  await grow.refresh(run.id); assert.equal(sends, 0); await grow.decide(run.id, action.id, 'approved'); assert.equal((await grow.load(run.id)).submissions[0].status, 'UNKNOWN');
  const resumed = new Growth(journal, () => provider, undefined, 'bing'); await resumed.decide(run.id, action.id, 'approved'); assert.equal(sends, 1);
  const state = await resumed.load(run.id); state.submissions[0].status = 'INTENT'; await resumed.save(state); await resumed.decide(run.id, action.id, 'approved'); assert.equal(sends, 1);
  provider.identity = () => 'rotated-bing-connection'; assert.equal((await resumed.report(run.id)).property, undefined);
  await assert.rejects(resumed.decide(run.id, action.id, 'approved'), /no longer matches/); await resumed.select(run.id, action.property); await assert.rejects(resumed.prepare(run.id), /earlier connection/);
  provider.maps = [{ path: action.sitemap, providerStatus: 'Success' }]; await resumed.refresh(run.id); assert.equal((await resumed.load(run.id)).submissions[0].status, 'OBSERVED'); assert.equal(sends, 1);
});

test('Bing declines, SEO prerequisites, reinspection, existing listing and history limit gate writes', async () => {
  const { journal, run, provider, grow } = await fixture(); await grow.select(run.id, 'https://example.test/');
  run.steps.seo.status = 'NOT_STARTED'; await journal.save(run); await assert.rejects(grow.prepare(run.id), /Verify/); run.steps.seo.status = 'VERIFIED'; await journal.save(run);
  const first = (await grow.prepare(run.id)).submissions[0]; await grow.decide(run.id, first.id, 'denied'); await assert.rejects(grow.decide(run.id, first.id, 'approved'), /declined/);
  const second = (await grow.prepare(run.id)).submissions[1]; provider.sites = async () => []; await assert.rejects(grow.decide(run.id, second.id, 'approved'), /unavailable/);
  provider.sites = async () => [{ siteUrl: second.property, permissionLevel: 'verified' }]; provider.maps = [{ path: second.sitemap }]; provider.submit = async () => assert.fail('Already listed'); await grow.decide(run.id, second.id, 'approved');
  const state = await grow.load(run.id); state.submissions = Array.from({ length: 100 }, (_, i) => ({ ...first, id: String(i), status: 'DECLINED' })); await grow.save(state); await assert.rejects(grow.prepare(run.id), /history is full/);
});

test('Bing API key is protected and restored by Windows vault; blank input keeps it', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launchkit-bing-vault-')); const vault = new Vault(dir);
  await vault.connect({ bingApiKey: 'protected-bing-fixture', cloudflare: 'preserved-provider' }); await vault.connect({ bingApiKey: '' });
  assert.doesNotMatch(await readFile(join(dir, 'connections.dpapi'), 'utf8'), /protected-bing-fixture/);
  const restored = new Vault(dir); await restored.load(); assert.equal(restored.values.bingApiKey, 'protected-bing-fixture'); assert.equal(restored.values.cloudflare, 'preserved-provider');
  assert.doesNotMatch(JSON.stringify(clean(restored.values)), /protected-bing-fixture/);
});
