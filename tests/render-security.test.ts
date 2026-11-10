import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedRenderAsset, renderHomepage } from '../src/grow/render.ts';
import { readPublicPage, readRenderAsset, renderAssetPath } from '../src/grow/public.ts';
import { inspectRendered } from '../src/grow/audit.ts';

test('Rendering permits only fixed-origin HTTPS GET script/CSS paths, not browser API or arbitrary navigation URLs', () => {
  assert.equal(allowedRenderAsset('example.test', 'https://example.test/assets/index-ABC.js', 'GET', 'script'), true);
  assert.equal(allowedRenderAsset('example.test', 'https://example.test/assets/chunks/index-ABC.mjs', 'GET', 'script'), true);
  assert.equal(allowedRenderAsset('example.test', 'https://example.test/assets/index-ABC.css', 'GET', 'stylesheet'), true);
  for (const url of ['http://example.test/assets/a.js', 'https://other.test/assets/a.js', 'https://127.0.0.1/assets/a.js', 'https://example.test:444/assets/a.js', 'https://user:pass@example.test/assets/a.js', 'https://example.test/assets/a.js?token=secret', 'https://example.test/assets/a.js#fragment', 'https://example.test/api/delete.js', 'file:///assets/a.js', 'data:text/javascript,alert(1)', 'https://example.test/assets/%2e%2e/api/a.js', 'https://example.test/assets/a%2f..%2fa.js']) assert.equal(allowedRenderAsset('example.test', url, 'GET', 'script'), false, url);
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) assert.equal(allowedRenderAsset('example.test', 'https://example.test/assets/a.js', method, 'script'), false);
  for (const kind of ['document', 'fetch', 'xhr', 'eventsource', 'image', 'font', 'websocket', 'other']) assert.equal(allowedRenderAsset('example.test', 'https://example.test/assets/a.js', 'GET', kind), false);
  for (const path of ['/api/a.js', '/assets/../a.js', '/assets//a.js', '/assets/a.json', '/assets/a.wasm', '/assets/.hidden.js', '/assets/a.js?q=1', '/assets/' + 'a'.repeat(241) + '.js']) assert.equal(renderAssetPath(path), false);
});

test('Transport validation rejects private addresses and out-of-scope paths before making requests', async () => {
  await assert.rejects(readPublicPage('example.test', '/', { address: '127.0.0.1', family: 4 }), /Invalid public target/);
  await assert.rejects(readPublicPage('example.test', '/api' as '/', { address: '8.8.8.8', family: 4 }), /Unsupported audit path/);
  assert.throws(() => readRenderAsset('example.test', '/api/a.js', { address: '8.8.8.8', family: 4 }, new AbortController().signal), /Unsupported render asset/);
  assert.throws(() => readRenderAsset('example.test', '/assets/a.js', { address: '::1', family: 6 }, new AbortController().signal), /Invalid public target/);
});

test('Unavailable browsers and invalid targets produce UNAVAILABLE with no static content assessment', async () => {
  const home = { status: 200, type: 'text/html', body: '<html><body><noscript>JavaScript is required to redact PDFs.</noscript></body></html>' };
  const failed = await renderHomepage('example.test', home, { address: '8.8.8.8', family: 4 }, { launch: async () => { throw Error('secret browser location'); } });
  assert.equal(failed.status, 'UNAVAILABLE'); assert.doesNotMatch(JSON.stringify(failed), /secret browser/);
  const findings = inspectRendered('example.test', failed, '2026-10-29T18:00:00Z');
  assert.equal(findings.length, 1); assert.equal(findings[0].status, 'UNAVAILABLE'); assert.ok(!findings.some(f => f.check.startsWith('content-')));
  for (const domain of ['example.test:80', 'https://example.test', 'example.test/other']) assert.equal((await renderHomepage(domain, home, { address: '8.8.8.8', family: 4 }, { launch: async () => assert.fail('Invalid target reached browser') })).status, 'UNAVAILABLE');
  assert.equal((await renderHomepage('example.test', home, { address: '127.0.0.1', family: 4 }, { launch: async () => assert.fail('Private target reached browser') })).status, 'UNAVAILABLE');
});
