import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/workflow/journal.ts';
import { Runner } from '../src/workflow/runner.ts';
import { MockProvider } from '../src/adapters/mock.ts';
import { Vault } from '../src/security/tokens.ts';
import { startServer } from '../src/ui/server.ts';
import { Operator } from '../src/operate/operator.ts';
import { MockOperatorProvider } from '../src/operate/provider.ts';

test('M2 API authenticates writes, schedules saved monitoring, prevents overlapping work, and recovers through approval gates', async () => {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-operate-api-')));
  const draft = await journal.create({ appPath: journal.dir, domain: 'example.test', accountId: 'mock', inbox: '', mode: 'mock', outbound: false, www: false, seo: { approved: false, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } });
  const launchProvider = new MockProvider(journal.dir); const run = await new Runner(journal, launchProvider).execute(draft.id);
  const monitor = new MockOperatorProvider(); const operator = new Operator(journal, () => monitor);
  await operator.configure(run.id, { enabled: true, intervalMinutes: 5, usageEnabled: true });
  let release!: () => void; let entered!: () => void;
  const enteredCheck = new Promise<void>(resolve => { entered = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
  const healthy = await monitor.health(); monitor.health = async () => { entered(); await wait; return healthy; };
  const { server, origin, tick } = await startServer({ journal, vault: new Vault(journal.dir), provider: () => launchProvider, operatorProvider: () => monitor });
  try {
    const page = await fetch(origin); const html = await page.text();
    const headers = { Cookie: page.headers.get('set-cookie')!.split(';')[0], 'X-LaunchKit-Token': html.match(/name="launchkit-session" content="([^"]+)"/)![1], 'Content-Type': 'application/json', Origin: origin };
    const path = `${origin}/api/runs/${run.id}/operate`;
    const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await fetch(path)).status, 403);
    assert.equal((await fetch(path, { method: 'POST', headers: { ...headers, Origin: 'https://foreign.test' }, body: '{}' })).status, 403);
    await tick(); await enteredCheck; // Persisted opt-in is discovered after server startup.
    assert.equal((await post(`${path}/check`, {})).status, 400);
    assert.equal((await post(`${origin}/api/runs/${run.id}/resume`, {})).status, 400);
    assert.equal((await post(path, { enabled: false, intervalMinutes: 5, usageEnabled: false })).status, 400);
    release();
    async function idle() { for (let i = 0; i < 200; i++) { if (!(await (await fetch(`${origin}/api/status`, { headers })).json()).active) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Operator did not finish'); }
    await idle();
    const report = await (await fetch(path, { headers })).json(); assert.equal(report.last.status, 'HEALTHY'); assert.equal(report.last.simulated, true); assert.equal(report.usage.requests, 1200);
    // A continuous monitoring backlog must not starve an interrupted launch.
    const interrupted = await journal.create({ ...run.config, domain: 'second.example.test' });
    const dueState = await operator.load(run.id); dueState.nextCheckAt = new Date(0).toISOString(); await operator.save(dueState);
    await tick(); await idle(); assert.equal((await journal.load(interrupted.id)).status, 'LIVE_VERIFIED');
    const before = JSON.parse(await readFile(join(journal.dir, `mock-${run.id}.json`), 'utf8')).counts;
    assert.equal((await post(`${path}/recover`, {})).status, 202); await idle();
    assert.deepEqual(JSON.parse(await readFile(join(journal.dir, `mock-${run.id}.json`), 'utf8')).counts, before);
    launchProvider.options.mxConflict = true;
    assert.equal((await post(`${path}/recover`, {})).status, 202); await idle();
    const pending = await journal.load(run.id); assert.equal(pending.steps.incoming.status, 'WAITING_USER'); assert.equal(pending.approvals.at(-1)?.decision, undefined);
    assert.equal((await operator.load(run.id)).events.filter(e => e.kind === 'RECOVERY').length, 2);
    assert.equal((await post(path, { enabled: false, intervalMinutes: 5, usageEnabled: false })).status, 200);
    const count = (await operator.load(run.id)).history.length; await tick(); await idle(); assert.equal((await operator.load(run.id)).history.length, count);
  } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
