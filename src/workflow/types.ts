export const stepNames = ['discover', 'connect', 'domain', 'prepare', 'preview', 'binding', 'incoming', 'outgoing', 'seo', 'analytics', 'verify'] as const;
export type StepName = typeof stepNames[number];
export type StepStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'WAITING_USER' | 'WAITING_PROVIDER' | 'VERIFIED' | 'SKIPPED' | 'FAILED' | 'NEEDS_RECONCILIATION';
export type Evidence = Record<string, unknown>;
export interface LaunchConfig {
  appPath: string; domain: string; accountId: string; inbox: string;
  mode: 'mock' | 'live'; outbound: boolean; www: boolean;
  seo: { approved: boolean; title: string; description: string };
  // Legacy isolated-mode fields retained for saved journals; live launches now
  // configure automatic Cloudflare Web Analytics after custom-domain binding.
  analytics: { approved: boolean; publicPaths: string[] };
}
export interface Step { status: StepStatus; evidence?: Evidence; message?: string; attempts: number; updatedAt?: string }
export interface Approval {
  id: string; kind: 'purchase' | 'dns' | 'deployment'; details: Evidence;
  decision?: 'approved' | 'denied'; createdAt: string; decidedAt?: string;
}
export interface Run {
  schema: 1; id: string; config: LaunchConfig; createdAt: string; updatedAt: string;
  approvalRevision?: number;
  status: 'RUNNING' | 'LIVE_VERIFIED' | 'LIVE_PARTIALLY_CONFIGURED' | 'BLOCKED' | 'FAILED';
  steps: Record<StepName, Step>; approvals: Approval[];
  resources: Record<string, any>;
  operations: Record<string, { status: 'INTENT' | 'OBSERVED' | 'REJECTED'; before?: unknown; result?: unknown; at: string }>;
  events: { at: string; step: StepName; message: string }[];
  report?: Evidence;
}
export class Pause extends Error {
  status: StepStatus;
  evidence: Evidence;
  constructor(status: StepStatus, message: string, evidence: Evidence = {}) { super(message); this.status = status; this.evidence = evidence; }
}
export interface Context {
  run: Run;
  save(): Promise<void>;
  approve(kind: Approval['kind'], details: Evidence): Promise<void>;
  effect<T>(key: string, before: unknown, action: () => Promise<T>): Promise<T>;
}
export interface Provider {
  step(name: StepName, ctx: Context): Promise<Evidence | 'SKIPPED'>;
}
