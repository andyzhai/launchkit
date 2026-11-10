import { Pause, type Context } from '../workflow/types.ts';
import type { Credentials } from '../security/tokens.ts';
import type { Registrar, Quote, Zone } from './domain.ts';
import { digest } from '../workflow/journal.ts';
export class APIError extends Error {
  status: number; definitiveFailure: boolean; codes: number[]; endpoint?: string;
  constructor(status: number, provider: string, codes: string, request?: { method: string; path: string }) {
    const endpoint = request ? `${request.method} ${request.path.split('?')[0]}` : undefined;
    super(`${provider} request failed (${status}; ${codes || 'no provider code'})${endpoint ? ` at ${endpoint}` : ''}. Check token permissions, account access, and provider availability. No response body was logged.`);
    this.status = status; this.codes = codes.split(',').filter(c => /^\d+$/.test(c)).map(Number); this.endpoint = endpoint;
    this.definitiveFailure = status >= 400 && status < 500 && ![408, 409, 429].includes(status);
  }
}
export class Cloudflare implements Registrar {
  accountId: string; credentials: Credentials; transport: typeof fetch; sandbox: boolean;
  constructor(accountId: string, credentials: Credentials, transport = fetch, sandbox = false) { this.accountId = accountId; this.credentials = credentials; this.transport = transport; this.sandbox = sandbox; }
  account(path: string) { return `/accounts/${this.accountId}${path}`; }
  registrar(path: string) { return this.account(`/${this.sandbox ? 'registrar-sandbox' : 'registrar'}${path}`); }
  async request(path: string, method = 'GET', body?: unknown, registrar = false): Promise<any> {
    const token = registrar ? this.credentials.registrar : this.credentials.cloudflare;
    if (!token) throw new Pause('WAITING_USER', registrar ? 'Connect a scoped Registrar token. Complete billing, default registrant contact and legal terms in Cloudflare before purchase.' : 'Connect a scoped Cloudflare API token.');
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try { response = await this.transport(`https://api.cloudflare.com/client/v4${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(25_000) }); }
      catch { throw new Pause('WAITING_PROVIDER', 'Cloudflare connection failed or timed out. Resume to inspect the actual provider state.'); }
      if (method === 'GET' && (response.status === 429 || response.status >= 500) && attempt < 2) { await response.body?.cancel(); await new Promise(r => setTimeout(r, 250 * 2 ** attempt)); continue; }
      const result: any = await response.json().catch(() => ({}));
      if (!response.ok || result.success !== true) throw new APIError(response.status, 'Cloudflare', (result.errors || []).map((e: any) => e.code).filter((c: any) => typeof c === 'number').join(','), { method, path });
      return result;
    }
  }
  async get(path: string, optional = false, registrar = false) { try { return (await this.request(path, 'GET', undefined, registrar)).result; } catch (e) { if (optional && e instanceof APIError && e.status === 404) return undefined; throw e; } }
  async list(path: string): Promise<any[]> {
    if (/\/workers\/(?:domains|routes)(?:\?|$)/.test(path)) {
      const response = await this.request(path);
      if (!Array.isArray(response.result) || response.result_info?.total_pages > 1) throw Error('Worker resource listing is incomplete; refusing to change routing');
      return response.result;
    }
    const items: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.request(`${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=50`);
      if (!Array.isArray(response.result)) throw Error('Unexpected Cloudflare list response; refusing an incomplete inspection');
      items.push(...response.result);
      if (response.result_info?.total_pages ? page >= response.result_info.total_pages : response.result.length < 50) return items;
    }
    throw Error('Provider list is too large for complete inspection');
  }
  async zone(domain: string): Promise<Zone | undefined> { const zones = await this.list(`/zones?name=${encodeURIComponent(domain)}&account.id=${this.accountId}`); return zones.find(z => z.name === domain && z.account?.id === this.accountId); }
  async registration(domain: string): Promise<'owned' | 'pending' | 'missing' | 'action_required'> {
    const resource = await this.get(this.registrar(`/registrations/${domain}`), true, true);
    if (resource?.status === 'active') return 'owned';
    const status = await this.get(this.registrar(`/registrations/${domain}/registration-status`), true, true);
    if (status?.state === 'succeeded') return 'pending'; // Wait for the actual registration resource.
    if (!resource && !status) return 'missing';
    return ['blocked', 'action_required', 'failed'].includes(status?.state) ? 'action_required' : 'pending';
  }
  async check(domain: string): Promise<Quote> {
    const result = (await this.request(this.registrar('/domain-check'), 'POST', { domains: [domain] }, true)).result;
    const record = result?.domains?.find((d: any) => d.name === domain);
    if (!record) throw Error('Registrar response omitted the requested domain');
    return { domain, available: record.registrable === true && record.tier !== 'premium', amount: String(record.pricing?.registration_cost || ''), currency: record.pricing?.currency || '', renewal: String(record.pricing?.renewal_cost || ''), reason: record.reason || (record.tier === 'premium' ? 'Premium registration is not supported by this API' : '') };
  }
  async suggestions(domain: string) { const result = await this.get(this.registrar(`/domain-search?q=${encodeURIComponent(domain.split('.')[0])}&limit=5`), false, true); return (result?.domains || []).map((r: any) => r.name).filter((n: any) => typeof n === 'string'); }
  async purchase(domain: string) { if (this.sandbox) throw Error('Sandbox registration requires explicit contact data; use sandboxPurchase'); return (await this.request(this.registrar('/registrations'), 'POST', { domain_name: domain }, true)).result; }
  async sandboxPurchase(domain: string, contacts: unknown) { if (!this.sandbox) throw Error('This method cannot register production domains'); return (await this.request(this.registrar('/registrations'), 'POST', { domain_name: domain, contacts }, true)).result; }
  async createZone(domain: string): Promise<Zone> { return (await this.request('/zones', 'POST', { name: domain, account: { id: this.accountId }, type: 'full' })).result; }
  dns(zoneId: string, name?: string) { return this.list(`/zones/${zoneId}/dns_records${name ? `?name=${encodeURIComponent(name)}` : ''}`); }
  async removeDNS(ctx: Context, zoneId: string, records: any[], reason: string) {
    if (!records.length) return;
    const snapshot = records.map(r => ({ id: r.id, name: r.name, type: r.type, content: r.content, priority: r.priority, proxied: r.proxied, ttl: r.ttl })).sort((a, b) => a.id.localeCompare(b.id));
    await ctx.approve('dns', { zoneId, action: reason, before: snapshot });
    // Re-read each exact record immediately before deletion. Changed records invalidate approval.
    for (const record of snapshot) {
      const current = await this.get(`/zones/${zoneId}/dns_records/${record.id}`, true);
      if (!current) continue;
      if (current.content !== record.content || current.type !== record.type || current.name !== record.name || current.priority !== record.priority || current.proxied !== record.proxied || current.ttl !== record.ttl) throw new Pause('WAITING_USER', 'DNS changed after approval. Resume to review the current records.');
      await ctx.effect(`dns-delete:${record.id}:${digest(record)}`, record, () => this.request(`/zones/${zoneId}/dns_records/${record.id}`, 'DELETE'));
      if (await this.get(`/zones/${zoneId}/dns_records/${record.id}`, true)) throw new Pause('WAITING_PROVIDER', 'DNS removal is not yet confirmed.');
    }
  }
  async ensureDNS(ctx: Context, zoneId: string, record: { name: string; type: string; content: string; priority?: number }) {
    const records = await this.dns(zoneId, record.name);
    const same = records.find(r => r.type === record.type && r.content.replace(/^"|"$/g, '') === record.content.replace(/^"|"$/g, '') && (record.priority === undefined || r.priority === record.priority));
    if (same) return same;
    const conflicts = records.filter(r => r.type === 'CNAME' || record.type === 'CNAME' || r.type === record.type && (record.type !== 'TXT' || record.content.startsWith('v=spf1') && r.content.replace(/^"/, '').startsWith('v=spf1')));
    await this.removeDNS(ctx, zoneId, conflicts, `Replace conflicting records for ${record.name} (${record.type})`);
    await ctx.effect(`dns-create:${digest(record)}`, records, () => this.request(`/zones/${zoneId}/dns_records`, 'POST', { ...record, ttl: 1, proxied: false }));
    const confirmed = (await this.dns(zoneId, record.name)).find(r => r.type === record.type && r.content.replace(/^"|"$/g, '') === record.content.replace(/^"|"$/g, ''));
    if (!confirmed) throw new Pause('WAITING_PROVIDER', 'New DNS record is not yet visible.');
    return confirmed;
  }
  async bind(ctx: Context, hostname: string) {
    const zone = ctx.run.resources.zone as Zone; const service = ctx.run.resources.worker;
    const path = this.account('/workers/domains');
    let existing = (await this.list(path)).find(d => d.hostname === hostname);
    const routes = await this.list(`/zones/${zone.id}/workers/routes`);
    // Wildcards and routes can supersede a custom domain. Treat every matching route as a conflict.
    const matching = routes.filter(r => { const pattern = String(r.pattern).replace(/^https?:\/\//, '').split('/')[0]; return pattern === hostname || pattern.startsWith('*') && hostname.endsWith(pattern.slice(1)); });
    if (matching.length) throw new Pause('WAITING_USER', 'Existing Workers routes overlap this hostname. Review them in Cloudflare before resuming; no route was overwritten.', { routes: matching.map(r => ({ id: r.id, pattern: r.pattern, script: r.script })) });
    if (existing && existing.service !== service) {
      await ctx.approve('dns', { hostname, before: existing, action: `Rebind to ${service}` });
      const current = (await this.list(path)).find(d => d.hostname === hostname);
      if (digest(current) !== digest(existing)) throw new Pause('WAITING_USER', 'Custom-domain binding changed after approval; review the current service.');
    }
    if (!existing || existing.service !== service || existing.enabled === false) {
      const conflicts = (await this.dns(zone.id, hostname)).filter(r => ['A', 'AAAA', 'CNAME'].includes(r.type));
      await this.removeDNS(ctx, zone.id, conflicts, `Replace web hosting records for ${hostname}`);
      await ctx.effect(`binding:${hostname}`, existing || null, () => this.request(path, 'PUT', { hostname, service, zone_id: zone.id, enabled: true, previews_enabled: false }));
      existing = (await this.list(path)).find(d => d.hostname === hostname && d.service === service && d.enabled !== false);
    }
    if (!existing) throw new Pause('WAITING_PROVIDER', 'Custom domain is not yet visible.');
    return { id: existing.id, hostname, service, certificateId: existing.cert_id };
  }
}
