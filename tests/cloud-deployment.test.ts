import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/workflow/journal.ts';
import { Vault } from '../src/security/tokens.ts';
import { Cloudflare, APIError } from '../src/adapters/cloudflare.ts';
import { CloudController } from '../src/operate/cloud/controller.ts';

test('cloud deployment inspects ownership/cost, reconciles partial upload, and isolates credentials', async () => {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-cloud-deploy-'))); const vault = new Vault(journal.dir);
  vault.values = { cloudflare: 'test-deployment-token', monitoring: 'd'.repeat(64) };
  const run = await journal.create({ appPath: journal.dir, accountId: 'a'.repeat(32), domain: 'example.test', inbox: 'owner@example.test', mode: 'live', outbound: false, www: false, seo: { approved: false, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } });
  run.resources = { url: 'https://example.test', release: 'b'.repeat(64), deployedRelease: 'b'.repeat(64), zone: { id: 'zone' } };
  run.status = 'LIVE_VERIFIED'; for (const step of Object.values(run.steps)) step.status = 'VERIFIED';
  run.steps.prepare.evidence = { release: run.resources.release }; run.steps.verify.evidence = { url: run.resources.url }; await journal.save(run);
  let paid = false; let remote: any; let deployed = 0; const mutations: string[] = []; let endpoint = { enabled: false, previews_enabled: false }; let schedules: any[] = [];
  const cf = new Cloudflare(run.config.accountId, vault.values);
  cf.get = async path => {
    if (path.endsWith('/subscriptions')) return paid ? [{ rate_plan: { id: 'workers_paid' }, price: 5 }] : [];
    if (path === '/zones/zone') return { name: run.config.domain, account: { id: run.config.accountId }, status: 'active' };
    if (path.endsWith('/email/routing')) return { enabled: true, status: 'ready' };
    if (path.endsWith('/workers/subdomain')) return { subdomain: 'example' };
    if (path.endsWith('/subdomain')) return endpoint;
    if (path.endsWith('/schedules')) return { schedules };
    if (path.endsWith('/settings')) { if (remote) return remote; throw new APIError(404, 'Cloudflare', '10007'); }
    throw Error(`Unexpected read ${path}`);
  };
  cf.list = async path => path.endsWith('/subscriptions') ? paid ? [{ rate_plan: { id: 'workers_paid' }, price: 5 }] : [] : [{ email: run.config.inbox, verified: true }];
  cf.request = async (path, method, body: any) => { mutations.push(path); if (path.endsWith('/subdomain')) { assert.equal(method, 'POST'); endpoint = body; return {}; } if (path.endsWith('/schedules')) { schedules = body; return {}; } assert.equal(method, 'PUT'); assert.ok(path.endsWith('/secrets')); assert.equal(body.name, 'ADMIN_TOKEN'); assert.notEqual(body.text, vault.values.cloudflare); return {}; };
  const controller = new CloudController(journal, vault, { cf: () => cf, command: async (_exe, args, cwd, env) => {
    deployed++; assert.ok(cwd.replace(/[\\/]+$/, '').endsWith('launchkit')); assert.equal(env?.CLOUDFLARE_API_TOKEN, vault.values.cloudflare);
    const config = JSON.parse(await readFile(args[args.indexOf('--config') + 1], 'utf8'));
    assert.deepEqual(config.triggers.crons, ['*/5 * * * *']); assert.deepEqual(config.migrations[0].new_sqlite_classes, ['MonitorState']); assert.equal(config.send_email[0].destination_address, run.config.inbox);
    assert.ok(!JSON.stringify(config).includes(vault.values.cloudflare!)); assert.ok(!JSON.stringify(config).includes(vault.values.monitoring!));
    remote = { bindings: Object.entries(config.vars).map(([name, text]) => ({ name, text })) }; throw Error('CLI interrupted after uploading, before installing the schedule');
  }, fetch: async (_url, options) => { assert.equal(options?.redirect, 'error'); assert.ok(!JSON.stringify(options?.headers).includes(vault.values.cloudflare!)); return Response.json({ ok: true }); } });
  const input = { enabled: true, intervalMinutes: 5, notifications: true, authorized: true };
  await assert.rejects(controller.deploy(run.id, { ...input, authorized: false }), /Authorize/); assert.equal(deployed, 0);
  paid = true; await assert.rejects(controller.deploy(run.id, input), /subscription/); assert.equal(deployed, 0); paid = false;
  await controller.deploy(run.id, input); await controller.deploy(run.id, input); assert.equal(deployed, 1); assert.equal(mutations.length, 4);
  remote.bindings.find((b: any) => b.name === 'LAUNCHKIT_BUSINESS').text = 'other-owner';
  await assert.rejects(controller.deploy(run.id, input), /unrecognized/); assert.equal(deployed, 1);
});
