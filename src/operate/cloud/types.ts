import type { HealthCheck, Incident, Observation } from '../types.ts';
export interface CloudTarget { runId: string; domain: string; release: string; recipient: string; sender: string; origin: string }
export interface CloudSettings { enabled: boolean; intervalMinutes: number; notifications: boolean }
export interface Notification {
  id: string; kind: 'INCIDENT' | 'RECOVERY' | 'TEST_INCIDENT' | 'TEST_RECOVERY'; subject: string; text: string;
  createdAt: string; status: 'PENDING' | 'ATTEMPTED' | 'ACCEPTED' | 'UNKNOWN' | 'CONFIRMED' | 'SUPPRESSED' | 'CANCELLED';
  attemptedAt?: string; acceptedAt?: string; confirmedAt?: string; messageId?: string; receiptHash?: string;
}
export interface CloudState {
  releaseOverride?: { base: string; release: string };
  schema: 1; settings: CloudSettings; enabledAt?: string; lastCronAt?: string; lastCronReceivedAt?: string;
  processedCron?: number; lastCheckScheduledTime?: number; last?: Observation; history: Observation[]; incidents: Incident[]; notifications: Notification[];
  events: { at: string; message: string }[]; drill?: { id: string; phase: 'ARMED' | 'INCIDENT' | 'COMPLETE'; incidentAt?: number };
  emailBudget?: { day: string; attempts: number };
}
export interface CloudStorage {
  get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void>;
  setAlarm(at: number): Promise<void>; deleteAlarm(): Promise<void>;
}
export interface CloudRuntime {
  now(): number; uuid(): string;
  health(target: CloudTarget): Promise<HealthCheck[]>;
  send(message: { from: string; to: string; subject: string; text: string }): Promise<{ messageId?: string } | void>;
}
export const validSettings = (value: any): value is CloudSettings => value && typeof value.enabled === 'boolean' && typeof value.notifications === 'boolean' && [5, 15, 30, 60].includes(value.intervalMinutes);
export const cloudDefaults = (): CloudState => ({ schema: 1, settings: { enabled: false, intervalMinutes: 5, notifications: false }, history: [], incidents: [], notifications: [], events: [] });
