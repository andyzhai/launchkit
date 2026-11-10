import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/workflow/journal.ts';
import { Vault } from '../src/security/tokens.ts';
import { Pause, type StepName, type Run } from '../src/workflow/types.ts';
import { CloudController } from '../src/operate/cloud/controller.ts';
import { CloudMonitor } from '../src/operate/cloud/engine.ts';
import worker, { MonitorState } from '../src/operate/cloud/worker.ts';
import type { CloudStorage, CloudState, CloudTarget, CloudRuntime } from '../src/operate/cloud/types.ts';
import { startServer } from '../src/ui/server.ts';

const oldRelease = 'b'.repeat(64), newRelease = 'c'.repeat(64);
async function setup() {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-release-'))), vault = new Vault(journal.dir);
  vault.values = { monitoring: 'd'.repeat(64) };
  const run = await journal.create({ appPath: journal.dir, accountId: 'a'.repeat(32), domain: 'example.test', inbox: 'owner@example.test', mode: 'live', outbound: false, www: false, seo: { approved: false, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } });
  run.resources = { release: newRelease, deployedRelease: newRelease, url: 'https://example.test' }; run.status = 'LIVE_VERIFIED';
  for (const step of Object.values(run.steps)) step.status = 'VERIFIED';
  run.steps.prepare.evidence = { release: newRelease }; run.steps.verify.evidence = { url: run.resources.url }; await journal.save(run);
  const target: CloudTarget = { runId: run.id, domain: run.config.domain, release: oldRelease, recipient: run.config.inbox, sender: `monitor@${run.config.domain}`, origin: `https://lk-monitor-${run.id}.example.workers.dev` };
  let stored: CloudState | undefined, now = Date.parse('2026-10-28T18:00:00Z'), published = newRelease, unavailable = false;
  const sent: string[] = [], paths: string[] = [];
  const storage: CloudStorage = { get: async () => structuredClone(stored) as any, put: async (_key, value) => { stored = structuredClone(value) as CloudState; }, setAlarm: async () => {}, deleteAlarm: async () => {} };
  const runtime: CloudRuntime = { now: () => now, uuid: () => crypto.randomUUID(), health: async expected => {
    assert.equal(expected.domain, target.domain); assert.equal(expected.recipient, target.recipient);
    return [ { name: 'https', status: unavailable ? 'UNKNOWN' : 'PASS', message: 'TLS' }, { name: 'http', status: 'PASS', message: 'HTTP 200' },
      { name: 'release', status: expected.release === published ? 'PASS' : 'FAIL', message: 'Release check' } ];
  }, send: async message => { sent.push(message.subject); } };
  const monitor = new CloudMonitor(storage, target, runtime);
  let loseResponse = false;
  const controller = new CloudController(journal, vault, {
    cf: () => { throw Error('No deployment credentials may be used for release sync'); }, command: async () => { throw Error('No deployments allowed'); },
    fetch: async (url, options) => {
      paths.push(new URL(String(url)).pathname);
      assert.equal(options?.redirect, 'error');
      const response = await worker.fetch(new Request(String(url), options), env);
      if (String(url).endsWith('/release') && loseResponse) { loseResponse = false; throw Error('Lost response after durable write'); }
      return response;
    }
  });
  const env = { TARGET: JSON.stringify(target), LAUNCHKIT_BUSINESS: run.id, MONITOR_BUILD: 'build', ADMIN_TOKEN: controller.token(run.id), EMAIL: { send: runtime.send }, MONITOR: { idFromName: () => run.id, get: () => object } };
  const object = new MonitorState({ storage }, env); object.monitor = monitor;
  await controller.save({ runId: run.id, worker: `lk-monitor-${run.id}`, target, build: 'build', status: 'DEPLOYED', updatedAt: new Date(now).toISOString() });
  return { run, journal, vault, controller, monitor, storage, runtime, target, env, paths, sent,
    advance: () => { now += 5 * 60_000; return now; }, publish: (release: string) => { published = release; }, unavailable: (value: boolean) => { unavailable = value; }, loseResponse: () => { loseResponse = true; } };
}

test('verified release reconciliation survives a lost response, preserves incidents and deduplicates recovery', async () => {
  const t = await setup(); await t.monitor.configure({ enabled: true, intervalMinutes: 5, notifications: true });
  await t.monitor.scheduled(t.advance()); // New deployment is visible while monitor still expects the old baseline.
  const before = await t.monitor.load(); assert.equal(t.sent.length, 1); assert.equal(before.incidents[0].check, 'release');
  t.loseResponse(); await assert.rejects(t.controller.reconcileRelease(t.run.id), /pending/);
  assert.equal((await t.controller.load(t.run.id))?.releaseSync?.status, 'PENDING');
  assert.equal((await t.monitor.report()).target.release, newRelease);
  await t.controller.reconcileRelease(t.run.id); assert.equal(t.paths.filter(p => p === '/release').length, 1);
  assert.equal((await t.controller.load(t.run.id))?.releaseSync?.status, 'SYNCED');
  const after = await t.monitor.load();
  for (const key of ['history', 'incidents', 'notifications', 'settings', 'processedCron', 'lastCheckScheduledTime', 'emailBudget'] as const) assert.deepEqual(after[key], before[key]);
  assert.equal(after.events.length, before.events.length + 1); assert.equal(t.sent.length, 1);
  const restarted = new CloudMonitor(t.storage, t.target, t.runtime);
  await restarted.scheduled(t.advance()); await restarted.scheduled(t.advance());
  assert.equal(t.sent.length, 2); assert.match(t.sent[1], /RECOVERY/); assert.ok((await restarted.report()).incidents[0].resolvedAt);
  assert.equal((await restarted.report()).last?.status, 'HEALTHY');
});

test('release update requires the authorized identity, CAS baseline and fresh public HTTPS/release evidence', async () => {
  const t = await setup(); const body = { runId: t.run.id, domain: t.target.domain, previousRelease: oldRelease, release: newRelease };
  for (const change of [{ domain: 'foreign.test' }, { runId: 'f'.repeat(24) }, { recipient: 'other@example.test' }, { release: 'invalid' }, { previousRelease: 'f'.repeat(64) }]) await assert.rejects(t.monitor.reconcileRelease({ ...body, ...change }));
  t.publish(oldRelease); await assert.rejects(t.monitor.reconcileRelease(body), /not publicly verified/);
  t.publish(newRelease); t.unavailable(true); await assert.rejects(t.monitor.reconcileRelease(body), /not publicly verified/);
  assert.equal((await t.monitor.report()).target.release, oldRelease);
  assert.equal((await worker.fetch(new Request(`${t.target.origin}/release`, { method: 'POST', body: JSON.stringify(body) }), t.env)).status, 401);
  t.unavailable(false); await t.monitor.reconcileRelease(body); await t.monitor.reconcileRelease(body);
  assert.equal((await t.monitor.load()).events.length, 1); assert.equal((await t.monitor.load()).history.length, 0); assert.equal(t.sent.length, 0);
  await assert.rejects(t.monitor.reconcileRelease({ ...body, release: 'e'.repeat(64) }), /Expected release changed/);
  assert.equal((await t.monitor.report()).verification.scheduledCheck, false);
});

test('failed, partial, stale, unbound and simulated launches cannot change expected release, even via monitor deployment', async () => {
  const t = await setup();
  const mutations: ((run: Run) => void)[] = [
    r => { r.status = 'FAILED'; }, r => { r.status = 'LIVE_PARTIALLY_CONFIGURED'; }, r => { r.status = 'RUNNING'; },
    r => { r.steps.verify.status = 'WAITING_PROVIDER'; }, r => { r.steps.preview.status = 'FAILED'; }, r => { r.steps.binding.status = 'NOT_STARTED'; },
    r => { r.steps.incoming.status = 'WAITING_USER'; }, r => { r.resources.deployedRelease = oldRelease; },
    r => { r.steps.prepare.evidence = { release: oldRelease }; }, r => { r.steps.verify.evidence = { url: 'https://preview.workers.dev' }; },
    r => { r.resources.url = 'https://foreign.test'; }, r => { r.resources.supersededBy = 'other'; }, r => { r.config.mode = 'mock'; }
  ];
  for (const mutate of mutations) {
    const run = structuredClone(t.run); mutate(run); await t.journal.save(run);
    await assert.rejects(t.controller.reconcileRelease(run.id), /fully verified/);
    await assert.rejects(t.controller.deploy(run.id, { authorized: true, enabled: true, notifications: true, intervalMinutes: 5 }), /fully verified/);
  }
  assert.deepEqual(t.paths, []); assert.equal((await t.monitor.report()).target.release, oldRelease);
  const changed = structuredClone(t.run); changed.config.domain = 'another.test'; changed.resources.url = 'https://another.test'; changed.steps.verify.evidence = { url: changed.resources.url }; await t.journal.save(changed);
  await assert.rejects(t.controller.reconcileRelease(changed.id), /identity differs/); assert.deepEqual(t.paths, []);
});

test('pending baseline is visible after interruption; retry works while disabled and cannot widen cloud authorization', async () => {
  const t = await setup(); // Successful launch persisted, but process stopped before its completion hook.
  assert.equal((await t.controller.report(t.run.id)).releasePending, true);
  const original = t.controller.tools.fetch;
  t.controller.tools.fetch = async () => Response.json({ target: { ...t.target, recipient: 'other@example.test' } });
  await assert.rejects(t.controller.reconcileRelease(t.run.id), /pending/); assert.equal((await t.monitor.report()).target.release, oldRelease);
  t.controller.tools.fetch = original; await t.controller.action(t.run.id, 'release', { release: 'f'.repeat(64), domain: 'foreign.test' });
  assert.equal((await t.controller.report(t.run.id)).releasePending, false);
  assert.equal((await t.monitor.report()).settings.enabled, false); assert.equal((await t.monitor.report()).target.release, newRelease);
  assert.equal(t.sent.length, 0);
});

test('M1 server reconciles only completed live launches and leaves a verified launch intact when monitor is unavailable', async () => {
  const t = await setup(); let failure: StepName | undefined = 'verify'; let waiting = false;
  const provider = { step: async (name: StepName, ctx: any) => {
    if (name === failure) { if (waiting) throw new Pause('WAITING_PROVIDER', 'Propagation pending'); throw Error('Deployment verification failed'); }
    if (name === 'prepare') return { release: ctx.run.resources.release };
    if (name === 'verify') return { url: ctx.run.resources.url };
    return {};
  } };
  const { server, origin } = await startServer({ journal: t.journal, vault: t.vault, provider: () => provider, cloudController: t.controller });
  try {
    const page = await fetch(origin), html = await page.text();
    const headers = { Cookie: page.headers.get('set-cookie')!.split(';')[0], 'X-LaunchKit-Token': html.match(/name="launchkit-session" content="([^"]+)"/)![1], 'Content-Type': 'application/json', Origin: origin };
    const post = (path: string) => fetch(`${origin}/api/runs/${t.run.id}/${path}`, { method: 'POST', headers, body: '{}' });
    async function idle() {
      for (let i = 0; i < 300; i++) { const status = await (await fetch(`${origin}/api/status`, { headers })).json(); if (!status.active) return status; await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.fail('Launch did not finish');
    }
    for (const step of ['preview', 'binding', 'verify'] as const) {
      failure = step; assert.equal((await post('resume')).status, 202); await idle(); assert.equal(t.paths.length, 0);
    }
    waiting = true; assert.equal((await post('resume')).status, 202); await idle(); assert.equal(t.paths.length, 0);
    failure = undefined;
    const transport = t.controller.tools.fetch; t.controller.tools.fetch = async () => new Response(null, { status: 404 });
    assert.equal((await post('resume')).status, 202); assert.match((await idle()).backgroundError, /sync is pending/);
    assert.equal((await t.journal.load(t.run.id)).status, 'LIVE_VERIFIED'); assert.equal((await t.monitor.report()).target.release, oldRelease);
    t.controller.tools.fetch = transport;
    assert.equal((await post('cloud/release')).status, 200); assert.equal((await t.monitor.report()).target.release, newRelease);
    assert.equal((await idle()).backgroundError, undefined);
    // Another successful M1 launch updates automatically, with no separate monitor deployment.
    const next = await t.journal.load(t.run.id); next.resources.release = next.resources.deployedRelease = 'e'.repeat(64); await t.journal.save(next); t.publish(next.resources.release);
    assert.equal((await post('resume')).status, 202); await idle();
    assert.equal((await t.monitor.report()).target.release, next.resources.release);
    assert.equal(t.paths.filter(p => p === '/release').length, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
