import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Journal } from '../src/workflow/journal.ts';
import { BusinessSelection } from '../src/ui/selection.ts';
import type { Run } from '../src/workflow/types.ts';

async function fixture() {
  const journal = new Journal(await mkdtemp(join(tmpdir(), 'launchkit-selection-')));
  const config = { appPath: journal.dir, domain: 'example.test', accountId: 'a'.repeat(32), mode: 'live' as const, inbox: '', outbound: false, www: false, seo: { approved: true, title: '', description: '' }, analytics: { approved: false, publicPaths: ['/'] } };
  const production = await journal.create(config); production.resources.url = 'https://example.test'; production.status = 'LIVE_VERIFIED'; await journal.save(production);
  const draft = await journal.create({ ...config, accountId: '' }); draft.status = 'BLOCKED'; await journal.save(draft);
  return { journal, production, draft, selection: new BusinessSelection(journal) };
}

test('Default selection prefers verified production to newer drafts regardless of filename order', async () => {
  const { journal, production, draft, selection } = await fixture();
  const before = await Promise.all([production, draft].map(r => readFile(journal.path(r.id), 'utf8')));
  assert.equal((await selection.current([production, draft]))?.id, production.id);
  assert.equal((await selection.current([draft, production]))?.id, production.id);
  assert.deepEqual(await Promise.all([production, draft].map(r => readFile(journal.path(r.id), 'utf8'))), before);
  assert.equal((await journal.list()).length, 2);
  await selection.restore();
  const newer = { ...production, id: 'a'.repeat(24), updatedAt: '2099-01-01T00:00:00Z' };
  assert.equal((await selection.current([production, newer, draft]))?.id, production.id);
});

test('Explicit selection survives new instances, remembers last production, and keeps drafts accessible', async () => {
  const { journal, production, draft, selection } = await fixture();
  const second = await journal.create({ ...production.config, domain: 'other.test' }); second.resources.url = 'https://other.test'; second.status = 'LIVE_VERIFIED'; await journal.save(second);
  await selection.select(production.id);
  assert.equal((await new BusinessSelection(new Journal(journal.dir)).current())?.id, production.id);
  await selection.select(draft.id); assert.equal((await new BusinessSelection(journal).current())?.id, draft.id);
  assert.equal((await selection.load()).lastProductionRunId, production.id);
  await writeFile(join(journal.dir, 'ui.json'), JSON.stringify({ selectedRunId: 'missing', lastProductionRunId: production.id }));
  assert.equal((await selection.current())?.id, production.id);
  await assert.rejects(selection.select('../outside'), /Invalid run ID/);
});

test('Supersession, missing/corrupt preferences and empty repositories recover without launching', async () => {
  const { journal, production, draft, selection } = await fixture(); await selection.select(draft.id);
  draft.resources.supersededBy = production.id; await journal.save(draft);
  assert.equal((await selection.current())?.id, production.id); await assert.rejects(selection.select(draft.id), /replaced/);
  await writeFile(join(journal.dir, 'ui.json'), '{unfinished'); assert.equal((await selection.current())?.id, production.id);
  assert.equal(await selection.current([]), undefined);
  const loop = structuredClone(production); loop.resources.supersededBy = loop.id;
  assert.equal(await selection.current([loop]), undefined);
  const noVerified: Run = { ...production, status: 'BLOCKED' }; assert.equal((await selection.current([noVerified, { ...draft, resources: {} }]))?.id, production.id);
});
