import { resolveMx } from 'node:dns/promises';
import { Pause, type Context } from '../workflow/types.ts';
import { Cloudflare, APIError } from './cloudflare.ts';
import { digest } from '../workflow/journal.ts';
const dnsContent = (record: any) => record.type === 'MX' ? String(record.content).replace(/\.$/, '').toLowerCase() : String(record.content).replace(/^"|"$/g, '');
export async function incoming(ctx: Context, cf: Cloudflare, mxLookup = resolveMx) {
  const { config, resources } = ctx.run; const zoneId = resources.zone.id;
  if (!config.inbox) throw new Pause('WAITING_USER', 'Enter a forwarding inbox in the launch settings.');
  const addressPath = cf.account('/email/routing/addresses');
  let destination = (await cf.list(addressPath)).find(d => d.email.toLowerCase() === config.inbox.toLowerCase());
  if (!destination) {
    if (ctx.run.operations['email-destination']?.status === 'INTENT') throw new Pause('NEEDS_RECONCILIATION', 'The destination request is unresolved. Check the provider before requesting another verification email.');
    await ctx.effect('email-destination', null, () => cf.request(addressPath, 'POST', { email: config.inbox }));
    destination = (await cf.list(addressPath)).find(d => d.email.toLowerCase() === config.inbox.toLowerCase());
  }
  if (!destination?.verified) throw new Pause('WAITING_USER', 'Open the Cloudflare verification email in your forwarding inbox. LaunchKit will check again automatically.', { poll: true, destinationId: destination?.id });
  const required = await cf.get(`/zones/${zoneId}/email/routing/dns`);
  if (!Array.isArray(required)) throw Error('Unexpected email DNS requirements');
  const records = await cf.dns(zoneId, config.domain);
  const conflicts = records.filter(r => r.type === 'MX' && !required.some(d => d.type === 'MX' && dnsContent(d) === dnsContent(r)) || r.type === 'TXT' && dnsContent(r).startsWith('v=spf1') && !required.some(d => d.type === 'TXT' && dnsContent(d) === dnsContent(r)));
  await cf.removeDNS(ctx, zoneId, conflicts, 'Replace existing incoming email service with Cloudflare forwarding');
  const settingsPath = `/zones/${zoneId}/email/routing`;
  let settings = await cf.get(settingsPath);
  if (!settings.enabled || settings.status !== 'ready') {
    if (ctx.run.operations['email-enable']?.status === 'OBSERVED') throw new Pause('WAITING_PROVIDER', 'Email Routing enablement was submitted; waiting for provider readiness without resubmitting.');
    await ctx.effect('email-enable', settings, () => cf.request(`${settingsPath}/dns`, 'POST')); settings = await cf.get(settingsPath);
  }
  const rulePath = `${settingsPath}/rules`; const source = `contact@${config.domain}`;
  let rule = (await cf.list(rulePath)).find(r => r.matchers?.some((m: any) => m.type === 'literal' && m.field === 'to' && m.value === source));
  const desired = { name: `LaunchKit ${ctx.run.id}`, enabled: true, matchers: [{ type: 'literal', field: 'to', value: source }], actions: [{ type: 'forward', value: [config.inbox] }] };
  const correct = (r: any) => r?.enabled === true && r.actions?.length === 1 && r.actions[0].type === 'forward' && r.actions[0].value?.length === 1 && r.actions[0].value[0] === config.inbox;
  if (rule && !correct(rule)) {
    await ctx.approve('dns', { action: `Replace routing rule for ${source}`, before: rule, after: desired });
    const current = (await cf.list(rulePath)).find(r => r.id === rule.id);
    if (digest(current) !== digest(rule)) throw new Pause('WAITING_USER', 'Email routing rule changed after approval. Resume to review the current rule.');
  }
  if (!correct(rule)) { await ctx.effect(`email-rule:${source}`, rule || null, () => cf.request(rule ? `${rulePath}/${rule.id}` : rulePath, rule ? 'PUT' : 'POST', desired)); rule = (await cf.list(rulePath)).find(r => r.matchers?.some((m: any) => m.value === source)); }
  let mx: Awaited<ReturnType<typeof resolveMx>>;
  try { mx = await mxLookup(config.domain); } catch { throw new Pause('WAITING_PROVIDER', 'Public MX records are not yet resolvable.'); }
  const expected = required.filter(d => d.type === 'MX');
  if (!settings.enabled || settings.status !== 'ready' || !correct(rule) || !expected.length || !expected.every(d => mx.some(r => r.exchange.toLowerCase() === d.content.replace(/\.$/, '').toLowerCase() && r.priority === d.priority))) throw new Pause('WAITING_PROVIDER', 'Forwarding is configured but provider readiness or public MX verification is pending.');
  return { source, destinationVerified: true, ruleId: rule.id, mx, configurationVerified: true, deliveryTested: false, verifiedAt: new Date().toISOString(), verificationScope: 'Provider configuration and public DNS; no delivery test message sent' };
}
export class Resend {
  token: string; transport: typeof fetch;
  constructor(token: string, transport = fetch) { this.token = token; this.transport = transport; }
  async request(path: string, method = 'GET', body?: unknown) {
    const response = await this.transport(`https://api.resend.com${path}`, { method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw new APIError(response.status, 'Resend', 'check domain access and plan limits');
    return response.json() as Promise<any>;
  }
  async list() {
    const all: any[] = []; let after = '';
    for (let i = 0; i < 100; i++) { const response = await this.request(`/domains?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`); if (!Array.isArray(response.data)) throw Error('Unexpected Resend list response'); all.push(...response.data); if (!response.has_more) return all; after = response.data.at(-1)?.id; if (!after) break; }
    throw Error('Could not inspect all Resend domains');
  }
}
export async function outgoing(ctx: Context, cf: Cloudflare, resend: Resend) {
  const name = `send.${ctx.run.config.domain}`; const zoneId = ctx.run.resources.zone.id;
  let domain = (await resend.list()).find(d => d.name === name);
  if (!domain) { await ctx.effect('resend-domain', null, () => resend.request('/domains', 'POST', { name })); domain = (await resend.list()).find(d => d.name === name); }
  if (!domain) throw new Pause('WAITING_PROVIDER', 'Resend sending domain is not yet visible.');
  domain = await resend.request(`/domains/${domain.id}`);
  for (const record of domain.records || []) {
    if (!['DKIM', 'SPF'].includes(record.record)) continue;
    if (!['TXT', 'MX', 'CNAME'].includes(record.type)) throw Error('Unsupported Resend DNS record type');
    const recordName = record.name === '@' ? name : record.name === name || record.name.endsWith(`.${name}`) ? record.name : `${record.name}.${name}`;
    if (recordName !== name && !recordName.endsWith(`.${name}`)) throw Error('Resend DNS record escaped sending subdomain');
    await cf.ensureDNS(ctx, zoneId, { name: recordName, type: record.type, content: record.value, ...(record.priority === undefined ? {} : { priority: record.priority }) });
  }
  if (domain.status !== 'verified') { await ctx.effect(`resend-verify:${domain.id}`, { status: domain.status }, () => resend.request(`/domains/${domain.id}/verify`, 'POST')); domain = await resend.request(`/domains/${domain.id}`); }
  if (domain.status !== 'verified') throw new Pause('WAITING_PROVIDER', 'Resend is checking sending-domain DNS. No email has been sent.', { domainId: domain.id, status: domain.status });
  return { domain: name, domainId: domain.id, status: domain.status, testMessageSent: false };
}
