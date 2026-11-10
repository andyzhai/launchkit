import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Journal } from '../src/workflow/journal.ts';
import { Vault } from '../src/security/tokens.ts';
import { Mastodon, MockSocial, validateText, validateLength } from '../src/grow/mastodon.ts';
import { Social } from '../src/grow/social.ts';
import { registerSecret } from '../src/security/redaction.ts';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const account = { id: '123', username: 'example', acct: 'example', url: 'https://mastodon.social/@example' };
const post = { id: '456', account, url: 'https://mastodon.social/@example/456', created_at: '2026-10-29T16:00:00Z', visibility: 'unlisted', media_attachments: [], reblog: null, in_reply_to_id: null };

test('Mastodon contract uses scoped bearer requests, fixed origin, exact content, idempotency and source verification', async () => {
  const vault = new Vault('unused'); vault.values.mastodonToken = 'fixture-social-user-token'; const calls: { url: string; init?: RequestInit }[] = [];
  const mastodon = new Mastodon(vault, async (url, init) => {
    calls.push({ url: String(url), init });
    assert.ok(String(url).startsWith('https://mastodon.social/api/')); assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-social-user-token');
    if (String(url).endsWith('verify_credentials')) return json(account);
    if (String(url).endsWith('/instance')) return json({ configuration: { statuses: { max_characters: 500, characters_reserved_per_url: 23 } } });
    if (String(url).endsWith('/source')) return json({ id: '456', text: 'Exact & text\nhttps://example.test/', spoiler_text: '' });
    return json(post);
  });
  assert.equal((await mastodon.account()).username, 'example');
  const published = await mastodon.publish('Exact & text\nhttps://example.test/', 'unlisted', 'approval-id'); assert.equal(published.id, '456');
  const write = calls.find(c => c.init?.method === 'POST')!; assert.equal(new Headers(write.init?.headers).get('Idempotency-Key'), 'approval-id');
  const body = new URLSearchParams(String(write.init?.body)); assert.equal(body.get('status'), 'Exact & text\nhttps://example.test/'); assert.equal(body.get('visibility'), 'unlisted'); assert.equal(body.get('sensitive'), 'false');
  assert.equal((await mastodon.inspect('456')).text, 'Exact & text\nhttps://example.test/');
  const before = calls.length; await assert.rejects(mastodon.inspect('../accounts'), /invalid ID/); assert.equal(calls.length, before);
});

test('Mastodon sanitizes authorization/rate/transport failures and rejects malformed or foreign evidence', async () => {
  const vault = new Vault('unused'); vault.values.mastodonToken = 'fixture-private-masto-token';
  for (const status of [401, 403, 429, 500]) {
    let calls = 0; const m = new Mastodon(vault, async () => { calls++; return json({ error: 'fixture-private-masto-token' }, status); });
    await assert.rejects(m.publish('text', 'public', 'id'), e => !String(e).includes('fixture-private') && /Mastodon/.test(String(e))); assert.equal(calls, 1);
  }
  await assert.rejects(new Mastodon(vault, async () => { throw Error('fixture-private-masto-token'); }).account(), /could not complete/);
  await assert.rejects(new Mastodon(vault, async () => json({ ...account, acct: 'example@evil.test' })).account(), /active local/);
  await assert.rejects(new Mastodon(vault, async () => json({ ...post, url: 'javascript:alert(1)' })).publish('text', 'public', 'id'), /unexpected/);
  await assert.rejects(new Mastodon(vault, async url => json(String(url).endsWith('/source') ? { id: '999', text: 'text', spoiler_text: '' } : post)).inspect('456'), /source evidence/);
  const before = new Mastodon(vault).identity(); vault.values.mastodonConnectionId = 'new-connection'; assert.notEqual(new Mastodon(vault).identity(), before);
});

test('draft validation preserves exact text, rejects secrets and conservatively handles URL and grapheme limits', async () => {
  registerSecret('social-sensitive-fixture');
  for (const text of ['', '   ', 'bad\u0000text', 'social-sensitive-fixture', 'api_key=private', 'Bearer private']) assert.throws(() => validateText(text));
  const a = await new MockSocial().account(); validateLength('😀'.repeat(500), a); assert.throws(() => validateLength('x'.repeat(501), a));
  assert.throws(() => validateLength('x'.repeat(480) + ' https://a.co', a));
});

async function setup() {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-social-')));
  const run = await journal.create({ appPath: journal.dir, domain: 'example.test', accountId: 'mock', mode: 'mock', inbox: '', outbound: false, www: false, seo: { approved: true, title: 'Example app', description: 'Customer-owned tools.' }, analytics: { approved: false, publicPaths: ['/'] } });
  run.resources.url = 'https://example.test'; await journal.save(run);
  const provider = new MockSocial(); const social = new Social(journal, () => provider);
  const save = async (text = 'A helpful product update.') => (await social.action(run.id, 'save', { text, visibility: 'unlisted' }))!;
  const prepare = async (draftId: string) => { await social.action(run.id, 'prepare', { draftId }); return (await social.load(run.id)).drafts.find(d => d.id === draftId)!.approvals.at(-1)!; };
  const approve = (draftId: string, approvalId: string) => social.action(run.id, 'approval', { draftId, approvalId, decision: 'approved' });
  return { journal, run, provider, social, save, prepare, approve };
}

test('editable templates and exact approvals persist; edits, declines, connection and business changes prevent stale sends', async () => {
  const { journal, run, provider, social, save, prepare, approve } = await setup();
  const template = await social.action(run.id, 'template', {}); assert.match((await social.load(run.id)).drafts[0].text, /Example app\nCustomer-owned tools.\nhttps:\/\/example.test\//);
  const id = await save(); let a = await prepare(id); assert.equal(provider.posts.size, 0);
  await social.action(run.id, 'save', { draftId: id, text: 'Edited update', visibility: 'public' }); await assert.rejects(approve(id, a.id), /no longer pending/);
  a = await prepare(id); await social.action(run.id, 'approval', { draftId: id, approvalId: a.id, decision: 'denied' }); await assert.rejects(approve(id, a.id));
  a = await prepare(id); provider.identity = () => 'changed'; assert.equal((await social.report(run.id)).drafts.find(d => d.id === id)!.approvalValid, false); await assert.rejects(approve(id, a.id), /changed/);
  a = await prepare(id); run.approvalRevision = 1; await journal.save(run); await assert.rejects(approve(id, a.id), /changed/);
  a = await prepare(id); const originalAccount = provider.account.bind(provider); provider.account = async () => ({ ...await originalAccount(), id: '2' }); await assert.rejects(approve(id, a.id), /destination changed/);
  provider.account = originalAccount;
  const restored = new Social(journal, () => provider); assert.equal((await restored.load(run.id)).drafts.length, 2); assert.equal((await restored.load(run.id)).drafts[0].id, template); assert.equal(provider.posts.size, 0);
});

test('publication saves intent before write, is immutable, resists replay and duplicate drafts, and reconciles by provider source', async () => {
  const { run, provider, social, save, prepare, approve } = await setup(); const id = await save(); const a = await prepare(id);
  const send = provider.publish.bind(provider); let sends = 0;
  provider.publish = async (text, visibility, key) => { sends++; assert.equal((await social.load(run.id)).drafts[0].status, 'INTENT'); assert.equal(key, a.id); return send(text, visibility, key); };
  await approve(id, a.id); assert.equal((await social.report(run.id)).drafts[0].status, 'ACCEPTED');
  await assert.rejects(approve(id, a.id)); await assert.rejects(social.action(run.id, 'prepare', { draftId: id })); await assert.rejects(social.action(run.id, 'save', { draftId: id, text: 'replace' }), /immutable/);
  await social.action(run.id, 'reconcile', { draftId: id }); assert.equal((await social.report(run.id)).drafts[0].status, 'OBSERVED');
  const duplicate = await save(); await assert.rejects(prepare(duplicate), /Identical content/); assert.equal(sends, 1);
});

test('lost responses and interrupted intents remain UNKNOWN through restart; only matching evidence reconciles, never retries', async () => {
  const { journal, run, provider, social, save, prepare, approve } = await setup(); const id = await save(); const a = await prepare(id);
  const send = provider.publish.bind(provider); let postId = ''; let sends = 0;
  provider.publish = async (...args) => { sends++; postId = (await send(...args)).id; throw Error('connection lost'); };
  await approve(id, a.id); assert.equal((await social.report(run.id)).drafts[0].status, 'UNKNOWN');
  const restarted = new Social(journal, () => provider); await assert.rejects(restarted.action(run.id, 'approval', { draftId: id, approvalId: a.id, decision: 'approved' }));
  const saved = provider.posts.get(postId)!; provider.posts.set(postId, { ...saved, text: 'Wrong content' }); await restarted.action(run.id, 'reconcile', { draftId: id, postId }); assert.equal((await restarted.report(run.id)).drafts[0].status, 'UNKNOWN');
  provider.posts.set(postId, { ...saved, accountId: '2' }); await restarted.action(run.id, 'reconcile', { draftId: id, postId }); assert.equal((await restarted.report(run.id)).drafts[0].status, 'UNKNOWN');
  provider.posts.set(postId, { ...saved, createdAt: '2020-01-01T00:00:00Z' }); await restarted.action(run.id, 'reconcile', { draftId: id, postId }); assert.equal((await restarted.report(run.id)).drafts[0].status, 'UNKNOWN');
  const state = await restarted.load(run.id); state.drafts[0].status = 'INTENT'; await restarted.save(state); assert.equal((await restarted.report(run.id)).drafts[0].status, 'UNKNOWN');
  provider.posts.set(postId, saved); await restarted.action(run.id, 'reconcile', { draftId: id, postId }); assert.equal((await restarted.report(run.id)).drafts[0].status, 'OBSERVED'); assert.equal(sends, 1);
});

test('failed durable intent never sends; pending duplicate approvals cannot both publish; GET reports never call provider', async () => {
  const { journal, run, provider, social, save, prepare, approve } = await setup(); const id = await save(); const a = await prepare(id); const second = await save(); const b = await prepare(second);
  const persist = social.save.bind(social); social.save = async state => { if (state.drafts.some(d => d.status === 'INTENT')) throw Error('disk full'); return persist(state); };
  await assert.rejects(approve(id, a.id), /disk full/); assert.equal(provider.posts.size, 0); social.save = persist;
  await approve(id, a.id); await assert.rejects(approve(second, b.id), /Identical/); assert.equal(provider.posts.size, 1);
  const bytes = await readFile(social.path(run.id), 'utf8'); provider.account = async () => { throw Error('GET must not access provider'); };
  assert.equal((await social.report(run.id)).drafts.length, 2); assert.equal(await readFile(social.path(run.id), 'utf8'), bytes);
  run.resources.url = undefined; await journal.save(run); await assert.rejects(social.action(run.id, 'save', { text: 'new' }), /bind/);
});

test('lost local receipt leaves a durable intent that restart cannot publish again', async () => {
  const { journal, run, provider, social, save, prepare, approve } = await setup(); const id = await save(); const a = await prepare(id);
  const persist = social.save.bind(social); social.save = async state => { if (state.drafts.some(d => d.status === 'ACCEPTED')) throw Error('receipt write failed'); return persist(state); };
  await assert.rejects(approve(id, a.id), /receipt write failed/); assert.equal(provider.posts.size, 1);
  const restored = new Social(journal, () => provider); assert.equal((await restored.report(run.id)).drafts[0].status, 'UNKNOWN');
  await assert.rejects(restored.action(run.id, 'approval', { draftId: id, approvalId: a.id, decision: 'approved' })); assert.equal(provider.posts.size, 1);
  await restored.action(run.id, 'reconcile', { draftId: id, postId: [...provider.posts.keys()][0] }); assert.equal((await restored.report(run.id)).drafts[0].status, 'OBSERVED');
});

test('failed reconciliation becomes UNKNOWN while retaining receipts and historical observations, without resending', async () => {
  const { journal, run, provider, social, save, prepare, approve } = await setup(); const id = await save(); const a = await prepare(id);
  await approve(id, a.id); const publication = (await social.load(run.id)).drafts[0].publication!;
  const inspect = provider.inspect.bind(provider); let reads = 0;
  provider.inspect = async () => { reads++; throw Error('Provider read unavailable'); };
  await social.action(run.id, 'reconcile', { draftId: id });
  let d = (await social.load(run.id)).drafts[0]; assert.equal(d.status, 'UNKNOWN'); assert.deepEqual(d.publication, publication); assert.ok(d.reconciledAt);
  provider.inspect = inspect; await social.action(run.id, 'reconcile', { draftId: id });
  d = (await social.load(run.id)).drafts[0]; assert.equal(d.status, 'OBSERVED'); const observedAt = d.observedAt;
  provider.posts.delete(publication.id); await social.action(run.id, 'reconcile', { draftId: id });
  d = (await new Social(journal, () => provider).report(run.id)).drafts[0]; assert.equal(d.status, 'UNKNOWN'); assert.equal(d.observedAt, observedAt); assert.deepEqual(d.publication, publication);
  await assert.rejects(approve(id, a.id)); await assert.rejects(prepare(id));
  const account = provider.account.bind(provider); provider.account = async () => ({ ...await account(), id: 'other-account' });
  provider.inspect = async () => { reads++; throw Error('Wrong account must not inspect'); };
  await social.action(run.id, 'reconcile', { draftId: id }); assert.equal(reads, 1); assert.equal((await social.load(run.id)).drafts[0].status, 'UNKNOWN');
});

test('Mastodon token uses protected Windows storage, blank preserves identity and reconnect invalidates old identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launchkit-social-vault-')); const vault = new Vault(dir);
  await vault.connect({ mastodonToken: 'social-protected-fixture-token' }); const identity = new Mastodon(vault).identity();
  await vault.connect({ mastodonToken: '' }); assert.equal(new Mastodon(vault).identity(), identity);
  if (process.platform === 'win32') {
    assert.doesNotMatch(await readFile(join(dir, 'connections.dpapi'), 'utf8'), /social-protected-fixture-token/);
    const restored = new Vault(dir); const prior = process.env.MASTODON_ACCESS_TOKEN; delete process.env.MASTODON_ACCESS_TOKEN;
    try { await restored.load(); assert.equal(new Mastodon(restored).identity(), identity); } finally { if (prior !== undefined) process.env.MASTODON_ACCESS_TOKEN = prior; }
  }
  await vault.connect({ mastodonToken: 'social-protected-fixture-token' }); assert.notEqual(new Mastodon(vault).identity(), identity);
});
