import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Journal } from '../src/workflow/journal.ts';
import { Vault } from '../src/security/tokens.ts';
import { MockProvider } from '../src/adapters/mock.ts';
import { MockSocial } from '../src/grow/mastodon.ts';
import { startServer } from '../src/ui/server.ts';

test('social API enforces session, origin, business isolation, exact approval, and shared mutation exclusion', async () => {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-social-api-'))); const vault = new Vault(journal.dir);
  vault.connect = async input => { vault.values = { ...vault.values, ...input }; };
  const run = await journal.create({ appPath: journal.dir, domain: 'example.test', accountId: 'mock', mode: 'mock', inbox: '', outbound: false, www: false, seo: { approved: true, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } });
  run.resources.url = 'https://example.test'; await journal.save(run);
  const other = await journal.create({ ...run.config, domain: 'other.test' }); other.resources.url = 'https://other.test'; await journal.save(other);
  const provider = new MockSocial(); const { server, origin, tick } = await startServer({ journal, vault, provider: () => new MockProvider(journal.dir), socialProvider: () => provider });
  let release = () => {};
  try {
    const page = await fetch(origin); const html = await page.text(); const headers = { Cookie: page.headers.get('set-cookie')!.split(';')[0], 'X-LaunchKit-Token': html.match(/name="launchkit-session" content="([^"]+)"/)![1], 'Content-Type': 'application/json', Origin: origin };
    const post = (path: string, body: unknown = {}) => fetch(`${origin}/api${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const path = `/runs/${run.id}/grow/social`;
    assert.equal((await fetch(`${origin}/api${path}`)).status, 403);
    for (const action of ['save', 'template', 'prepare', 'approval', 'reconcile', 'refresh']) {
      assert.equal((await fetch(`${origin}/api${path}/${action}`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: '{}' })).status, 403);
      assert.equal((await fetch(`${origin}/api${path}/${action}`, { headers })).status, 404);
    }
    assert.equal((await post('/grow/social/connect', { accessToken: 'fixture-mastodon-token' })).status, 200);
    assert.equal((await post('/connections', { mastodonToken: 'generic-route-token' })).status, 200); assert.equal(vault.values.mastodonToken, 'fixture-mastodon-token');
    const saved = await (await post(`${path}/save`, { text: 'Customer-approved test content', visibility: 'unlisted' })).json(); const draftId = saved.savedDraftId;
    assert.equal((await post(`/runs/${other.id}/grow/social/prepare`, { draftId })).status, 400);
    const prepared = await (await post(`${path}/prepare`, { draftId })).json(); const approvalId = prepared.drafts[0].approvals[0].id; assert.equal(provider.posts.size, 0);
    assert.equal((await post(`${path}/approval`, { draftId, approvalId, decision: 'yes' })).status, 400);
    assert.equal((await post(`${path}/approval`, { draftId, approvalId, decision: 'approved' })).status, 200); assert.equal(provider.posts.size, 1);
    assert.equal((await post(`${path}/approval`, { draftId, approvalId, decision: 'approved' })).status, 400);
    const observed = await (await post(`${path}/reconcile`, { draftId })).json(); assert.equal(observed.drafts[0].status, 'OBSERVED');
    assert.doesNotMatch(JSON.stringify(observed), /fixture-mastodon-token/);
    let entered!: () => void; const arrived = new Promise<void>(resolve => { entered = resolve; }); const waiting = new Promise<void>(resolve => { release = resolve; });
    const account = provider.account.bind(provider); provider.account = async () => { entered(); await waiting; return account(); };
    const pending = post(`${path}/refresh`); await arrived;
    for (const target of [`${path}/save`, `/runs/${run.id}/grow/bing/refresh`, '/grow/social/connect', `/runs/${run.id}/resume`]) assert.equal((await post(target)).status, 400);
    await tick(); release(); assert.equal((await pending).status, 200);
  } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
