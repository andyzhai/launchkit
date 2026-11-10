import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyHTTP } from '../src/verification/http.ts';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'launchkit-http-')); const html = '<html><body>app</body></html>'; await writeFile(join(dir, 'index.html'), html);
  const manifest = { 'index.html': hash(html), 'notices.html': hash('notices'), 'module.wasm': hash('wasm') };
  const transport = (badMime = false, redirectExternal = false): typeof fetch => async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('.html')) return new Response(null, { status: 307, headers: { Location: redirectExternal ? 'https://other.test/' : path === '/index.html' ? '/' : '/notices' } });
    if (path.endsWith('launchkit-missing.wasm')) return new Response('missing', { status: 404 });
    const content = path === '/' ? html : path === '/notices' ? 'notices' : 'wasm';
    return new Response(content, { headers: { 'X-LaunchKit-Release': 'release', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Type': path.endsWith('.wasm') ? badMime ? 'text/html' : 'application/wasm' : 'text/html' } });
  };
  return { dir, manifest, transport };
}
test('A11 HTTP verifier follows Cloudflare 307 HTML canonicalization on the same origin', async () => { const t = await setup(); const result = await verifyHTTP('https://example.test', t.manifest, 'release', false, t.dir, t.transport()); assert.equal(result.assets, 3); assert.equal(result.wasm, 1); });
test('A11 HTTP verifier rejects foreign HTML redirects and incorrect WASM MIME', async () => { const t = await setup(); await assert.rejects(verifyHTTP('https://example.test', t.manifest, 'release', false, t.dir, t.transport(true)), /MIME/); await assert.rejects(verifyHTTP('https://example.test', t.manifest, 'release', false, t.dir, t.transport(false, true)), /outside the site/); });

test('production HTML tolerates only the recognized Cloudflare beacon addition; other changes still fail', async () => {
  const t = await setup();
  const script = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js/v123abc" data-cf-beacon='{"token":"${'a'.repeat(32)}"}'></script>`;
  const valid = script;
  const transport = (extra: string, change = false): typeof fetch => async (input, init) => {
    const response = await t.transport()(input, init);
    if (new URL(String(input)).pathname !== '/') return response;
    return new Response((await response.text()).replace('app', change ? 'tampered' : 'app').replace('</body>', `${extra}\n</body>`), { headers: response.headers });
  };
  const result = await verifyHTTP('https://example.test', t.manifest, 'release', false, t.dir, transport(valid));
  assert.equal(result.transformedHTML, 1); assert.match(result.hashes, /removing the Cloudflare beacon/);
  for (const extra of [valid.replace('defer', 'onload="steal()"'), valid.replace('static.cloudflareinsights.com', 'evil.test'), valid.replace('</script>', 'inlineCode()</script>'), '<script src="/other.js"></script>']) {
    await assert.rejects(verifyHTTP('https://example.test', t.manifest, 'release', false, t.dir, transport(extra)), /differs from release/);
  }
  await assert.rejects(verifyHTTP('https://example.test', t.manifest, 'release', false, t.dir, transport(valid, true)), /differs from release/);
});
