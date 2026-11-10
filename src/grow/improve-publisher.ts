import { Cloudflare } from '../adapters/cloudflare.ts';
import { deploy } from '../adapters/wrangler.ts';
import { verifyHTTP } from '../verification/http.ts';
import { auditDistribution } from '../adapters/app-vite.ts';
import { digest } from '../workflow/journal.ts';
import type { Run, Context } from '../workflow/types.ts';
import type { Vault } from '../security/tokens.ts';
import type { ImprovementPublisher, Proposal } from './improve.ts';

interface PublisherTools { cloudflare(run: Run): Cloudflare; deploy: typeof deploy; verifyHTTP: typeof verifyHTTP }

export class M1ImprovementPublisher implements ImprovementPublisher {
  vault: Vault; tools: PublisherTools;
  constructor(vault: Vault, tools?: PublisherTools) { this.vault = vault; this.tools = tools || { cloudflare: run => new Cloudflare(run.config.accountId, vault.values), deploy, verifyHTTP }; }
  identity() { return digest(['m3c-title-v1', this.vault.values.cloudflare || 'disconnected']); }
  async inspect(run: Run) {
    const cf = this.tools.cloudflare(run);
    const worker = `lk-${run.id}`;
    const domains = await cf.list(cf.account('/workers/domains'));
    if (!domains.some(d => d.hostname === run.config.domain && d.service === worker)) throw Error('Existing production Worker binding not found.');
    const result = await cf.get(cf.account(`/workers/scripts/${worker}/deployments`));
    const deploymentId = result?.deployments?.[0]?.id;
    if (typeof deploymentId !== 'string' || !deploymentId) throw Error('Current deployment unavailable.');
    return { cf, deploymentId };
  }
  async preflight(run: Run, p: Proposal) {
    const { deploymentId } = await this.inspect(run);
    if (deploymentId !== p.baseDeployment || run.resources.release !== p.baseRelease) throw Error('Deployment changed since the proposal.');
    if (digest(await auditDistribution(run.resources.publishDir)) !== digest(run.resources.manifest)) throw Error('Baseline files changed.');
    await this.tools.verifyHTTP(`https://${run.config.domain}`, run.resources.manifest, p.baseRelease, false, run.resources.publishDir);
  }
  async publish(run: Run, p: Proposal) {
    const { cf, deploymentId } = await this.inspect(run);
    if (deploymentId !== p.baseDeployment) throw Error('Deployment changed.');
    if (digest(await auditDistribution(p.directory)) !== digest(p.manifest)) throw Error('Approved files changed.');
    const copy = structuredClone(run);
    Object.assign(copy.resources, { release: p.release, publishDir: p.directory, manifest: p.manifest });
    let attempted = false;
    const ctx: Context = { run: copy, save: async () => {},
      approve: async (kind, details) => {
        if (kind !== 'deployment' || details.worker !== `lk-${run.id}` || details.beforeDeploymentId !== p.baseDeployment || details.newRelease !== p.release || details.domain !== run.config.domain) throw Error('Publication differs from the approved preview.');
      },
      effect: async (key, _before, action) => {
        if (attempted || key !== `deploy:${p.release}`) throw Error('Only one exact deployment is approved.');
        attempted = true; return action();
      }
    };
    // The improvement journal already durably records INTENT. This helper never
    // runs for reconciliation, so an interrupted call cannot duplicate a send.
    const result = await this.tools.deploy(ctx, cf, p.directory);
    return { deploymentId: result.deploymentId };
  }
  async verify(run: Run, p: Proposal) {
    const { deploymentId } = await this.inspect(run);
    if (digest(await auditDistribution(p.directory)) !== digest(p.manifest)) throw Error('Approved files changed.');
    await this.tools.verifyHTTP(`https://${run.config.domain}`, p.manifest, p.release, false, p.directory);
    return { deploymentId };
  }
}
