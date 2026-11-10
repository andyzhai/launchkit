import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';
import { Journal, atomicJSON, digest } from '../../workflow/journal.ts';
import { Vault } from '../../security/tokens.ts';
import { registerSecret, redact } from '../../security/redaction.ts';
import { Cloudflare, APIError } from '../../adapters/cloudflare.ts';
import { command } from '../../adapters/process.ts';
import { eligible } from '../operator.ts';
import type { Run } from '../../workflow/types.ts';
import { validSettings, type CloudTarget } from './types.ts';

const source = dirname(fileURLToPath(import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
interface Receipt { runId: string; worker: string; target: CloudTarget; build: string; status: 'INTENT' | 'DEPLOYED'; updatedAt: string; error?: string; verifiedAt?: string; releaseSync?: { release: string; status: 'PENDING' | 'SYNCED'; error?: string } }
export function verifiedProduction(run: Run) {
  return run.config.mode === 'live' && eligible(run) && run.status === 'LIVE_VERIFIED' &&
    Object.values(run.steps).every(s => ['VERIFIED', 'SKIPPED'].includes(s.status)) &&
    ['prepare', 'preview', 'binding', 'verify'].every(name => run.steps[name as keyof Run['steps']].status === 'VERIFIED') &&
    /^[a-f0-9]{64}$/.test(run.resources.release || '') && run.resources.release === run.resources.deployedRelease &&
    run.steps.prepare.evidence?.release === run.resources.release && run.steps.verify.evidence?.url === run.resources.url;
}
export interface CloudTools { command: typeof command; fetch: typeof fetch; cf(run: Run): Cloudflare }
export function monitoringConfig(run: Run, target: CloudTarget, build: string) {
  return { name: `lk-monitor-${run.id}`, account_id: run.config.accountId, main: join(source, 'worker.ts'), compatibility_date: '2026-10-28', workers_dev: true, preview_urls: false,
    vars: { LAUNCHKIT_BUSINESS: run.id, TARGET: JSON.stringify(target), MONITOR_BUILD: build },
    durable_objects: { bindings: [{ name: 'MONITOR', class_name: 'MonitorState' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['MonitorState'] }],
    send_email: [{ name: 'EMAIL', destination_address: target.recipient }], triggers: { crons: ['*/5 * * * *'] }, observability: { enabled: false }, keep_vars: true };
}
export class CloudController {
  journal: Journal; vault: Vault; tools: CloudTools; busy = false;
  constructor(journal: Journal, vault: Vault, tools?: CloudTools) { this.journal = journal; this.vault = vault; this.tools = tools || { command, fetch, cf: run => new Cloudflare(run.config.accountId, vault.values) }; }
  path(id: string) { this.journal.path(id); return join(this.journal.dir, 'cloud-monitoring', `${id}.json`); }
  async load(id: string): Promise<Receipt | undefined> { try { return JSON.parse(await readFile(this.path(id), 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; } }
  async save(receipt: Receipt) { await mkdir(dirname(this.path(receipt.runId)), { recursive: true, mode: 0o700 }); receipt.updatedAt = new Date().toISOString(); await atomicJSON(this.path(receipt.runId), receipt); }
  async requireFreeAccount(cf: Cloudflare) {
    const subscriptions = await cf.list(cf.account('/subscriptions'));
    if (subscriptions.some(s => /worker|durable/i.test(JSON.stringify(s)))) throw Error('Paid, trial or unknown Workers subscription detected. This free-only deployment will not proceed; review and approve a paid implementation separately.');
  }
  token(id: string) {
    if (!/^[a-f0-9]{64}$/i.test(this.vault.values.monitoring || '')) throw Error('Monitoring management credential is unavailable or invalid. Restore the original vault or a 64-character hexadecimal LAUNCHKIT_MONITORING_KEY.');
    const token = createHmac('sha256', this.vault.values.monitoring!).update(`launchkit-monitor:${id}`).digest('hex'); registerSecret(token); return token;
  }
  async request(receipt: Receipt, path: string, body?: unknown): Promise<any> {
    // Derive URL from validated saved target; never forward credentials to a supplied URL or redirect.
    if (!/^https:\/\/lk-monitor-[a-f0-9]{24}\.[a-z0-9-]+\.workers\.dev$/.test(receipt.target.origin) || new URL(receipt.target.origin).hostname.split('.')[0] !== `lk-monitor-${receipt.runId}`) throw Error('Invalid monitoring endpoint');
    const result = await this.tools.fetch(`${receipt.target.origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${this.token(receipt.runId)}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!result.ok) { await result.body?.cancel(); throw Error(`Cloud monitor returned HTTP ${result.status}. Deployment, credential or provider readiness may need review.`); }
    return result.json();
  }
  async deploy(id: string, input: unknown) {
    if (this.busy) throw Error('Cloud monitoring update already in progress'); this.busy = true;
    try {
      const body = input as any;
      const authorized = body?.authorized === true; const verifyNotifications = body?.verifyNotifications === true;
      if (!validSettings(body) || !authorized) throw Error('Authorize the displayed production hostname, verified inbox, and free-tier monitoring deployment.');
      const run = await this.journal.load(id);
      if (!verifiedProduction(run)) throw Error('Cloud monitoring requires a fully verified production deployment.');
      if (!run.config.inbox || /[\r\n<>]/.test(run.config.inbox)) throw Error('A verified owner inbox is required.');
      const cf = this.tools.cf(run);
      const [, zone, destinations, routing, subdomain] = await Promise.all([
        this.requireFreeAccount(cf), cf.get(`/zones/${run.resources.zone.id}`), cf.list(cf.account('/email/routing/addresses')),
        cf.get(`/zones/${run.resources.zone.id}/email/routing`), cf.get(cf.account('/workers/subdomain'))
      ]);
      if (zone.name !== run.config.domain || zone.account?.id !== run.config.accountId || zone.status !== 'active') throw Error('Production hostname must be an active zone owned by the connected account.');
      if (!destinations.some(d => d.email?.toLowerCase() === run.config.inbox.toLowerCase() && d.verified) || !routing.enabled || routing.status !== 'ready') throw Error('The saved owner inbox and Email Routing must already be verified and ready. No email or DNS onboarding is performed by the monitor.');
      if (!/^[a-z0-9-]+$/.test(subdomain.subdomain || '')) throw Error('Workers subdomain is unavailable.');
      const worker = `lk-monitor-${id}`;
      const target: CloudTarget = { runId: id, domain: run.config.domain, release: run.resources.deployedRelease, recipient: run.config.inbox, sender: `monitor@${run.config.domain}`, origin: `https://${worker}.${subdomain.subdomain}.workers.dev` };
      const code = await Promise.all(['worker.ts', 'engine.ts', 'health.ts', 'types.ts', '../incidents.ts', '../types.ts'].map(file => readFile(join(source, file), 'utf8')));
      const build = digest([target, code]); const prior = await this.load(id);
      const settingsPath = cf.account(`/workers/scripts/${worker}/settings`);
      let remote: any;
      try { remote = await cf.get(settingsPath); }
      catch (e) { if (!(e instanceof APIError && e.status === 404 && e.codes.includes(10007))) throw e; }
      const binding = (name: string) => remote?.bindings?.find((b: any) => b.name === name)?.text;
      if (remote && binding('LAUNCHKIT_BUSINESS') !== id) throw Error('The monitoring Worker name belongs to an unrecognized deployment. Nothing was overwritten.');
      if (remote?.bindings?.some((b: any) => !['LAUNCHKIT_BUSINESS', 'TARGET', 'MONITOR_BUILD', 'MONITOR', 'EMAIL', 'ADMIN_TOKEN'].includes(b.name))) throw Error('Unexpected bindings exist on the monitoring Worker; review them before updating.');
      if (prior?.status === 'INTENT' && binding('MONITOR_BUILD') !== prior.build) throw Error('A previous monitor deployment has an unknown outcome. Reconcile it in Cloudflare before another deployment.');
      if (!this.vault.values.monitoring) {
        if (remote) throw Error('The original monitoring management credential is missing. Restore the vault before updating the deployed monitor.');
        if (process.platform !== 'win32') throw Error('Set LAUNCHKIT_MONITORING_KEY through your secret store before cloud deployment; this platform has no durable encrypted credential storage.');
        await this.vault.connect({ monitoring: randomBytes(32).toString('hex') });
      }
      const receipt: Receipt = { runId: id, worker, target, build, status: 'INTENT', updatedAt: new Date().toISOString() };
      await this.save(receipt);
      if (binding('MONITOR_BUILD') !== build) {
        const dir = join(this.journal.dir, 'cloud-monitoring', id); await mkdir(dir, { recursive: true, mode: 0o700 }); const config = join(dir, 'wrangler.json');
        await writeFile(config, JSON.stringify(monitoringConfig(run, target, build), null, 2), { mode: 0o600 });
        // Only deployment tooling receives Cloudflare credentials. Neither Worker vars nor bindings do.
        try { await this.tools.command(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', config, '--no-autoconfig'], root, { CLOUDFLARE_API_TOKEN: this.vault.values.cloudflare!, CLOUDFLARE_ACCOUNT_ID: run.config.accountId, WRANGLER_SEND_METRICS: 'false' }, 180_000); }
        catch (error) {
          receipt.error = `Deployment interrupted or rejected. ${redact(error instanceof Error ? error.message : 'Tool failed')}`; await this.save(receipt);
          // Wrangler can fail after uploading but before installing triggers. Reconcile the
          // exact build instead of publishing a second time or declaring the schedule ready.
          remote = await cf.get(settingsPath);
          if (binding('MONITOR_BUILD') !== build) throw Error(receipt.error);
        }
      }
      remote = await cf.get(settingsPath);
      if (binding('MONITOR_BUILD') !== build) throw Error('Monitor deployment not yet observed. Resume after provider propagation.');
      await cf.request(cf.account(`/workers/scripts/${worker}/secrets`), 'PUT', { name: 'ADMIN_TOKEN', type: 'secret_text', text: this.token(id) });
      const subdomainPath = cf.account(`/workers/scripts/${worker}/subdomain`);
      const endpoint = await cf.get(subdomainPath);
      if (!endpoint.enabled || endpoint.previews_enabled) await cf.request(subdomainPath, 'POST', { enabled: true, previews_enabled: false });
      const schedulePath = cf.account(`/workers/scripts/${worker}/schedules`);
      const scheduled = (value: any) => Array.isArray(value?.schedules) && value.schedules.length === 1 && value.schedules[0].cron === '*/5 * * * *';
      if (!scheduled(await cf.get(schedulePath))) await cf.request(schedulePath, 'PUT', [{ cron: '*/5 * * * *' }]);
      if (!(await cf.get(subdomainPath)).enabled || !scheduled(await cf.get(schedulePath))) throw Error('Monitor endpoint or schedule has not yet been confirmed by Cloudflare.');
      receipt.error = undefined;
      receipt.status = 'DEPLOYED'; await this.save(receipt);
      let result = await this.request(receipt, '/config', { enabled: body.enabled, intervalMinutes: body.intervalMinutes, notifications: body.notifications });
      // A deliberate monitor update may reuse durable state from an earlier release (including a rollback).
      if (result.target?.release && result.target.release !== target.release) result = await this.request(receipt, '/release', { runId: id, domain: target.domain, previousRelease: result.target.release, release: target.release });
      if (verifyNotifications && body.enabled && body.notifications) await this.request(receipt, '/verification', {});
      receipt.verifiedAt = new Date().toISOString(); await this.save(receipt); return result;
    } finally { this.busy = false; }
  }
  async reconcileRelease(id: string) {
    if (this.busy) throw Error('Cloud monitoring update already in progress'); this.busy = true;
    try {
      const receipt = await this.load(id); if (!receipt) return; // Monitoring is opt-in; never provision here.
      const run = await this.journal.load(id);
      if (receipt.status !== 'DEPLOYED' || !verifiedProduction(run)) throw Error('Release reconciliation requires a fully verified production deployment and an existing cloud monitor.');
      const release: string = run.resources.release;
      if (receipt.runId !== id || receipt.target.runId !== id || receipt.target.domain !== run.config.domain) throw Error('Authorized monitoring identity differs from this production deployment.');
      receipt.releaseSync = { release, status: 'PENDING' }; await this.save(receipt);
      try {
        const remote = await this.request(receipt, '/status');
        const matches = (target: CloudTarget) => target && ['runId', 'domain', 'origin', 'sender', 'recipient'].every(key => target[key as keyof CloudTarget] === receipt.target[key as keyof CloudTarget]);
        if (!matches(remote.target) || !/^[a-f0-9]{64}$/.test(remote.target.release)) throw Error('Cloud monitor authorization differs from the saved target.');
        if (remote.target.release !== release) {
          const result = await this.request(receipt, '/release', { runId: id, domain: run.config.domain, previousRelease: remote.target.release, release });
          if (!matches(result.target) || result.target.release !== release) throw Error('Updated cloud release was not confirmed.');
        }
        receipt.releaseSync.status = 'SYNCED'; await this.save(receipt);
      } catch (error) {
        receipt.releaseSync.error = 'Cloud release update is pending. Refresh cloud status and retry release sync. Older monitors must be explicitly updated first.';
        await this.save(receipt); throw Error(receipt.releaseSync.error);
      }
    } finally { this.busy = false; }
  }
  async action(id: string, action: 'configure' | 'verification' | 'acknowledge' | 'release', input: any) {
    if (action === 'release') { await this.reconcileRelease(id); return this.report(id); }
    if (this.busy) throw Error('Cloud monitoring update already in progress');
    const receipt = await this.load(id); if (!receipt || receipt.status !== 'DEPLOYED') throw Error('Deploy the cloud monitor first.');
    if (action === 'configure' && !validSettings(input)) throw Error('Invalid cloud settings');
    if (action === 'configure' && input.notifications === true && input.authorized !== true) throw Error('Explicit authorization is required to enable email notifications.');
    if (action === 'configure' && input.enabled) await this.requireFreeAccount(this.tools.cf(await this.journal.load(id)));
    return this.request(receipt, action === 'configure' ? '/config' : `/${action}`, action === 'configure' ? { enabled: input.enabled, intervalMinutes: input.intervalMinutes, notifications: input.notifications } : input);
  }
  async report(id: string) {
    const run = await this.journal.load(id); const receipt = await this.load(id);
    const base = { eligible: run.config.mode === 'live' && eligible(run), domain: run.config.domain, recipient: run.config.inbox, deployment: receipt };
    if (!receipt) return { ...base, status: 'NOT_DEPLOYED', releasePending: false };
    try {
      const cloud = await this.request(receipt, '/status');
      return { ...base, status: receipt.status, cloud, releasePending: verifiedProduction(run) && cloud.target?.release !== run.resources.release };
    }
    catch { return { ...base, status: 'UNREACHABLE', releasePending: verifiedProduction(run) && receipt.releaseSync?.status === 'PENDING', error: 'Cloud monitoring status is unavailable. This is not evidence of healthy service; check connectivity, deployment and credentials.' }; }
  }
}
