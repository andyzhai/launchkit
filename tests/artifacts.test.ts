import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workerSource } from '../src/adapters/wrangler.ts';
import { seo } from '../src/adapters/seo.ts';
import { instrument } from '../src/adapters/analytics.ts';
import { auditDistribution } from '../src/adapters/app-vite.ts';
import type { LaunchConfig } from '../src/workflow/types.ts';
export const artifactConfig: LaunchConfig = { appPath: '/', domain: 'example.test', inbox: '', accountId: '', mode: 'mock', www: true, outbound: false, seo: { approved: true, title: 'Example <Business>', description: 'Local application & tools' }, analytics: { approved: true, publicPaths: ['/'] } };
test('A11 distribution audit rejects credentials, fixtures and sourcemaps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launchkit-dist-')); await writeFile(join(dir, 'index.html'), '<html></html>');
  assert.equal(Object.keys(await auditDistribution(dir)).length, 1);
  await writeFile(join(dir, 'leak.map'), '{}'); await assert.rejects(auditDistribution(dir), /Unsafe distribution/);
});
test('A14 SEO only publishes approved facts and escaped metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launchkit-seo-')); const original = '<html><head><title>Old</title></head><body></body></html>'; await writeFile(join(dir, 'index.html'), original);
  await seo(dir, { ...artifactConfig, seo: { ...artifactConfig.seo, approved: false } }); assert.equal(await readFile(join(dir, 'index.html'), 'utf8'), original);
  await seo(dir, artifactConfig); const html = await readFile(join(dir, 'index.html'), 'utf8'); assert.match(html, /Example &lt;Business&gt;/); assert.match(html, /canonical/); assert.ok(!html.includes('application/ld+json'));
  assert.match(await readFile(join(dir, 'sitemap.xml'), 'utf8'), /https:\/\/example.test\//);
});
test('A13 only frame-src changes in the application policy; script and connect remain local', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launchkit-policy-')); const policy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-src 'none'";
  await writeFile(join(dir, 'index.html'), `<html><head><meta http-equiv="Content-Security-Policy" content="${policy}"></head><body></body></html>`); await writeFile(join(dir, '_headers'), `/*\n  Content-Security-Policy: ${policy}; frame-ancestors 'none'\n`);
  await instrument(dir, artifactConfig); const html = await readFile(join(dir, 'index.html'), 'utf8'); assert.match(html, /frame-src 'self'/); assert.match(html, /connect-src 'self'/); assert.ok(!html.includes('cloudflareinsights.com'));
});
test('A19 generated Worker protects preview indexing and redirects only configured hosts', async () => {
  const source = workerSource(artifactConfig, 'release-id', '0'.repeat(32)); const worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
  const env = { ASSETS: { fetch: async () => new Response('app', { headers: { 'Content-Type': 'text/html' } }) } };
  const preview = await worker.fetch(new Request('https://preview.workers.dev/'), env); assert.match(preview.headers.get('x-robots-tag'), /noindex/);
  assert.match(await (await worker.fetch(new Request('https://preview.workers.dev/robots.txt'), env)).text(), /Disallow: \//);
  const production = await worker.fetch(new Request('https://example.test/'), env); assert.equal(production.headers.get('x-robots-tag'), null);
  const redirect = await worker.fetch(new Request('https://www.example.test/help?q=one'), env); assert.equal(redirect.status, 301); assert.equal(redirect.headers.get('location'), 'https://example.test/help?q=one');
  const http = await worker.fetch(new Request('http://example.test/'), env); assert.equal(http.headers.get('location'), 'https://example.test/');
  assert.equal((await worker.fetch(new Request('https://preview.workers.dev/__launchkit/metrics/0'), env)).status, 404);
});

test('Worker permits production analytics injection while preserving application cache and CSP', async () => {
  const config = {...artifactConfig,analytics:{approved:false,publicPaths:['/']}};
  const policy = "default-src 'self'; script-src 'self'; connect-src 'self'";
  const worker = (await import(`data:text/javascript;base64,${Buffer.from(workerSource(config,'no-transform',undefined,{'Content-Security-Policy':policy})).toString('base64')}`)).default;
  for (const cache of ['', 'public, max-age=3600', 'private, no-store', 'public, no-transform']) {
    const env = {ASSETS:{fetch:async()=>new Response('<html>app</html>',{headers:cache?{'Cache-Control':cache}:{}})}};
    const response = await worker.fetch(new Request('https://example.test/'),env);
    assert.equal(response.headers.get('Cache-Control'),cache || null);
    const preview = await worker.fetch(new Request('https://preview.workers.dev/'),env);
    assert.match(preview.headers.get('Cache-Control'),/no-transform/);
    assert.equal(response.headers.get('Content-Security-Policy'),policy); assert.equal(await response.text(),'<html>app</html>');
    assert.equal(await (await worker.fetch(new Request('https://example.test/__launchkit/page.js'),env)).text(),'');
    assert.equal((await worker.fetch(new Request('https://example.test/__launchkit/metrics/0'),env)).status,404);
  }
});
