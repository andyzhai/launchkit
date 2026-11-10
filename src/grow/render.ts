import { chromium, type Browser } from 'playwright';
import { createServer, type AddressInfo } from 'node:net';
import { publicAddress } from '../operate/health.ts';
import { hostname } from '../security/config.ts';
import { readRenderAsset, renderAssetPath, type Address, type PublicAsset, type PublicPage } from './public.ts';

export interface RenderedPage {
  status: 'AVAILABLE' | 'UNAVAILABLE';
  title?: string; description?: string; headings?: { level: number; text: string }[]; text?: string;
  truncated?: boolean; limited?: boolean; blocked?: number; scriptErrors?: number; message?: string;
}
interface RenderTools {
  launch(): Promise<Browser>;
  readAsset(domain: string, path: string, address: Address, signal: AbortSignal, remaining: number): Promise<PublicAsset>;
  timeoutMs: number; settleMs: number;
}
const defaults: RenderTools = {
  launch: async () => {
    // An ephemeral loopback socket rejects every connection; it never forwards.
    // This avoids assuming a supposedly unused proxy port is actually unused.
    const deny = createServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => { deny.once('error', reject); deny.listen(0, '127.0.0.1', resolve); });
    try {
      const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, timeout: 10_000,
        proxy: { server: `http://127.0.0.1:${(deny.address() as AddressInfo).port}`, bypass: '<-loopback>' },
        args: ['--host-resolver-rules=MAP * ~NOTFOUND', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
      browser.once('disconnected', () => deny.close());
      return browser;
    } catch (error) { deny.close(); throw error; }
  },
  readAsset: readRenderAsset, timeoutMs: 12_000, settleMs: 1500
};

export function allowedRenderAsset(domain: string, url: string, method: string, kind: string) {
  try {
    const target = new URL(url);
    return method === 'GET' && target.origin === `https://${domain}` && !target.username && !target.password && !target.search && !target.hash &&
      renderAssetPath(target.pathname) && ((kind === 'script' && /\.m?js$/i.test(target.pathname)) || (kind === 'stylesheet' && /\.css$/i.test(target.pathname)));
  } catch { return false; }
}

// Only the homepage of the already-validated business is rendered. No links,
// clicks, uploads, downloads, form submissions or authenticated browser state.
export async function renderHomepage(domain: string, homepage: PublicPage, address: Address, overrides: Partial<RenderTools> = {}): Promise<RenderedPage> {
  const unavailable = (message: string): RenderedPage => ({ status: 'UNAVAILABLE', message });
  try {
    if (hostname(domain) !== domain || !publicAddress(address.address) || ![4, 6].includes(address.family) || homepage.status !== 200 || !/^text\/html\b/i.test(homepage.type) || Buffer.byteLength(homepage.body) > 512_000) throw Error();
  } catch { return unavailable('A valid public HTTPS homepage response is required for rendering.'); }
  const tools = { ...defaults, ...overrides };
  let browser: Browser | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  let assetQueue = Promise.resolve();
  let blocked = 0, assets = 0, bytes = 0, scriptErrors = 0, failedAsset = false, navigationBlocked = false, servedHome = false;
  try {
    browser = await tools.launch();
    timer = setTimeout(() => { abort.abort(); void browser?.close().catch(() => {}); }, tools.timeoutMs);
    const context = await browser.newContext({ offline: true, serviceWorkers: 'block', acceptDownloads: false, permissions: [],
      viewport: { width: 1280, height: 900 }, locale: 'en-US', colorScheme: 'light', reducedMotion: 'reduce' });
    await context.routeWebSocket('**/*', socket => { blocked++; socket.close(); });
    const page = await context.newPage();
    page.on('pageerror', () => { scriptErrors++; });
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
    context.on('page', popup => { if (popup !== page) { blocked++; void popup.close().catch(() => {}); } });
    // Additional CSP limits worker/WebRTC-like connections, frames, forms and
    // browser-managed resource loading. Original CSP is retained as a second policy.
    const policy = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; img-src data:; font-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'";
    await context.route('**/*', async route => {
      const req = route.request();
      try {
        if (!servedHome && req.isNavigationRequest() && req.frame() === page.mainFrame() && req.method() === 'GET' && req.url() === `https://${domain}/`) {
          servedHome = true;
          await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'Content-Security-Policy': homepage.csp ? `${policy}, ${homepage.csp}` : policy }, body: homepage.body }); return;
        }
        if (req.isNavigationRequest()) { navigationBlocked = true; blocked++; await route.abort(); return; }
        if (!allowedRenderAsset(domain, req.url(), req.method(), req.resourceType()) || abort.signal.aborted) {
          if (['script', 'stylesheet'].includes(req.resourceType()) && new URL(req.url()).origin === `https://${domain}`) failedAsset = true;
          blocked++; await route.abort(); return;
        }
        if (++assets > 16) throw Error('Asset count limit');
        // Serialize network reads so simultaneous module requests cannot each
        // consume the same remaining byte budget.
        const loaded = assetQueue.then(async () => {
          if (abort.signal.aborted || bytes >= 8_000_000) throw Error('Render budget exhausted');
          const asset = await tools.readAsset(domain, new URL(req.url()).pathname, address, abort.signal, 8_000_000 - bytes);
          bytes += asset.body.length;
          const validType = req.resourceType() === 'script' ? /^(?:text|application)\/(?:javascript|ecmascript)\b/i.test(asset.type) : /^text\/css\b/i.test(asset.type);
          if (asset.status !== 200 || !validType || asset.body.length > 4_000_000 || bytes > 8_000_000) throw Error('Unsupported asset');
          return asset;
        });
        assetQueue = loaded.then(() => {}, () => { abort.abort(); });
        const asset = await loaded;
        await route.fulfill({ status: 200, contentType: asset.type, body: asset.body });
      } catch { failedAsset = true; await route.abort().catch(() => {}); }
    });
    await page.goto(`https://${domain}/`, { waitUntil: 'load', timeout: tools.timeoutMs });
    // A bounded observation window, not a guarantee all asynchronous UI is ready.
    await page.waitForTimeout(tools.settleMs);
    const result = await page.evaluate(() => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const visible = (element: Element) => {
        if (element.closest('noscript,script,style,template,[hidden],[aria-hidden="true"],input,textarea,select')) return false;
        for (let node: Element | null = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return false;
        }
        return true;
      };
      const collect = (root: Element, limit: number) => {
        const parts: string[] = []; let length = 0, visited = 0, truncated = false, lastBlock: Element | null = null;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (++visited > 20_000 || length >= limit) { truncated = true; break; }
          const value = normalize(node.textContent || '');
          if (!value || !node.parentElement || !visible(node.parentElement)) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          if (![...range.getClientRects()].some(r => r.width > 0 && r.height > 0)) continue;
          const block = node.parentElement.closest('p,li,h1,h2,h3,h4,div,section,article,main,header,footer,button') || root;
          const clipped = value.slice(0, limit - length);
          if (block === lastBlock) parts[parts.length - 1] += ` ${clipped}`; else parts.push(clipped);
          lastBlock = block; truncated ||= clipped.length < value.length; length += clipped.length + 1;
        }
        return { text: parts.join('\n'), truncated };
      };
      const headings = [...document.querySelectorAll('h1,h2,h3')].filter(e => visible(e) && e.getClientRects().length).slice(0, 20).map(e => ({ level: Number(e.tagName.slice(1)), text: collect(e, 200).text })).filter(h => h.text);
      return { title: document.title.slice(0, 300), description: document.querySelector<HTMLMetaElement>('meta[name="description" i]')?.content.slice(0, 500) || '', headings, ...collect(document.body, 12_000) };
    });
    if (abort.signal.aborted || navigationBlocked || page.url() !== `https://${domain}/` || failedAsset || scriptErrors) return unavailable('Rendering did not complete without script errors within the homepage navigation and asset limits. No product-content conclusion was inferred.');
    if (!result.text.trim()) return unavailable('No visible homepage text was obtained within the bounded rendering window. No product-content conclusion was inferred.');
    return { status: 'AVAILABLE', ...result, blocked, scriptErrors, limited: blocked > 0 || scriptErrors > 0 || result.truncated };
  } catch { return unavailable('Browser unavailable, rendering failed or timed out. No product-content conclusion was inferred.'); }
  finally { clearTimeout(timer); abort.abort(); await browser?.close().catch(() => {}); }
}
