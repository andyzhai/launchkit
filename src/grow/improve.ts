import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJSON, digest, Journal } from '../workflow/journal.ts';
import type { Run } from '../workflow/types.ts';
import { eligible } from '../operate/operator.ts';
import { auditDistribution } from '../adapters/app-vite.ts';
import { escapeHTML } from '../adapters/seo.ts';
import { redact } from '../security/redaction.ts';
import { inspectPage, type Discoverability, type Finding } from './audit.ts';

export interface Proposal {
  id: string; createdAt: string; status: 'AWAITING_APPROVAL' | 'DECLINED' | 'STALE' | 'FAILED' | 'INTENT' | 'UNKNOWN' | 'PUBLISHED' | 'VERIFIED';
  binding: string; connection: string; title: string; before: Finding[]; beforeAt: string; changes: { before: string; after: string }[];
  directory: string; manifest: Record<string, string>; release: string; baseRelease: string; baseDeployment: string;
  previewHash: string; approvedAt?: string; attemptedAt?: string; deploymentId?: string; message?: string;
  after?: { at: string; findings: Finding[]; result: 'CORRECTED' | 'REVIEW' | 'UNAVAILABLE' };
}
interface State { schema: 1; runId: string; proposals: Proposal[] }
export interface ImprovementPublisher {
  identity(): string;
  preflight(run: Run, proposal: Proposal): Promise<void>;
  publish(run: Run, proposal: Proposal): Promise<{ deploymentId: string }>;
  verify(run: Run, proposal: Proposal): Promise<{ deploymentId: string }>;
}
const pending = (p: Proposal) => ['INTENT', 'UNKNOWN', 'PUBLISHED'].includes(p.status);
const binding = (run: Run) => digest([run.id, run.config, run.approvalRevision, run.status, run.steps.verify.status, run.resources.release, run.resources.deploymentId, run.resources.manifest, run.resources.publishDir, run.resources.analytics, run.resources.worker]);
const evidence = (findings: Finding[]) => findings.filter(f => ['metadata', 'rendered-metadata', 'rendered-headings', 'content-product-name'].includes(f.check));
const previewHash = (p: Proposal) => digest([p.id, p.binding, p.connection, p.title, p.before, p.beforeAt, p.changes, p.directory, p.manifest, p.release, p.baseRelease, p.baseDeployment]);

// Deliberately supports only the M1-generated title syntax. Refuse ambiguous
// markup instead of rewriting unrelated head content, robots or application JS.
export function changeTitle(html: string, title: string) {
  const heads = [...html.matchAll(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/gi)];
  if (heads.length !== 1) throw Error('A single HTML head is required.');
  const head = heads[0][1]; const titles = [...head.matchAll(/<title>[\s\S]*?<\/title>/gi)];
  if (titles.length !== 1 || (head.match(/<title\b/gi) || []).length !== 1) throw Error('A single plain title element is required.');
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].filter(m => /\bproperty\s*=\s*["']og:title["']/i.test(m[0]));
  if (metas.length > 1 || metas.some(m => !/\bcontent\s*=\s*(["'])(.*?)\1/i.test(m[0]))) throw Error('Unsupported Open Graph title markup.');
  const changes = [{ before: titles[0][0], after: `<title>${escapeHTML(title)}</title>` }];
  for (const meta of metas) changes.push({ before: meta[0], after: meta[0].replace(/\bcontent\s*=\s*(["'])(.*?)\1/i, () => `content="${escapeHTML(title)}"`) });
  let changed = head;
  for (const edit of changes) changed = changed.replace(edit.before, () => edit.after);
  if (changed === head) throw Error('The proposed title is already present.');
  return { html: html.replace(heads[0][0], () => heads[0][0].replace(head, () => changed)), changes };
}

export class Improvements {
  journal: Journal; audit: Discoverability; publisher: ImprovementPublisher; busy = false;
  constructor(journal: Journal, audit: Discoverability, publisher: ImprovementPublisher) { this.journal = journal; this.audit = audit; this.publisher = publisher; }
  path(id: string) { this.journal.path(id); return join(this.journal.dir, 'grow-improvements', `${id}.json`); }
  async load(id: string): Promise<State> {
    try { const state = JSON.parse(await readFile(this.path(id), 'utf8')); if (state.schema !== 1 || state.runId !== id || !Array.isArray(state.proposals)) throw Error('Unsupported improvement journal'); return state; }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; return { schema: 1, runId: id, proposals: [] }; }
  }
  async save(state: State) { await mkdir(join(this.journal.dir, 'grow-improvements'), { recursive: true, mode: 0o700 }); await atomicJSON(this.path(state.runId), state); }
  async assertSettled(id: string) {
    const run = await this.journal.load(id);
    for (const business of await this.journal.list()) if (business.config.domain === run.config.domain && business.config.mode === run.config.mode && (await this.load(business.id)).proposals.some(pending)) throw Error('An improvement publication needs read-only verification before another launch or proposal.');
  }
  async report(id: string) {
    const run = await this.journal.load(id); const state = await this.load(id);
    return { runId: id, domain: run.config.domain, simulated: run.config.mode === 'mock', eligible: eligible(run),
      owner: 'The customer owns the application source. LaunchKit edits only a copy of the verified M1 publication; future source releases must retain the approved title.',
      limits: 'One homepage title and its existing Open Graph title. Exact approval publishes to the existing bound Worker. No source build, DNS, robots, sitemap or analytics configuration changes. Verification is explicit and read-only; no ranking, traffic or AI citation claim.',
      proposals: state.proposals.map(p => ({ ...p, stale: p.status === 'AWAITING_APPROVAL' && (p.binding !== binding(run) || p.connection !== this.publisher.identity() || Date.now() - Date.parse(p.createdAt) > 86_400_000) })) };
  }
  async action(id: string, action: string, body: any) {
    if (this.busy) throw Error('An improvement action is running.'); this.busy = true;
    try {
      const run = await this.journal.load(id); const state = await this.load(id);
      if (!eligible(run)) throw Error('Select a bound production business.');
      if (action === 'prepare') {
        await this.assertSettled(id);
        const title = body.title;
        if (typeof title !== 'string' || !title.trim() || title !== title.trim() || title.length > 120 || /[\u0000-\u001f\u007f<>]/.test(title) || redact(title) !== title) throw Error('Enter a factual title of 1–120 characters without markup or credentials.');
        const report = await this.audit.report(id);
        if (report.stale || !report.at || !report.findings.some(f => f.check === 'metadata' && f.status !== 'UNAVAILABLE')) throw Error('Refresh the public audit before preparing a title change.');
        if (run.config.mode === 'live' && (!run.config.seo.approved || run.steps.verify.status !== 'VERIFIED' || !run.resources.release || !run.resources.deploymentId || run.resources.worker !== `lk-${id}`)) throw Error('A verified, M1-owned release with approved SEO is required.');
        if (state.proposals.length >= 50) throw Error('Improvement history is full.');
        const proposalId = randomUUID(); const directory = join(this.journal.dir, 'improvement-releases', id, proposalId);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (run.config.mode === 'mock') await writeFile(join(directory, 'index.html'), '<html><head><title>Simulation</title></head><body><h1>Simulated business</h1></body></html>');
        else {
          if (digest(await auditDistribution(run.resources.publishDir)) !== digest(run.resources.manifest)) throw Error('The verified publication copy changed; re-establish the M1 baseline first.');
          await cp(run.resources.publishDir, directory, { recursive: true });
          if (digest(await auditDistribution(directory)) !== digest(run.resources.manifest)) throw Error('Publication copy changed during preparation.');
        }
        const changed = changeTitle(await readFile(join(directory, 'index.html'), 'utf8'), title);
        if (changed.changes.some(c => redact(c.before) !== c.before)) throw Error('Title contains sensitive text.');
        await writeFile(join(directory, 'index.html'), changed.html);
        const manifest = await auditDistribution(directory);
        const p: Proposal = { id: proposalId, createdAt: new Date().toISOString(), status: 'AWAITING_APPROVAL', binding: binding(run), connection: this.publisher.identity(), title,
          before: evidence(report.findings), beforeAt: report.at, changes: changed.changes, directory, manifest,
          release: digest([run.resources.release, manifest, proposalId]), baseRelease: run.resources.release || 'simulation', baseDeployment: run.resources.deploymentId || 'simulation', previewHash: '' };
        p.previewHash = previewHash(p);
        for (const old of state.proposals) if (old.status === 'AWAITING_APPROVAL') old.status = 'STALE';
        state.proposals.push(p); await this.save(state); return;
      }
      const p = state.proposals.find(p => p.id === body.proposalId);
      if (!p) throw Error('Select an existing proposal.');
      if (action === 'decline') {
        if (p.status !== 'AWAITING_APPROVAL') throw Error('This proposal cannot be declined.');
        p.status = 'DECLINED'; await this.save(state); return;
      }
      if (action === 'publish') {
        if (p.status !== 'AWAITING_APPROVAL' || body.previewHash !== p.previewHash || p.previewHash !== previewHash(p)) throw Error('Review and approve the exact current preview.');
        if (p.binding !== binding(run) || p.connection !== this.publisher.identity() || Date.now() - Date.parse(p.createdAt) > 86_400_000) { p.status = 'STALE'; await this.save(state); throw Error('The proposal is stale. Prepare and review a new one.'); }
        await this.assertSettled(id);
        try {
          if (digest(await auditDistribution(p.directory)) !== digest(p.manifest)) throw Error('The preview artifact changed.');
          if (run.config.mode === 'live') await this.publisher.preflight(run, p);
        } catch { p.status = 'FAILED'; p.message = 'Pre-publication checks failed. No publication attempted. Refresh the baseline and prepare again.'; await this.save(state); return; }
        p.approvedAt = new Date().toISOString(); p.attemptedAt = p.approvedAt; p.status = 'INTENT'; await this.save(state);
        try {
          const result = run.config.mode === 'mock' ? { deploymentId: 'simulation' } : await this.publisher.publish(run, p);
          p.deploymentId = result.deploymentId; p.status = 'PUBLISHED'; p.message = 'Publication accepted; independently verify the public release and audit.';
        } catch { p.status = 'UNKNOWN'; p.message = 'Publication outcome is unknown. No retry will be sent. Use read-only verification; absence is not proof of failure.'; }
        await this.save(state); return;
      }
      if (action === 'verify') {
        if (!pending(p) && p.status !== 'VERIFIED') throw Error('Only an attempted publication can be verified.');
        // Once finalized, re-audits must not overwrite newer launch configuration.
        const wasVerified = p.status === 'VERIFIED';
        let verified = false;
        try {
          const result = run.config.mode === 'mock' ? { deploymentId: 'simulation' } : await this.publisher.verify(run, p);
          p.deploymentId = result.deploymentId; verified = true;
        } catch { /* Record the independent audit even when release verification fails. */ }
        const report = await this.audit.refresh(id);
        const findings = run.config.mode === 'mock' ? evidence(inspectPage(run.config.domain, '/', { status: 200, type: 'text/html', body: await readFile(join(p.directory, 'index.html'), 'utf8') }, report.at!)) : evidence(report.findings);
        const metadata = findings.find(f => f.check === 'metadata');
        const corrected = !!metadata && metadata.evidence.startsWith(`Initial HTML title: “${escapeHTML(p.title)}”;`);
        p.after = { at: report.at!, findings, result: verified && corrected ? 'CORRECTED' : metadata ? 'REVIEW' : 'UNAVAILABLE' };
        if (verified && run.resources.improvementReceipt === p.id) p.status = 'VERIFIED';
        else if (verified && !wasVerified) {
          if (p.binding !== binding(run)) { p.message = 'Public release observed, but saved launch state changed. Manual reconciliation required.'; await this.save(state); return; }
          run.config.seo.title = p.title; run.approvalRevision = (run.approvalRevision || 0) + 1;
          Object.assign(run.resources, { release: p.release, deployedRelease: p.release, deploymentId: p.deploymentId, publishDir: p.directory, manifest: p.manifest });
          // Persist a receipt with the launch update so restart can finish safely.
          run.resources.improvementReceipt = p.id;
          run.steps.verify.evidence = { ...run.steps.verify.evidence, improvement: p.id, release: p.release, verifiedAt: report.at };
          run.report = undefined;
          await this.journal.save(run);
          p.status = 'VERIFIED';
        }
        p.message = verified ? 'Exact release observed. See the separate before/after audit; rankings and citations are unmeasured. Sync the existing cloud monitor release explicitly if enabled.' : 'Expected release not verified. Publication remains unresolved; read-only verification can be repeated.';
        await this.save(state); return;
      }
      throw Error('Unsupported improvement action.');
    } finally { this.busy = false; }
  }
}
