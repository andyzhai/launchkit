import { Vault } from '../src/security/tokens.ts';
import { defaultDataDir, atomicJSON } from '../src/workflow/journal.ts';
import { Cloudflare } from '../src/adapters/cloudflare.ts';
import { Resend } from '../src/adapters/email.ts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
// Deliberately read-only. Production purchases/deployments are only available
// through the journaled UI workflow and its approval gates.
if (process.env.LAUNCHKIT_LIVE_READ_ONLY !== '1') {
  console.log('SKIPPED: set LAUNCHKIT_LIVE_READ_ONLY=1 and connect credentials to opt into provider reads. No live verification was performed.');
} else {
  const dir = process.env.LAUNCHKIT_DATA_DIR || defaultDataDir(); await mkdir(dir, { recursive: true }); const vault = new Vault(dir); await vault.load();
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account || !/^[a-f0-9]{32}$/.test(account) || !vault.values.cloudflare) throw Error('Cloudflare account ID and connection are required for live checks');
  const cf = new Cloudflare(account, vault.values); const identity = await cf.get(cf.account('')); const zones = await cf.list(`/zones?account.id=${account}`);
  const report: any = { at: new Date().toISOString(), scope: 'Read-only provider integration checks; no publication or billing', accountId: identity.id, visibleZones: zones.length };
  if (vault.values.resend) report.resendDomains = (await new Resend(vault.values.resend).list()).length;
  if (process.env.LAUNCHKIT_REGISTRAR_SANDBOX === '1') {
    const sandbox = new Cloudflare(account, vault.values, fetch, true);
    report.sandbox = await sandbox.check('launchkit-acceptance-example.com');
  }
  await atomicJSON(join(dir, 'live-check.report.json'), report); console.log('Read-only checks passed. Report saved in the LaunchKit state directory. No live launch has been verified.');
}
