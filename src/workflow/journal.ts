import { mkdir, readFile, writeFile, rename, readdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { clean } from '../security/redaction.ts';
import { stepNames, type LaunchConfig, type Run } from './types.ts';
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const defaultDataDir = () => join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'LaunchKit');
export async function atomicJSON(path: string, value: unknown, replace = rename) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(clean(value), null, 2)); await handle.sync(); } finally { await handle.close(); }
  // A concurrent reader or scanner can briefly lock the destination on Windows.
  // Retry only replacement of the same already-fsynced snapshot, never a caller's
  // provider action. Do not delete the destination or fall back to partial writes.
  for (let attempt = 0; ; attempt++) {
    try { await replace(temp, path); break; }
    catch (error: any) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
      await delay(25 * 2 ** attempt);
    }
  }
}
export class Journal {
  dir: string;
  constructor(dir = defaultDataDir()) { this.dir = resolve(dir); }
  async init() { await mkdir(join(this.dir, 'runs'), { recursive: true, mode: 0o700 }); }
  path(id: string) { if (!/^[a-f0-9]{24}$/.test(id)) throw Error('Invalid run ID'); return join(this.dir, 'runs', `${id}.json`); }
  async load(id: string): Promise<Run> {
    const run = JSON.parse(await readFile(this.path(id), 'utf8'));
    if (run.schema !== 1) throw Error('Unsupported journal schema');
    return run;
  }
  async save(run: Run) { run.updatedAt = new Date().toISOString(); await atomicJSON(this.path(run.id), run); }
  async list() { await this.init(); return Promise.all((await readdir(join(this.dir, 'runs'))).filter(x => /^[a-f0-9]{24}\.json$/.test(x)).map(x => this.load(x.slice(0, -5)))); }
  async create(config: LaunchConfig): Promise<Run> {
    await this.init();
    const id = digest([resolve(config.appPath), config.accountId, config.domain, config.mode]).slice(0, 24);
    try {
      const prior = await this.load(id);
      if (digest(prior.config) !== digest(config)) {
        prior.approvalRevision = (prior.approvalRevision || 0) + 1;
        prior.config = config;
        prior.steps = Object.fromEntries(stepNames.map(name => [name, { status: 'NOT_STARTED', attempts: 0 }])) as Run['steps'];
        prior.report = undefined; prior.status = 'RUNNING';
        await this.save(prior);
      }
      return prior;
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const now = new Date().toISOString();
    const run: Run = { schema: 1, id, config, createdAt: now, updatedAt: now, status: 'RUNNING',
      steps: Object.fromEntries(stepNames.map(name => [name, { status: 'NOT_STARTED', attempts: 0 }])) as Run['steps'],
      approvals: [], resources: {}, operations: {}, events: [] };
    await this.save(run); return run;
  }
  async lock(): Promise<() => Promise<void>> {
    await this.init(); const path = join(this.dir, 'operator.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const handle = await open(path, 'wx', 0o600); await handle.writeFile(String(process.pid)); await handle.close(); return async () => { await unlink(path); }; }
      catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        const pid = Number(await readFile(path, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Invalid operator lock; inspect the state directory.');
        try { process.kill(pid, 0); throw Error('Another LaunchKit operator is using this state directory.'); }
        catch (e: any) { if (e.code !== 'ESRCH') throw e; await unlink(path); }
      }
    }
    throw Error('Cannot acquire operator lock');
  }
}
