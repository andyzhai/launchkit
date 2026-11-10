import { readFile, readdir, stat, mkdir, cp, lstat } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { digest } from '../workflow/journal.ts';
import { npm } from './process.ts';
import type { Context } from '../workflow/types.ts';
import { containsKnownSecret } from '../security/redaction.ts';
const excluded = new Set(['node_modules', '.git', 'dist', 'coverage', 'test-results', 'playwright-report', '.wrangler', 'private']);
export async function files(dir: string, source = false): Promise<string[]> {
  const result: string[] = [];
  async function walk(root: string) { for (const item of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (source && (excluded.has(item.name) || item.name.startsWith('.'))) continue;
    const path = join(root, item.name); if (item.isSymbolicLink()) throw Error('Symbolic links are not supported in application release files');
    if (item.isDirectory()) await walk(path); else if (item.isFile()) result.push(path);
  } }
  await walk(dir); return result;
}
export async function discover(appPath: string) {
  const root = resolve(appPath); const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!(pkg.devDependencies?.vite || pkg.dependencies?.vite) || !pkg.scripts?.build) throw Error('M1 supports Node/Vite applications with a build script');
  if (!pkg.scripts.test) throw Error('Application needs an npm test script before it can be launched');
  await stat(join(root, 'package-lock.json'));
  const hash = createHash('sha256');
  for (const path of await files(root, true)) { hash.update(relative(root, path).replaceAll(sep, '/')); hash.update(await readFile(path)); }
  // Environment files affect Vite output but are never copied into a release or journal.
  for (const item of await readdir(root)) if (/^\.env(?:\.|$)/.test(item)) { hash.update(item); hash.update(await readFile(join(root, item))); }
  return { name: String(pkg.name || 'Vite application'), root, fingerprint: hash.digest('hex'), scripts: Object.keys(pkg.scripts), dist: join(root, 'dist') };
}
export async function auditDistribution(dir: string) {
  const manifest: Record<string, string> = {};
  for (const path of await files(dir)) {
    const name = relative(dir, path).replaceAll(sep, '/');
    if (/(^|\/)(?:\.[^/]+|private|tests?|fixtures?|verifier|node_modules)(\/|$)|\.(?:map|pem|key|pfx|pdf)$|(?:^|\/)(?:package-lock\.json|wrangler\.[^/]+)$/i.test(name)) throw Error(`Unsafe distribution entry: ${name}`);
    const bytes = await readFile(path);
    if (containsKnownSecret(bytes.toString('utf8'))) throw Error(`Connected credential detected in distribution: ${name}`);
    if (/\.(html|js|json|txt|css)$/i.test(name) && /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:re_|sk-)[A-Za-z0-9_-]{24,}\b/.test(bytes.toString('utf8'))) throw Error(`Potential credential in distribution: ${name}`);
    manifest[name] = createHash('sha256').update(bytes).digest('hex');
  }
  if (!manifest['index.html']) throw Error('Build did not produce dist/index.html');
  return manifest;
}
export async function prepare(ctx: Context, dataDir: string) {
  const app = await discover(ctx.run.config.appPath); const r = ctx.run.resources;
  const release = digest([app.fingerprint, ctx.run.config.seo, ctx.run.config.analytics, ctx.run.config.domain]);
  const dir = join(dataDir, 'releases', ctx.run.id, release);
  if (r.buildFingerprint === release) {
    try { const manifest = await auditDistribution(dir); if (digest(manifest) === digest(r.originalManifest)) return { directory: dir, cached: true, fingerprint: release }; } catch { /* Incomplete build is rebuilt. */ }
  }
  await npm(['ci', '--no-fund', '--no-audit'], app.root, {}, 600_000);
  await npm(['test'], app.root);
  await npm(['run', 'build'], app.root, {}, 600_000);
  if (app.scripts.includes('audit:dist')) await npm(['run', 'audit:dist'], app.root);
  if ((await lstat(app.dist)).isSymbolicLink()) throw Error('Build output must not be a symbolic link');
  const manifest = await auditDistribution(app.dist);
  await mkdir(dir, { recursive: true, mode: 0o700 }); await cp(app.dist, dir, { recursive: true });
  r.buildFingerprint = release; r.buildDir = dir; r.originalManifest = manifest; r.app = app; await ctx.save();
  return { directory: dir, cached: false, fingerprint: release, files: Object.keys(manifest).length };
}
