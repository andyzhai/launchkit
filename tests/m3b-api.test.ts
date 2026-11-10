import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Journal } from '../src/workflow/journal.ts';
import { Vault } from '../src/security/tokens.ts';
import { MockProvider } from '../src/adapters/mock.ts';
import { MockBing } from '../src/grow/bing.ts';
import { startServer } from '../src/ui/server.ts';

test('Bing and audit APIs retain session, CSRF, read-only GET, business isolation and shared exclusion', async () => {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-m3b-api-'))); const vault = new Vault(journal.dir);
  vault.connect = async input => { vault.values = { ...vault.values, ...input }; };
  const run = await journal.create({ appPath: journal.dir, domain: 'example.test', accountId: 'mock', mode: 'mock', inbox: '', outbound: false, www: false, seo: { approved: true, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } });
  run.resources.url = 'https://example.test'; run.steps.seo.status = 'VERIFIED'; await journal.save(run);
  const provider = new MockBing(run.config.domain); const { server, origin, tick } = await startServer({ journal, vault, provider: () => new MockProvider(journal.dir), bingProvider: () => provider });
  let release = () => {};
  try {
    const page = await fetch(origin); const html = await page.text(); const headers = { Cookie: page.headers.get('set-cookie')!.split(';')[0], 'X-LaunchKit-Token': html.match(/name="launchkit-session" content="([^"]+)"/)![1], 'Content-Type': 'application/json', Origin: origin };
    const post = (path: string, body: unknown = {}) => fetch(`${origin}/api${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const path = `/runs/${run.id}/grow`;
    for (const suffix of ['bing', 'audit']) {
      assert.equal((await fetch(`${origin}/api${path}/${suffix}`)).status, 403);
      assert.equal((await fetch(`${origin}/api${path}/${suffix}/refresh`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: '{}' })).status, 403);
      assert.equal((await fetch(`${origin}/api${path}/${suffix}/refresh`, { headers })).status, 404);
      assert.equal((await fetch(`${origin}/api${path}/${suffix}`, { headers })).status, 200);
    }
    assert.equal((await post('/grow/bing/connect', { apiKey: 'fixture-api-key' })).status, 200);
    assert.equal((await post('/connections', { bingApiKey: 'untrusted-generic-route' })).status, 200); assert.equal(vault.values.bingApiKey, 'fixture-api-key');
    assert.equal((await post(`${path}/bing/select`, { property: 'https://evil.test/' })).status, 400);
    await post(`${path}/bing/refresh`); await post(`${path}/bing/select`, { property: 'https://example.test/' });
    const prepared = await (await post(`${path}/bing/prepare`)).json(); assert.equal(provider.maps.length, 0);
    assert.equal((await post(`${path}/approval`, { approvalId: prepared.submissions[0].id, decision: 'approved' })).status, 400);
    assert.equal((await post(`${path}/bing/approval`, { approvalId: prepared.submissions[0].id, decision: 'approved' })).status, 200); assert.equal(provider.maps.length, 1);
    const audit = await (await post(`${path}/audit/refresh`)).json(); assert.equal(audit.simulated, true); assert.ok(audit.findings.length);
    let entered!: () => void; const arrived = new Promise<void>(resolve => { entered = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
    provider.sites = async () => { entered(); await wait; return []; };
    const reading = post(`${path}/bing/refresh`); await arrived;
    for (const target of [`${path}/audit/refresh`, `${path}/refresh`, '/grow/bing/connect', `/runs/${run.id}/resume`]) assert.equal((await post(target)).status, 400);
    await tick(); release(); assert.equal((await reading).status, 200);
  } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
