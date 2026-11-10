import { healthStatus, reconcileIncidents } from '../incidents.ts';
import type { HealthCheck } from '../types.ts';
import { cloudDefaults, validSettings, type CloudState, type CloudStorage, type CloudRuntime, type CloudTarget, type Notification } from './types.ts';

const minute = 60_000;
export const hashReceipt = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
export class CloudMonitor {
  storage: CloudStorage; target: CloudTarget; runtime: CloudRuntime;
  constructor(storage: CloudStorage, target: CloudTarget, runtime: CloudRuntime) { this.storage = storage; this.target = target; this.runtime = runtime; }
  async load() { return await this.storage.get<CloudState>('state') || cloudDefaults(); }
  effectiveTarget(state: CloudState): CloudTarget {
    // An explicitly redeployed TARGET supersedes overrides made against an older configuration.
    return { ...this.target, release: state.releaseOverride?.base === this.target.release ? state.releaseOverride.release : this.target.release };
  }
  async reconcileRelease(value: any) {
    if (!value || Object.keys(value).sort().join(',') !== 'domain,previousRelease,release,runId' || value.runId !== this.target.runId || value.domain !== this.target.domain ||
      !/^[a-f0-9]{64}$/.test(value.release) || !/^[a-f0-9]{64}$/.test(value.previousRelease)) throw Error('Invalid release reconciliation');
    const state = await this.load(); const current = this.effectiveTarget(state);
    if (current.release === value.release) return this.report(); // Safe replay after a lost response.
    if (current.release !== value.previousRelease) throw Error('Expected release changed; inspect before retrying');
    const checks = await this.runtime.health({ ...current, release: value.release });
    if (!['https', 'http', 'release'].every(name => checks.some(c => c.name === name && c.status === 'PASS'))) throw Error('New production release is not publicly verified');
    state.releaseOverride = { base: this.target.release, release: value.release };
    this.event(state, `Authorized production release reconciled: ${current.release} -> ${value.release}.`);
    // Do not manufacture a scheduled observation or resolve incidents/send mail here.
    await this.save(state); return this.report();
  }
  timestamp() { return new Date(this.runtime.now()).toISOString(); }
  event(state: CloudState, message: string) { state.events.push({ at: this.timestamp(), message }); state.events = state.events.slice(-80); }
  async save(state: CloudState) {
    state.history = state.history.slice(-48);
    state.incidents = [...state.incidents.filter(i => i.resolvedAt).slice(-32), ...state.incidents.filter(i => !i.resolvedAt)];
    state.notifications = state.notifications.slice(-80);
    await this.storage.put('state', state);
  }
  async configure(value: unknown) {
    if (!validSettings(value)) throw Error('Choose explicit enable/email preferences and an interval of 5, 15, 30 or 60 minutes.');
    const state = await this.load(); const enabling = value.enabled && !state.settings.enabled;
    if (enabling) { state.enabledAt = this.timestamp(); state.lastCronAt = undefined; state.lastCronReceivedAt = undefined; state.processedCron = undefined; }
    if (!value.enabled || !value.notifications) {
      for (const n of state.notifications) if (n.status === 'PENDING') n.status = 'CANCELLED';
      if (state.drill?.phase !== 'COMPLETE') state.drill = undefined;
    }
    state.settings = { enabled: value.enabled, notifications: value.notifications, intervalMinutes: value.intervalMinutes };
    this.event(state, `Cloud monitoring ${value.enabled ? 'enabled' : 'disabled'}; interval ${value.intervalMinutes} minutes; email ${value.notifications ? 'authorized' : 'disabled'}.`);
    await this.save(state);
    if (value.enabled) await this.storage.setAlarm(this.runtime.now() + (enabling ? 20 : 11) * minute); else await this.storage.deleteAlarm();
    return this.report();
  }
  queue(state: CloudState, id: string, kind: Notification['kind'], message: string) {
    if (!state.settings.notifications || state.notifications.some(n => n.id === id)) return;
    state.notifications.push({ id, kind, subject: `[LaunchKit${kind.startsWith('TEST_') ? ' verification drill' : ''}] ${kind.replace('TEST_', '')}: ${this.target.domain}`, text: `${message}\n\nBusiness: ${this.target.domain}\nObserved: ${this.timestamp()}\nThis monitor is read-only. No production repair was performed.`, status: 'PENDING', createdAt: this.timestamp() });
  }
  reconcile(state: CloudState, checks: HealthCheck[]) {
    for (const { kind, incident } of reconcileIncidents(state.incidents, checks, this.timestamp(), this.runtime.uuid)) {
      this.event(state, `${kind}: ${incident.check}. ${incident.message}`);
      this.queue(state, `${kind}:${incident.id}`, kind === 'OPENED' ? 'INCIDENT' : 'RECOVERY', `${kind === 'OPENED' ? incident.message : `${incident.check} recovered on a successful observation.`}\n${incident.guidance}`);
    }
  }
  async armVerification() {
    const state = await this.load();
    if (!state.settings.enabled || !state.settings.notifications) throw Error('Enable cloud monitoring and authorize email first.');
    // Repeat clicks cannot enqueue duplicate drills. A new drill requires the old one to finish.
    if (state.drill && state.drill.phase !== 'COMPLETE') return this.report();
    if (state.drill && this.runtime.now() - Date.parse(state.notifications.find(n => n.id === `test-open:${state.drill!.id}`)?.createdAt || this.timestamp()) < 86_400_000) throw Error('A verification drill is limited to once per day.');
    state.drill = { id: this.runtime.uuid(), phase: 'ARMED' }; this.event(state, 'Two clearly labeled verification emails armed for separate real scheduled checks.'); await this.save(state); return this.report();
  }
  async scheduled(scheduledTime: number) {
    const state = await this.load();
    if (!state.settings.enabled || !Number.isFinite(scheduledTime) || scheduledTime <= (state.processedCron || 0)) return;
    if (scheduledTime > this.runtime.now() + minute || scheduledTime < Date.parse(state.enabledAt || '1970-01-01')) return;
    const previousCron = state.lastCronReceivedAt;
    state.processedCron = scheduledTime; state.lastCronAt = new Date(scheduledTime).toISOString(); state.lastCronReceivedAt = this.timestamp();
    // The reservation and watchdog survive a killed invocation. A replay cannot run a second check/send.
    await this.save(state); await this.storage.setAlarm(this.runtime.now() + 11 * minute);
    if (previousCron && this.runtime.now() - Date.parse(previousCron) > 11 * minute) this.event(state, `Cloud schedule gap since ${previousCron}; no uptime inferred.`);
    const due = !state.last || Date.parse(state.last.startedAt) < Date.parse(state.enabledAt || '1970-01-01') || scheduledTime - (state.lastCheckScheduledTime || 0) >= state.settings.intervalMinutes * minute;
    if (due || state.drill?.phase === 'ARMED' || state.drill?.phase === 'INCIDENT') {
      const startedAt = this.timestamp();
      let checks: HealthCheck[];
      try {
        checks = await this.runtime.health(this.effectiveTarget(state));
        if (!checks.length || !checks.some(c => c.name === 'https') || !checks.some(c => c.name === 'http')) throw Error('Incomplete health results');
      } catch { checks = [{ name: 'https', status: 'UNKNOWN', message: 'Cloud health checker failed before producing an observation.' }]; }
      const completed = checks.some(c => c.status !== 'UNKNOWN');
      this.reconcile(state, checks);
      this.reconcile(state, [{ name: 'schedule', status: completed ? 'PASS' : 'FAIL', message: completed ? 'Scheduled observation completed.' : 'Scheduled handler ran but health observations are missing.' }]);
      state.last = { id: this.runtime.uuid(), startedAt, finishedAt: this.timestamp(), simulated: false, status: healthStatus(checks), checks };
      state.lastCheckScheduledTime = scheduledTime;
      state.history.push(state.last);
      if (state.drill?.phase === 'ARMED' && completed) {
        this.queue(state, `test-open:${state.drill.id}`, 'TEST_INCIDENT', 'Delivery verification drill: simulated incident. The real scheduled health check ran; this is not a production outage.');
        state.drill.phase = 'INCIDENT'; state.drill.incidentAt = scheduledTime;
      } else if (state.drill?.phase === 'INCIDENT' && scheduledTime > state.drill.incidentAt! && completed) {
        this.queue(state, `test-close:${state.drill.id}`, 'TEST_RECOVERY', 'Delivery verification drill: simulated recovery. A second real scheduled health check ran; no production outage was introduced.');
        state.drill.phase = 'COMPLETE';
      }
    }
    await this.save(state); await this.deliver(state);
  }
  async watchdog() {
    const state = await this.load(); if (!state.settings.enabled) { await this.storage.deleteAlarm(); return; }
    const now = this.runtime.now();
    const missingCron = now - Date.parse(state.lastCronReceivedAt || state.enabledAt!) >= (state.lastCronReceivedAt ? 11 : 20) * minute;
    const missingCheck = state.last ? now - Date.parse(state.last.finishedAt) > (state.settings.intervalMinutes * 2 + 2) * minute : now - Date.parse(state.enabledAt!) >= 20 * minute;
    if (missingCron || missingCheck) this.reconcile(state, [{ name: 'schedule', status: 'FAIL', message: missingCron ? 'Scheduled triggers are missing or delayed; cloud coverage is unverified.' : 'Recent health observations are missing; cloud coverage is unverified.' }]);
    await this.save(state); await this.storage.setAlarm(now + 11 * minute); await this.deliver(state);
  }
  async deliver(state: CloudState) {
    if (!state.settings.enabled || !state.settings.notifications) return;
    const day = this.timestamp().slice(0, 10);
    if (state.emailBudget?.day !== day) state.emailBudget = { day, attempts: 0 };
    for (const notification of state.notifications) {
      if (notification.status === 'ATTEMPTED') { notification.status = 'UNKNOWN'; this.event(state, 'An interrupted email attempt has an unknown outcome and will not be resent.'); await this.save(state); }
      if (notification.status !== 'PENDING') continue;
      if (state.emailBudget!.attempts >= 20) { notification.status = 'SUPPRESSED'; this.event(state, 'Email safety cap reached (20 attempts per UTC day). Review incidents in the dashboard.'); await this.save(state); continue; }
      const receipt = `${this.runtime.uuid()}${this.runtime.uuid()}`.replaceAll('-', '');
      notification.receiptHash = await hashReceipt(receipt); notification.attemptedAt = this.timestamp(); notification.status = 'ATTEMPTED'; state.emailBudget!.attempts++;
      // At-most-once delivery attempt: persist before calling a provider without an idempotency contract.
      // Crash/timeout/rejection stays UNKNOWN; neither Cron replay nor alarms resend this message.
      await this.save(state);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([this.runtime.send({ from: this.target.sender, to: this.target.recipient, subject: notification.subject,
          text: `${notification.text}\n\nConfirm receipt (opens a page with a confirmation button):\n${this.target.origin}/receipt?token=${receipt}` }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Email timeout')), 15_000); })]);
        notification.status = 'ACCEPTED'; notification.acceptedAt = this.timestamp();
        if (result?.messageId) notification.messageId = result.messageId;
      } catch { notification.status = 'UNKNOWN'; this.event(state, 'Email was not confirmed accepted. No automatic resend; inspect provider and inbox.'); }
      finally { clearTimeout(timer); }
      await this.save(state);
    }
  }
  async confirm(receipt: string) {
    if (!/^[a-f0-9]{64}$/.test(receipt)) return false;
    const state = await this.load(); const hash = await hashReceipt(receipt);
    const notification = state.notifications.find(n => n.receiptHash === hash);
    if (!notification || !notification.attemptedAt || this.runtime.now() - Date.parse(notification.attemptedAt) > 7 * 86_400_000) return false;
    notification.status = 'CONFIRMED'; notification.confirmedAt ||= this.timestamp(); await this.save(state); return true;
  }
  async acknowledge(id: string) {
    const state = await this.load(); const incident = state.incidents.find(i => i.id === id); if (!incident) throw Error('Incident not found');
    incident.acknowledgedAt ||= this.timestamp(); await this.save(state); return this.report();
  }
  async report() {
    const state = await this.load(); const now = this.runtime.now();
    const stale = !state.last || now - Date.parse(state.last.finishedAt) > (state.settings.intervalMinutes * 2 + 2) * minute;
    const scheduleMissing = !state.lastCronReceivedAt || now - Date.parse(state.lastCronReceivedAt) > 11 * minute;
    const drillMessages = state.drill ? state.notifications.filter(n => n.id === `test-open:${state.drill!.id}` || n.id === `test-close:${state.drill!.id}`) : [];
    const notificationVerified = state.drill?.phase === 'COMPLETE' && drillMessages.length === 2 && drillMessages.every(n => n.status === 'CONFIRMED');
    return { ...state, notifications: state.notifications.map(({ receiptHash: _secret, ...n }) => n), target: this.effectiveTarget(state), fetchedAt: this.timestamp(), stale, scheduleMissing,
      verification: { scheduledCheck: !!state.lastCronAt && !!state.last, notificationVerified, operational: state.settings.enabled && !stale && !scheduleMissing && state.last?.status !== 'UNKNOWN' && notificationVerified },
      limitations: 'Cloud HTTPS checks use Cloudflare transport; certificate expiry remains a local check. Shared-platform failure can interrupt Cron, the watchdog and email together. Email acceptance is not delivery; receipt confirmation verifies the drill. No uptime guarantee.' };
  }
}
