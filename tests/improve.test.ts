import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Journal, atomicJSON } from '../src/workflow/journal.ts';
import { auditDistribution } from '../src/adapters/app-vite.ts';
import { Discoverability } from '../src/grow/audit.ts';
import { Improvements, changeTitle } from '../src/grow/improve.ts';
import { Vault } from '../src/security/tokens.ts';
import { MockProvider } from '../src/adapters/mock.ts';
import { startServer } from '../src/ui/server.ts';
import { M1ImprovementPublisher } from '../src/grow/improve-publisher.ts';
import type { Cloudflare } from '../src/adapters/cloudflare.ts';

export async function fixture() {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-improve-')));
  const run = await journal.create({ appPath: journal.dir, domain: 'fixture.test', accountId: 'fixture', mode: 'live', inbox: '', outbound: false, www: false, seo: { approved: true, title: 'Old name', description: 'A tool for teams.' }, analytics: { approved: false, publicPaths: ['/'] } });
  const dir = join(journal.dir, 'baseline'); await mkdir(dir);
  let html = '<html><head><title>Old name</title><meta property="og:title" content="Old name"><meta name="description" content="A tool for teams."></head><body><h1>Product name</h1></body></html>';
  await writeFile(join(dir, 'index.html'), html); await writeFile(join(dir, 'robots.txt'), 'User-agent: GPTBot\nDisallow: /');
  run.steps.verify.status = 'VERIFIED'; run.status = 'LIVE_VERIFIED';
  Object.assign(run.resources, { url: 'https://fixture.test', release: 'baseline', deploymentId: 'before-deployment', worker: `lk-${run.id}`, publishDir: dir, manifest: await auditDistribution(dir) }); await journal.save(run);
  let reads = 0; let sends = 0; let identity = 'connection'; let failure = false; let visible = true;
  const audit = new Discoverability(journal, { resolve: async () => [{ address: '8.8.8.8', family: 4 }], read: async (_host, path) => { reads++; return { status: 200, type: path === '/' ? 'text/html' : path === '/robots.txt' ? 'text/plain' : 'text/xml', body: path === '/' ? html : '' }; } });
  const publisher = { identity: () => identity, preflight: async () => {}, publish: async (_run: any, p: any) => { sends++; html = await readFile(join(p.directory, 'index.html'), 'utf8'); if (failure) throw Error('sensitive provider detail'); return { deploymentId: 'after-deployment' }; }, verify: async () => { if (!visible) throw Error('unavailable'); return { deploymentId: 'after-deployment' }; } };
  const improvements = new Improvements(journal, audit, publisher);
  await audit.refresh(run.id);
  const prepare = async (title = 'Product name') => { await improvements.action(run.id, 'prepare', { title }); return (await improvements.load(run.id)).proposals.at(-1)!; };
  return { journal, run, audit, publisher, improvements, prepare, sends: () => sends, reads: () => reads, identity: (value: string) => { identity = value; }, fail: () => { failure = true; }, visibility: (value: boolean) => { visible = value; } };
}

test('Title loop previews only metadata, preserves original assets, requires exact approval and verifies independently', async () => {
  const f = await fixture(); const p = await f.prepare(); const body = { proposalId: p.id, previewHash: p.previewHash };
  assert.equal(f.sends(), 0); assert.equal(p.changes.length, 2);
  assert.match(await readFile(join(f.run.resources.publishDir, 'index.html'), 'utf8'), /Old name/);
  assert.equal(await readFile(join(p.directory, 'robots.txt'), 'utf8'), 'User-agent: GPTBot\nDisallow: /');
  await assert.rejects(f.improvements.action(f.run.id, 'publish', { ...body, previewHash: 'wrong' }), /exact/);
  await f.improvements.action(f.run.id, 'publish', body); assert.equal(f.sends(), 1);
  assert.equal((await f.improvements.load(f.run.id)).proposals[0].status, 'PUBLISHED');
  await assert.rejects(f.improvements.action(f.run.id, 'publish', body));
  await assert.rejects(f.prepare(), /verification/);
  const reads = f.reads(); await f.improvements.report(f.run.id); assert.equal(f.reads(), reads);
  await f.audit.refresh(f.run.id); assert.equal(f.sends(), 1);
  await f.improvements.action(f.run.id, 'verify', body);
  const result = (await f.improvements.load(f.run.id)).proposals[0]; assert.equal(result.status, 'VERIFIED'); assert.equal(result.after?.result, 'CORRECTED');
  assert.match(result.before.find(x => x.check === 'metadata')!.evidence, /Old name/);
  assert.match(result.after!.findings.find(x => x.check === 'metadata')!.evidence, /Product name/);
  assert.equal((await f.journal.load(f.run.id)).config.seo.title, 'Product name');
  await f.improvements.action(f.run.id, 'verify', body); assert.equal(f.sends(), 1);
});

test('Edited, expired, declined, changed-connection and changed-release proposals cannot publish', async () => {
  for (const change of ['edit', 'expiry', 'decline', 'connection', 'release', 'artifact']) {
    const f = await fixture(); const p = await f.prepare(); const body = { proposalId: p.id, previewHash: p.previewHash };
    if (change === 'edit') await f.prepare('Another name');
    if (change === 'expiry') { const state = await f.improvements.load(f.run.id); state.proposals[0].createdAt = '2000-01-01T00:00:00Z'; await f.improvements.save(state); }
    if (change === 'decline') await f.improvements.action(f.run.id, 'decline', body);
    if (change === 'connection') f.identity('different');
    if (change === 'release') { const run = await f.journal.load(f.run.id); run.resources.release = 'different'; await f.journal.save(run); }
    if (change === 'artifact') await writeFile(join(p.directory, 'index.html'), 'altered');
    if (change === 'artifact') { await f.improvements.action(f.run.id, 'publish', body); assert.equal((await f.improvements.load(f.run.id)).proposals[0].status, 'FAILED'); }
    else await assert.rejects(f.improvements.action(f.run.id, 'publish', body));
    assert.equal(f.sends(), 0, change);
  }
});

test('Unknown and interrupted sends survive restart without retry; missing evidence remains unresolved', async () => {
  const f = await fixture(); const p = await f.prepare(); const body = { proposalId: p.id, previewHash: p.previewHash }; f.fail();
  await f.improvements.action(f.run.id, 'publish', body);
  assert.equal((await f.improvements.load(f.run.id)).proposals[0].status, 'UNKNOWN');
  assert.doesNotMatch(JSON.stringify(await f.improvements.report(f.run.id)), /sensitive provider/);
  const restarted = new Improvements(f.journal, f.audit, f.publisher); f.visibility(false);
  await restarted.action(f.run.id, 'verify', body); assert.equal((await restarted.load(f.run.id)).proposals[0].status, 'UNKNOWN');
  await assert.rejects(restarted.action(f.run.id, 'publish', body)); await assert.rejects(restarted.assertSettled(f.run.id));
  const state = await restarted.load(f.run.id); state.proposals[0].status = 'INTENT'; await restarted.save(state);
  f.visibility(true); await restarted.action(f.run.id, 'verify', body); assert.equal((await restarted.load(f.run.id)).proposals[0].status, 'VERIFIED'); assert.equal(f.sends(), 1);
  // Simulate a crash between the saved launch receipt and final proposal save.
  const completed = await restarted.load(f.run.id); completed.proposals[0].status = 'INTENT'; await restarted.save(completed);
  await restarted.action(f.run.id, 'verify', body); assert.equal((await restarted.load(f.run.id)).proposals[0].status, 'VERIFIED'); assert.equal(f.sends(), 1);
});

test('Bounded factual title input and conservative markup handling', async () => {
  const f = await fixture();
  for (const title of ['', ' padded ', '<script>', 'x'.repeat(121), 'line\nbreak']) await assert.rejects(f.prepare(title));
  for (const html of ['<head></head>', '<head><title>A</title><title>B</title></head>', '<head><title data-x="1">A</title></head>']) assert.throws(() => changeTitle(html, 'Name'));
  assert.equal(changeTitle('<head><title>A</title><meta property="og:title" content="A"></head>', 'A & B $&').html, '<head><title>A &amp; B $&amp;</title><meta property="og:title" content="A &amp; B $&amp;"></head>');
  const state = await f.audit.report(f.run.id); await atomicJSON(f.audit.path(f.run.id), { schema: 1, inspectionVersion: 2, runId: f.run.id, at: '2000-01-01T00:00:00Z', findings: state.findings });
  await assert.rejects(f.prepare(), /Refresh/);
});

test('Improvement API enforces auth, business isolation, shared exclusion and no deployment on GET or tick', { timeout: 15_000 }, async () => {
  const f = await fixture(); const p = await f.prepare();
  const other = await f.journal.create({ ...f.run.config, domain: 'second.test' }); other.resources.url = 'https://second.test'; other.status = 'LIVE_VERIFIED'; await f.journal.save(other);
  let entered!: () => void; let release = () => {};
  const arrived = new Promise<void>(r => { entered = r; }); const wait = new Promise<void>(r => { release = r; });
  const originalPreflight = f.publisher.preflight; f.publisher.preflight = async () => { entered(); await wait; await originalPreflight(); };
  const { server, origin, tick } = await startServer({ journal: f.journal, vault: new Vault(f.journal.dir), provider: () => new MockProvider(f.journal.dir), improvementPublisher: f.publisher });
  try {
    const response = await fetch(origin); const html = await response.text();
    const headers = { Cookie: response.headers.get('set-cookie')!.split(';')[0], 'X-LaunchKit-Token': html.match(/name="launchkit-session" content="([^"]+)"/)![1], Origin: origin, 'Content-Type': 'application/json' };
    const path = `/api/runs/${f.run.id}/grow/improvements`;
    const post = (url: string, body: unknown = {}) => fetch(origin + url, { method: 'POST', headers, body: JSON.stringify(body) });
    const body = { proposalId: p.id, previewHash: p.previewHash };
    assert.equal((await fetch(origin + path)).status, 403);
    assert.equal((await fetch(origin + path + '/publish', { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: JSON.stringify(body) })).status, 403);
    assert.equal((await fetch(origin + path + '/publish', { headers })).status, 404);
    assert.equal((await post(`/api/runs/${other.id}/grow/improvements/publish`, body)).status, 400);
    await fetch(origin + path, { headers }); await tick(); assert.equal(f.sends(), 0);
    const publishing = post(path + '/publish', body); await arrived;
    for (const url of ['/api/connections', `/api/runs/${f.run.id}/resume`, path + '/prepare', `/api/runs/${f.run.id}/grow/audit/refresh`]) assert.equal((await post(url)).status, 400, url);
    await tick(); release(); assert.equal((await publishing).status, 200); assert.equal(f.sends(), 1);
    assert.equal((await post(`/api/runs/${f.run.id}/resume`)).status, 400);
    assert.equal((await fetch(origin + path, { headers })).status, 200); assert.equal(f.sends(), 1);
  } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('M1 publisher confines approval and effects to one existing Worker deployment; verification cannot deploy', async () => {
  const f = await fixture(); const p = await f.prepare(); let sends = 0; let checks = 0; let deployment = p.baseDeployment; let bound = true;
  const cf = { account: (s: string) => '/accounts/fixture' + s, list: async () => bound ? [{ hostname: f.run.config.domain, service: `lk-${f.run.id}` }] : [], get: async () => ({ deployments: [{ id: deployment }] }) } as unknown as Cloudflare;
  const publisher = new M1ImprovementPublisher(new Vault(f.journal.dir), { cloudflare: () => cf,
    verifyHTTP: async () => { checks++; return { url: 'https://fixture.test', tls: 'fixture', assets: 2, wasm: 0, hashes: 'fixture', securityHeaders: true, noindex: false, verifiedAt: new Date().toISOString() }; },
    deploy: async ctx => {
      const details = { worker: `lk-${f.run.id}`, beforeDeploymentId: p.baseDeployment, newRelease: p.release, domain: f.run.config.domain };
      await assert.rejects(ctx.approve('dns', details)); await assert.rejects(ctx.approve('deployment', { ...details, beforeDeploymentId: 'changed' }));
      await ctx.approve('deployment', details);
      await assert.rejects(ctx.effect('other-effect', {}, async () => { sends++; }));
      await ctx.effect(`deploy:${p.release}`, {}, async () => { sends++; });
      await assert.rejects(ctx.effect(`deploy:${p.release}`, {}, async () => { sends++; }));
      return { url: 'https://preview.test', worker: `lk-${f.run.id}`, deploymentId: 'new-deployment', releaseVerified: true };
    }
  });
  await publisher.preflight(f.run, p); assert.equal(checks, 1);
  deployment = 'changed'; await assert.rejects(publisher.preflight(f.run, p)); await assert.rejects(publisher.publish(f.run, p)); assert.equal(sends, 0);
  deployment = p.baseDeployment; await publisher.publish(f.run, p); assert.equal(sends, 1);
  deployment = 'new-deployment'; await publisher.verify(f.run, p); assert.equal(sends, 1); assert.equal(checks, 2);
  bound = false; await assert.rejects(publisher.verify(f.run, p));
});
