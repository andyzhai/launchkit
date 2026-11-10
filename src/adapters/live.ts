import { cp, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Pause, type Provider, type StepName, type Context } from '../workflow/types.ts';
import { Vault } from '../security/tokens.ts';
import { Cloudflare, APIError } from './cloudflare.ts';
import { ensureDomain } from './domain.ts';
import { discover, prepare, auditDistribution } from './app-vite.ts';
import { seo } from './seo.ts';
import { ensureWebAnalytics } from './web-analytics.ts';
import { deploy } from './wrangler.ts';
import { incoming, outgoing, Resend } from './email.ts';
import { verifyHTTP, verifySEO } from '../verification/http.ts';
import { bindDomain } from './binding.ts';
import { npm } from './process.ts';
import { digest } from '../workflow/journal.ts';
export class LiveProvider implements Provider {
  dir: string; vault: Vault;
  constructor(dir: string, vault: Vault) { this.dir = dir; this.vault = vault; }
  async step(name: StepName, ctx: Context): Promise<any> {
    const { config, resources: r } = ctx.run; const cf = new Cloudflare(config.accountId, this.vault.values);
    if (name === 'discover') { const app = await discover(config.appPath); r.app = app; return { name: app.name, fingerprint: app.fingerprint, build: 'npm ci / test / build / audit:dist when present' }; }
    if (name === 'connect') {
      if (!this.vault.values.cloudflare) throw new Pause('WAITING_USER', 'Connect your Cloudflare account using the local connection form.');
      if (!config.accountId) throw new Pause('WAITING_USER', 'Select your Cloudflare account and launch again.');
      const account = await cf.get(cf.account(''));
      const zoneAccess = await cf.list(`/zones?account.id=${config.accountId}`);
      if (config.outbound && !this.vault.values.resend) throw new Pause('WAITING_USER', 'Connect Resend to enable outbound email.');
      if (config.outbound) await new Resend(this.vault.values.resend!).list();
      return { accountId: account.id, accountName: account.name, visibleZones: zoneAccess.length, permissions: 'Read access verified; individual write permissions checked at each operation', paidPlans: 'No plan or subscription upgrade is performed' };
    }
    if (name === 'domain') {
      try { return await ensureDomain(ctx, cf); }
      catch (e) { if (e instanceof APIError && [400, 401, 403, 404].includes(e.status)) throw new Pause('WAITING_USER', 'Registrar or zone access is unavailable. Connect the appropriate scoped token and complete account prerequisites, or register externally and resume.', { actionURL: `https://dash.cloudflare.com/${config.accountId}/domains/registrations`, code: e.status }); throw e; }
    }
    if (name === 'prepare') {
      const built = await prepare(ctx, this.dir);
      // Automatic analytics is provisioned after custom-domain readiness.
      r.analytics = undefined; r.analyticsError = undefined;
      r.release = digest([r.buildFingerprint, 'launchkit-worker-v3-auto-analytics', config.www]);
      r.publishDir = join(dirname(built.directory), `publish-${r.release}`);
      await mkdir(r.publishDir, { recursive: true, mode: 0o700 }); await cp(built.directory, r.publishDir, { recursive: true });
      await seo(r.publishDir, config);
      r.manifest = await auditDistribution(r.publishDir); await ctx.save();
      return { ...built, release: r.release, distributionFiles: Object.keys(r.manifest).length, analyticsProvisioned: !!r.analytics };
    }
    if (name === 'preview') {
      const deployment = await deploy(ctx, cf, r.publishDir);
      const verification = await verifyHTTP(r.previewUrl, r.manifest, r.release, true, r.publishDir);
      if (r.app.scripts.includes('test:deployed')) await npm(['run', 'test:deployed', '--', r.previewUrl], config.appPath, { LAUNCHKIT_DIST_DIR: r.publishDir, LAUNCHKIT_ANALYTICS: r.analytics ? 'isolated' : '' }, 600_000);
      return { ...deployment, verification, syntheticTests: r.app.scripts.includes('test:deployed') ? 'Passed application deployed tests' : 'No application test:deployed script; final browser smoke test required' };
    }
    if (name === 'binding') return bindDomain(ctx, cf);
    if (name === 'incoming') return incoming(ctx, cf);
    if (name === 'outgoing') return config.outbound ? outgoing(ctx, cf, new Resend(this.vault.values.resend!)) : 'SKIPPED';
    if (name === 'seo') return verifySEO(r.url, config.seo.approved);
    if (name === 'analytics') {
      const result = await ensureWebAnalytics(ctx, cf);
      r.webAnalytics = result; await ctx.save();
      if (result.status === 'attention') throw new Pause('WAITING_USER', result.message, result);
      return result;
    }
    if (name === 'verify') {
      const evidence = await verifyHTTP(r.url, r.manifest, r.release, false, r.publishDir);
      if (r.app.scripts.includes('test:deployed')) {
        await npm(['run', 'test:deployed', '--', r.url], config.appPath, { LAUNCHKIT_DIST_DIR: r.publishDir, LAUNCHKIT_ANALYTICS: r.analytics ? 'isolated' : '' }, 600_000);
        return { ...evidence, applicationTests: 'Passed application test:deployed script with synthetic fixtures', monitoring: false };
      }
      throw new Pause('WAITING_USER', 'Public assets are verified. Add a test:deployed script for application-specific browser checks before full launch verification.', evidence);
    }
    throw Error('Unsupported step');
  }
}
