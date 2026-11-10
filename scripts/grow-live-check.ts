import { Journal, atomicJSON } from '../src/workflow/journal.ts';
import { Vault } from '../src/security/tokens.ts';
import { GoogleSearch, searchWindow } from '../src/grow/google.ts';
import { covers, Growth } from '../src/grow/controller.ts';
import { join } from 'node:path';

// Read-only acceptance probe. Never calls property creation, verification,
// sitemap submit, DNS, hosting, consent or billing APIs.
if (process.env.LAUNCHKIT_LIVE_READ_ONLY !== '1') {
  console.log('SKIPPED: set LAUNCHKIT_LIVE_READ_ONLY=1 to allow Google provider reads.');
} else {
  const journal = new Journal(process.env.LAUNCHKIT_DATA_DIR); await journal.init();
  const vault = new Vault(journal.dir); await vault.load(); const google = new GoogleSearch(vault);
  const report: Record<string, unknown> = { at: new Date().toISOString(), scope: 'Read-only Google Search Console acceptance check', simulated: false };
  if (!google.connected()) {
    report.status = 'BLOCKED_AUTHORIZATION'; report.action = 'Configure a customer-owned Desktop OAuth client with Search Console API enabled; connect through Growth and consent. No authenticated Google requests were made.';
  } else {
    const id = process.env.LAUNCHKIT_GROW_RUN_ID; if (!id) throw Error('Choose a saved business with LAUNCHKIT_GROW_RUN_ID.');
    const run = await journal.load(id); if (run.config.mode !== 'live') throw Error('Live verification requires a live business.');
    const sites = (await google.sites()).filter(s => covers(s.siteUrl, run.config.domain) && ['siteOwner', 'siteFullUser', 'siteRestrictedUser'].includes(s.permissionLevel));
    report.properties = sites;
    const selected = process.env.LAUNCHKIT_GROW_PROPERTY || (await new Growth(journal, () => google).report(id)).property;
    if (!selected || !sites.some(s => s.siteUrl === selected)) { report.status = 'BLOCKED_PROPERTY'; report.action = 'Select an accessible property in Growth, or verify ownership/access in Search Console, then rerun.'; }
    else {
      report.property = selected; report.window = searchWindow();
      try { report.sitemaps = { status: 'AVAILABLE', data: await google.sitemaps(selected) }; }
      catch (e: any) { report.sitemaps = { status: 'UNAVAILABLE', message: e.message }; }
      try { const metrics = await google.performance(selected, searchWindow()); report.performance = metrics ? { status: 'AVAILABLE', data: metrics } : { status: 'NO_DATA' }; }
      catch (e: any) { report.performance = { status: 'UNAVAILABLE', message: e.message }; }
      report.status = 'READS_COMPLETED'; // Inspect each component; not a blanket provider success.
    }
  }
  await atomicJSON(join(journal.dir, 'grow-live-check.report.json'), report);
  console.log(JSON.stringify(report, null, 2));
}
