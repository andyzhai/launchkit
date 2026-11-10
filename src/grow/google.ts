import { createHash, randomBytes } from 'node:crypto';
import type { Vault } from '../security/tokens.ts';
import { registerSecret } from '../security/redaction.ts';
import { digest } from '../workflow/journal.ts';

export const READ_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
export const WRITE_SCOPE = 'https://www.googleapis.com/auth/webmasters';
export interface Site { siteUrl: string; permissionLevel: string }
export interface Sitemap { path: string; isPending?: boolean; lastSubmitted?: string; lastDownloaded?: string; errors?: number; warnings?: number; providerStatus?: string; lastCrawled?: string; urlCount?: number }
export interface Window { startDate: string; endDate: string }
export interface Metrics { clicks: number; impressions: number; ctr: number; position: number }
export interface SearchProvider<M = Metrics> {
  identity(): string;
  connected(): boolean;
  writable(): boolean;
  sites(): Promise<Site[]>;
  sitemaps(site: string): Promise<Sitemap[]>;
  performance(site: string, window: Window): Promise<M | undefined>;
  submit(site: string, sitemap: string): Promise<void>;
}
const fail = (status: number) => Error(status === 401 ? 'Google authorization expired or was revoked. Reconnect Google.' : status === 403 ? 'Google denied access. Check property permissions, consent scope and that Search Console API is enabled.' : status === 429 ? 'Google rate limit reached. Wait before refreshing.' : `Google request failed (HTTP ${status}). Retry reads later; reconcile any submitted action first.`);
export class GoogleSearch implements SearchProvider {
  vault: Vault; transport: typeof fetch; now: () => number;
  pending?: { state: string; verifier: string; redirect: string; expires: number; clientId: string; clientSecret: string; scope: string };
  access?: { value: string; expires: number; identity: string };
  constructor(vault: Vault, transport = fetch, now = Date.now) { this.vault = vault; this.transport = transport; this.now = now; }
  identity() { return digest([this.vault.values.googleClientId, this.vault.values.googleRefreshToken, this.vault.values.googleScope]); }
  connected() { return !!this.vault.values.googleClientId && !!this.vault.values.googleRefreshToken; }
  writable() { return this.connected() && this.vault.values.googleScope === WRITE_SCOPE; }
  status() { return { connected: this.connected(), writable: this.writable(), configured: !!this.vault.values.googleClientId, persistence: this.vault.status().persistence }; }
  begin(origin: string, input: { clientId?: string; clientSecret?: string; manageSitemaps?: boolean }) {
    const local = new URL(origin);
    if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.origin !== origin) throw Error('Google callback must use the local operator.');
    const clientId = input.clientId || this.vault.values.googleClientId || '';
    const clientSecret = input.clientSecret || this.vault.values.googleClientSecret || '';
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId) || typeof clientSecret !== 'string' || clientSecret.length > 4096 || /\s/.test(clientSecret)) throw Error('Enter a Google Desktop OAuth client ID and its client secret from your own project.');
    registerSecret(clientSecret);
    const state = randomBytes(32).toString('base64url'); const verifier = randomBytes(32).toString('base64url');
    const scope = input.manageSitemaps === true ? WRITE_SCOPE : READ_SCOPE;
    const redirect = `${origin}/oauth/google/callback`;
    this.pending = { state, verifier, redirect, expires: this.now() + 600_000, clientId, clientSecret, scope };
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent select_account' }).toString();
    return { url: url.href, expiresInSeconds: 600 };
  }
  async tokenRequest(params: Record<string, string>) {
    let response: Response;
    try { response = await this.transport('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(20_000) }); }
    catch { throw Error('Google token exchange could not complete. Reconnect or retry a read later.'); }
    if (!response.ok) throw Error('Google authorization failed or expired. Reconnect and check the Desktop OAuth client configuration.');
    let data: any; try { data = await response.json(); } catch { throw Error('Google returned an invalid token response. Reconnect.'); }
    if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 4096 || typeof data.expires_in !== 'number' || data.expires_in <= 0 || data.token_type?.toLowerCase() !== 'bearer') throw Error('Google returned an invalid token response. Reconnect.');
    registerSecret(data.access_token); if (typeof data.refresh_token === 'string') registerSecret(data.refresh_token);
    return data;
  }
  async callback(url: URL) {
    const pending = this.pending;
    if (!pending || url.origin + url.pathname !== pending.redirect || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== pending.state || this.now() >= pending.expires) throw Error('Google sign-in expired or does not match this session. Start Connect Google again.');
    this.pending = undefined; // Consume before exchanging; replay cannot replace a connection.
    if (url.searchParams.has('error')) throw Error('Google consent was cancelled or denied. Start Connect Google when ready.');
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) throw Error('Google did not return a valid authorization code.');
    registerSecret(code);
    const data = await this.tokenRequest({ client_id: pending.clientId, client_secret: pending.clientSecret, code, code_verifier: pending.verifier, redirect_uri: pending.redirect, grant_type: 'authorization_code' });
    const scopes = typeof data.scope === 'string' ? data.scope.split(' ') : [];
    if (!scopes.includes(pending.scope) || typeof data.refresh_token !== 'string' || !data.refresh_token) throw Error('Google did not grant the requested scope and offline access. Reconnect with consent.');
    await this.vault.connect({ googleClientId: pending.clientId, googleClientSecret: pending.clientSecret, googleRefreshToken: data.refresh_token, googleScope: pending.scope });
    this.access = { value: data.access_token, expires: this.now() + data.expires_in * 1000, identity: this.identity() };
  }
  async accessToken() {
    if (!this.connected()) throw Error('Connect Google to read Search Console.');
    if (this.access && this.access.identity === this.identity() && this.access.expires > this.now() + 60_000) return this.access.value;
    const v = this.vault.values;
    const data = await this.tokenRequest({ client_id: v.googleClientId!, client_secret: v.googleClientSecret || '', refresh_token: v.googleRefreshToken!, grant_type: 'refresh_token' });
    if (data.scope && !String(data.scope).split(' ').includes(v.googleScope!)) throw Error('Google scope changed. Reconnect Google.');
    this.access = { value: data.access_token, expires: this.now() + data.expires_in * 1000, identity: this.identity() }; return this.access.value;
  }
  async request(path: string, method = 'GET', body?: unknown) {
    const token = await this.accessToken(); let response: Response;
    try { response = await this.transport(`https://www.googleapis.com/webmasters/v3/${path}`, { method, redirect: 'error', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) }); }
    catch { throw Error('Google request could not complete. Retry reads later; submission outcomes require reconciliation.'); }
    if (!response.ok) { if (response.status === 401) this.access = undefined; throw fail(response.status); }
    if (method === 'PUT') return undefined;
    try { return await response.json(); } catch { throw Error('Google returned an invalid response. Refresh later.'); }
  }
  async sites(): Promise<Site[]> {
    const data = await this.request('sites');
    if (!data || (data.siteEntry !== undefined && !Array.isArray(data.siteEntry))) throw Error('Google returned an invalid property list.');
    return (data.siteEntry || []).map((s: any) => {
      if (typeof s.siteUrl !== 'string' || s.siteUrl.length > 2048 || typeof s.permissionLevel !== 'string') throw Error('Google returned an invalid property.');
      return { siteUrl: s.siteUrl, permissionLevel: s.permissionLevel };
    });
  }
  async sitemaps(site: string): Promise<Sitemap[]> {
    const data = await this.request(`sites/${encodeURIComponent(site)}/sitemaps`);
    if (!data || (data.sitemap !== undefined && !Array.isArray(data.sitemap))) throw Error('Google returned an invalid sitemap list.');
    return (data.sitemap || []).map((s: any) => {
      if (typeof s.path !== 'string' || s.path.length > 2048) throw Error('Google returned an invalid sitemap.');
      const result: Sitemap = { path: s.path };
      if (typeof s.isPending === 'boolean') result.isPending = s.isPending;
      for (const key of ['lastSubmitted', 'lastDownloaded'] as const) if (typeof s[key] === 'string' && Number.isFinite(Date.parse(s[key]))) result[key] = s[key];
      for (const key of ['errors', 'warnings'] as const) if (s[key] !== undefined) { const n = Number(s[key]); if (!Number.isSafeInteger(n) || n < 0 || s[key] === null || s[key] === '') throw Error('Google returned an invalid sitemap count.'); result[key] = n; }
      return result; // Deprecated contents.indexed is deliberately excluded.
    });
  }
  async performance(site: string, window: Window): Promise<Metrics | undefined> {
    const data = await this.request(`sites/${encodeURIComponent(site)}/searchAnalytics/query`, 'POST', { ...window, type: 'web', dataState: 'final', aggregationType: 'byProperty', rowLimit: 1 });
    if (!data || (data.rows !== undefined && !Array.isArray(data.rows))) throw Error('Google returned invalid search metrics.');
    if (!data.rows?.length) return undefined;
    const row = data.rows[0];
    if (['clicks', 'impressions', 'ctr', 'position'].some(k => typeof row[k] !== 'number' || !Number.isFinite(row[k]) || row[k] < 0) || row.ctr > 1) throw Error('Google returned invalid search metrics.');
    return { clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position };
  }
  async submit(site: string, sitemap: string) { if (!this.writable()) throw Error('Reconnect Google with sitemap management consent before submitting.'); await this.request(`sites/${encodeURIComponent(site)}/sitemaps/${encodeURIComponent(sitemap)}`, 'PUT'); }
}

export function searchWindow(now = new Date()): Window {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  const end = new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`); end.setUTCDate(end.getUTCDate() - 3);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 27);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}
