import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Journal } from '../src/workflow/journal.ts';
import { Runner } from '../src/workflow/runner.ts';
import { MockProvider, type MockOptions } from '../src/adapters/mock.ts';
import { registerSecret } from '../src/security/redaction.ts';
import type { LaunchConfig } from '../src/workflow/types.ts';
export const config = (): LaunchConfig => ({ appPath: resolve('tests/fixtures/vite-app'), accountId: 'mock-account', domain: 'example.test', inbox: 'owner@example.test', mode: 'mock', outbound: true, www: true, seo: { approved: true, title: 'Example business', description: 'An example application' }, analytics: { approved: true, publicPaths: ['/'] } });
async function setup(options: MockOptions = {}, edit?: (c: LaunchConfig) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'launchkit-test-')); const journal = new Journal(dir); await journal.init(); const input = config(); edit?.(input);
  const run = await journal.create(input); const provider = new MockProvider(dir, options); const runner = new Runner(journal, provider);
  return { dir, journal, provider, runner, run, execute: () => runner.execute(run.id), remote: async () => JSON.parse(await readFile(join(dir, `mock-${run.id}.json`), 'utf8')) };
}
test('A01 unauthenticated launch persists and waits only at connection', async () => { const t = await setup({ connected: false }); const r = await t.execute(); assert.equal(r.steps.discover.status, 'VERIFIED'); assert.equal(r.steps.connect.status, 'WAITING_USER'); assert.equal((await t.journal.load(r.id)).status, 'BLOCKED'); });
test('A02 simulated one-click happy path has complete evidence and no purchase', async () => { const t = await setup(); const r = await t.execute(); assert.equal(r.status, 'LIVE_VERIFIED'); assert.equal(r.resources.url, 'https://example.test'); assert.match(String(r.report?.verificationScope), /SIMULATED/); assert.equal((await t.remote()).counts.purchase, undefined); });
test('A03 owned domain never asks for registrar approval', async () => { const t = await setup(); const r = await t.execute(); assert.equal(r.approvals.length, 0); });
test('A04 unavailable domain offers alternatives without registration', async () => { const t = await setup({ owned: false, unavailable: true }); const r = await t.execute(); assert.equal(r.steps.domain.status, 'WAITING_USER'); assert.equal((r.steps.domain.evidence?.alternatives as string[]).length, 2); assert.equal(r.operations.purchase, undefined); });
test('A05 exact quote requires approval; denial cannot purchase', async () => { const t = await setup({ owned: false }); let r = await t.execute(); assert.equal(r.approvals[0].details.amount, '10.11'); await t.runner.decide(r.id, r.approvals[0].id, 'denied'); r = await t.execute(); assert.equal(r.steps.domain.status, 'WAITING_USER'); assert.equal(r.operations.purchase, undefined); });
test('A06 ambiguous purchase is reconciled without a second charge', async () => { const t = await setup({ owned: false, ambiguousPurchase: true }); let r = await t.execute(); await t.runner.decide(r.id, r.approvals[0].id, 'approved'); r = await t.execute(); assert.equal(r.steps.domain.status, 'NEEDS_RECONCILIATION'); r = await new Runner(t.journal, t.provider).execute(r.id); assert.equal(r.status, 'LIVE_VERIFIED'); assert.equal((await t.remote()).counts.purchase, 1); });
test('A07 rerun does not duplicate provider resources', async () => { const t = await setup(); await t.execute(); const before = (await t.remote()).counts; await t.execute(); assert.deepEqual((await t.remote()).counts, before); });
test('A08 interrupted after preview resumes without another build', async () => { const t = await setup({ failStep: 'binding' }); let r = await t.execute(); assert.equal(r.steps.preview.status, 'VERIFIED'); t.provider.options.failStep = undefined; r = await new Runner(t.journal, t.provider).execute(r.id); assert.equal(r.status, 'LIVE_VERIFIED'); assert.equal((await t.remote()).counts.build, 1); });
test('A09 MX and www collisions require exact approval', async () => { for (const options of [{ mxConflict: true }, { wwwConflict: true }]) { const t = await setup(options); const r = await t.execute(); assert.equal(r.approvals[0].kind, 'dns'); assert.ok(r.approvals[0].details.before); assert.equal(r.steps[options.mxConflict ? 'incoming' : 'binding'].status, 'WAITING_USER'); } });
test('A10 pending inbox verification is partial, then resumes', async () => { const t = await setup({ emailPending: true }); let r = await t.execute(); assert.equal(r.status, 'LIVE_PARTIALLY_CONFIGURED'); assert.equal(r.steps.incoming.status, 'WAITING_USER'); t.provider.options.emailPending = false; r = await t.execute(); assert.equal(r.status, 'LIVE_VERIFIED'); assert.equal((await t.remote()).counts.destination, 1); });
test('A13 analytics creation is not tracking verification', async () => { const t = await setup({ analyticsPending: true }); const r = await t.execute(); assert.equal(r.steps.analytics.status, 'WAITING_PROVIDER'); assert.equal(r.status, 'LIVE_PARTIALLY_CONFIGURED'); });
test('A14 SEO is not modified without owner consent', async () => { const t = await setup({}, c => { c.seo.approved = false; }); const r = await t.execute(); assert.equal(r.steps.seo.status, 'SKIPPED'); });
test('A15 known secrets never persist in journals or reports', async () => { const t = await setup(); const secret = 'sensitive-test-credential-12345'; registerSecret(secret); t.provider.step = async () => { throw Error(`provider failed ${secret}`); }; const r = await t.execute(); const text = await readFile(t.journal.path(r.id), 'utf8'); assert.ok(!text.includes(secret)); assert.match(text, /REDACTED/); });
test('A16 provider failure is durable and resumable', async () => { const t = await setup({ failStep: 'connect' }); let r = await t.execute(); assert.equal(r.status, 'FAILED'); assert.match(r.steps.connect.message!, /resume/); t.provider.options.failStep = undefined; r = await t.execute(); assert.equal(r.status, 'LIVE_VERIFIED'); });
test('A17 no purchase operation is invoked before exact approval', async () => { const t = await setup({ owned: false }); const r = await t.execute(); assert.equal(r.operations.purchase, undefined); assert.equal(r.steps.prepare.status, 'NOT_STARTED'); });
test('A20 final report explicitly does not claim ongoing monitoring', async () => { const t = await setup(); const r = await t.execute(); assert.equal(r.report?.ongoingMonitoring, false); });
test('A07 unresolved non-purchase mutations cannot duplicate a create on resume', async () => {
  const t = await setup(); let mutations = 0;
  t.provider.step = async (_name, ctx) => { await ctx.effect('create-resource', null, async () => { mutations++; throw Error('connection lost'); }); return {}; };
  await t.execute(); const r = await t.execute(); assert.equal(mutations, 1); assert.equal(r.steps.discover.status, 'NEEDS_RECONCILIATION');
});
test('A16 definitive provider rejection can be retried after account correction', async () => {
  const t = await setup(); let rejected = true;
  t.provider.step = async (name, ctx) => { if (name !== 'discover') return {}; await ctx.effect('create-resource', null, async () => { if (rejected) throw Object.assign(Error('forbidden'), { definitiveFailure: true }); return { id: 'resource' }; }); return {}; };
  let r = await t.execute(); assert.equal(r.operations['create-resource'].status, 'REJECTED'); rejected = false; r = await t.execute(); assert.equal(r.operations['create-resource'].status, 'OBSERVED');
});
test('changing saved preferences retains business identity and provider history', async () => {
  const t = await setup(); const before = await t.execute(); const input = { ...before.config, outbound: false };
  const changed = await t.journal.create(input); assert.equal(changed.id, before.id); assert.equal(changed.config.outbound, false); assert.equal(changed.resources.url, before.resources.url);
});

test('analytics is automatic and unselected outbound is SKIPPED', async () => {
  const t = await setup({}, c => { c.analytics.approved = false; c.outbound = false; });
  const r = await t.execute(); assert.equal(r.status, 'LIVE_VERIFIED');
  assert.equal(r.steps.analytics.status, 'VERIFIED'); assert.equal(r.steps.outgoing.status, 'SKIPPED');
  assert.equal((await t.remote()).counts.analytics, 1);
});

test('required or selected capabilities cannot be skipped to claim completion', async () => {
  for (const step of ['incoming', 'analytics'] as const) {
    const t = await setup(); const real = t.provider.step.bind(t.provider);
    t.provider.step = (name, ctx) => name === step ? Promise.resolve('SKIPPED') : real(name,ctx);
    const r = await t.execute(); assert.equal(r.steps[step].status, 'FAILED'); assert.equal(r.status, 'LIVE_PARTIALLY_CONFIGURED');
  }
});

test('failure of a prerequisite on recheck cannot reuse stale downstream success', async () => {
  const t = await setup(); await t.execute(); t.provider.options.failStep = 'connect';
  const r = await t.execute(); assert.equal(r.status, 'FAILED'); assert.equal(r.steps.binding.status, 'NOT_STARTED');
  assert.equal(r.steps.verify.evidence, undefined); assert.equal(r.steps.verify.status, 'NOT_STARTED');
});

test('changed and reverted settings invalidate old approvals while keeping mutation history', async () => {
  const t = await setup({mxConflict:true}); let r = await t.execute();
  const original = structuredClone(r.config); const id = r.approvals[0].id;
  await t.runner.decide(r.id,id,'approved'); r = await t.execute(); assert.equal(r.status,'LIVE_VERIFIED');
  await t.journal.create({...original,outbound:false}); await t.journal.create(original);
  r = await t.execute(); assert.equal(r.steps.incoming.status,'WAITING_USER');
  assert.notEqual(r.steps.incoming.evidence?.approvalId,id); assert.equal(r.approvals.find(a=>a.id===id)?.decision,'approved');
});
