import { chromium } from 'playwright';

export interface AnalyticsObservation {
  beaconPresent: boolean; browserTrackingVerified: boolean; blockers: string[]; checkedAt: string;
}
function allows(policy: string, directive: string, target: string, origin: string): boolean {
  const directives = new Map(policy.split(';').map(part => { const [name, ...values] = part.trim().split(/\s+/); return [name.toLowerCase(), values]; }));
  const sources = directives.get(directive) || (directive === 'script-src-elem' ? directives.get('script-src') : undefined) || directives.get('default-src');
  if (!sources) return true;
  const url = new URL(target);
  return sources.some(source => source === '*' || source === 'https:' || source === "'self'" && url.origin === origin || source === url.origin || source === target || source === `${url.origin}/`);
}
export function analyticsBlockers(headers: Headers, html: string, url: string) {
  const blockers: string[] = [];
  if (/(?:^|,)\s*no-transform\s*(?:,|$)/i.test(headers.get('cache-control') || '')) blockers.push('Cache-Control: no-transform prevents automatic beacon injection. Remove it from production HTML responses before rechecking.');
  const policies = (headers.get('content-security-policy') || '').split(',').filter(Boolean);
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = new Map([...tag[0].matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/gs)].map(m => [m[1].toLowerCase(), m[3]]));
    if (attrs.get('http-equiv')?.toLowerCase() === 'content-security-policy') policies.push(attrs.get('content') || '');
  }
  if (policies.some(p => !allows(p, 'script-src-elem', 'https://static.cloudflareinsights.com/beacon.min.js', url))) blockers.push('CSP may block the beacon. Allow https://static.cloudflareinsights.com in the effective script-src/script-src-elem policy.');
  if (policies.some(p => !allows(p, 'connect-src', `${url}/cdn-cgi/rum`, url))) blockers.push("CSP may block collection. Allow 'self' in connect-src for /cdn-cgi/rum on this proxied hostname.");
  return blockers;
}
export async function inspectWebAnalytics(url: string, siteToken?: string, transport = fetch): Promise<AnalyticsObservation> {
  const result: AnalyticsObservation = { beaconPresent: false, browserTrackingVerified: false, blockers: [], checkedAt: new Date().toISOString() };
  const response = await transport(`${url}/`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) { await response.body?.cancel(); result.blockers.push('The public root did not return successful HTML; browser verification is pending.'); return result; }
  // Bound the lightweight probe even if an origin returns an unexpectedly large body.
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  if (reader) try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1_000_000) { result.blockers.push('HTML exceeds the lightweight check limit.'); break; } chunks.push(value); } } finally { await reader.cancel(); }
  const html = Buffer.concat(chunks).toString('utf8');
  result.beaconPresent = /<script\b[^>]*\bsrc\s*=\s*["']https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js(?:[/?][^"']*)?["']/i.test(html);
  result.blockers.push(...analyticsBlockers(response.headers, html, url));
  if (!result.beaconPresent) result.blockers.push('The beacon was not present in this response. Edge propagation, existing rules or regional exclusions may apply.');
  if (!result.beaconPresent || result.blockers.length || !siteToken) return result;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 15_000 });
    const page = await browser.newPage({ serviceWorkers: 'block' }); let scriptLoaded = false; let collected = false;
    page.on('response', res => {
      const target = new URL(res.url()); const request = res.request();
      if (target.hostname === 'static.cloudflareinsights.com' && target.pathname.startsWith('/beacon.min.js') && res.ok()) scriptLoaded = true;
      if (target.origin === url && target.pathname === '/cdn-cgi/rum' && request.method() === 'POST' && res.ok()) {
        try { if (JSON.parse(request.postData() || '{}').siteToken === siteToken) collected = true; } catch { /* No payloads are retained. */ }
      }
    });
    await page.goto(`${url}/`, { waitUntil: 'load', timeout: 20_000 });
    await page.waitForTimeout(3000); await page.goto('about:blank'); await page.waitForTimeout(1000);
    result.browserTrackingVerified = scriptLoaded && collected;
    if (!result.browserTrackingVerified) result.blockers.push('No successful collection response for this analytics site was observed. Browser tracking remains unverified.');
  } catch { result.blockers.push('Browser verification was unavailable or timed out. Configuration remains enabled.'); }
  finally { await browser?.close(); }
  return result;
}
