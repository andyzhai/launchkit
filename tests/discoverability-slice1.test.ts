import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homepagePolicy, crawlers } from '../src/grow/robots.ts';
import { Discoverability, inspectPage, inspectRendered, type AuditTools } from '../src/grow/audit.ts';
import { Journal, atomicJSON } from '../src/workflow/journal.ts';
import { registerSecret } from '../src/security/redaction.ts';

const at = '2026-10-29T18:00:00Z';
const robots = (body: string) => inspectPage('example.test', '/robots.txt', { status: 200, type: 'text/plain', body }, at);
test('Homepage policies distinguish exact groups, wildcard fallback, repeated and adjacent groups, and training controls', () => {
  const body = 'User-agent: *\nDisallow: /\nUser-agent: OAI-SearchBot\nDisallow: /private\nUser-agent: GPTBot\nDisallow: /\nUser-agent: oai-searchbot\nAllow: /$';
  const findings = robots(body);
  const search = findings.find(f => f.crawler === 'OAI-SearchBot')!;
  assert.equal(search.policy, 'ALLOWED'); assert.equal(search.purpose, 'SEARCH'); assert.match(search.evidence, /2 exact.*merged; wildcard groups excluded/);
  assert.equal(findings.find(f => f.crawler === 'bingbot')?.policy, 'BLOCKED');
  const training = findings.find(f => f.crawler === 'GPTBot')!;
  assert.equal(training.policy, 'BLOCKED'); assert.equal(training.status, 'OBSERVED'); assert.equal(training.purpose, 'TRAINING'); assert.equal(training.action, undefined);
  assert.equal(homepagePolicy('User-agent: bingbot\nSitemap: https://example.test/sitemap.xml\n\nUser-agent: Googlebot\nDisallow: /', 'bingbot').state, 'BLOCKED');
  assert.equal(homepagePolicy('User-agent: *\nDisallow: /\nUser-agent: bingbot\nDisallow:', 'bingbot').state, 'ALLOWED');
  assert.equal(homepagePolicy('User-agent: OtherBot\nDisallow: /', 'bingbot').state, 'ALLOWED');
});

test('Homepage matching respects longest paths, allow ties, anchors, comments and empty rules', () => {
  for (const [rules, expected] of [
    ['Disallow: /', 'BLOCKED'], ['Disallow: /\nAllow: /', 'ALLOWED'],
    ['Allow: /\nDisallow: /$', 'BLOCKED'], ['Disallow: /\nAllow: /$', 'ALLOWED'],
    ['Disallow: /*', 'BLOCKED'], ['Disallow: /*$', 'BLOCKED'],
    ['Disallow: /private\nDisallow: /?q=*\nDisallow: /file$', 'ALLOWED'],
    ['Disallow: /#comment', 'BLOCKED'], ['Disallow:\nAllow:', 'ALLOWED'],
    ['Disallow: /\nAllow: /*', 'ALLOWED']
  ]) assert.equal(homepagePolicy(`\uFEFFUser-Agent: BINGBOT\r\n${rules}`, 'bingbot').state, expected, rules);
  assert.equal(homepagePolicy('', 'bingbot').state, 'ALLOWED');
});

test('Ambiguous or unsupported robots syntax is indeterminate, never guessed', () => {
  for (const body of [
    'User-agent bingbot\nDisallow: /', 'Disallow: /',
    'User-agent: bingbot/2.0\nAllow: /', 'User-agent: bing\nAllow: /',
    'User-agent: *\nDisallow: /%2F', 'User-agent: *\nDisallow: /café',
    'User-agent: *\nDisallow: /$bad', 'User-agent: *\nDisallow: relative',
    'User-agent: *\nDisallow: /\uFFFD', '\n'.repeat(4001)
  ]) assert.equal(homepagePolicy(body, 'bingbot').state, 'INDETERMINATE', body.slice(0, 80));
  // Unrelated unsupported rule paths do not affect the selected exact group.
  assert.equal(homepagePolicy('User-agent: OtherBot\nDisallow: /%FF\nUser-agent: bingbot\nAllow: /', 'bingbot').state, 'ALLOWED');
});

test('Exact robots product-token groups are not made indeterminate by shorter names', () => {
  for (const token of ['Googlebot', 'bingbot', 'OAI-SearchBot', 'Claude-SearchBot']) {
    assert.equal(homepagePolicy(`User-agent: bot\nDisallow: /\nUser-agent: ${token}\nAllow: /`, token).state, 'ALLOWED');
    assert.equal(homepagePolicy(`User-agent: ${token}\nDisallow: /\nUser-agent: bot\nAllow: /`, token).state, 'BLOCKED');
  }
  assert.equal(homepagePolicy('User-agent: Googlebot-News\nDisallow: /\nUser-agent: *\nAllow: /', 'Googlebot').state, 'ALLOWED');
  assert.equal(homepagePolicy('User-agent: Google\nDisallow: /\nUser-agent: *\nAllow: /', 'Googlebot').state, 'INDETERMINATE');
  assert.equal(homepagePolicy('User-agent: Googlebot\nDisallow: /%FF\nUser-agent: Google\nAllow: /', 'Googlebot').state, 'INDETERMINATE');
});

test('Unavailable robots responses do not imply permission or block independent homepage evidence', () => {
  for (const page of [{ status: 404, type: 'text/plain', body: '' }, { status: 302, type: 'text/plain', body: 'User-agent: *\nAllow: /' }, { status: 200, type: 'text/html', body: '<html>Fallback</html>' }]) {
    const findings = inspectPage('example.test', '/robots.txt', page, at);
    assert.equal(findings.filter(f => f.policy === 'UNAVAILABLE').length, crawlers.length);
    assert.ok(findings.filter(f => f.status !== 'OBSERVED').every(f => f.action));
    assert.ok(findings.every(f => f.url === 'https://example.test/robots.txt' && f.at === at));
  }
});

test('Rendered content assessments stay REVIEW, exclude JavaScript fallback and retain bounded redacted excerpts', () => {
  const inspect = (text: string, names = ['Example PDF']) => inspectRendered('example.test', { status: 'AVAILABLE', title: 'Example PDF', description: 'A PDF tool.', headings: names.map(text => ({ level: 1, text })), text }, at).filter(f => f.check.startsWith('content-'));
  const findings = inspect('A tool for redacting PDF files.\nDesigned for small teams.\nOnly supports text PDFs.');
  assert.equal(findings.length, 4);
  for (const f of findings) { assert.equal(f.status, 'REVIEW'); assert.equal(f.source, 'RENDERED_PAGE'); assert.equal(f.assessment, true); assert.match(f.evidence, /candidate excerpt/); assert.ok(f.action && f.why); assert.equal(f.url, 'https://example.test/'); assert.equal(f.at, at); }
  for (const f of inspect('JavaScript is required to redact local PDFs.', [])) {
    assert.match(f.evidence, /no unambiguous candidate.*0 characters/); assert.doesNotMatch(f.evidence, /candidate excerpt/);
  }
  assert.match(inspect('Useful text', ['One', 'Two'])[0].evidence, /no unambiguous/);
  assert.match(inspect('Bonjour.')[1].evidence, /no unambiguous/);
  const secret = 'fixture-sensitive-content-value'; registerSecret(secret);
  const bounded = inspect('Useful text', [`${secret}${'x'.repeat(2000)}`]);
  assert.doesNotMatch(JSON.stringify(bounded), new RegExp(secret)); assert.match(bounded[0].evidence, /REDACTED/);
  assert.ok(bounded.every(f => f.evidence.length <= 500));
  const purpose = inspectRendered('example.test', { status: 'AVAILABLE', title: 'PDF tool', description: 'Redact PDFs locally in your browser.', text: 'Password-protected and encrypted PDFs are unsupported.' }, at).find(f => f.check === 'content-purpose')!;
  assert.match(purpose.evidence, /rendered meta description/); assert.match(purpose.evidence, /Redact PDFs locally/); assert.doesNotMatch(purpose.evidence, /Password-protected/);
});

test('Explicit refresh persists bounded evidence per business; restart/legacy reads never fetch and failures remain independent', async () => {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-slice1-')));
  const config = { appPath: journal.dir, accountId: 'fixture', mode: 'live' as const, inbox: '', outbound: false, www: false, seo: { approved: true, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } };
  const first = await journal.create({ ...config, domain: 'first.test' }); first.resources.url = 'https://first.test'; await journal.save(first);
  const second = await journal.create({ ...config, domain: 'second.test' }); second.resources.url = 'https://second.test'; await journal.save(second);
  let reads = 0;
  const tools: AuditTools = { resolve: async () => [{ address: '8.8.8.8', family: 4 }], read: async (domain, path) => {
    reads++; assert.equal(domain, 'first.test');
    if (path === '/robots.txt') throw Error('private failure details');
    return { status: 200, type: path === '/' ? 'text/html' : 'text/xml', body: path === '/' ? '<html><body><h1>First product</h1></body></html>' : '<urlset></urlset>' };
  } };
  const audit = new Discoverability(journal, tools, () => new Date(at));
  const report = await audit.refresh(first.id); assert.equal(reads, 3); assert.equal(report.simulated, false);
  assert.equal(report.findings.filter(f => f.policy === 'UNAVAILABLE').length, 7);
  assert.ok(report.findings.some(f => f.check === 'rendered-content' && f.status === 'UNAVAILABLE')); assert.ok(report.findings.some(f => f.check === 'sitemap'));
  assert.ok(!report.findings.some(f => f.check.startsWith('content-')));
  assert.match(report.limits, /initial HTML and restricted JavaScript-rendered/);
  assert.deepEqual((await audit.report(second.id)).findings, []);
  assert.deepEqual((await new Discoverability(journal, tools).report(first.id)).findings, report.findings); assert.equal(reads, 3);
  const saved = await readFile(audit.path(first.id), 'utf8'); assert.doesNotMatch(saved, /<html>|private failure details/); assert.ok(saved.length < 20000);
  // Existing schema-1 evidence remains readable; no migration or refresh on GET.
  await atomicJSON(audit.path(first.id), { schema: 1, runId: first.id, at, findings: [{ check: 'metadata', status: 'OBSERVED', url: 'https://first.test/', at, evidence: 'Legacy evidence' }] });
  assert.equal((await audit.report(first.id)).findings[0].evidence, 'Legacy evidence'); assert.equal(reads, 3);
  assert.equal((await audit.report(first.id)).stale, true);
  await atomicJSON(audit.path(first.id), { schema: 1, runId: first.id, at, findings: [{ check: 'content-purpose', status: 'REVIEW', url: 'https://first.test/', at, evidence: 'JavaScript is required to redact local PDFs.' }] });
  assert.ok(!(await audit.report(first.id)).findings.some(f => f.check === 'content-purpose'));
  tools.render = async () => { throw Error('private browser details'); };
  const failed = await audit.refresh(first.id);
  assert.ok(failed.findings.some(f => f.check === 'rendered-content' && f.status === 'UNAVAILABLE'));
  assert.doesNotMatch(JSON.stringify(failed), /private browser/);
});
