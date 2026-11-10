import { createHash } from 'node:crypto';
import { resolve4, resolve6, resolveNs } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pause } from '../workflow/types.ts';
const pendingHTTP = new Set([404, 408, 409, 425, 429, 500, 502, 503, 504, 521, 522, 523, 524, 525, 526, 530]);
export async function publicFetch(url: string | URL, transport = fetch): Promise<Response> {
  const target = new URL(url); const endpoint = `${target.origin}${target.pathname}`;
  try { return await transport(target, { redirect: 'manual', signal: AbortSignal.timeout(25_000) }); }
  catch (error: any) {
    const candidates = [error?.cause?.code, ...(error?.cause?.errors || []).map((e: any) => e.code), error?.code, error?.name];
    const codes = [...new Set(candidates.filter(c => typeof c === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(c)))];
    if (!codes.length) codes.push(error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR');
    throw new Pause('WAITING_PROVIDER', `Public ${target.protocol === 'https:' ? 'HTTPS' : 'HTTP'} check for ${target.hostname} is not ready (${codes.join(', ')}). Waiting for DNS, TLS, or edge connectivity; certificate validation remains enabled.`, { endpoint: `GET ${endpoint}`, codes });
  }
}
export function requireReadyHTTP(response: Response, url: string | URL) {
  if (pendingHTTP.has(response.status)) {
    const target = new URL(url);
    throw new Pause('WAITING_PROVIDER', `Public endpoint ${target.hostname}${target.pathname} returned HTTP ${response.status}; waiting for provider readiness.`, { endpoint: `GET ${target.origin}${target.pathname}`, httpStatus: response.status });
  }
}
export async function checkedFetch(url: string, transport = fetch) {
  const response = await publicFetch(url, transport);
  if (!response.ok) { await response.body?.cancel(); requireReadyHTTP(response, url); throw Error(`HTTP verification failed: ${new URL(url).pathname} returned ${response.status}`); } return response;
}
export function withoutCloudflareBeacon(html: string) {
  return html.replace(/(?:<!-- Cloudflare Web Analytics -->\s*)?<script\b([^>]*)>\s*<\/script>(?:\s*<!-- End Cloudflare Web Analytics -->)?/gi, (script, attributes: string) => {
    const attrs = [...attributes.matchAll(/([\w-]+)(?:\s*=\s*(["'])(.*?)\2)?/gs)];
    if (attrs.some(a => !['src', 'defer', 'data-cf-beacon', 'integrity', 'crossorigin'].includes(a[1].toLowerCase()))) return script;
    const src = attrs.find(a => a[1].toLowerCase() === 'src')?.[3];
    const beacon = attrs.find(a => a[1].toLowerCase() === 'data-cf-beacon')?.[3];
    if (!src || !/^https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js(?:\/v?[a-f0-9]+)?$/.test(src) || !beacon) return script;
    try { if (!/^[a-f0-9]{32}$/.test(JSON.parse(beacon).token)) return script; } catch { return script; }
    return '';
  });
}
export async function verifyHTTP(url: string, manifest: Record<string, string>, release: string, preview: boolean, dir: string, transport = fetch) {
  if (new URL(url).protocol !== 'https:') throw Error('Public verification requires HTTPS');
  const index = await checkedFetch(url, transport);
  if (index.headers.get('x-launchkit-release') !== release) throw new Pause('WAITING_PROVIDER', 'HTTPS is responding but the expected release is not yet visible.');
  if (preview && !index.headers.get('x-robots-tag')?.includes('noindex')) throw Error('Preview is missing its noindex response header');
  if (!preview && index.headers.get('x-robots-tag')?.includes('noindex')) throw Error('Production still has a noindex response header');
  if (index.headers.get('x-content-type-options') !== 'nosniff' || index.headers.get('referrer-policy') !== 'no-referrer') throw Error('Required security headers missing');
  const localHTML = await readFile(join(dir, 'index.html'), 'utf8');
  const metaCSP = localHTML.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/i)?.[1];
  if (metaCSP && !index.headers.get('content-security-policy')?.includes(metaCSP)) throw Error('Deployed CSP differs from the approved policy');
  await index.body?.cancel();
  let assets = 0; let wasm = 0; let transformedHTML = 0;
  for (const [name, expected] of Object.entries(manifest)) {
    if (name.startsWith('_') || preview && name === 'robots.txt') continue;
    const path = '/' + name.split('/').map(encodeURIComponent).join('/');
    let response = await publicFetch(new URL(path, url), transport);
    if (name.endsWith('.html') && [301, 302, 307, 308].includes(response.status)) {
      const target = new URL(response.headers.get('location') || '', url); await response.body?.cancel(); if (target.origin !== new URL(url).origin) throw Error('Asset redirected outside the site'); response = await checkedFetch(target.href, transport);
    }
    if (!response.ok) { await response.body?.cancel(); requireReadyHTTP(response, new URL(path, url)); throw Error(`Asset verification failed: ${name} (${response.status})`); }
    const content = Buffer.from(await response.arrayBuffer());
    const hash = createHash('sha256').update(content).digest('hex');
    if (hash !== expected) {
      const local = !preview && name.endsWith('.html') ? await readFile(join(dir, name)) : undefined;
      const normalize = (html: string) => html.replace(/\s*<\/body>/i, '</body>').trimEnd();
      const stripped = withoutCloudflareBeacon(content.toString('utf8'));
      if (!local || createHash('sha256').update(local).digest('hex') !== expected || stripped === content.toString('utf8') || normalize(stripped) !== normalize(local.toString('utf8'))) throw Error(`Published asset differs from release: ${name}`);
      transformedHTML++;
    }
    if (name.endsWith('.wasm')) { if (!response.headers.get('content-type')?.startsWith('application/wasm')) throw Error('WASM MIME type is incorrect'); wasm++; }
    assets++;
  }
  const missing = await publicFetch(new URL('/assets/launchkit-missing.wasm', url), transport);
  if (missing.status !== 404) throw Error('Missing runtime assets must return 404');
  await missing.body?.cancel();
  return { url, tls: 'Validated by HTTPS client', assets, wasm, hashes: transformedHTML ? 'SHA-256 matched for original assets; HTML matched after removing the Cloudflare beacon and boundary whitespace' : 'SHA-256 matched', ...(transformedHTML ? { transformedHTML } : {}), securityHeaders: true, noindex: preview, verifiedAt: new Date().toISOString() };
}
export async function verifyDNS(domain: string, expectedNS: string[]) {
  try {
    const ns = await resolveNs(domain);
    const addresses = (await Promise.allSettled([resolve4(domain), resolve6(domain)])).flatMap(r => r.status === 'fulfilled' ? r.value : []);
    if (!addresses.length || !expectedNS.length || !expectedNS.every(n => ns.map(s => s.toLowerCase()).includes(n.toLowerCase()))) throw Error('DNS not ready');
    return { nameservers: ns, addresses };
  } catch { throw new Pause('WAITING_PROVIDER', 'Authoritative nameservers or public web DNS are still propagating.'); }
}
export async function verifySEO(url: string, approved: boolean) {
  if (!approved) return 'SKIPPED' as const;
  const html = await (await checkedFetch(url)).text(); const robots = await (await checkedFetch(`${url}/robots.txt`)).text(); const sitemap = await (await checkedFetch(`${url}/sitemap.xml`)).text();
  if (!html.includes(`rel="canonical" href="${url}/"`) || !robots.includes(`Sitemap: ${url}/sitemap.xml`) || !sitemap.includes(`<loc>${url}/</loc>`)) throw Error('Public SEO metadata does not match the approved domain');
  return { canonical: `${url}/`, sitemap: `${url}/sitemap.xml`, robots: `${url}/robots.txt`, searchConsole: 'Optional owner verification; no indexing or ranking guarantee' };
}
