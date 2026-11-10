import { CloudMonitor } from './engine.ts';
import { cloudHealth } from './health.ts';
import type { CloudTarget, CloudStorage, CloudRuntime } from './types.ts';

interface Env {
  TARGET: string; ADMIN_TOKEN?: string; MONITOR_BUILD: string; LAUNCHKIT_BUSINESS: string;
  MONITOR: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  EMAIL: { send: CloudRuntime['send'] };
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
function target(env: Env): CloudTarget {
  const t = JSON.parse(env.TARGET) as CloudTarget;
  if (!/^[a-f0-9]{24}$/.test(t.runId) || t.runId !== env.LAUNCHKIT_BUSINESS || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(t.domain) || !/^[a-f0-9]{64}$/.test(t.release) || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(t.recipient) || t.sender !== `monitor@${t.domain}` || !/^https:\/\/lk-monitor-[a-f0-9]{24}\.[a-z0-9-]+\.workers\.dev$/.test(t.origin)) throw Error('Invalid authorized monitoring target');
  return t;
}
async function authorized(request: Request, env: Env) {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) return false;
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.headers.get('Authorization') || '')));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`Bearer ${env.ADMIN_TOKEN}`)));
  let difference = 0; for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i]; return difference === 0;
}
export default {
  async fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    if (path !== '/receipt' && !await authorized(request, env)) return json({ error: 'Unauthorized' }, 401);
    if (!['/status', '/config', '/verification', '/acknowledge', '/release', '/receipt'].includes(path)) return json({ error: 'Not found' }, 404);
    const t = target(env); return env.MONITOR.get(env.MONITOR.idFromName(t.runId)).fetch(request);
  },
  async scheduled(controller: { scheduledTime: number; cron: string }, env: Env) {
    if (controller.cron !== '*/5 * * * *') throw Error('Unexpected monitor schedule');
    const t = target(env);
    const result = await env.MONITOR.get(env.MONITOR.idFromName(t.runId)).fetch(new Request('https://internal/cron', { method: 'POST', body: JSON.stringify({ scheduledTime: controller.scheduledTime }) }));
    if (!result.ok) throw Error('Scheduled monitoring failed; inspect persisted status and watchdog.');
  }
};
export class MonitorState {
  monitor: CloudMonitor; env: Env; tail: Promise<unknown> = Promise.resolve();
  constructor(state: { storage: CloudStorage }, env: Env) {
    this.env = env;
    this.monitor = new CloudMonitor(state.storage, target(env), { now: Date.now, uuid: () => crypto.randomUUID(), health: cloudHealth, send: message => env.EMAIL.send(message) });
  }
  serialize<T>(action: () => Promise<T>): Promise<T> { const next = this.tail.then(action); this.tail = next.catch(() => {}); return next; }
  alarm() { return this.serialize(() => this.monitor.watchdog()); }
  fetch(request: Request) { return this.serialize(async () => {
    try {
      const url = new URL(request.url); const path = url.pathname;
      if (path === '/receipt') {
        const receipt = url.searchParams.get('token') || '';
        if (!/^[a-f0-9]{64}$/.test(receipt)) return json({ error: 'Invalid receipt' }, 400);
        if (request.method === 'POST') return new Response(await this.monitor.confirm(receipt) ? 'Receipt confirmed. You can close this page.' : 'Receipt missing or expired.', { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
        if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
        // Mail scanners may GET the link. Only the user's explicit form POST confirms receipt.
        return new Response('<!doctype html><html><meta name="viewport" content="width=device-width"><title>LaunchKit receipt</title><h1>Confirm notification delivery</h1><p>Confirm that you received this LaunchKit monitoring email.</p><form method="post"><button>Confirm receipt</button></form></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'" } });
      }
      if (path === '/status' && request.method === 'GET') return json({ ...await this.monitor.report(), build: this.env.MONITOR_BUILD });
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const raw = await request.text(); if (raw.length > 4096) return json({ error: 'Request too large' }, 413); const body = JSON.parse(raw || '{}');
      if (path === '/cron' && url.hostname === 'internal') { await this.monitor.scheduled(body.scheduledTime); return json({ ok: true }); }
      if (path === '/config') return json(await this.monitor.configure(body));
      if (path === '/release') return json(await this.monitor.reconcileRelease(body));
      if (path === '/verification') return json(await this.monitor.armVerification());
      if (path === '/acknowledge') return json(await this.monitor.acknowledge(body.incidentId));
      return json({ error: 'Not found' }, 404);
    } catch { return json({ error: 'Cloud monitoring operation failed. Check configuration and persisted observations.' }, 500); }
  }); }
}
