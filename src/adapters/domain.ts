import { Pause, type Context } from '../workflow/types.ts';
export interface Quote { domain: string; available: boolean; amount: string; currency: string; renewal: string; reason?: string }
export interface Zone { id: string; name: string; status: string; name_servers?: string[] }
export interface Registrar {
  zone(domain: string): Promise<Zone | undefined>;
  registration(domain: string): Promise<'owned' | 'pending' | 'missing' | 'action_required'>;
  check(domain: string): Promise<Quote>;
  suggestions(domain: string): Promise<string[]>;
  purchase(domain: string): Promise<unknown>;
  createZone(domain: string): Promise<Zone>;
}
export async function ensureDomain(ctx: Context, api: Registrar) {
  const { run } = ctx; const domain = run.config.domain;
  let zone = await api.zone(domain);
  if (!zone) {
    const ownership = await api.registration(domain);
    if (ownership !== 'owned') {
      if (run.operations.purchase && run.operations.purchase.status !== 'REJECTED' || ownership === 'pending') throw new Pause('NEEDS_RECONCILIATION', 'Registration has an unresolved outcome. LaunchKit will inspect it again but will never automatically submit a second purchase.', { domain });
      if (ownership === 'action_required') throw new Pause('WAITING_USER', 'Complete the registrar account or registrant verification and resume.');
      const quote = await api.check(domain);
      if (!quote.available) throw new Pause('WAITING_USER', `Domain cannot be registered: ${quote.reason || 'unavailable'}. Start a launch with another domain.`, { alternatives: await api.suggestions(domain) });
      if (!/^\d+(\.\d{1,2})?$/.test(quote.amount) || !/^[A-Z]{3}$/.test(quote.currency)) throw new Pause('WAITING_USER', 'Registrar did not return an exact supported price. Review the domain in Cloudflare.');
      const terms = { domain, amount: quote.amount, currency: quote.currency, renewal: quote.renewal, years: 1, autoRenew: false,
        terms: 'Non-refundable registration charged to the account default payment method. Confirm the account registrant details and Domain Registration Agreement.' };
      await ctx.approve('purchase', terms);
      const fresh = await api.check(domain);
      if (fresh.amount !== quote.amount || fresh.currency !== quote.currency || fresh.renewal !== quote.renewal || !fresh.available) throw new Pause('WAITING_USER', 'Availability or price changed. Resume to review a fresh quote.');
      try { await ctx.effect('purchase', terms, () => api.purchase(domain)); }
      catch { throw new Pause(run.operations.purchase?.status === 'REJECTED' ? 'WAITING_USER' : 'NEEDS_RECONCILIATION', run.operations.purchase?.status === 'REJECTED' ? 'Registrar rejected the request before registration. Check account permissions and prerequisites, then resume to recheck the quote.' : 'Registration outcome is unknown. Inspecting ownership on resume; no automatic second charge.'); }
      if (await api.registration(domain) !== 'owned') throw new Pause('WAITING_PROVIDER', 'Registration submitted; waiting for confirmed ownership.');
      run.resources.costs = [{ type: 'domain registration', amount: quote.amount, currency: quote.currency, renewal: quote.renewal, evidence: 'Approved quote and completed registration; billing invoice not retrieved' }];
    }
    zone = await api.zone(domain) || await ctx.effect('zone', null, () => api.createZone(domain));
    const confirmed = await api.zone(domain);
    if (!confirmed || confirmed.id !== zone.id) throw new Pause('WAITING_PROVIDER', 'Zone creation is not yet visible.');
    zone = confirmed;
  }
  if (run.operations.purchase?.before && run.operations.purchase.status !== 'REJECTED' && !run.resources.costs) {
    const approved = run.operations.purchase.before as Record<string, unknown>;
    run.resources.costs = [{ type: 'domain registration (reconciled)', amount: approved.amount, currency: approved.currency, renewal: approved.renewal, evidence: 'Approved quote; ownership reconciled; billing invoice not retrieved' }];
  }
  run.resources.zone = zone; await ctx.save();
  return { zoneId: zone.id, domain, status: zone.status, nameServers: zone.name_servers || [] };
}
