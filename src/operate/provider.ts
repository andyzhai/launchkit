import type { Run } from '../workflow/types.ts';
import type { Vault } from '../security/tokens.ts';
import { checkHealth } from './health.ts';
import type { HealthCheck, OperatorProvider, Usage } from './types.ts';

export function usageWindow(now: Date) { return { checkedAt: now.toISOString(), from: new Date(now.getTime() - 86_400_000).toISOString(), to: now.toISOString() }; }
export async function cloudflareUsage(run: Run, token: string | undefined, now: Date, transport = fetch): Promise<Usage> {
  const base = { ...usageWindow(now), simulated: false };
  const unavailable = (message: string): Usage => ({ ...base, status: 'UNAVAILABLE', message });
  if (!token || !/^[a-f0-9]{32}$/.test(run.config.accountId) || !/^lk-[a-f0-9]{24}$/.test(run.resources.worker || '')) return unavailable('Connect Cloudflare with Account Analytics Read and launch a Worker to read usage.');
  try {
    // No dimensions: one aggregate for the exact Worker and window, without truncated time buckets.
    const response = await transport('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `query LaunchKitUsage($accountTag: string!, $scriptName: string!, $start: Time!, $end: Time!) {
        viewer { accounts(filter: {accountTag: $accountTag}) { workersInvocationsAdaptive(limit: 1,
          filter: {scriptName: $scriptName, datetime_geq: $start, datetime_leq: $end}) { sum { requests errors } } } }
      }`, variables: { accountTag: run.config.accountId, scriptName: run.resources.worker, start: base.from, end: base.to } })
    });
    if (!response.ok) { await response.body?.cancel(); return unavailable(`Cloudflare usage unavailable (HTTP ${response.status}). Check Account Analytics Read access or retry later.`); }
    const data: any = await response.json();
    if (data.errors?.length) return unavailable('Cloudflare could not serve usage. Check Account Analytics Read permission, dataset entitlement, and provider availability.');
    const accounts = data.data?.viewer?.accounts;
    if (!Array.isArray(accounts) || accounts.length !== 1) return unavailable('Cloudflare did not return the requested account.');
    const rows = accounts[0].workersInvocationsAdaptive;
    if (!Array.isArray(rows) || rows.length > 1) return unavailable('Cloudflare returned an unexpected usage response.');
    if (!rows.length) return unavailable('No usage samples were returned for this window; zero usage has not been established.');
    const { requests, errors } = rows[0]?.sum || {};
    if (![requests, errors].every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0)) return unavailable('Cloudflare returned incomplete usage metrics.');
    return { ...base, status: 'AVAILABLE', requests, errors, message: 'Cloudflare sampled Worker invocations over the last 24 hours, including health checks. These are not unique visitors or a billing meter.' };
  } catch { return unavailable('Cloudflare usage request failed or timed out. Retry later; no provider response body was saved.'); }
}
export class LiveOperatorProvider implements OperatorProvider {
  vault: Vault;
  constructor(vault: Vault) { this.vault = vault; }
  health = checkHealth;
  usage(run: Run, now: Date) { return cloudflareUsage(run, this.vault.values.cloudflare, now); }
}
export class MockOperatorProvider implements OperatorProvider {
  async health(): Promise<HealthCheck[]> { return (['dns', 'https', 'certificate', 'http', 'release', 'headers'] as const).map(name => ({ name, status: 'PASS', message: `Simulated ${name} check; no public request made.` })); }
  async usage(_run: Run, now: Date): Promise<Usage> { return { ...usageWindow(now), simulated: true, status: 'AVAILABLE', requests: 1200, errors: 3, message: 'Simulated usage fixture; no provider request made.' }; }
}
