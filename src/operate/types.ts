import type { Evidence, Run } from '../workflow/types.ts';

export type CheckName = 'dns' | 'https' | 'certificate' | 'http' | 'release' | 'headers' | 'schedule';
export interface HealthCheck {
  name: CheckName; status: 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN'; message: string; evidence?: Evidence;
}
export interface Observation {
  id: string; startedAt: string; finishedAt: string; simulated: boolean;
  status: 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN'; checks: HealthCheck[];
}
export interface Incident {
  id: string; check: CheckName; severity: 'WARN' | 'FAIL'; message: string;
  openedAt: string; lastSeenAt: string; occurrences: number; resolvedAt?: string; acknowledgedAt?: string;
  guidance: string;
}
export interface Usage {
  status: 'AVAILABLE' | 'UNAVAILABLE' | 'DISABLED'; simulated: boolean;
  checkedAt: string; from: string; to: string; requests?: number; errors?: number; message: string;
}
export interface OperateState {
  schema: 1; runId: string;
  settings: { enabled: boolean; intervalMinutes: number; usageEnabled: boolean };
  nextCheckAt?: string; nextUsageAt?: string; last?: Observation; history: Observation[];
  incidents: Incident[]; usage?: Usage;
  events: { at: string; kind: 'ENABLED' | 'PAUSED' | 'SETTINGS' | 'OPENED' | 'RESOLVED' | 'ACKNOWLEDGED' | 'GAP' | 'RECOVERY'; message: string }[];
}
export interface OperatorProvider {
  health(run: Run): Promise<HealthCheck[]>;
  usage(run: Run, now: Date): Promise<Usage>;
}
