import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJSON, Journal } from '../workflow/journal.ts';
import type { Run } from '../workflow/types.ts';
import type { CheckName, HealthCheck, Observation, OperateState, OperatorProvider } from './types.ts';
import { usageWindow } from './provider.ts';
import { healthStatus, reconcileIncidents } from './incidents.ts';

const names: CheckName[] = ['dns', 'https', 'certificate', 'http', 'release', 'headers'];
export function eligible(run: Run) { return !run.resources.supersededBy && run.resources.url === `https://${run.config.domain}`; }
export function defaults(runId: string): OperateState {
  return { schema: 1, runId, settings: { enabled: false, intervalMinutes: 5, usageEnabled: false }, history: [], incidents: [], events: [] };
}
function event(state: OperateState, kind: OperateState['events'][number]['kind'], message: string, at: string) {
  state.events.push({ at, kind, message }); state.events = state.events.slice(-200);
}
export class Operator {
  journal: Journal; provider: (mode: 'mock' | 'live') => OperatorProvider; now: () => Date; busy = false;
  constructor(journal: Journal, provider: Operator['provider'], now = () => new Date()) { this.journal = journal; this.provider = provider; this.now = now; }
  path(id: string) { this.journal.path(id); return join(this.journal.dir, 'operate', `${id}.json`); }
  async load(id: string): Promise<OperateState> {
    try { const state = JSON.parse(await readFile(this.path(id), 'utf8')); if (state.schema !== 1 || state.runId !== id) throw Error('Unsupported operations journal'); return state; }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; return defaults(id); }
  }
  async save(state: OperateState) { await mkdir(join(this.journal.dir, 'operate'), { recursive: true, mode: 0o700 }); await atomicJSON(this.path(state.runId), state); }
  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw Error('An operations check is running. Try again when it finishes.');
    this.busy = true; try { return await action(); } finally { this.busy = false; }
  }
  async configure(id: string, input: unknown) {
    return this.exclusive(async () => {
      const settings = input as OperateState['settings'];
      if (!settings || typeof settings.enabled !== 'boolean' || typeof settings.usageEnabled !== 'boolean' || !Number.isInteger(settings.intervalMinutes) || settings.intervalMinutes < 1 || settings.intervalMinutes > 1440) throw Error('Choose a check interval from 1 to 1440 whole minutes and explicit monitoring/usage preferences.');
      const run = await this.journal.load(id);
      if (settings.enabled && !eligible(run)) throw Error('Launch and bind this business before enabling monitoring.');
      const state = await this.load(id); const now = this.now().toISOString();
      const kind = state.settings.enabled === settings.enabled ? 'SETTINGS' : settings.enabled ? 'ENABLED' : 'PAUSED';
      state.settings = { enabled: settings.enabled, intervalMinutes: settings.intervalMinutes, usageEnabled: settings.usageEnabled };
      state.nextCheckAt = settings.enabled ? now : undefined;
      state.nextUsageAt = undefined;
      if (!settings.usageEnabled) state.usage = { ...usageWindow(this.now()), simulated: run.config.mode === 'mock', status: 'DISABLED', message: 'Usage collection is disabled.' };
      event(state, kind, `Monitoring ${settings.enabled ? 'enabled' : 'paused'}; interval ${settings.intervalMinutes} minutes; usage ${settings.usageEnabled ? 'enabled' : 'disabled'}.`, now);
      await this.save(state); return state;
    });
  }
  async acknowledge(id: string, incidentId: string) {
    return this.exclusive(async () => {
      await this.journal.load(id); const state = await this.load(id);
      const incident = state.incidents.find(i => i.id === incidentId);
      if (!incident) throw Error('Incident not found');
      if (!incident.acknowledgedAt) { incident.acknowledgedAt = this.now().toISOString(); event(state, 'ACKNOWLEDGED', `Acknowledged ${incident.check} incident ${incident.id}; this does not resolve it.`, incident.acknowledgedAt); await this.save(state); }
      return state;
    });
  }
  async recordRecovery(id: string) {
    return this.exclusive(async () => {
      const state = await this.load(id); const now = this.now().toISOString();
      event(state, 'RECOVERY', 'Requested launch inspection and repair. Existing approval and unknown-outcome reconciliation rules apply. Health is rechecked separately.', now);
      state.nextCheckAt = state.settings.enabled ? now : undefined; await this.save(state);
    });
  }
  async due(): Promise<string | undefined> {
    const due: { id: string; at: string }[] = [];
    for (const run of await this.journal.list()) {
      if (!eligible(run)) continue;
      const state = await this.load(run.id);
      if (state.settings.enabled && (!state.nextCheckAt || Date.parse(state.nextCheckAt) <= this.now().getTime())) due.push({ id: run.id, at: state.nextCheckAt || '' });
    }
    return due.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))[0]?.id;
  }
  async check(id: string) {
    return this.exclusive(async () => {
      const run = await this.journal.load(id); if (!eligible(run)) throw Error('Launch and bind this business before checking public health.');
      const state = await this.load(id); const start = this.now(); const startedAt = start.toISOString();
      if (state.settings.enabled && state.nextCheckAt && start.getTime() - Date.parse(state.nextCheckAt) > state.settings.intervalMinutes * 60_000) event(state, 'GAP', `Scheduled checks were missed after ${state.nextCheckAt}. No uptime or incident timing is inferred for this gap.`, startedAt);
      // Persist a future due time before network I/O. A crash cannot cause a tight retry loop.
      state.nextCheckAt = state.settings.enabled ? new Date(start.getTime() + state.settings.intervalMinutes * 60_000).toISOString() : undefined;
      await this.save(state);
      const provider = this.provider(run.config.mode);
      let checks: HealthCheck[];
      try {
        checks = await provider.health(run);
        if (checks.length !== names.length || names.some(name => checks.filter(c => c.name === name).length !== 1) || checks.some(c => !['PASS', 'WARN', 'FAIL', 'UNKNOWN'].includes(c.status))) throw Error('Incomplete check response');
      } catch { checks = names.map(name => ({ name, status: 'UNKNOWN', message: 'The local checker could not complete. Recheck or restart LaunchKit; no healthy result was inferred.' })); }
      const finishedAt = this.now().toISOString();
      const observation: Observation = { id: randomUUID(), startedAt, finishedAt, simulated: run.config.mode === 'mock', checks,
        status: healthStatus(checks) };
      for (const transition of reconcileIncidents(state.incidents, checks, finishedAt, randomUUID)) event(state, transition.kind, `${transition.incident.check}: ${transition.kind === 'RESOLVED' ? 'Recovered on a successful check.' : transition.incident.message}`, finishedAt);
      state.last = observation; state.history.push(observation); state.history = state.history.slice(-288);
      const resolved = state.incidents.filter(i => i.resolvedAt).slice(-100);
      state.incidents = [...resolved, ...state.incidents.filter(i => !i.resolvedAt)];
      await this.save(state); // Preserve health evidence even if usage hangs or the process stops.
      if (state.settings.usageEnabled && (!state.nextUsageAt || Date.parse(state.nextUsageAt) <= start.getTime())) {
        state.nextUsageAt = new Date(start.getTime() + 3_600_000).toISOString(); await this.save(state);
        try { state.usage = await provider.usage(run, start); }
        catch { state.usage = { ...usageWindow(start), status: 'UNAVAILABLE', simulated: run.config.mode === 'mock', message: 'Usage could not be read. Health checks are independent.' }; }
      }
      await this.save(state); return state;
    });
  }
  async report(id: string) {
    const run = await this.journal.load(id); const state = await this.load(id); const now = this.now();
    const stale = !state.last || now.getTime() - Date.parse(state.last.finishedAt) > state.settings.intervalMinutes * 120_000;
    return { ...state, mode: run.config.mode, eligible: eligible(run), generatedAt: now.toISOString(), stale,
      coverage: 'Local checks only while LaunchKit is running. Alerts appear in this dashboard; no email or external notifications. Gaps are not measured uptime.',
      costs: { recorded: run.resources.costs || [], billingStatus: 'UNAVAILABLE', message: 'Recorded launch quotes and registration evidence only; invoices, taxes, renewals and ongoing provider charges are not retrieved. No total bill or free-plan guarantee is inferred.' },
      recovery: { action: 'Inspect and repair launch', message: 'Rechecks can confirm transient recovery without changes. Launch inspection runs the saved application build and provider workflow; purchases, replacements and deployment updates retain their existing approval gates. No automatic rollback or forced redeploy.' }
    };
  }
}
