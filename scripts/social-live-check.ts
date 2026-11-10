import { Journal, atomicJSON, digest } from '../src/workflow/journal.ts';
import { Vault } from '../src/security/tokens.ts';
import { Mastodon } from '../src/grow/mastodon.ts';
import { join } from 'node:path';

// Read-only acceptance: never calls publish or creates provider resources.
if (process.env.LAUNCHKIT_LIVE_READ_ONLY !== '1') {
  console.log('SKIPPED: set LAUNCHKIT_LIVE_READ_ONLY=1 to allow Mastodon account and instance reads.');
} else {
  const journal = new Journal(process.env.LAUNCHKIT_DATA_DIR); await journal.init();
  const vault = new Vault(journal.dir); await vault.load(); const provider = new Mastodon(vault);
  const report: Record<string, unknown> = { at: new Date().toISOString(), scope: 'Read-only mastodon.social acceptance check', simulated: false, publishing: 'NOT VERIFIED — no post sent' };
  if (!provider.connected()) {
    report.status = 'BLOCKED_AUTHORIZATION'; report.action = 'Save a mastodon.social user access token in Social publishing. No authenticated requests were made.';
  } else {
    try {
      const account = await provider.account(); report.account = account; report.status = 'ACCOUNT_READ_VERIFIED';
      if (process.env.LAUNCHKIT_MASTODON_POST_ID) {
        const post = await provider.inspect(process.env.LAUNCHKIT_MASTODON_POST_ID);
        if (post.accountId !== account.id) throw Error('The selected post is not on this account.');
        const { text, spoiler, ...publication } = post; report.publication = { ...publication, sourceHash: digest([text, spoiler]) }; report.status = 'ACCOUNT_AND_POST_READS_VERIFIED';
      }
    } catch { report.status = 'BLOCKED_PROVIDER'; report.action = 'Check token scopes, account access and optional post ID, then retry reads. No post was sent.'; }
  }
  await atomicJSON(join(journal.dir, 'social-live-check.report.json'), report); console.log(JSON.stringify(report, null, 2));
}
