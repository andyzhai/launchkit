import { Journal } from '../src/workflow/journal.ts';
import { Vault } from '../src/security/tokens.ts';
import { Runner } from '../src/workflow/runner.ts';
import { LiveProvider } from '../src/adapters/live.ts';
import { hostname } from '../src/security/config.ts';

// Uses the same protected credentials, mutation journal and process lock as the UI.
const domain = hostname(process.argv[2] || '');
const journal = new Journal(process.env.LAUNCHKIT_DATA_DIR); await journal.init();
const unlock = await journal.lock();
try {
  const candidates = (await journal.list()).filter(r => r.config.mode === 'live' && r.config.domain === domain && r.resources.url === `https://${domain}` && r.resources.zone?.id && !r.resources.supersededBy);
  if (candidates.length !== 1) throw Error('Expected one saved deployment for this hostname. Select the intended business in the LaunchKit UI.');
  const vault = new Vault(journal.dir); await vault.load();
  const runner = new Runner(journal, new LiveProvider(journal.dir, vault));
  const run = await runner.configureAnalytics(candidates[0].id);
  console.log(JSON.stringify(run.steps.analytics, null, 2));
  if (run.steps.analytics.status !== 'VERIFIED') process.exitCode = 1;
} finally { await unlock(); }
