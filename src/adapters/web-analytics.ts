import { Cloudflare, APIError } from './cloudflare.ts';
import { Pause, type Context } from '../workflow/types.ts';
import { inspectWebAnalytics, type AnalyticsObservation } from '../verification/web-analytics.ts';

export interface WebAnalyticsResult extends Record<string, unknown> {
  status: 'enabled' | 'attention' | 'unsupported';
  message: string; hostname: string; actionURL: string; checkedAt: string;
  configurationVerified: boolean; browserTrackingVerified: boolean;
  siteId?: string; autoInstall?: boolean; observation?: AnalyticsObservation;
}
const normalized = (value: unknown) => typeof value === 'string' ? value.toLowerCase().replace(/\.$/, '') : '';
const exact = (site: any, host: string) => site?.rules?.some((r: any) => normalized(r.host) === host);
// Enabling a site affects its entire ruleset. Never activate another hostname,
// a wildcard, or an uninspectable rule as a side effect of this deployment.
const scoped = (site: any, host: string) => Array.isArray(site?.rules) && site.rules.length > 0 &&
  site.rules.every((r: any) => r.inclusive === false || normalized(r.host) === host) &&
  site.rules.some((r: any) => normalized(r.host) === host && r.inclusive === true && r.is_paused === false);

export async function ensureWebAnalytics(ctx: Context, cf: Cloudflare,
  inspect = inspectWebAnalytics): Promise<WebAnalyticsResult> {
  const { config, resources } = ctx.run; const host = normalized(config.domain);
  const result: WebAnalyticsResult = { status: 'attention', message: '', hostname: host,
    actionURL: `https://dash.cloudflare.com/${encodeURIComponent(config.accountId)}/web-analytics`,
    checkedAt: new Date().toISOString(), configurationVerified: false, browserTrackingVerified: false };
  let permission = 'Zone Read';
  try {
    if (config.mode !== 'live' || !config.accountId || !resources.zone?.id || resources.url !== `https://${host}` || /\.(workers\.dev|pages\.dev)$/.test(host)) {
      return { ...result, status: 'unsupported', message: 'A deployed Cloudflare custom hostname, account and zone are required.' };
    }
    const zone = await cf.get(`/zones/${encodeURIComponent(resources.zone.id)}`);
    if (zone?.account?.id !== config.accountId || zone.status !== 'active' || zone.paused ||
      !(host === normalized(zone.name) || host.endsWith(`.${normalized(zone.name)}`))) {
      return { ...result, status: 'unsupported', message: 'The hostname is not in an active, unpaused zone in the deployment account.' };
    }
    permission = 'DNS Read';
    const dns = await cf.dns(zone.id, host);
    if (!dns.some(r => normalized(r.name) === host && ['A', 'AAAA', 'CNAME'].includes(r.type) && r.proxied === true)) {
      return { ...result, status: 'unsupported', message: 'This hostname has no Cloudflare-proxied web DNS record. Automatic installation is unavailable; review DNS proxying or install the Cloudflare snippet manually.' };
    }
    if (resources.analytics?.site_token) return { ...result, message: 'This deployment uses legacy isolated analytics. Migrate it through the launch workflow before enabling automatic injection to avoid duplicate measurement.' };
    const path = cf.account('/rum/site_info');
    permission = 'Account Settings Read';
    const sites = await cf.list(`${path}/list`);
    // The live list endpoint may omit rules, despite documenting them. Inspect
    // candidate details before matching a hostname or deciding to create a site.
    for (let i = 0; i < sites.length; i++) {
      const summary = sites[i];
      if (!Array.isArray(summary.rules) && (!summary.ruleset?.zone_tag || summary.ruleset.zone_tag === zone.id)) {
        if (!summary.site_tag) throw Error('Missing site identifier');
        sites[i] = await cf.get(`${path}/${encodeURIComponent(summary.site_tag)}`);
        if (!Array.isArray(sites[i]?.rules)) return { ...result, message: 'Cloudflare did not return hostname rules for an existing analytics site. Recheck or inspect it in the dashboard; no duplicate site was created.' };
      }
    }
    const candidates = sites.filter(s => exact(s, host));
    if (candidates.length > 1) return { ...result, message: 'Multiple analytics sites match this hostname. Resolve the duplicates in Cloudflare; no site was changed.' };
    let site = candidates[0];
    const key = `web-analytics-create:${zone.id}:${host}`;
    const prior = ctx.run.operations[key];
    // A confirmed creation can be read directly while the list is propagating.
    if (!site && prior?.result && typeof (prior.result as any).siteId === 'string') site = await cf.get(`${path}/${encodeURIComponent((prior.result as any).siteId)}`);
    if (!site && sites.some(s => s.ruleset?.zone_tag === zone.id)) {
      return { ...result, message: 'This zone already has analytics rules for other or wildcard hostnames. Review the rules in Cloudflare to include only this hostname; no duplicate or zone-wide activation was made.' };
    }
    if (!site) {
      if (prior && prior.status !== 'REJECTED') return { ...result, message: 'An earlier site creation has an unresolved outcome. Recheck later or reconcile it in Cloudflare; no duplicate request was sent.' };
      permission = 'Account Settings Write';
      // Stage without injection, inspect the actual rules, then enable. The API's
      // host parameter is for manual sites; zone-wide defaults must not go live.
      const created = await ctx.effect(key, null, async () => {
        const response = await cf.request(path, 'POST', { host, zone_tag: zone.id, auto_install: false });
        return { siteId: response.result?.site_tag };
      });
      if (!created.siteId) throw Error('Missing site identifier');
      permission = 'Account Settings Read';
      site = await cf.get(`${path}/${encodeURIComponent(created.siteId)}`);
    } else {
      if (!site.site_tag) throw Error('Missing site identifier');
      site = await cf.get(`${path}/${encodeURIComponent(site.site_tag)}`);
    }
    if (!site?.site_tag) throw Error('Missing site identifier');
    result.siteId = site.site_tag;
    result.actionURL += `/overview?siteTag=${encodeURIComponent(site.site_tag)}`;
    if (site.ruleset?.zone_tag && site.ruleset.zone_tag !== zone.id) return { ...result, message: 'The analytics site belongs to a different zone; no settings were changed.' };
    // Only narrow the default rule of a site created by this run, while disabled.
    const owned = (ctx.run.operations[key]?.result as any)?.siteId === site.site_tag;
    const scopeKey = `web-analytics-scope:${site.site_tag}`;
    const defaultRule = site.rules?.length === 1 && site.rules[0];
    if (owned && !(ctx.run.operations[key]?.result as any)?.scopeVerified && !site.auto_install && defaultRule?.host === '*' && defaultRule.inclusive === true && defaultRule.is_paused === false &&
      defaultRule.paths?.length === 1 && defaultRule.paths[0] === '*' && site.ruleset?.id && defaultRule.id && ctx.run.operations[scopeKey]?.status !== 'OBSERVED') {
      permission = 'Account Settings Write';
      await ctx.effect(scopeKey, null, () => cf.request(cf.account(`/rum/v2/${encodeURIComponent(site.ruleset.id)}/rule/${encodeURIComponent(defaultRule.id)}`), 'PUT', { host, inclusive: true, is_paused: false, paths: ['*'] }));
      permission = 'Account Settings Read'; site = await cf.get(`${path}/${encodeURIComponent(site.site_tag)}`);
    }
    if (!scoped(site, host)) return { ...result, message: 'Existing analytics rules are paused, missing, or include other hostnames. Review them in Cloudflare; site-specific settings were preserved.' };
    if (owned && !(ctx.run.operations[key].result as any)?.scopeVerified) {
      ctx.run.operations[key].result = { siteId: site.site_tag, scopeVerified: true }; await ctx.save();
    }
    if (site.auto_install !== true || site.ruleset?.enabled !== true) {
      permission = 'Account Settings Write';
      await ctx.effect(`web-analytics-enable:${site.site_tag}`, { autoInstall: site.auto_install, enabled: site.ruleset?.enabled }, async () => {
        await cf.request(`${path}/${encodeURIComponent(site.site_tag)}`, 'PUT', { auto_install: true, enabled: true, zone_tag: zone.id });
        return { submitted: true };
      });
    }
    permission = 'Account Settings Read';
    site = await cf.get(`${path}/${encodeURIComponent(site.site_tag)}`);
    if (!scoped(site, host) || site.ruleset?.zone_tag !== zone.id || site.auto_install !== true || site.ruleset?.enabled !== true) {
      return { ...result, message: 'Cloudflare has not confirmed the exact hostname, enabled ruleset and automatic installation. Recheck after propagation.' };
    }
    result.configurationVerified = true; result.autoInstall = true; result.status = 'enabled';
    result.message = 'Cloudflare Web Analytics: Enabled. Configuration verified; browser tracking has not yet been verified.';
    try {
      result.observation = await inspect(resources.url, site.site_token);
      result.browserTrackingVerified = result.observation.browserTrackingVerified;
      result.message = `Cloudflare Web Analytics: Enabled. ${result.browserTrackingVerified ? 'Browser tracking verified by a successful beacon response.' : 'Browser tracking unverified.'} ${result.observation.blockers.join(' ')}`.trim();
    } catch { result.message += ' The public website check was unavailable; retry verification.'; }
    return result;
  } catch (error) {
    if (error instanceof APIError && ([401, 403].includes(error.status) || error.status < 500 && error.codes.some(c => [10000, 9109].includes(c)))) {
      result.message = `Cloudflare denied ${permission} access for this operation. Edit the saved API token in Cloudflare → My Profile → API Tokens, grant ${permission} for only the selected ${permission.startsWith('Account') ? 'account' : 'zone'}, then reconnect it in LaunchKit and retry. Check token expiry and resource scope too; a denial does not expose the token's exact grants.`;
      result.requiredPermission = permission;
    } else if (error instanceof Pause) result.message = error.message;
    else result.message = 'Cloudflare Web Analytics setup could not be confirmed. Retry to inspect provider state; the application deployment is unaffected.';
    return result;
  }
}
