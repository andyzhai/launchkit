import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Discoverability, inspectPage, type AuditTools } from '../src/grow/audit.ts';
import { Journal } from '../src/workflow/journal.ts';
const at = '2026-10-29T12:00:00Z';
test('Static audit distinguishes evidence from indexing; ignores comments/scripts and keeps scoped directives visible', () => {
  const body = '<html><head><!-- <link rel="canonical" href="https://example.test/"> --><script>"<meta name="description" content="fake">"</script><title>Business</title><meta content="noindex" name="bingbot"><link href="https://elsewhere.test/" rel="canonical"></head><body><script>secret application data</script></body></html>';
  const findings = inspectPage('example.test', '/', { status: 200, type: 'text/html', body, robots: 'googlebot: nofollow' }, at);
  for (const check of ['canonical', 'indexing-directives', 'metadata']) assert.equal(findings.find(f => f.check === check)?.status, 'REVIEW');
  assert.equal(findings.find(f => f.check === 'public-content')?.source, 'STATIC_HTML');
  assert.ok(!findings.some(f => f.check.startsWith('content-')));
  assert.doesNotMatch(JSON.stringify(findings), /secret application data/); assert.ok(findings.every(f => f.url === 'https://example.test/' && f.at === at));
  assert.equal(inspectPage('example.test', '/', { status: 302, type: 'text/html', body }, at)[0].status, 'UNAVAILABLE');
  assert.equal(inspectPage('example.test', '/', { status: 200, type: 'application/json', body }, at)[0].status, 'UNAVAILABLE');
  const robots = inspectPage('example.test', '/robots.txt', { status: 200, type: 'text/plain', body: 'User-agent: *\nAllow: /\nUser-agent: SpecialBot\nDisallow: /\nSitemap: https://example.test/sitemap.xml' }, at);
  assert.match(robots[0].evidence, /SpecialBot/); assert.equal(robots[1].status, 'OBSERVED');
  assert.equal(inspectPage('example.test', '/robots.txt', { status: 200, type: 'text/html', body }, at)[0].status, 'UNAVAILABLE');
  assert.equal(inspectPage('example.test', '/sitemap.xml', { status: 200, type: 'text/xml', body: '<!DOCTYPE urlset><urlset></urlset>' }, at)[0].status, 'UNAVAILABLE');
  const sitemap = inspectPage('example.test', '/sitemap.xml', { status: 200, type: 'text/xml', body: '<urlset><url><loc>https://example.test/</loc></url></urlset>' }, at);
  assert.match(sitemap[0].evidence, /homepage present: true/); assert.match(sitemap[0].evidence, /not XML schema validation or indexing/);
});

async function fixture(mode: 'live' | 'mock' = 'live') {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-audit-')));
  const run = await journal.create({ appPath: journal.dir, domain: 'example.test', accountId: 'fixture', mode, inbox: '', outbound: false, www: false, seo: { approved: true, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } });
  run.resources.url = 'https://example.test'; await journal.save(run); return { journal, run };
}
test('Public audit blocks mixed/private DNS and isolates endpoint failures with pinned target and saved timestamps', async () => {
  const { journal, run } = await fixture(); const original = await readFile(journal.path(run.id), 'utf8'); let requests = 0;
  const tools: AuditTools = { resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], read: async () => { requests++; throw Error('private error'); } };
  const audit = new Discoverability(journal, tools, () => new Date(at)); await audit.report(run.id); assert.equal(requests, 0);
  let report = await audit.refresh(run.id); assert.equal(requests, 0); assert.equal(report.findings[0].status, 'UNAVAILABLE');
  tools.resolve = async () => [{ address: '8.8.8.8', family: 4 }];
  const paths: string[] = []; tools.read = async (domain, path, address) => { requests++; paths.push(path); assert.equal(domain, 'example.test'); assert.equal(address.address, '8.8.8.8'); if (path === '/') throw Error('sensitive-network-details'); return { status: 200, type: path === '/robots.txt' ? 'text/plain' : 'application/xml', body: path === '/robots.txt' ? 'User-agent: *\nDisallow: /' : '<urlset></urlset>' }; };
  report = await audit.refresh(run.id); assert.deepEqual(paths, ['/', '/robots.txt', '/sitemap.xml']); assert.equal(report.findings[0].status, 'UNAVAILABLE'); assert.ok(report.findings.some(f => f.check === 'robots-directives')); assert.doesNotMatch(JSON.stringify(report), /sensitive-network-details/);
  assert.equal(await readFile(journal.path(run.id), 'utf8'), original);
  const reopened = new Discoverability(journal, tools, () => new Date('2026-11-01T12:00:00Z')); assert.equal((await reopened.report(run.id)).stale, true); assert.equal(requests, 3);
  run.resources.url = undefined; await journal.save(run); await assert.rejects(audit.refresh(run.id), /bound/);
});
test('Simulated public audit makes no network calls and labels all evidence', async () => {
  const { journal, run } = await fixture('mock');
  const audit = new Discoverability(journal, { resolve: async () => assert.fail('Simulation DNS'), read: async () => assert.fail('Simulation HTTPS') });
  const report = await audit.refresh(run.id); assert.equal(report.simulated, true); assert.ok(report.findings.length >= 7); assert.match(report.limits, /separate approval/);
});
