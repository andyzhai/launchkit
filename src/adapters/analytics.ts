import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LaunchConfig } from '../workflow/types.ts';
// The vendor script runs in an opaque sandboxed frame, without parent DOM access.
// Its location is a fixed page identifier; no parent URL, query, fragment or document is sent.
export function pageScript(domain: string, paths: string[]) {
  return `(()=>{if(location.hostname!==${JSON.stringify(domain)}||location.search||location.hash)return;const paths=${JSON.stringify(paths)};const index=paths.indexOf(location.pathname);if(index<0)return;const frame=document.createElement('iframe');frame.hidden=true;frame.title='Anonymous page measurement';frame.setAttribute('sandbox','allow-scripts');frame.referrerPolicy='no-referrer';frame.src='/__launchkit/metrics/'+index;document.body.append(frame);})();`;
}
export function metricHTML(token: string) {
  if (!/^[a-f0-9]{32}$/.test(token)) throw Error('Invalid public analytics site token');
  return `<!doctype html><html><head><meta name="referrer" content="no-referrer"><title>Public page</title></head><body><script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${token}","spa":false}'></script></body></html>`;
}
export function allowAnalyticsFrame(policy: string) {
  const parts = policy.split(';').map(x => x.trim()).filter(Boolean);
  const index = parts.findIndex(x => x.startsWith('frame-src '));
  if (index < 0) parts.push("frame-src 'self'"); else if (parts[index] === "frame-src 'none'") parts[index] = "frame-src 'self'"; else if (!parts[index].split(/\s+/).includes("'self'")) parts[index] += " 'self'";
  return parts.join('; ');
}
export async function instrument(dir: string, config: LaunchConfig) {
  if (!config.analytics.approved) return;
  let html = await readFile(join(dir, 'index.html'), 'utf8');
  html = html.replace(/(http-equiv="Content-Security-Policy" content=")([^"]+)(")/i, (_, a, policy, b) => a + allowAnalyticsFrame(policy) + b);
  html = html.replace('</body>', '<script defer src="/__launchkit/page.js"></script>\n</body>');
  await writeFile(join(dir, 'index.html'), html);
  try { const headers = await readFile(join(dir, '_headers'), 'utf8'); await writeFile(join(dir, '_headers'), headers.replace(/(Content-Security-Policy: )([^\r\n]+)/g, (_, a, policy) => a + allowAnalyticsFrame(policy))); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
}
