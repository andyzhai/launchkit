import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/workflow/journal.ts';
import { Operator } from '../src/operate/operator.ts';
import { MockOperatorProvider, cloudflareUsage } from '../src/operate/provider.ts';
import { checkHealth, publicAddress, type Probe, type HealthTools } from '../src/operate/health.ts';
import type { HealthCheck } from '../src/operate/types.ts';
import { registerSecret } from '../src/security/redaction.ts';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'launchkit-operate-')); const journal = new Journal(dir);
  const run = await journal.create({ appPath: dir, domain: 'example.test', accountId: 'a'.repeat(32), inbox: '', mode: 'mock', outbound: false, www: false, seo: { approved: false, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } });
  run.resources = { url: 'https://example.test', worker: `lk-${run.id}`, deployedRelease: 'confirmed-release' }; run.status = 'LIVE_VERIFIED'; await journal.save(run);
  let date = new Date('2026-10-28T12:00:00Z'); const now = () => date;
  const provider = new MockOperatorProvider(); const operator = new Operator(journal, () => provider, now);
  return { journal, run, operator, provider, now, advance: (minutes: number) => { date = new Date(date.getTime() + minutes * 60_000); } };
}
test('M2 opt-in settings survive restart, missed intervals create gaps, pause stops scheduling', async () => {
  const t = await setup(); assert.equal(await t.operator.due(), undefined);
  await t.operator.configure(t.run.id, { enabled: true, intervalMinutes: 5, usageEnabled: false });
  assert.equal(await t.operator.due(), t.run.id);
  await t.operator.check(t.run.id); assert.equal(await t.operator.due(), undefined);
  const restarted = new Operator(t.journal, () => t.provider, t.now);
  t.advance(16); assert.equal(await restarted.due(), t.run.id); assert.equal((await restarted.report(t.run.id)).stale, true);
  const result = await restarted.check(t.run.id); assert.equal(result.history.length, 2); assert.equal(result.events.filter(e => e.kind === 'GAP').length, 1);
  assert.equal((await restarted.report(t.run.id)).stale, false);
  await restarted.configure(t.run.id, { enabled: false, intervalMinutes: 5, usageEnabled: false }); t.advance(10);
  assert.equal(await restarted.due(), undefined); await restarted.check(t.run.id); assert.equal((await restarted.load(t.run.id)).nextCheckAt, undefined);
});
test('M2 deduplicates alerts, acknowledgement does not resolve, UNKNOWN does not recover, PASS does', async () => {
  const t = await setup(); let status: HealthCheck['status'] = 'FAIL';
  const healthy = await t.provider.health();
  t.provider.health = async () => healthy.map(c => c.name === 'http' ? { ...c, status, message: 'HTTP test result' } : c);
  let state = await t.operator.check(t.run.id); const firstId = state.incidents[0].id; assert.equal(state.last?.status, 'DOWN');
  t.advance(5); state = await t.operator.check(t.run.id); assert.equal(state.incidents.length, 1); assert.equal(state.incidents[0].occurrences, 2);
  state = await t.operator.acknowledge(t.run.id, firstId); assert.ok(state.incidents[0].acknowledgedAt); assert.equal(state.incidents[0].resolvedAt, undefined);
  status = 'UNKNOWN'; state = await t.operator.check(t.run.id); assert.equal(state.incidents[0].resolvedAt, undefined); assert.equal(state.last?.status, 'UNKNOWN');
  status = 'PASS'; state = await t.operator.check(t.run.id); assert.ok(state.incidents[0].resolvedAt); assert.equal(state.events.filter(e => e.kind === 'RESOLVED').length, 1);
  status = 'FAIL'; state = await t.operator.check(t.run.id); assert.equal(state.incidents.length, 2); assert.notEqual(state.incidents[1].id, firstId);
});
test('M2 severity escalation makes an acknowledged warning visible again', async () => {
  const t = await setup(); const healthy = await t.provider.health(); let status: HealthCheck['status'] = 'WARN';
  t.provider.health = async () => healthy.map(c => c.name === 'certificate' ? { ...c, status } : c);
  let state = await t.operator.check(t.run.id); await t.operator.acknowledge(t.run.id, state.incidents[0].id);
  status = 'FAIL'; state = await t.operator.check(t.run.id); assert.equal(state.incidents[0].acknowledgedAt, undefined); assert.equal(state.incidents[0].severity, 'FAIL');
});
test('M2 checks never mutate launch evidence and checker exceptions cannot claim healthy', async () => {
  const t = await setup(); const before = await readFile(t.journal.path(t.run.id), 'utf8');
  t.provider.health = async () => { throw Error('unexpected failure'); };
  const state = await t.operator.check(t.run.id); assert.equal(state.last?.status, 'UNKNOWN');
  assert.equal(await readFile(t.journal.path(t.run.id), 'utf8'), before);
  t.provider.health = async () => []; assert.equal((await t.operator.check(t.run.id)).last?.status, 'UNKNOWN');
});
test('M2 serializes checks and settings, throttles usage to hourly, disables usage explicitly', async () => {
  const t = await setup(); let calls = 0; let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; }); const healthy = await t.provider.health();
  t.provider.health = async () => { entered(); await held; return healthy; };
  const originalUsage = t.provider.usage.bind(t.provider); t.provider.usage = async (...args) => { calls++; return originalUsage(...args); };
  await t.operator.configure(t.run.id, { enabled: true, intervalMinutes: 5, usageEnabled: true });
  const pending = t.operator.check(t.run.id); await started;
  await assert.rejects(t.operator.check(t.run.id), /running/);
  await assert.rejects(t.operator.configure(t.run.id, { enabled: false, intervalMinutes: 5, usageEnabled: false }), /running/);
  release(); await pending; assert.equal(calls, 1);
  t.advance(5); await t.operator.check(t.run.id); assert.equal(calls, 1);
  t.advance(60); await t.operator.check(t.run.id); assert.equal(calls, 2);
  await t.operator.configure(t.run.id, { enabled: true, intervalMinutes: 5, usageEnabled: false });
  assert.equal((await t.operator.load(t.run.id)).usage?.status, 'DISABLED');
  await t.operator.check(t.run.id); assert.equal(calls, 2);
});
test('M2 rejects invalid settings and unlaunched businesses, reports unknown costs honestly', async () => {
  const t = await setup();
  for (const value of [null, {}, { enabled: true, intervalMinutes: 0, usageEnabled: false }, { enabled: true, intervalMinutes: 1441, usageEnabled: false }, { enabled: 'true', intervalMinutes: 5, usageEnabled: false }]) await assert.rejects(t.operator.configure(t.run.id, value));
  const report = await t.operator.report(t.run.id); assert.equal(report.costs.billingStatus, 'UNAVAILABLE'); assert.equal(report.costs.recorded.length, 0); assert.equal(report.stale, true);
  delete t.run.resources.url; await t.journal.save(t.run);
  await assert.rejects(t.operator.configure(t.run.id, { enabled: true, intervalMinutes: 5, usageEnabled: false }), /bind/);
  await assert.rejects(t.operator.check(t.run.id), /bind/);
});
test('M2 bounded histories preserve open incidents and redact known credentials', async () => {
  const t = await setup(); let state = await t.operator.check(t.run.id); const sample = state.last!;
  state.history = Array.from({ length: 288 }, () => sample); await t.operator.save(state);
  const secret = 'operate-test-private-value-12345'; registerSecret(secret); const healthy = await t.provider.health();
  t.provider.health = async () => healthy.map(c => ({ ...c, message: secret }));
  state = await t.operator.check(t.run.id); assert.equal(state.history.length, 288);
  assert.ok(!(await readFile(t.operator.path(t.run.id), 'utf8')).includes(secret));
});
test('M2 usage handles denied, partial, empty, malformed and sampled responses without exposing bodies', async () => {
  const t = await setup();
  let request: any;
  const transport = (payload: any, status = 200): typeof fetch => async (_url, init) => { request = init; return Response.json(payload, { status }); };
  for (const payload of [{ errors: [{ message: 'private-provider-error' }] }, { data: { viewer: { accounts: [] } } }, { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } }, { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 5 } }] }] } } }]) {
    const usage = await cloudflareUsage(t.run, 'credential', t.now(), transport(payload)); assert.equal(usage.status, 'UNAVAILABLE'); assert.ok(!JSON.stringify(usage).includes('private-provider-error'));
  }
  assert.equal((await cloudflareUsage(t.run, 'credential', t.now(), transport({ error: 'private' }, 403))).status, 'UNAVAILABLE');
  const usage = await cloudflareUsage(t.run, 'credential', t.now(), transport({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 100, errors: 2 } }] }] } }, errors: null }));
  assert.equal(usage.status, 'AVAILABLE'); assert.equal(usage.requests, 100); assert.equal(request.method, 'POST');
  const body = JSON.parse(request.body); assert.equal(body.variables.scriptName, t.run.resources.worker); assert.equal(body.variables.accountTag, t.run.config.accountId); assert.ok(!body.query.includes('dimensions'));
  assert.equal((await cloudflareUsage(t.run, undefined, t.now(), async () => { assert.fail('No token must not make network requests'); })).status, 'UNAVAILABLE');
});
test('M2 public health rejects private/reserved IPv4, IPv6, mapped addresses and DNS rebinding', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '2002:7f00:1::', 'not-an-ip']) assert.equal(publicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(publicAddress(address), true, address);
  const t = await setup(); let probes = 0;
  const checks = await checkHealth(t.run, { now: Date.now, resolve: async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }], probe: async () => { probes++; throw Error('must not connect'); } });
  assert.equal(probes, 0); assert.match(checks[0].message, /UNSAFE_ADDRESS/); assert.equal(checks[1].status, 'UNKNOWN');
});
test('M2 verifies TLS expiry, HTTP, confirmed release and headers independently without following redirects', async () => {
  const t = await setup(); let response: Probe = { status: 200, expiresAt: '2026-12-28T12:00:00Z', latencyMs: 15, headers: { 'x-launchkit-release': 'confirmed-release', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } };
  const tools: HealthTools = { now: () => t.now().getTime(), resolve: async () => [{ address: '1.1.1.1', family: 4 }], probe: async (domain, address) => { assert.equal(domain, 'example.test'); assert.equal(address.address, '1.1.1.1'); return response; } };
  assert.ok((await checkHealth(t.run, tools)).every(c => c.status === 'PASS'));
  response.expiresAt = '2026-11-05T12:00:00Z'; assert.equal((await checkHealth(t.run, tools)).find(c => c.name === 'certificate')?.status, 'WARN');
  response.expiresAt = '2026-10-30T12:00:00Z'; assert.equal((await checkHealth(t.run, tools)).find(c => c.name === 'certificate')?.status, 'FAIL');
  response.headers['x-launchkit-release'] = 'unknown-release'; assert.equal((await checkHealth(t.run, tools)).find(c => c.name === 'release')?.status, 'FAIL');
  // A prepared but unapproved new release must not replace the confirmed deployment baseline.
  t.run.resources.release = 'new-unapproved-release'; response.headers['x-launchkit-release'] = 'confirmed-release';
  assert.equal((await checkHealth(t.run, tools)).find(c => c.name === 'release')?.status, 'PASS');
  response = { ...response, status: 302, headers: { location: 'http://127.0.0.1/private' } };
  const redirected = await checkHealth(t.run, tools); assert.equal(redirected.find(c => c.name === 'http')?.status, 'FAIL'); assert.equal(redirected.find(c => c.name === 'release')?.status, 'UNKNOWN');
  tools.probe = async () => { throw Object.assign(Error('private diagnostic data'), { code: 'CERT_HAS_EXPIRED' }); };
  const failed = await checkHealth(t.run, tools); assert.match(failed[1].message, /CERT_HAS_EXPIRED/); assert.ok(!JSON.stringify(failed).includes('private diagnostic data'));
});
