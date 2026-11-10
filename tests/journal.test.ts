import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJSON } from '../src/workflow/journal.ts';

test('atomic journal replacement retries a transient Windows lock using the same complete snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launchkit-atomic-')); const path = join(dir, 'state.json');
  await atomicJSON(path, { revision: 1 }); let attempts = 0; let temp: string | undefined;
  await atomicJSON(path, { revision: 2 }, async (source, target) => {
    attempts++; if (!temp) temp = String(source); assert.equal(String(source), temp); assert.equal(String(target), path);
    assert.deepEqual(JSON.parse(await readFile(String(source), 'utf8')), { revision: 2 }); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { revision: 1 });
    if (process.platform === 'win32' && attempts < 3) throw Object.assign(Error('Temporary sharing violation'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' });
    await rename(source, target);
  });
  assert.equal(attempts, process.platform === 'win32' ? 3 : 1); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { revision: 2 });
});

test('atomic journal replacement is bounded and preserves the prior file on persistent or nontransient failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launchkit-atomic-fail-')); const path = join(dir, 'state.json'); await atomicJSON(path, { revision: 1 });
  for (const code of ['EACCES', 'ENOSPC']) {
    let attempts = 0;
    await assert.rejects(atomicJSON(path, { revision: 2 }, async () => { attempts++; throw Object.assign(Error('Replacement failed'), { code }); }), /Replacement failed/);
    assert.equal(attempts, process.platform === 'win32' && code === 'EACCES' ? 6 : 1);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { revision: 1 });
  }
});
