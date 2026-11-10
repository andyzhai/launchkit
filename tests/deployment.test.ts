import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Cloudflare, APIError } from '../src/adapters/cloudflare.ts';
import { deploy, type DeploymentTools } from '../src/adapters/wrangler.ts';
import { Journal } from '../src/workflow/journal.ts';
import { Pause, type Context } from '../src/workflow/types.ts';
const accountId = 'a'.repeat(32);
const reply = (result: unknown, status = 200, code?: number) => new Response(JSON.stringify({ success: status === 200, result, errors: code ? [{ code, message: 'provider body must not be logged' }] : [] }), { status });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'launchkit-deploy-')); const journal = new Journal(dir);
  const run = await journal.create({ appPath: dir, accountId, domain: 'example.test', inbox: 'owner@example.test', mode: 'live', www: true, outbound: false, seo: { approved: false, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } });
  run.resources.release = 'release-under-test'; await journal.save(run);
  const ctx: Context = { run, save: () => journal.save(run), approve: async () => { throw new Pause('WAITING_USER', 'Review existing deployment'); }, effect: async (key, before, action) => {
    assert.notEqual(run.operations[key]?.status, 'INTENT'); run.operations[key] = { status: 'INTENT', before, at: new Date().toISOString() }; await journal.save(run);
    const result = await action(); run.operations[key] = { ...run.operations[key], status: 'OBSERVED', result }; await journal.save(run); return result;
  } };
  const state = { created: false, visible: false, writes: 0, readsAfterCreate: 0, delayReads: 0, failStatus: 0, failCode: 0, events: [] as string[] };
  const path = `/accounts/${accountId}/workers/scripts/lk-${run.id}/deployments`;
  const cf = new Cloudflare(accountId, { cloudflare: 'test-only-token' }, async (input, init) => {
    const endpoint = new URL(String(input)).pathname.replace(/^\/client\/v4/, ''); assert.equal(init?.method, 'GET'); state.events.push(endpoint);
    if (endpoint.endsWith('/workers/subdomain')) return reply({ subdomain: 'existing-account' });
    assert.equal(endpoint, path);
    if (state.failStatus) return reply(null, state.failStatus, state.failCode);
    if (!state.created || ++state.readsAfterCreate <= state.delayReads) return reply(null, 404, 10007);
    return reply({ deployments: [{ id: 'deployment-1' }] });
  });
  const tools: DeploymentTools = {
    command: async (_executable, args, _cwd, env) => {
      state.events.push('wrangler deploy'); state.writes++;
      assert.equal(args[1], 'deploy'); assert.ok(!args.includes('--temporary')); assert.equal(env?.CLOUDFLARE_ACCOUNT_ID, accountId);
      const config = JSON.parse(await readFile(args[args.indexOf('--config') + 1], 'utf8'));
      assert.equal(config.name, `lk-${run.id}`); assert.equal(config.account_id, accountId); assert.equal(config.workers_dev, true); assert.equal(config.assets.directory, dir);
      state.created = true; return 'Deployment submitted';
    },
    fetch: async input => {
      state.events.push('preview GET'); assert.equal(String(input), `https://lk-${run.id}.existing-account.workers.dev`);
      return new Response('site', { status: state.visible ? 200 : 404, headers: state.visible ? { 'X-LaunchKit-Release': run.resources.release } : {} });
    },
    sleep: async () => {}
  };
  return { dir, journal, run, ctx, state, cf, tools, path };
}
test('first deployment: nonexistent Worker (404/10007) is created by Wrangler and verified after propagation', async () => {
  const t = await fixture(); t.state.delayReads = 1;
  t.tools.sleep = async () => { t.state.visible = true; };
  const result = await deploy(t.ctx, t.cf, t.dir, t.tools);
  assert.equal(t.state.writes, 1); assert.equal(result.deploymentId, 'deployment-1'); assert.equal(result.releaseVerified, true);
  const write = t.state.events.indexOf('wrangler deploy'); assert.ok(write > 0); assert.ok(t.state.events.slice(write + 1).includes(t.path));
  assert.equal((await t.journal.load(t.run.id)).resources.deployedRelease, t.run.resources.release);
});
test('propagation timeout waits and resume reconciles without a second Wrangler deployment', async () => {
  const t = await fixture(); t.state.delayReads = 100;
  await assert.rejects(deploy(t.ctx, t.cf, t.dir, t.tools), e => e instanceof Pause && e.status === 'WAITING_PROVIDER' && e.evidence.endpoint === `GET ${t.path}`);
  assert.equal(t.run.resources.deployedRelease, undefined); assert.equal(t.state.writes, 1);
  const restored = await t.journal.load(t.run.id); Object.assign(t.run, restored);
  t.state.delayReads = 0; t.state.visible = true;
  await deploy(t.ctx, t.cf, t.dir, t.tools); assert.equal(t.state.writes, 1);
});
test('visible deployment record alone does not count as a verified public release', async () => {
  const t = await fixture();
  await assert.rejects(deploy(t.ctx, t.cf, t.dir, t.tools), e => e instanceof Pause && e.status === 'WAITING_PROVIDER');
  assert.equal(t.run.resources.deployedRelease, undefined); assert.equal(t.state.writes, 1);
  await assert.rejects(deploy(t.ctx, t.cf, t.dir, t.tools), e => e instanceof Pause && e.status === 'WAITING_PROVIDER'); assert.equal(t.state.writes, 1);
});
test('unknown Wrangler outcome reconciles the observed release after restart', async () => {
  const t = await fixture(); const submit = t.tools.command;
  t.tools.command = async (...args) => { await submit(...args); throw Error('process interrupted after upload'); };
  await assert.rejects(deploy(t.ctx, t.cf, t.dir, t.tools), /interrupted/);
  assert.equal(t.run.operations[`deploy:${t.run.resources.release}`].status, 'INTENT'); t.state.visible = true;
  await deploy(t.ctx, t.cf, t.dir, t.tools);
  assert.equal(t.state.writes, 1); assert.equal(t.run.operations[`deploy:${t.run.resources.release}`].status, 'OBSERVED');
});
test('unrelated 404 and permission failures are not treated as missing Workers', async () => {
  for (const [status, code] of [[404, 9999], [403, 10007], [401, 10000]]) {
    const t = await fixture(); t.state.failStatus = status; t.state.failCode = code;
    await assert.rejects(deploy(t.ctx, t.cf, t.dir, t.tools), e => e instanceof APIError && e.status === status && e.endpoint === `GET ${t.path}` && e.codes[0] === code);
    assert.equal(t.state.writes, 0);
  }
});
test('an unrelated existing Worker deployment still requires replacement approval', async () => {
  const t = await fixture(); t.state.created = true;
  await assert.rejects(deploy(t.ctx, t.cf, t.dir, t.tools), e => e instanceof Pause && e.status === 'WAITING_USER'); assert.equal(t.state.writes, 0);
});
