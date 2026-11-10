import { domainToASCII } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import type { LaunchConfig } from '../workflow/types.ts';
export function hostname(value: string): string {
  if (/[\s/:;\\?#@]/.test(String(value).trim())) throw Error('Enter a domain name without a URL, path, or port.');
  const domain = domainToASCII(String(value).trim().toLowerCase().replace(/\.$/, ''));
  if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(domain)) throw Error('Enter a domain name without a URL, path, or port.');
  return domain;
}
export function configuration(input: any): LaunchConfig {
  if (!input || !['live', 'mock'].includes(input.mode)) throw Error('Select live or simulation mode');
  if (typeof input.appPath !== 'string' || !isAbsolute(input.appPath)) throw Error('Select an absolute application folder path');
  const accountId = String(input.accountId || '');
  if (input.mode === 'live' && accountId && !/^[a-f0-9]{32}$/.test(accountId)) throw Error('Invalid Cloudflare account ID');
  const inbox = String(input.inbox || '').trim();
  if (inbox && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inbox)) throw Error('Invalid forwarding inbox');
  const publicPaths: string[] = input.analytics?.publicPaths || ['/'];
  if (!Array.isArray(publicPaths) || publicPaths.length > 20 || publicPaths.some(p => typeof p !== 'string' || !/^\/[a-zA-Z0-9/_-]*$/.test(p))) throw Error('Analytics accepts exact public paths only, without queries or wildcards');
  return { appPath: resolve(input.appPath), domain: hostname(input.domain), accountId, inbox,
    mode: input.mode, outbound: input.outbound === true, www: input.www === true,
    seo: { approved: input.seo?.approved === true, title: String(input.seo?.title || '').slice(0, 120), description: String(input.seo?.description || '').slice(0, 300) },
    analytics: { approved: input.analytics?.approved === true, publicPaths } };
}
