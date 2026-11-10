import { digest, Journal } from './journal.ts';
import { Pause, stepNames, type Context, type Provider, type Run, type Approval, type Evidence } from './types.ts';
import { clean, redact } from '../security/redaction.ts';
export class Runner {
  journal: Journal; provider: Provider; busy = new Set<string>();
  constructor(journal: Journal, provider: Provider) { this.journal = journal; this.provider = provider; }
  async decide(id: string, approvalId: string, decision: 'approved' | 'denied') {
    if (this.busy.has(id)) throw Error('Wait until this launch pauses before approving.');
    const run = await this.journal.load(id);
    const approval = run.approvals.find(a => a.id === approvalId);
    if (!approval || approval.decision) throw Error('Approval missing or already decided');
    approval.decision = decision; approval.decidedAt = new Date().toISOString(); await this.journal.save(run);
  }
  context(run: Run): Context {
    const save = () => this.journal.save(run);
    return { run, save,
      approve: async (kind: Approval['kind'], details: Evidence) => {
        const approvalId = digest([run.id, kind, details, ...(run.approvalRevision ? [run.approvalRevision] : [])]).slice(0, 24);
        let item = run.approvals.find(a => a.id === approvalId);
        if (!item) { item = { id: approvalId, kind, details: clean(details), createdAt: new Date().toISOString() }; run.approvals.push(item); await save(); }
        if (item.decision !== 'approved') throw new Pause('WAITING_USER', item.decision === 'denied' ? 'Approval declined. No action taken.' : `Review and approve ${kind}.`, { approvalId });
      },
      effect: async (key, before, action) => {
        if (run.operations[key]?.status === 'INTENT') throw new Pause('NEEDS_RECONCILIATION', 'A previous provider mutation has an unknown outcome. Re-inspection did not yet confirm it; no duplicate request was sent.', { operation: key });
        run.operations[key] = { status: 'INTENT', before: clean(before), at: new Date().toISOString() }; await save();
        try {
          const result = await action();
          run.operations[key] = { ...run.operations[key], status: 'OBSERVED', result: clean(result) }; await save(); return result;
        } catch (error: any) {
          if (error?.definitiveFailure === true) { run.operations[key].status = 'REJECTED'; await save(); }
          throw error;
        }
      }
    };
  }

  async configureAnalytics(id: string) {
    if (this.busy.size) throw Error('A launch is already running.');
    this.busy.add(id);
    try {
      const run = await this.journal.load(id);
      if (run.config.mode !== 'live' || run.resources.url !== `https://${run.config.domain}` || !run.resources.zone?.id) throw Error('Select a deployed Cloudflare custom domain.');
      const step = run.steps.analytics; step.attempts++; step.updatedAt = new Date().toISOString();
      try {
        const evidence = await this.provider.step('analytics', this.context(run));
        if (evidence === 'SKIPPED') throw Error('Analytics setup was unexpectedly skipped.');
        step.status = evidence.status === 'unsupported' ? 'SKIPPED' : 'VERIFIED'; step.evidence = clean(evidence); step.message = String(evidence.message || '');
      } catch (error) {
        step.status = error instanceof Pause ? error.status : 'FAILED';
        step.message = redact(error instanceof Error ? error.message : 'Analytics setup failed');
        step.evidence = error instanceof Pause ? clean(error.evidence) : undefined;
      }
      // Preserve the existing application deployment status and release.
      if (run.report) run.report = { ...run.report, steps: run.steps, generatedAt: new Date().toISOString() };
      run.events.push({ at: step.updatedAt, step: 'analytics', message: step.message || step.status });
      run.events = run.events.slice(-200); await this.journal.save(run); return run;
    } finally { this.busy.delete(id); }
  }
  async execute(id: string): Promise<Run> {
    if (this.busy.size) throw Error('A launch is already running.');
    this.busy.add(id);
    try {
      const run = await this.journal.load(id); run.status = 'RUNNING';
      const ctx = this.context(run); const save = ctx.save;
      // All provider steps re-inspect remote state on resume; build caching belongs to the app adapter.
      // Unvisited steps must not look current
      // when an earlier prerequisite fails on this attempt.
      for (const step of Object.values(run.steps)) { step.status = 'NOT_STARTED'; step.evidence = undefined; step.message = undefined; }
      for (const name of stepNames) {
        const step = run.steps[name]; step.status = 'IN_PROGRESS'; step.attempts++; step.message = undefined; step.updatedAt = new Date().toISOString(); await save();
        try {
          const evidence = await this.provider.step(name, ctx);
          if (evidence === 'SKIPPED' && !(['outgoing', 'seo', 'analytics'].includes(name))) throw Error(`Required capability ${name} cannot be skipped`);
          if (evidence === 'SKIPPED' && (name === 'outgoing' && run.config.outbound || name === 'seo' && run.config.seo.approved || name === 'analytics' && run.config.analytics.approved)) throw Error(`Selected capability ${name} cannot be skipped`);
          step.status = evidence === 'SKIPPED' || name === 'analytics' && evidence.status === 'unsupported' ? 'SKIPPED' : 'VERIFIED'; step.evidence = evidence === 'SKIPPED' ? undefined : clean(evidence);
        } catch (error) {
          step.status = error instanceof Pause ? error.status : 'FAILED';
          step.message = redact(error instanceof Error ? error.message : 'Unexpected failure');
          step.evidence = error instanceof Pause ? clean(error.evidence) : undefined;
        }
        run.events.push({ at: new Date().toISOString(), step: name, message: step.message || step.status });
        run.events = run.events.slice(-200); await save();
        if (!['VERIFIED', 'SKIPPED'].includes(step.status) && stepNames.indexOf(name) <= stepNames.indexOf('binding')) break;
      }
      const states = Object.values(run.steps);
      const complete = states.every(s => ['VERIFIED', 'SKIPPED'].includes(s.status));
      run.status = complete ? 'LIVE_VERIFIED' : run.steps.binding.status === 'VERIFIED' ? 'LIVE_PARTIALLY_CONFIGURED' : states.some(s => s.status === 'FAILED') ? 'FAILED' : 'BLOCKED';
      run.report = { mode: run.config.mode, status: run.status, url: run.resources.url,
        generatedAt: new Date().toISOString(), steps: run.steps, approvals: run.approvals,
        costs: run.resources.costs || [], ongoingMonitoring: false,
        verificationScope: run.config.mode === 'mock' ? 'SIMULATED — no live resources or external verification' : 'See individual timestamped evidence; no continuous monitoring' };
      await save(); return run;
    } finally { this.busy.delete(id); }
  }
}
