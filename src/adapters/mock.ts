import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON } from '../workflow/journal.ts';
import { Pause, type Context, type Provider, type StepName, type Evidence } from '../workflow/types.ts';
import { ensureDomain, type Registrar, type Zone } from './domain.ts';
export interface MockOptions { connected?: boolean; owned?: boolean; unavailable?: boolean; ambiguousPurchase?: boolean; mxConflict?: boolean; wwwConflict?: boolean; emailPending?: boolean; failStep?: StepName; analyticsPending?: boolean }
export class MockProvider implements Provider {
  options: MockOptions; dir: string;
  constructor(dir: string, options: MockOptions = {}) { this.dir = dir; this.options = options; }
  async step(name: StepName, ctx: Context): Promise<Evidence | 'SKIPPED'> {
    const { run } = ctx; const cfg = run.config;
    const path = join(this.dir, `mock-${run.id}.json`);
    let remote: any;
    try { remote = JSON.parse(await readFile(path, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; remote = { counts: {}, owned: this.options.owned !== false }; }
    const create = async (key: string) => {
      if (!remote[key]) { remote[key] = `${key}-${run.id}`; remote.counts[key] = (remote.counts[key] || 0) + 1; await atomicJSON(path, remote); }
      return remote[key];
    };
    const zone = (): Zone => ({ id: remote.zone || `zone-${run.id}`, name: cfg.domain, status: 'active' });
    const api: Registrar = {
      zone: async () => remote.owned ? zone() : undefined,
      registration: async () => remote.owned ? 'owned' : 'missing',
      check: async () => ({ domain: cfg.domain, available: !this.options.unavailable, amount: '10.11', currency: 'USD', renewal: '10.11' }),
      suggestions: async () => ['example-business.net', 'example-business.org'],
      purchase: async () => { await create('purchase'); remote.owned = true; await atomicJSON(path, remote); if (this.options.ambiguousPurchase) throw Error('timeout'); return { state: 'succeeded' }; },
      createZone: async () => { await create('zone'); return zone(); }
    };
    if (this.options.failStep === name) throw Error('Simulated provider unavailable; resume after service recovers.');
    if (name === 'connect' && this.options.connected === false) throw new Pause('WAITING_USER', 'Connect Cloudflare to continue.');
    if (name === 'domain') return { ...await ensureDomain(ctx, api), simulated: true };
    if (name === 'prepare') { await create('build'); run.resources.fingerprint = 'mock-release'; }
    if (name === 'preview') { await create('deployment'); run.resources.previewUrl = `https://mock-${run.id}.invalid`; }
    if (name === 'binding') {
      if (this.options.wwwConflict && cfg.www) await ctx.approve('dns', { host: `www.${cfg.domain}`, before: ['existing service'], action: 'replace with redirect' });
      await create('binding'); run.resources.url = `https://${cfg.domain}`;
    }
    if (name === 'incoming') {
      if (this.options.mxConflict) await ctx.approve('dns', { domain: cfg.domain, before: ['existing MX'], action: 'replace email provider' });
      await create('destination');
      if (this.options.emailPending) throw new Pause('WAITING_USER', 'Verify the forwarding inbox using the provider email.');
      await create('route');
    }
    if (name === 'outgoing') { if (!cfg.outbound) return 'SKIPPED'; await create('resendDomain'); }
    if (name === 'seo' && !cfg.seo.approved) return 'SKIPPED';
    if (name === 'analytics') {
      await create('analytics');
      if (this.options.analyticsPending) throw new Pause('WAITING_PROVIDER', 'Site created; tracking has not been observed.');
    }
    return { simulated: true, check: name, verifiedAt: new Date().toISOString(), ...(name === 'verify' ? { ongoingMonitoring: false, networkUploads: 0 } : {}) };
  }
}
