import type { Vault } from '../security/tokens.ts';
import { registerSecret } from '../security/redaction.ts';
import { digest } from '../workflow/journal.ts';
import type { SearchProvider, Site, Sitemap } from './google.ts';

export interface BingMetrics { rows: { date: string; clicks: number; impressions: number }[] }
export function bingCovers(site: string, domain: string) {
  // Preserve Bing's exact property spelling in requests and approvals.
  return site === `https://${domain}` || site === `https://${domain}/`;
}
export function bingDate(value: unknown): string {
  if (typeof value !== 'string') throw Error('Bing returned an invalid date.');
  const match = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  const ms = match ? Number(match[1]) : /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) throw Error('Bing returned an invalid date.');
  return new Date(ms).toISOString();
}
const count = (n: unknown): number => { if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw Error('Bing returned an invalid count.'); return n; };
const url = (value: unknown): string => { if (typeof value !== 'string' || value.length > 2048) throw Error('Bing returned an invalid URL.'); try { const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error(); } catch { throw Error('Bing returned an invalid URL.'); } return value; };

export class BingSearch implements SearchProvider<BingMetrics> {
  vault: Vault; transport: typeof fetch;
  constructor(vault: Vault, transport = fetch) { this.vault = vault; this.transport = transport; }
  identity() { return digest(['bing', this.vault.values.bingApiKey]); }
  connected() { return !!this.vault.values.bingApiKey; }
  writable() { return this.connected(); } // API keys have account-wide access, not a read-only scope.
  status() { return { connected: this.connected(), persistence: this.vault.status().persistence }; }
  async request(method: 'GetUserSites' | 'GetFeeds' | 'GetRankAndTrafficStats' | 'SubmitFeed', args: Record<string, string> = {}) {
    const key = this.vault.values.bingApiKey;
    if (!key) throw Error('Connect your Bing Webmaster API key.');
    registerSecret(key); registerSecret(encodeURIComponent(key));
    const endpoint = new URL(`https://ssl.bing.com/webmaster/api.svc/json/${method}`);
    endpoint.searchParams.set('apikey', key);
    const write = method === 'SubmitFeed';
    if (!write) for (const [name, value] of Object.entries(args)) endpoint.searchParams.set(name, value);
    let response: Response;
    try { response = await this.transport(endpoint.href, { method: write ? 'POST' : 'GET', redirect: 'error', headers: { Accept: 'application/json', ...(write ? { 'Content-Type': 'application/json' } : {}) }, ...(write ? { body: JSON.stringify(args) } : {}), signal: AbortSignal.timeout(20_000) }); }
    catch { throw Error('Bing request could not complete. Retry reads later; reconcile submissions before any retry.'); }
    if (!response.ok) throw Error(response.status === 401 || response.status === 403 ? 'Bing denied access. Check the API key and verified site access.' : response.status === 429 ? 'Bing rate limit reached. Wait before refreshing.' : `Bing request failed (HTTP ${response.status}).`);
    // Never expose provider error bodies or the URL containing the API key.
    let data: any; try { data = await response.json(); } catch { throw Error('Bing returned an invalid response.'); }
    if (!data || !Object.hasOwn(data, 'd') || (write ? data.d !== null : !Array.isArray(data.d)) || data.ErrorCode !== undefined) throw Error('Bing returned an invalid or unsuccessful response.');
    if (!write && data.d.length > 10_000) throw Error('Bing response exceeds the supported evidence limit.');
    return data.d;
  }
  async sites(): Promise<Site[]> {
    return (await this.request('GetUserSites')).map((s: any) => {
      if (!s || typeof s.IsVerified !== 'boolean') throw Error('Bing returned invalid site verification evidence.');
      return { siteUrl: url(s.Url), permissionLevel: s.IsVerified ? 'verified' : 'unverified' };
    });
  }
  async sitemaps(site: string): Promise<Sitemap[]> {
    return (await this.request('GetFeeds', { siteUrl: site })).map((s: any) => {
      if (!s) throw Error('Bing returned an invalid sitemap.');
      const map: Sitemap = { path: url(s.Url) };
      if (s.Status != null) { if (typeof s.Status !== 'string' || s.Status.length > 200) throw Error('Bing returned an invalid sitemap status.'); map.providerStatus = s.Status; }
      if (s.Submitted != null) map.lastSubmitted = bingDate(s.Submitted);
      if (s.LastCrawled != null) map.lastCrawled = bingDate(s.LastCrawled);
      if (s.UrlCount != null) map.urlCount = count(s.UrlCount);
      return map; // URL count is a feed count, never an indexed-page count.
    });
  }
  async performance(site: string): Promise<BingMetrics | undefined> {
    const rows = (await this.request('GetRankAndTrafficStats', { siteUrl: site })).map((r: any) => ({ date: bingDate(r?.Date), clicks: count(r?.Clicks), impressions: count(r?.Impressions) }));
    if (new Set(rows.map((r: { date: string }) => r.date)).size !== rows.length) throw Error('Bing returned duplicate reporting dates.');
    rows.sort((a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date));
    return rows.length ? { rows } : undefined;
  }
  async submit(site: string, sitemap: string) { await this.request('SubmitFeed', { siteUrl: site, feedUrl: sitemap }); }
}

export class MockBing implements SearchProvider<BingMetrics> {
  domain: string; maps: Sitemap[] = [];
  constructor(domain: string) { this.domain = domain; }
  identity() { return `simulation:bing:${this.domain}`; }
  connected() { return true; }
  writable() { return true; }
  async sites() { return [{ siteUrl: `https://${this.domain}/`, permissionLevel: 'verified' }]; }
  async sitemaps() { return this.maps; }
  async performance() { return { rows: [{ date: '2026-10-25T07:00:00.000Z', clicks: 3, impressions: 60 }] }; }
  async submit(_site: string, sitemap: string) { this.maps = [{ path: sitemap, providerStatus: 'Pending' }]; }
}
