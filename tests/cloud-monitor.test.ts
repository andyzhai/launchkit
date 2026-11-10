import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudMonitor } from '../src/operate/cloud/engine.ts';
import { cloudHealth } from '../src/operate/cloud/health.ts';
import worker, { MonitorState } from '../src/operate/cloud/worker.ts';
import type { CloudStorage, CloudState, CloudTarget, CloudRuntime } from '../src/operate/cloud/types.ts';
import type { HealthCheck } from '../src/operate/types.ts';

const target: CloudTarget = { runId: 'a'.repeat(24), domain: 'example.test', release: 'b'.repeat(64), recipient: 'owner@example.test', sender: 'monitor@example.test', origin: `https://lk-monitor-${'a'.repeat(24)}.example.workers.dev` };
function setup() {
  let now = Date.parse('2026-10-28T18:00:00Z'); let stored: CloudState | undefined; let alarm: number | undefined;
  const sent: { subject: string; text: string; to: string }[] = [];
  const storage: CloudStorage = { get: async () => structuredClone(stored) as any, put: async (_key, value) => { stored = structuredClone(value) as CloudState; }, setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = undefined; } };
  let fail = false;
  const runtime: CloudRuntime = { now: () => now, uuid: () => crypto.randomUUID(), health: async () => [
    { name: 'https', status: 'PASS', message: 'TLS' }, { name: 'http', status: fail ? 'FAIL' : 'PASS', message: fail ? 'HTTP 503' : 'HTTP 200' }
  ], send: async message => { sent.push(message); return { messageId: crypto.randomUUID() }; } };
  const monitor = new CloudMonitor(storage, target, runtime);
  return { monitor, runtime, storage, sent, now: () => now, advance: (minutes: number) => { now += minutes * 60_000; }, failure: (value: boolean) => { fail = value; }, alarm: () => alarm };
}
test('cloud Cron persists observations, deduplicates replays/incidents, and sends one recovery', async () => {
  const t = setup(); await t.monitor.configure({ enabled: true, intervalMinutes: 5, notifications: true }); t.failure(true); t.advance(5);
  await t.monitor.scheduled(t.now()); await t.monitor.scheduled(t.now()); assert.equal(t.sent.length, 1); assert.equal((await t.monitor.report()).history.length, 1);
  t.advance(5); await new CloudMonitor(t.storage, target, t.runtime).scheduled(t.now()); assert.equal(t.sent.length, 1);
  t.failure(false); t.advance(5); await t.monitor.scheduled(t.now()); assert.equal(t.sent.length, 2); assert.match(t.sent[1].subject, /RECOVERY/);
  assert.equal((await t.monitor.report()).history.length, 3); assert.ok((await t.monitor.report()).incidents[0].resolvedAt);
});
test('cloud persists unknown email outcome before sending and never retries after a crash', async () => {
  const t = setup(); await t.monitor.configure({ enabled: true, intervalMinutes: 5, notifications: true }); t.failure(true);
  const realPut = t.storage.put;
  t.storage.put = async (key, value) => { if ((value as CloudState).notifications.some(n => n.status === 'ACCEPTED')) throw Error('Disk failure after provider acceptance'); return realPut(key, value); };
  t.advance(5); await assert.rejects(t.monitor.scheduled(t.now())); assert.equal(t.sent.length, 1);
  t.storage.put = realPut; t.advance(5); await new CloudMonitor(t.storage, target, t.runtime).scheduled(t.now());
  assert.equal(t.sent.length, 1); assert.equal((await t.monitor.report()).notifications[0].status, 'UNKNOWN');
});
test('cloud watchdog reports missing schedule while laptop is absent, deduplicates and recovers', async () => {
  const t = setup(); await t.monitor.configure({ enabled: true, intervalMinutes: 5, notifications: true });
  assert.ok(t.alarm()); t.advance(21); await t.monitor.watchdog(); assert.equal(t.sent.length, 1); assert.equal((await t.monitor.report()).scheduleMissing, true);
  t.advance(11); await t.monitor.watchdog(); assert.equal(t.sent.length, 1);
  t.advance(5); await t.monitor.scheduled(t.now()); assert.equal(t.sent.length, 2); assert.ok((await t.monitor.report()).incidents.find(i => i.check === 'schedule')?.resolvedAt);
  await t.monitor.configure({ enabled: false, intervalMinutes: 5, notifications: false }); assert.equal(t.alarm(), undefined);
  t.advance(60); await t.monitor.scheduled(t.now()); await t.monitor.watchdog(); assert.equal(t.sent.length, 2);
});
test('cloud delivery drill needs two real schedules and two receipt confirmations, not send acceptance', async () => {
  const t = setup(); await t.monitor.configure({ enabled: true, intervalMinutes: 5, notifications: true });
  await t.monitor.armVerification(); await t.monitor.armVerification(); assert.equal(t.sent.length, 0);
  t.advance(5); await t.monitor.scheduled(t.now()); assert.equal(t.sent.length, 1); assert.equal((await t.monitor.report()).verification.notificationVerified, false);
  t.advance(5); await t.monitor.scheduled(t.now()); assert.equal(t.sent.length, 2);
  for (const email of t.sent) { assert.match(email.subject, /verification drill/); const receipt = email.text.match(/token=([a-f0-9]{64})/)![1]; assert.equal(await t.monitor.confirm(receipt), true); }
  const report = await t.monitor.report(); assert.equal(report.verification.operational, true); assert.ok(!JSON.stringify(report).includes('receiptHash'));
  const health = t.runtime.health; t.runtime.health = async value => [...await health(value), { name: 'release', status: 'PASS', message: 'New authorized release' }];
  await t.monitor.reconcileRelease({ runId: target.runId, domain: target.domain, previousRelease: target.release, release: 'e'.repeat(64) });
  const updated = await t.monitor.report(); assert.equal(updated.verification.notificationVerified, true);
  assert.deepEqual(updated.notifications, report.notifications); assert.deepEqual(updated.drill, report.drill); assert.deepEqual(updated.history, report.history); assert.equal(t.sent.length, 2);
  t.advance(20); assert.equal((await t.monitor.report()).verification.operational, false);
});
test('cloud fetch is restricted to the configured HTTPS root and never follows a redirect', async () => {
  let requests = 0;
  const result = await cloudHealth(target, async (url, options) => { requests++; assert.equal(url, 'https://example.test/'); assert.equal(options?.redirect, 'manual'); assert.ok(options?.signal); return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } }); });
  assert.equal(requests, 1); assert.equal(result.find(c => c.name === 'http')?.status, 'FAIL'); assert.equal(result.find(c => c.name === 'release')?.status, 'UNKNOWN');
  const failed = await cloudHealth(target, async () => { throw Error('sensitive provider diagnostic'); }); assert.equal(failed.find(c => c.name === 'https')?.status, 'FAIL'); assert.ok(!JSON.stringify(failed).includes('sensitive'));
});
test('cloud public endpoint cannot forge scheduled checks or mutate configuration without authentication', async () => {
  const t = setup(); let internal = 0;
  const env = { TARGET: JSON.stringify(target), LAUNCHKIT_BUSINESS: target.runId, MONITOR_BUILD: 'build', ADMIN_TOKEN: 'c'.repeat(64), EMAIL: { send: t.runtime.send }, MONITOR: { idFromName: () => 'id', get: () => ({ fetch: async () => { internal++; return Response.json({ ok: true }); } }) } };
  assert.equal((await worker.fetch(new Request('https://monitor/config', { method: 'POST', body: '{}' }), env)).status, 401);
  assert.equal((await worker.fetch(new Request('https://monitor/cron', { method: 'POST', headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` } }), env)).status, 404); assert.equal(internal, 0);
  await worker.scheduled({ scheduledTime: t.now(), cron: '*/5 * * * *' }, env); assert.equal(internal, 1);
  const object = new MonitorState({ storage: t.storage }, env); object.monitor = t.monitor;
  await t.monitor.configure({ enabled: true, intervalMinutes: 5, notifications: true }); await t.monitor.armVerification(); t.advance(5); await t.monitor.scheduled(t.now());
  const receipt = t.sent[0].text.match(/token=([a-f0-9]{64})/)![1];
  await object.fetch(new Request(`https://monitor/receipt?token=${receipt}`)); assert.equal((await t.monitor.report()).notifications[0].status, 'ACCEPTED');
  await object.fetch(new Request(`https://monitor/receipt?token=${receipt}`, { method: 'POST' })); assert.equal((await t.monitor.report()).notifications[0].status, 'CONFIRMED');
});
test('cloud unknown observations do not resolve incidents, and changed intervals do not duplicate checks', async () => {
  const t = setup(); await t.monitor.configure({ enabled: true, intervalMinutes: 15, notifications: true }); t.failure(true); t.advance(5); await t.monitor.scheduled(t.now());
  t.advance(5); await t.monitor.scheduled(t.now()); assert.equal((await t.monitor.report()).history.length, 1);
  t.runtime.health = async (): Promise<HealthCheck[]> => [{ name: 'https', status: 'UNKNOWN', message: 'Unknown' }, { name: 'http', status: 'UNKNOWN', message: 'Unknown' }];
  t.advance(10); await t.monitor.scheduled(t.now()); assert.equal((await t.monitor.report()).incidents.find(i => i.check === 'http')?.resolvedAt, undefined); assert.equal((await t.monitor.report()).last?.status, 'UNKNOWN');
});
