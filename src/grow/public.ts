import { request } from 'node:https';
import { publicAddress } from '../operate/health.ts';
import { hostname } from '../security/config.ts';

export type AuditPath = '/' | '/robots.txt' | '/sitemap.xml';
export interface PublicPage { status: number; type: string; robots?: string; csp?: string; body: string }
export interface Address { address: string; family: number }
export interface PublicAsset { status: number; type: string; body: Buffer }

export function renderAssetPath(path: string) {
  return path.length <= 240 && /^\/assets\/(?:[a-z0-9_-][a-z0-9._-]*\/)*[a-z0-9_-][a-z0-9._-]*\.(?:m?js|css)$/i.test(path);
}

// Internal fixed-host transport, never a UI/API URL fetcher. Both entry points
// validate their path subset. Browser headers/cookies are never forwarded.
function read(domain: string, path: string, address: Address, limit: number, signal?: AbortSignal) {
  if (hostname(domain) !== domain || !publicAddress(address.address) || ![4, 6].includes(address.family)) throw Error('Invalid public target');
  return new Promise<{ status: number; type: string; robots: string; csp?: string; body: Buffer }>((resolve, reject) => {
    const req = request({ hostname: domain, servername: domain, port: 443, path, method: 'GET', agent: false, rejectUnauthorized: true,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(15_000), family: address.family,
      lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      headers: { 'User-Agent': 'LaunchKit-Public-Audit/0.3', Accept: path === '/' ? 'text/html' : path === '/robots.txt' ? 'text/plain' : path === '/sitemap.xml' ? 'application/xml, text/xml' : '*/*', 'Accept-Encoding': 'identity' }
    }, res => {
      const chunks: Buffer[] = []; let length = 0;
      res.on('error', reject);
      res.on('data', (chunk: Buffer) => { length += chunk.length; if (length > limit) { reject(Error('Public response exceeds audit limit')); res.destroy(); } else chunks.push(chunk); });
      res.on('end', () => {
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') return reject(Error('Unsupported content encoding'));
        const csp = res.headers['content-security-policy'];
        resolve({ status: res.statusCode || 0, type: res.headers['content-type'] || '', robots: String(res.headers['x-robots-tag'] || ''), csp: Array.isArray(csp) ? csp.join(', ') : csp, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject); req.end();
  });
}
export async function readPublicPage(domain: string, path: AuditPath, address: Address): Promise<PublicPage> {
  if (!['/', '/robots.txt', '/sitemap.xml'].includes(path)) throw Error('Unsupported audit path');
  const response = await read(domain, path, address, 512_000);
  return { ...response, body: response.body.toString('utf8') };
}
export function readRenderAsset(domain: string, path: string, address: Address, signal: AbortSignal, remaining = 4_000_000): Promise<PublicAsset> {
  if (!renderAssetPath(path) || !Number.isInteger(remaining) || remaining <= 0) throw Error('Unsupported render asset');
  return read(domain, path, address, Math.min(4_000_000, remaining), signal);
}
