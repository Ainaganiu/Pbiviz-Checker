import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// counters.js picks its backend at import time, so the temp directory has to be
// in place before the dynamic import below. No TURSO_DATABASE_URL here, so this
// exercises the local-file path — the same libSQL code as the hosted one.
const dir = mkdtempSync(join(tmpdir(), 'pbiviz-counters-'));
process.env.DATA_DIR = dir;

const { recordCheck, readStats, storeMode, storeHealth, closeStore } =
  await import('../src/stats/counters.js');

test.after(() => {
  closeStore();
  // Best-effort: Windows can hold the .db handle briefly after close, and a temp
  // directory left behind is not a test failure.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch { /* the OS will reclaim it */ }
});

test('falls back to a local file when no Turso URL is configured', async () => {
  assert.equal(storeMode, 'local-file');
  assert.deepEqual(await storeHealth(), { mode: 'local-file', ok: true });
});

test('an empty store returns a full, zeroed series', async () => {
  const stats = await readStats(30);
  assert.equal(stats.series.length, 30);
  assert.equal(stats.window.uploads, 0);
  assert.equal(stats.persistent, false, 'a local file must not claim to be persistent');
});

test('counters accumulate into the current day bucket', async () => {
  await recordCheck(2);
  await recordCheck(1);

  const stats = await readStats(30);
  assert.equal(stats.today.uploads, 2);
  assert.equal(stats.today.recommendations, 3);
  assert.equal(stats.window.uploads, 2);
  assert.equal(stats.series.at(-1).day, new Date().toISOString().slice(0, 10));
});

test('the requested window size is honoured', async () => {
  const stats = await readStats(7);
  assert.equal(stats.series.length, 7);
  assert.equal(stats.windowDays, 7);
});

test('recordCheck writes both counters in a single statement', async () => {
  const before = (await readStats(30)).today;
  await recordCheck(2);
  const after = (await readStats(30)).today;
  assert.equal(after.uploads, before.uploads + 1);
  assert.equal(after.recommendations, before.recommendations + 2);
});

test('recordCheck still counts the upload when no fixes were shown', async () => {
  const before = (await readStats(30)).today;
  await recordCheck(0);
  const after = (await readStats(30)).today;
  assert.equal(after.uploads, before.uploads + 1);
  assert.equal(after.recommendations, before.recommendations);
});
