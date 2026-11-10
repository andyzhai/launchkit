import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, Journal } from '../workflow/journal.ts';
import type { Run } from '../workflow/types.ts';
import { eligible } from '../operate/operator.ts';

interface Selection { selectedRunId?: string; lastProductionRunId?: string; selectedAt?: string }
const production = (run: Run) => run.config.mode === 'live' && eligible(run);
// UI preferences never change launch configuration, provider identity or journals.
export class BusinessSelection {
  journal: Journal;
  constructor(journal: Journal) { this.journal = journal; }
  async load(): Promise<Selection> {
    try { const value = JSON.parse(await readFile(join(this.journal.dir, 'ui.json'), 'utf8')); return value && typeof value === 'object' ? value : {}; }
    catch (e: any) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return {}; throw e; }
  }
  async current(runs?: Run[]) {
    const available = runs || await this.journal.list();
    const saved = await this.load();
    // Follow M1's existing supersession link, without creating or migrating a run.
    const resolve = (id?: string) => {
      const visited = new Set<string>();
      while (id && !visited.has(id)) {
        visited.add(id); const run = available.find(r => r.id === id); if (!run) return;
        if (!run.resources.supersededBy) return run;
        id = run.resources.supersededBy;
      }
    };
    const explicit = resolve(saved.selectedRunId);
    if (explicit) return explicit; // Deliberately selected drafts remain accessible after reopening.
    const recentProduction = resolve(saved.lastProductionRunId);
    if (recentProduction && production(recentProduction)) return recentProduction;
    const candidates = available.filter(r => !r.resources.supersededBy);
    const rank = (run: Run) => production(run) ? (run.status === 'LIVE_VERIFIED' ? 3 : 2) : eligible(run) ? 1 : 0;
    return candidates.sort((a, b) => rank(b) - rank(a) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))[0];
  }
  async select(id: string) {
    const run = await this.journal.load(id);
    if (run.resources.supersededBy) throw Error('This business was replaced. Select its current saved entry.');
    const saved = await this.load();
    await atomicJSON(join(this.journal.dir, 'ui.json'), { selectedRunId: id, lastProductionRunId: production(run) ? id : saved.lastProductionRunId, selectedAt: new Date().toISOString() });
    return { selectedRunId: id };
  }
  async restore() {
    const run = await this.current();
    // Persist the initial fallback once, so background journal updates cannot
    // later change which business the operator has been using.
    if (run && (await this.load()).selectedRunId !== run.id) await this.select(run.id);
  }
}
