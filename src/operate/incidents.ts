import type { CheckName, HealthCheck, Incident, Observation } from './types.ts';

const guidance: Record<CheckName, string> = {
  dns: 'Recheck after connectivity or DNS propagation recovers. If it persists, inspect launch configuration; DNS replacements still require approval.',
  https: 'Recheck after a transient network or edge failure. Persistent TLS failures require certificate or provider review; validation is never bypassed.',
  certificate: 'Cloudflare normally renews managed certificates. Recheck renewal, then review certificate status with the provider if expiry remains near.',
  http: 'Recheck for transient outages. Inspect launch configuration for a persistent failure; a changed application is rebuilt and deployment approval may be required.',
  release: 'Confirm whether someone deployed outside LaunchKit. Inspect launch configuration before changing production. Unknown deployment outcomes require reconciliation.',
  headers: 'Inspect launch configuration and the approved application policy before changing security or indexing headers.',
  schedule: 'Cloud observations are missing or delayed. Inspect the monitor schedule, Cloudflare availability and account limits. No uptime is inferred for the gap.'
};
export function healthStatus(checks: HealthCheck[]): Observation['status'] {
  return checks.some(c => ['dns', 'https', 'http'].includes(c.name) && c.status === 'FAIL') ? 'DOWN' : checks.some(c => ['FAIL', 'WARN'].includes(c.status)) ? 'DEGRADED' : checks.some(c => c.status === 'UNKNOWN') ? 'UNKNOWN' : 'HEALTHY';
}
export function reconcileIncidents(incidents: Incident[], checks: HealthCheck[], at: string, uuid: () => string) {
  const transitions: { kind: 'OPENED' | 'RESOLVED'; incident: Incident }[] = [];
  for (const check of checks) {
    const open = incidents.find(i => i.check === check.name && !i.resolvedAt);
    if (check.status === 'PASS' && open) { open.resolvedAt = at; transitions.push({ kind: 'RESOLVED', incident: open }); }
    if (check.status !== 'FAIL' && check.status !== 'WARN') continue;
    if (open) {
      if (open.severity !== check.status) open.acknowledgedAt = undefined;
      open.severity = check.status; open.message = check.message; open.lastSeenAt = at; open.occurrences++;
    } else {
      const incident: Incident = { id: uuid(), check: check.name, severity: check.status, message: check.message, openedAt: at, lastSeenAt: at, occurrences: 1, guidance: guidance[check.name] };
      incidents.push(incident); transitions.push({ kind: 'OPENED', incident });
    }
  }
  return transitions;
}
