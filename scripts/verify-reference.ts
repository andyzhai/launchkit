import { spawn } from 'node:child_process';
import { cp, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { verifyHTTP } from '../src/verification/http.ts';
import { fileURLToPath } from 'node:url';
import { Journal, atomicJSON, defaultDataDir, digest } from '../src/workflow/journal.ts';
import { prepare, auditDistribution } from '../src/adapters/app-vite.ts';
import { seo } from '../src/adapters/seo.ts';
import { instrument } from '../src/adapters/analytics.ts';
import { wranglerConfig } from '../src/adapters/wrangler.ts';
import { command, npm, safeEnv } from '../src/adapters/process.ts';
import type { Context, LaunchConfig } from '../src/workflow/types.ts';
const appPath = process.argv[2] || process.env.LAUNCHKIT_REFERENCE_APP;
if (!appPath) throw Error('Usage: npm run test:reference -- /absolute/path/to/vite-app');
const root = fileURLToPath(new URL('../', import.meta.url));
const parent = join(defaultDataDir(), 'verification'); await mkdir(parent, { recursive: true, mode: 0o700 });
const dir = await mkdtemp(join(parent, 'reference-')); const journal = new Journal(dir);
const config: LaunchConfig = { appPath: resolve(appPath), domain: '127.0.0.1', accountId: '0'.repeat(32), inbox: 'owner@example.test', mode: 'mock', www: false, outbound: false, seo: { approved: true, title: '', description: '' }, analytics: { approved: true, publicPaths: ['/'] } };
const run = await journal.create(config);
const ctx: Context = { run, save: () => journal.save(run), approve: async () => { throw Error('Reference verification cannot approve cloud actions'); }, effect: async () => { throw Error('Reference verification cannot mutate providers'); } };
console.log('Building and auditing reference application through LaunchKit.');
const built = await prepare(ctx, dir); const r = run.resources;
r.release = digest([r.buildFingerprint, 'reference-verification']); r.worker = 'launchkit-reference-test'; r.analytics = { site_token: '0'.repeat(32) };
r.publishDir = join(dirname(built.directory), 'published'); await mkdir(r.publishDir, { recursive: true }); await cp(built.directory, r.publishDir, { recursive: true });
await seo(r.publishDir, config); await instrument(r.publishDir, config); r.manifest = await auditDistribution(r.publishDir);
const cfgPath = await wranglerConfig(ctx, r.publishDir);
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
await command(process.execPath, [wrangler, 'deploy', '--dry-run', '--config', cfgPath, '--outdir', join(dir, 'bundle')], dir, { WRANGLER_SEND_METRICS: 'false' });
const cached = await prepare(ctx, dir); if (!cached.cached) throw Error('Unchanged application rebuilt during resume verification');
const listener = createServer(); await new Promise<void>(r => listener.listen(0, '127.0.0.1', r)); const port = (listener.address() as { port: number }).port; await new Promise<void>(r => listener.close(() => r()));
const child = spawn(process.execPath, [wrangler, 'dev', '--local', '--config', cfgPath, '--ip', '127.0.0.1', '--port', String(port), '--local-protocol', 'https', '--show-interactive-dev-session=false'], { cwd: dir, env: safeEnv({ WRANGLER_SEND_METRICS: 'false' }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stdout.on('data', d => { output = (output + d.toString()).slice(-20_000); }); child.stderr.on('data', d => { output = (output + d.toString()).slice(-20_000); });
let report: any;
try {
  const ready = Date.now() + 45_000;
  while (!output.includes('Ready on')) { if (child.exitCode !== null || Date.now() > ready) throw Error(`Wrangler local startup failed: ${output}`); await new Promise(r => setTimeout(r, 200)); }
  const url = `https://127.0.0.1:${port}`; console.log('Running existing deployed synthetic browser tests against local Wrangler HTTPS.');
  // Only this local harness trusts the self-signed loopback certificate. The
  // production verifier always uses the platform's normal TLS validation.
  const loopbackFetch: typeof fetch = async (input, init) => {
    const target = new URL(String(input));
    if (target.origin !== url) throw Error('Local TLS transport cannot access a public host');
    return new Promise((resolve, reject) => {
      const req = request(target, { rejectUnauthorized: false, signal: init?.signal || undefined }, response => {
        const chunks: Buffer[] = []; response.on('data', d => chunks.push(d)); response.on('end', () => { const headers: Record<string, string> = {}; for (const [name, value] of Object.entries(response.headers)) if (value) headers[name] = Array.isArray(value) ? value.join(', ') : value; resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers })); });
      }); req.on('error', reject); req.end();
    });
  };
  const http = await verifyHTTP(url, r.manifest, r.release, false, r.publishDir, loopbackFetch);
  const result = await npm(['run', 'test:deployed', '--', url], config.appPath, { LAUNCHKIT_DIST_DIR: r.publishDir, LAUNCHKIT_LOCAL_TLS: '1', LAUNCHKIT_ANALYTICS: 'isolated', LAUNCHKIT_ANALYTICS_STUB: '1' }, 600_000);
  await writeFile(join(dir, 'application-tests.log'), result);
  report = { scope: 'LOCAL Wrangler runtime, self-signed loopback TLS, synthetic fixtures, mocked analytics transport. NOT a public deployment.', passed: true, fingerprint: r.buildFingerprint, files: Object.keys(r.manifest).length, cachedBuild: cached.cached, http: { ...http, tls: 'Self-signed loopback only; public certificate verification not performed' }, output: result, at: new Date().toISOString() };
  console.log(result);
} catch (e: any) { report = { passed: false, error: e.message, at: new Date().toISOString() }; process.exitCode = 1; console.error(e.message); }
finally {
  if (process.platform === 'win32' && child.pid) await command('taskkill', ['/PID', String(child.pid), '/T', '/F'], dir).catch(() => {}); else child.kill('SIGTERM');
  await atomicJSON(join(dir, 'reference.report.json'), report); console.log(`Reference report: ${join(dir, 'reference.report.json')}`);
}
