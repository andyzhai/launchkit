import { Journal, atomicJSON } from '../src/workflow/journal.ts';
import { Vault } from '../src/security/tokens.ts';
import { BingSearch, bingCovers } from '../src/grow/bing.ts';
import { Growth } from '../src/grow/controller.ts';
import { eligible } from '../src/operate/operator.ts';
import { join } from 'node:path';

// Deliberately no submit, site creation, ownership verification, DNS or hosting calls.
if (process.env.LAUNCHKIT_LIVE_READ_ONLY !== '1') {
  console.log('SKIPPED: set LAUNCHKIT_LIVE_READ_ONLY=1 to allow Bing provider reads.');
} else {
  const journal = new Journal(process.env.LAUNCHKIT_DATA_DIR); await journal.init();
  const vault = new Vault(journal.dir); await vault.load(); const bing = new BingSearch(vault);
  const report: Record<string, unknown> = { at: new Date().toISOString(), scope: 'Read-only Bing Webmaster acceptance check', simulated: false };
  if (!bing.connected()) {
    report.status = 'BLOCKED_AUTHORIZATION'; report.action = 'Connect your Bing Webmaster API key in Growth. No authenticated Bing requests were made.';
  } else {
    const id = process.env.LAUNCHKIT_GROW_RUN_ID; if (!id) throw Error('Choose a saved business with LAUNCHKIT_GROW_RUN_ID.');
    const run = await journal.load(id); if (run.config.mode !== 'live' || !eligible(run)) throw Error('Live verification requires a bound live business.');
    try {
      const sites = (await bing.sites()).filter(s => s.permissionLevel === 'verified' && bingCovers(s.siteUrl, run.config.domain)); report.properties = sites;
      const selected = process.env.LAUNCHKIT_BING_PROPERTY || (await new Growth(journal, () => bing, undefined, 'bing').report(id)).property;
      if (!selected || !sites.some(s => s.siteUrl === selected)) { report.status = 'BLOCKED_PROPERTY'; report.action = 'Verify and select an exact HTTPS site in Bing Growth, then rerun.'; }
      else {
        report.property = selected;
        try { report.sitemaps = { status: 'AVAILABLE', data: await bing.sitemaps(selected) }; } catch (e: any) { report.sitemaps = { status: 'UNAVAILABLE', message: e.message }; }
        try { const data = await bing.performance(selected); report.performance = data ? { status: 'AVAILABLE', data } : { status: 'NO_DATA' }; } catch (e: any) { report.performance = { status: 'UNAVAILABLE', message: e.message }; }
        report.status = 'READS_COMPLETED'; // Inspect each component; never a blanket provider success.
      }
    } catch { report.status = 'BLOCKED_PROVIDER'; report.action = 'Check Bing authorization and verified site access, then retry reads.'; }
  }
  await atomicJSON(join(journal.dir, 'bing-live-check.report.json'), report);
  console.log(JSON.stringify(report, null, 2));
}
