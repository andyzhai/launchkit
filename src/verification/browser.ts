import { chromium } from 'playwright';
import { Pause } from '../workflow/types.ts';
export async function verifyAnalytics(url: string, publicPaths: string[]) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await context.newPage(); const accepted: { endpoint: string; status: number; bytes: number }[] = []; const violations: string[] = [];
    page.on('request', request => {
      const target = new URL(request.url());
      if (target.origin === new URL(url).origin || target.hostname === 'static.cloudflareinsights.com') return;
      if (target.hostname !== 'cloudflareinsights.com' || target.pathname !== '/cdn-cgi/rum') { violations.push('Unexpected external destination'); return; }
      const payload = request.postData() || '';
      if (payload.includes('launchkit-sensitive-canary') || payload.includes('private-file.pdf')) violations.push('Private canary leaked');
      // Never retain the vendor payload or browser request URLs in a report.
    });
    page.on('response', async response => {
      const target = new URL(response.url());
      if (target.hostname === 'cloudflareinsights.com' && target.pathname === '/cdn-cgi/rum' && response.ok()) accepted.push({ endpoint: 'Cloudflare Web Analytics', status: response.status(), bytes: response.request().postDataBuffer()?.length || 0 });
    });
    await page.goto(`${url}${publicPaths[0] || '/'}`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.evaluate(() => { const p = document.createElement('p'); p.textContent = 'launchkit-sensitive-canary private-file.pdf'; document.body.append(p); });
    await page.waitForTimeout(5000); await page.goto('about:blank'); await page.waitForTimeout(1000);
    if (violations.length || context.serviceWorkers().length) throw Error('Analytics privacy verification failed; unexpected traffic or a service worker was observed.');
    if (!accepted.length) throw new Pause('WAITING_PROVIDER', 'Analytics site exists, but no successful beacon response was observed. Tracking remains unverified.');
    return { trackingObserved: true, responses: accepted, isolation: 'Opaque sandbox; no parent DOM, queries, fragments or referrer', customEvents: 'Unavailable with this provider', verifiedAt: new Date().toISOString() };
  } finally { await browser.close(); }
}
