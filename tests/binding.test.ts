import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Cloudflare } from '../src/adapters/cloudflare.ts';
import { bindDomain, type BindingChecks } from '../src/adapters/binding.ts';
import { publicFetch } from '../src/verification/http.ts';
import { Journal } from '../src/workflow/journal.ts';
import { Pause, type Context } from '../src/workflow/types.ts';

async function fixture() {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-binding-')));
  const accountId = 'a'.repeat(32);
  const run = await journal.create({ appPath: journal.dir, accountId, domain: 'example.test', inbox: 'owner@example.test', mode: 'live', www: true, outbound: false, seo: { approved: false, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } });
  run.resources.worker = `lk-${run.id}`;
  const ctx: Context = { run, save: () => journal.save(run), approve: async () => { throw Error('Unexpected approval'); }, effect: async (key, before, action) => {
    run.operations[key] = { status: 'INTENT', before, at: new Date().toISOString() }; await journal.save(run);
    const result = await action(); run.operations[key] = { ...run.operations[key], status: 'OBSERVED', result }; await journal.save(run); return result;
  } };
  const state = { writes: 0, polls: 0, verified: 0, waits: [] as number[], failCount: 1, redirect: 'https://example.test/', transientStatus: 0 };
  const domains: any[] = [];
  const cf = new Cloudflare(accountId, { cloudflare: 'test-only-token' }, async (input, init) => {
    const url = new URL(String(input)); const path = url.pathname.replace(/^\/client\/v4/, '');
    let result: unknown;
    if (path === '/zones') result = [{ id: 'zone', name: 'example.test', status: 'active', account: { id: accountId }, name_servers: ['ns.example.test'] }];
    else if (path === `/accounts/${accountId}/workers/domains`) {
      if (init?.method === 'PUT') { state.writes++; const body = JSON.parse(String(init.body)); domains.push({ ...body, id: `binding-${body.hostname}`, cert_id: `cert-${body.hostname}` }); }
      result = domains;
    } else if (path === '/zones/zone/workers/routes' || path === '/zones/zone/dns_records') result = [];
    else throw Error(`Unexpected endpoint ${path}`);
    return Response.json({ success: true, result });
  });
  const checks: BindingChecks = {
    dns: async () => ({ nameservers: ['ns.example.test'], addresses: ['192.0.2.1'] }),
    http: async url => { state.verified++; return { url, tls: 'Validated by HTTPS client', assets: 2, wasm: 1, hashes: 'SHA-256 matched', securityHeaders: true, noindex: false, verifiedAt: new Date().toISOString() }; },
    fetch: url => publicFetch(url, async () => {
      state.polls++;
      if (state.failCount-- > 0) {
        if (state.transientStatus) return new Response('', { status: state.transientStatus });
        throw new TypeError('fetch failed', { cause: Object.assign(Error('handshake not ready'), { code: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE' }) });
      }
      return new Response(null, { status: 301, headers: { location: state.redirect } });
    }),
    sleep: async ms => { state.waits.push(ms); }
  };
  return { journal, run, ctx, cf, checks, state };
}

test('new custom domains: transient TLS failure retries public checks without repeating binding writes', async () => {
  const t = await fixture();
  const result = await bindDomain(t.ctx, t.cf, t.checks);
  assert.equal(t.state.writes, 2); assert.deepEqual(t.state.waits, [250]);
  assert.equal(t.state.verified, 1); assert.equal(result.httpRedirect, true);
  assert.equal(result.binding.id, 'binding-example.test'); assert.notEqual(result.www, 'Not selected');
});

test('readiness timeout pauses with exact endpoint and resumes existing bindings without another write', async () => {
  const t = await fixture(); t.state.failCount = 20;
  await assert.rejects(bindDomain(t.ctx, t.cf, t.checks), e => {
    assert.ok(e instanceof Pause); assert.equal(e.status, 'WAITING_PROVIDER');
    assert.equal(e.evidence.endpoint, 'GET https://www.example.test/');
    assert.equal(e.evidence.attempts, 4); assert.equal(e.evidence.wwwBindingId, 'binding-www.example.test');
    assert.match(e.message, /ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE/); return true;
  });
  assert.equal(t.state.verified, 0); assert.equal(t.state.writes, 2);
  assert.deepEqual(t.state.waits, [250, 1000, 2000]);
  Object.assign(t.run, await t.journal.load(t.run.id)); t.state.failCount = 0;
  await bindDomain(t.ctx, t.cf, t.checks);
  assert.equal(t.state.writes, 2); assert.equal(t.state.verified, 1);
});

test('DNS propagation and edge HTTP 525 wait for readiness', async () => {
  const t = await fixture(); t.state.transientStatus = 525;
  let dnsCalls = 0;
  t.checks.dns = async () => {
    if (!dnsCalls++) throw new Pause('WAITING_PROVIDER', 'DNS propagating');
    return { nameservers: ['ns.example.test'], addresses: ['192.0.2.1'] };
  };
  await bindDomain(t.ctx, t.cf, t.checks);
  assert.equal(t.state.writes, 2); assert.deepEqual(t.state.waits, [250, 1000]); assert.equal(t.state.verified, 1);
});

test('incorrect redirect and deterministic content failure remain errors', async () => {
  const t = await fixture(); t.state.failCount = 0; t.state.redirect = 'https://wrong.example.test/';
  await assert.rejects(bindDomain(t.ctx, t.cf, t.checks), /Redirect verification failed for www.example.test/);
  assert.equal(t.state.waits.length, 0); assert.equal(t.state.verified, 0);
  t.state.redirect = 'https://example.test/'; t.checks.http = async () => { throw Error('Published asset differs from release'); };
  await assert.rejects(bindDomain(t.ctx, t.cf, t.checks), /Published asset differs/);
  assert.equal(t.state.waits.length, 0); assert.equal(t.state.writes, 2);
});

test('public network errors retain safe hostname/code evidence without raw error or query secrets', async () => {
  for (const code of ['ENOTFOUND', 'ECONNRESET', 'CERT_HAS_EXPIRED']) {
    let options: RequestInit | undefined;
    await assert.rejects(publicFetch('https://example.test/?token=secret', async (_input, init) => {
      options = init; throw new TypeError('private token=secret', { cause: Object.assign(Error('private'), { code }) });
    }), e => {
      assert.ok(e instanceof Pause); assert.equal(e.status, 'WAITING_PROVIDER');
      assert.equal(e.evidence.endpoint, 'GET https://example.test/'); assert.deepEqual(e.evidence.codes, [code]);
      assert.ok(!JSON.stringify(e).includes('secret')); return true;
    });
    assert.equal(options?.redirect, 'manual'); assert.ok(options?.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(options!).sort(), ['redirect', 'signal']);
  }
});

test('public timeout reports readiness wait with a bounded request', async () => {
  await assert.rejects(publicFetch('https://example.test/', async () => { throw new DOMException('timed out', 'TimeoutError'); }), e => e instanceof Pause && e.status === 'WAITING_PROVIDER' && (e.evidence.codes as string[]).includes('TIMEOUT'));
});
