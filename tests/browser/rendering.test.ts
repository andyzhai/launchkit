import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { renderHomepage } from '../../src/grow/render.ts';
import { inspectPage, inspectRendered } from '../../src/grow/audit.ts';

const address = { address: '8.8.8.8', family: 4 };
const at = '2026-10-29T18:00:00Z';
const html = (body: string) => ({ status: 200, type: 'text/html', body });

test('Vite-style SPA fixtures render real module content, keep initial HTML separate, and exclude hidden/fallback text', async () => {
  const home = html('<html><head><title>Initial title</title><script type="module" src="/assets/index-ABC.js"></script><link rel="stylesheet" href="/assets/index-ABC.css"></head><body><div id="root"></div><noscript>JavaScript is required to redact local PDFs.</noscript></body></html>');
  const paths: string[] = [];
  const result = await renderHomepage('fixture.test', home, address, { settleMs: 100, readAsset: async (domain, path, pin) => {
    assert.equal(domain, 'fixture.test'); assert.deepEqual(pin, address); paths.push(path);
    return { status: 200, type: path.endsWith('.css') ? 'text/css' : 'text/javascript', body: Buffer.from(path.endsWith('.css') ? '.hidden { display:none } .transparent { opacity:0 }' : `document.title='Rendered PDF Tool';const meta=document.createElement('meta');meta.name='description';meta.content='Redact PDF documents locally.';document.head.append(meta);document.querySelector('#root').innerHTML='<main><h1>Rendered PDF Tool</h1><h2>Redact documents locally</h2><p>A tool for redacting PDF files.</p><p>Designed for small teams.</p><p>Only supports text PDFs.</p><p class="hidden">Hidden secret claim</p><div class="transparent"><p>Invisible ancestor claim</p></div><p aria-hidden="true">ARIA hidden claim</p><textarea>Private input</textarea></main>';`) };
  } });
  assert.equal(result.status, 'AVAILABLE', result.message); assert.deepEqual(paths.sort(), ['/assets/index-ABC.css', '/assets/index-ABC.js']);
  assert.equal(result.title, 'Rendered PDF Tool'); assert.equal(result.description, 'Redact PDF documents locally.');
  assert.match(result.text!, /A tool for redacting PDF files/); assert.doesNotMatch(result.text!, /JavaScript|Hidden secret|Invisible ancestor|ARIA hidden|Private input/);
  assert.deepEqual(result.headings, [{ level: 1, text: 'Rendered PDF Tool' }, { level: 2, text: 'Redact documents locally' }]);
  const initial = inspectPage('fixture.test', '/', home, at);
  assert.ok(initial.every(f => f.source === 'STATIC_HTML')); assert.ok(!initial.some(f => f.check.startsWith('content-')));
  const rendered = inspectRendered('fixture.test', result, at);
  assert.ok(rendered.every(f => f.source === 'RENDERED_PAGE'));
  for (const f of rendered.filter(f => f.check.startsWith('content-'))) { assert.equal(f.status, 'REVIEW'); assert.match(f.evidence, /candidate excerpt/); assert.doesNotMatch(f.evidence, /JavaScript is required/); }
});

test('Static page renders without asset requests and runtime fallback is never a product-purpose claim', async () => {
  const result = await renderHomepage('fixture.test', html('<html><head><title>Static product</title><meta name="description" content="Static description"></head><body><h1>Static product<span style="opacity:0">Misleading hidden name</span></h1><p>A tool for <strong>creating reports.</strong></p><p><span>JavaScript is required</span> <strong>to redact local PDFs.</strong></p><noscript>Enable JavaScript.</noscript></body></html>'), address, { settleMs: 50, readAsset: async () => assert.fail('Static page requested an asset') });
  assert.equal(result.status, 'AVAILABLE'); assert.equal(result.title, 'Static product');
  assert.equal(result.headings?.[0].text, 'Static product');
  const findings = inspectRendered('fixture.test', result, at);
  assert.match(findings.find(f => f.check === 'content-purpose')!.evidence, /creating reports/);
  assert.match(findings.find(f => f.check === 'content-limitations')!.evidence, /no unambiguous/);
  assert.doesNotMatch(JSON.stringify(findings.filter(f => f.assessment)), /JavaScript is required/);
});

test('Browser security fixture cannot send writes, API reads, sockets, workers, or private/foreign subresources', async () => {
  let hits = 0; const trap = createServer((_req, res) => { hits++; res.end('must never be reached'); });
  await new Promise<void>(resolve => trap.listen(0, '127.0.0.1', resolve));
  const port = (trap.address() as { port: number }).port;
  try {
    const paths: string[] = [];
    const home = html(`<html><head><script src="/assets/app.js"></script><script src="http://127.0.0.1:${port}/leak.js"></script><link rel="stylesheet" href="https://other.test/leak.css"></head><body><h1>Safe fixture</h1><iframe src="http://127.0.0.1:${port}/frame"></iframe><img src="http://127.0.0.1:${port}/pixel"></body></html>`);
    const result = await renderHomepage('fixture.test', home, address, { settleMs: 100, readAsset: async (_domain, path) => {
      paths.push(path); return { status: 200, type: 'text/javascript', body: Buffer.from(`fetch('http://127.0.0.1:${port}/read').catch(()=>{});fetch('/api/write',{method:'POST',body:'sensitive'}).catch(()=>{});fetch('/assets/private.js').catch(()=>{});try{navigator.sendBeacon('/api/beacon','sensitive')}catch{};try{new WebSocket('ws://127.0.0.1:${port}/socket')}catch{};try{new Worker('/assets/worker.js')}catch{};try{navigator.serviceWorker.register('/assets/sw.js').catch(()=>{})}catch{};`) };
    } });
    assert.equal(result.status, 'AVAILABLE', result.message); assert.deepEqual(paths, ['/assets/app.js']); assert.equal(hits, 0);
  } finally { trap.closeAllConnections(); await new Promise<void>(resolve => trap.close(() => resolve())); }
});

test('Secondary navigation and resource redirects are not followed, including same-host redirects', async () => {
  const navigated = await renderHomepage('fixture.test', html('<html><body><h1>Fixture</h1><script>setTimeout(()=>location.href="https://other.test/",10)</script></body></html>'), address, { settleMs: 100 });
  assert.equal(navigated.status, 'UNAVAILABLE');
  let reads = 0;
  const redirected = await renderHomepage('fixture.test', html('<html><body><h1>Fixture</h1><script src="/assets/a.js"></script></body></html>'), address, { settleMs: 50, readAsset: async () => { reads++; return { status: 302, type: 'text/javascript', body: Buffer.alloc(0) }; } });
  assert.equal(redirected.status, 'UNAVAILABLE'); assert.equal(reads, 1);
});

test('Browser timeout and asset resource limits are unavailable rather than static product findings', async () => {
  const timed = await renderHomepage('fixture.test', html('<html><body><h1>Fixture</h1></body></html>'), address, { timeoutMs: 150, settleMs: 1000 });
  assert.equal(timed.status, 'UNAVAILABLE');
  const oversized = await renderHomepage('fixture.test', html('<html><body><h1>Fixture</h1><script src="/assets/a.js"></script></body></html>'), address, { settleMs: 50, readAsset: async () => ({ status: 200, type: 'text/javascript', body: Buffer.alloc(4_000_001) }) });
  assert.equal(oversized.status, 'UNAVAILABLE');
  let reads = 0;
  const many = await renderHomepage('fixture.test', html(`<html><body><h1>Fixture</h1>${Array.from({ length: 17 }, (_, i) => `<script src="/assets/a${i}.js"></script>`).join('')}</body></html>`), address, { settleMs: 50, readAsset: async () => { reads++; return { status: 200, type: 'text/javascript', body: Buffer.from('void 0;') }; } });
  assert.equal(many.status, 'UNAVAILABLE'); assert.equal(reads, 16);
  const budgets: number[] = [];
  const total = await renderHomepage('fixture.test', html('<html><body><h1>Fixture</h1><script src="/assets/a.js"></script><script src="/assets/b.js"></script><script src="/assets/c.js"></script></body></html>'), address, { settleMs: 50, readAsset: async (_domain, _path, _address, _signal, remaining) => { budgets.push(remaining); return { status: 200, type: 'text/javascript', body: Buffer.from('//' + 'a'.repeat(2_999_998)) }; } });
  assert.equal(total.status, 'UNAVAILABLE'); assert.deepEqual(budgets, [8_000_000, 5_000_000, 2_000_000]);
});

test('Unsupported first-party script locations and script failures never produce product assessments', async () => {
  const unsupported = await renderHomepage('fixture.test', html('<html><body><h1>Initial shell</h1><script src="/app.js"></script></body></html>'), address, { settleMs: 50, readAsset: async () => assert.fail('Out-of-scope script request') });
  assert.equal(unsupported.status, 'UNAVAILABLE');
  const failed = await renderHomepage('fixture.test', html('<html><body><h1>Initial shell</h1><script>throw Error("private application details")</script></body></html>'), address, { settleMs: 50 });
  assert.equal(failed.status, 'UNAVAILABLE'); assert.doesNotMatch(JSON.stringify(failed), /private application/);
});
