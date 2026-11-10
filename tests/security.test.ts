import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startServer } from '../src/ui/server.ts';
import { Journal } from '../src/workflow/journal.ts';
import { Vault } from '../src/security/tokens.ts';
import { MockProvider } from '../src/adapters/mock.ts';
import { hostname } from '../src/security/config.ts';
test('A01/A15 local UI rejects CSRF, unauthenticated API, foreign hosts and origins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launchkit-ui-')); const journal = new Journal(dir); const vault = new Vault(dir);
  const { server, origin } = await startServer({ journal, vault, provider: () => new MockProvider(dir) });
  try {
    assert.equal((server.address() as any).address, '127.0.0.1');
    const page = await fetch(origin); const html = await page.text(); assert.match(html, /Launch ↗/); const cookie = page.headers.get('set-cookie')!.split(';')[0]; const token = html.match(/name="launchkit-session" content="([^"]+)"/)![1];
    assert.equal((await fetch(`${origin}/api/runs`)).status, 403);
    const headers = { Cookie: cookie, 'X-LaunchKit-Token': token, 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' };
    assert.equal((await fetch(`${origin}/api/connections`, { method: 'POST', headers, body: '{}' })).status, 403);
    const hostStatus = await new Promise(resolve => { const req = request(origin, { headers: { Host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.end(); });
    assert.equal(hostStatus, 403);
    headers.Origin = origin;
    const status = await (await fetch(`${origin}/api/status`, { headers })).json(); assert.equal(status.connections.cloudflare, false);
    const response = await fetch(`${origin}/api/connections`, { method: 'POST', headers, body: JSON.stringify({ cloudflare: 'unit-test-token-value' }) });
    assert.equal(response.status, 200); assert.ok(!(await response.text()).includes('unit-test-token-value'));
    const restored = new Vault(dir); await restored.load(); if (process.platform === 'win32') assert.equal(restored.values.cloudflare, 'unit-test-token-value');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('hostname validation excludes URLs, injection, localhost and ports', () => { assert.equal(hostname(' PDFRedactForge.COM. '), 'pdfredactforge.com'); for (const value of ['localhost', 'https://example.com', 'example.com/a', 'x.com:80', 'x.com\nfoo', 'x.com;whoami']) assert.throws(() => hostname(value)); });
