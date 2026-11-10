import { lookup } from 'node:dns/promises';
import { request, type RequestOptions } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { hostname } from '../security/config.ts';
import type { Run } from '../workflow/types.ts';
import type { HealthCheck } from './types.ts';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) blocked.addSubnet(address, prefix);
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6'); blocked.addSubnet('2001:db8::', 32, 'ipv6'); blocked.addSubnet('2002::', 16, 'ipv6'); blocked.addSubnet('3fff::', 20, 'ipv6');
export function publicAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
export interface Probe { status: number; headers: Record<string, string | string[] | undefined>; expiresAt?: string; latencyMs: number }
export interface HealthTools {
  resolve(domain: string): Promise<{ address: string; family: number }[]>;
  probe(domain: string, address: { address: string; family: number }): Promise<Probe>;
  now(): number;
}
async function resolvePublic(domain: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([lookup(domain, { all: true }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('DNS timeout'), { code: 'TIMEOUT' })), 10_000); })]); }
  finally { clearTimeout(timer); }
}
export function probeHTTPS(domain: string, address: { address: string; family: number }): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    // Pin the validated public address, retain hostname/SNI validation, and never follow redirects.
    const options: RequestOptions = { hostname: domain, servername: domain, port: 443, path: '/', method: 'GET', agent: false,
      family: address.family, rejectUnauthorized: true, signal: AbortSignal.timeout(15_000),
      lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      headers: { 'User-Agent': 'LaunchKit-Health/0.2', Accept: 'text/html' }
    };
    const req = request(options, res => {
      const cert = (res.socket as TLSSocket).getPeerCertificate();
      const expiry = Date.parse(cert.valid_to);
      resolve({ status: res.statusCode || 0, headers: res.headers, latencyMs: Date.now() - start, ...(Number.isFinite(expiry) ? { expiresAt: new Date(expiry).toISOString() } : {}) });
      res.destroy(); // Health checks do not retain page bodies or application data.
    });
    req.on('error', reject); req.end();
  });
}
function code(error: unknown) {
  const value = (error as { code?: string })?.code;
  return typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value) ? value : 'NETWORK_ERROR';
}
export async function checkHealth(run: Run, tools: HealthTools = { resolve: resolvePublic, probe: probeHTTPS, now: Date.now }): Promise<HealthCheck[]> {
  const domain = hostname(run.config.domain);
  const checks: HealthCheck[] = [];
  let addresses: { address: string; family: number }[];
  try {
    addresses = await tools.resolve(domain);
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw Object.assign(Error('Non-public DNS target'), { code: 'UNSAFE_ADDRESS' });
    checks.push({ name: 'dns', status: 'PASS', message: 'Domain resolves to public addresses.', evidence: { addresses: addresses.map(a => a.address) } });
  } catch (error) {
    return [{ name: 'dns', status: 'FAIL', message: `Public DNS check failed (${code(error)}).` }, ...(['https', 'certificate', 'http', 'release', 'headers'] as const).map(name => ({ name, status: 'UNKNOWN' as const, message: 'Not checked because public DNS was unavailable.' }))];
  }
  let result: Probe;
  try {
    result = await tools.probe(domain, addresses.find(a => a.family === 4) || addresses[0]);
    checks.push({ name: 'https', status: 'PASS', message: 'HTTPS connected with certificate and hostname validation.', evidence: { latencyMs: result.latencyMs } });
  } catch (error) {
    checks.push({ name: 'https', status: 'FAIL', message: `HTTPS check failed (${code(error)}). Certificate validation remains enabled.` });
    return [...checks, ...(['certificate', 'http', 'release', 'headers'] as const).map(name => ({ name, status: 'UNKNOWN' as const, message: 'Not checked because HTTPS was unavailable.' }))];
  }
  const days = result.expiresAt ? (Date.parse(result.expiresAt) - tools.now()) / 86_400_000 : NaN;
  checks.push({ name: 'certificate', status: !Number.isFinite(days) ? 'UNKNOWN' : days <= 7 ? 'FAIL' : days <= 21 ? 'WARN' : 'PASS',
    message: !Number.isFinite(days) ? 'Certificate expiration could not be read.' : `TLS certificate expires in ${Math.max(0, Math.floor(days))} days.`, evidence: result.expiresAt ? { expiresAt: result.expiresAt } : undefined });
  const ok = result.status === 200;
  checks.push({ name: 'http', status: ok ? 'PASS' : 'FAIL', message: `Homepage returned HTTP ${result.status}.`, evidence: { status: result.status } });
  const expected = run.resources.deployedRelease;
  checks.push({ name: 'release', status: !ok || !expected ? 'UNKNOWN' : result.headers['x-launchkit-release'] === expected ? 'PASS' : 'FAIL',
    message: !ok ? 'Release not evaluated on an unsuccessful response.' : !expected ? 'No confirmed release baseline is saved.' : result.headers['x-launchkit-release'] === expected ? 'Published release matches the confirmed deployment.' : 'Published release differs from the confirmed deployment.', evidence: expected ? { expected } : undefined });
  const headersOK = result.headers['x-content-type-options'] === 'nosniff' && result.headers['referrer-policy'] === 'no-referrer' && !String(result.headers['x-robots-tag'] || '').includes('noindex');
  checks.push({ name: 'headers', status: !ok ? 'UNKNOWN' : headersOK ? 'PASS' : 'WARN', message: !ok ? 'Headers not evaluated on an unsuccessful response.' : headersOK ? 'Baseline security and indexing headers are present.' : 'Baseline security or indexing headers changed.' });
  return checks;
}
