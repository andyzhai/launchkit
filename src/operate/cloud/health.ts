import type { HealthCheck } from '../types.ts';
import type { CloudTarget } from './types.ts';

// Workers fetch validates HTTPS but does not expose the peer certificate or its expiry.
// No URL is taken from an HTTP request, response redirect, or mutable settings.
export async function cloudHealth(target: CloudTarget, transport = fetch): Promise<HealthCheck[]> {
  const start = Date.now();
  let response: Response;
  try { response = await transport(`https://${target.domain}/`, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'LaunchKit-Cloud-Health/1', 'Cache-Control': 'no-cache' } }); }
  catch { return [
    { name: 'https', status: 'FAIL', message: 'Cloudflare could not complete the HTTPS request. DNS, TLS, network or runtime failure; certificate validation remains enabled.' },
    ...(['dns', 'certificate', 'http', 'release', 'headers'] as const).map(name => ({ name, status: 'UNKNOWN' as const, message: 'Unavailable because the HTTPS request failed.' }))
  ]; }
  const ok = response.status === 200; const headers = response.headers; await response.body?.cancel();
  return [
    { name: 'dns', status: 'PASS', message: 'Hostname reached by Cloudflare fetch; not an independent authoritative DNS audit.' },
    { name: 'https', status: 'PASS', message: 'HTTPS response received through Cloudflare transport.', evidence: { latencyMs: Date.now() - start } },
    { name: 'certificate', status: 'PASS', message: 'HTTPS transport validation enabled. Cloud Workers do not expose certificate expiry; local checks retain expiry warnings.', evidence: { expiryAvailable: false } },
    { name: 'http', status: ok ? 'PASS' : 'FAIL', message: `Homepage returned HTTP ${response.status}. Redirects are not followed.`, evidence: { status: response.status } },
    { name: 'release', status: !ok ? 'UNKNOWN' : headers.get('x-launchkit-release') === target.release ? 'PASS' : 'FAIL', message: !ok ? 'Release not evaluated on unsuccessful HTTP.' : headers.get('x-launchkit-release') === target.release ? 'Confirmed release matches.' : 'Published release differs from the authorized baseline.' },
    { name: 'headers', status: !ok ? 'UNKNOWN' : headers.get('x-content-type-options') === 'nosniff' && headers.get('referrer-policy') === 'no-referrer' && !String(headers.get('x-robots-tag')).includes('noindex') ? 'PASS' : 'WARN', message: 'Baseline security and indexing response headers checked.' }
  ];
}
