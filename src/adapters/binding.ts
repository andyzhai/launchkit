import { Pause, type Context } from '../workflow/types.ts';
import type { Cloudflare } from './cloudflare.ts';
import { verifyDNS, verifyHTTP, publicFetch, requireReadyHTTP } from '../verification/http.ts';

export interface BindingChecks {
  dns: typeof verifyDNS;
  http: typeof verifyHTTP;
  fetch: typeof publicFetch;
  sleep: (milliseconds: number) => Promise<void>;
}
export async function bindDomain(ctx: Context, cf: Pick<Cloudflare, 'zone' | 'bind'>, checks: BindingChecks = {
  dns: verifyDNS, http: verifyHTTP, fetch: publicFetch, sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
}) {
  const { config, resources: r } = ctx.run;
  const zone = await cf.zone(config.domain);
  if (!zone || zone.status !== 'active') throw new Pause('WAITING_USER', 'Activate this zone by completing registrar nameserver delegation. External registrars require account authorization; LaunchKit will not guess registrar credentials.', { nameservers: zone?.name_servers || r.zone?.name_servers || [], actionURL: `https://dash.cloudflare.com/${config.accountId}/${config.domain}/dns`, poll: true });
  r.zone = zone;
  const binding = await cf.bind(ctx, config.domain);
  r.url = `https://${config.domain}`; await ctx.save();
  // Provision requested hosts once, then poll only their observable readiness.
  // Resume uses the provider adapter's inspect-before-write reconciliation.
  const www = config.www ? await cf.bind(ctx, `www.${config.domain}`) : 'Not selected';
  const redirects = async (url: string, allowed: number[]) => {
    const response = await checks.fetch(url);
    const location = response.headers.get('location'); await response.body?.cancel();
    requireReadyHTTP(response, url);
    if (!allowed.includes(response.status) || location !== `${r.url}/`) throw Error(`Redirect verification failed for ${new URL(url).hostname}: expected ${allowed.join('/')} to ${r.url}/, received HTTP ${response.status}.`);
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await checks.sleep([250, 1000, 2000][attempt - 1]);
    try {
      const dns = await checks.dns(config.domain, zone.name_servers || []);
      if (config.www) await redirects(`https://www.${config.domain}/`, [301]);
      await redirects(`http://${config.domain}/`, [301, 308]);
      const http = await checks.http(r.url, r.manifest, r.release, false, r.publishDir);
      return { binding, dns, http, www, httpRedirect: true };
    } catch (error) {
      if (!(error instanceof Pause) || error.status !== 'WAITING_PROVIDER') throw error;
      if (attempt === 3) throw new Pause('WAITING_PROVIDER', error.message, { ...error.evidence, phase: 'domain readiness', attempts: 4, bindingId: binding.id, wwwBindingId: typeof www === 'string' ? undefined : www.id });
    }
  }
  throw Error('Unexpected binding verification state');
}
