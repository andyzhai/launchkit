import type { Vault } from '../security/tokens.ts';
import { registerSecret, clean } from '../security/redaction.ts';
import { digest } from '../workflow/journal.ts';

export const MASTODON = 'https://mastodon.social';
export type Visibility = 'public' | 'unlisted';
export interface SocialAccount { id: string; username: string; url: string; maxCharacters: number; urlCharacters: number }
export interface Publication { id: string; accountId: string; url: string; visibility: Visibility; createdAt: string }
export interface SocialProvider {
  identity(): string; connected(): boolean;
  account(): Promise<SocialAccount>;
  publish(text: string, visibility: Visibility, key: string): Promise<Publication>;
  inspect(id: string): Promise<Publication & { text: string; spoiler: string }>;
}
const numeric = (id: unknown): string => { if (typeof id !== 'string' || !/^\d{1,40}$/.test(id)) throw Error('Mastodon returned an invalid ID.'); return id; };
export function validateText(text: unknown): asserts text is string {
  if (typeof text !== 'string' || !text.trim() || text.length > 4000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw Error('Enter a nonempty post without control characters.');
  // Atomic journals and reports redact secrets. Reject before hashing or approval
  // rather than approving text that cannot be stored and displayed verbatim.
  if (clean(text) !== text) throw Error('Remove credentials or secret-like text from the draft.');
}
export function validateLength(text: string, account: SocialAccount) {
  const graphemes = (s: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length;
  // Conservative: never discount a long URL, and reserve the provider's minimum
  // length for short URLs. Server validation remains authoritative.
  const length = graphemes(text) + [...text.matchAll(/https?:\/\/[^\s]+/g)].reduce((n, m) => n + Math.max(0, account.urlCharacters - graphemes(m[0])), 0);
  if (length > account.maxCharacters) throw Error(`Shorten the post to fit this server's ${account.maxCharacters}-character limit (URLs may count extra).`);
}
export class Mastodon implements SocialProvider {
  vault: Vault; transport: typeof fetch;
  constructor(vault: Vault, transport = fetch) { this.vault = vault; this.transport = transport; }
  identity() { return digest(['mastodon.social', this.vault.values.mastodonToken, this.vault.values.mastodonConnectionId]); }
  connected() { return !!this.vault.values.mastodonToken; }
  async request(path: string, body?: URLSearchParams, key?: string) {
    const token = this.vault.values.mastodonToken;
    if (!token) throw Error('Connect a mastodon.social user access token.');
    registerSecret(token);
    let response: Response;
    try { response = await this.transport(`${MASTODON}${path}`, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': key! } : {}) }, ...(body ? { body: body.toString() } : {}) }); }
    catch { throw Error('Mastodon request could not complete. Reconcile uncertain publications; do not resend.'); }
    if (!response.ok) throw Error(response.status === 429 ? 'Mastodon rate limit reached. Wait before retrying reads; publications require reconciliation.' : response.status === 401 || response.status === 403 ? 'Mastodon denied access. Check your user token and scopes.' : `Mastodon request failed (HTTP ${response.status}).`);
    try { return await response.json(); } catch { throw Error('Mastodon returned an invalid response.'); }
  }
  async account(): Promise<SocialAccount> {
    const a = await this.request('/api/v1/accounts/verify_credentials');
    if (!a || typeof a.username !== 'string' || !/^[a-zA-Z0-9_]{1,100}$/.test(a.username) || a.acct !== a.username || a.url !== `${MASTODON}/@${a.username}` || a.suspended || a.moved) throw Error('An active local mastodon.social account is required.');
    const instance = await this.request('/api/v2/instance'); const limits = instance?.configuration?.statuses;
    if (!limits || !Number.isSafeInteger(limits.max_characters) || limits.max_characters < 1 || limits.max_characters > 10000 || !Number.isSafeInteger(limits.characters_reserved_per_url) || limits.characters_reserved_per_url < 1 || limits.characters_reserved_per_url > 1000) throw Error('Mastodon character limits are unavailable.');
    return { id: numeric(a.id), username: a.username, url: a.url, maxCharacters: limits.max_characters, urlCharacters: limits.characters_reserved_per_url };
  }
  publication(s: any): Publication {
    const id = numeric(s?.id); const accountId = numeric(s?.account?.id);
    if (!['public', 'unlisted'].includes(s.visibility) || typeof s.created_at !== 'string' || !Number.isFinite(Date.parse(s.created_at)) || typeof s.account.username !== 'string' || !/^[a-zA-Z0-9_]{1,100}$/.test(s.account.username) || s.url !== `${MASTODON}/@${s.account.username}/${id}` || s.reblog || s.in_reply_to_id || s.media_attachments?.length || s.poll) throw Error('Mastodon returned unexpected publication evidence.');
    return { id, accountId, url: s.url, visibility: s.visibility, createdAt: new Date(s.created_at).toISOString() };
  }
  async publish(text: string, visibility: Visibility, key: string) {
    return this.publication(await this.request('/api/v1/statuses', new URLSearchParams({ status: text, visibility, sensitive: 'false', spoiler_text: '' }), key));
  }
  async inspect(id: string) {
    numeric(id);
    const status = this.publication(await this.request(`/api/v1/statuses/${id}`));
    const source = await this.request(`/api/v1/statuses/${id}/source`);
    if (status.id !== id || source?.id !== id || typeof source.text !== 'string' || typeof source.spoiler_text !== 'string') throw Error('Mastodon source evidence is unavailable.');
    return { ...status, text: source.text, spoiler: source.spoiler_text };
  }
}
export class MockSocial implements SocialProvider {
  identity() { return 'simulation:mastodon'; }
  connected() { return true; }
  async account() { return { id: '1', username: 'simulation', url: `${MASTODON}/@simulation`, maxCharacters: 500, urlCharacters: 23 }; }
  posts = new Map<string, Publication & { text: string; spoiler: string }>();
  async publish(text: string, visibility: Visibility, _key: string) {
    const id = String(Date.now()) + String(this.posts.size); const post = { id, accountId: '1', url: `${MASTODON}/@simulation/${id}`, visibility, createdAt: new Date().toISOString() };
    this.posts.set(id, { ...post, text, spoiler: '' }); return post;
  }
  async inspect(id: string) { const post = this.posts.get(id); if (!post) throw Error('Simulated provider evidence is unavailable after restart. Saved publication history remains.'); return post; }
}
