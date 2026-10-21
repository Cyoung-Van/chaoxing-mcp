import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/core/state.mjs';
import { selectTasks, summaryCoverage } from '../src/core/query.mjs';

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'chaoxing-state-test-'));
  try { await run(new StateStore(directory), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('fresh state has defaults and no invented snapshot', async () => withStore(async store => {
  assert.equal((await store.settings()).delayMs, 1500);
  await assert.rejects(store.snapshot(), e => e.code === 'NO_DATA');
}));

test('snapshot replacement preserves the prior report and private permissions', async () => withStore(async (store, dir) => {
  const first = { schemaVersion: 1, tasks: [{ id: 'a' }] };
  const second = { schemaVersion: 1, tasks: [{ id: 'b' }] };
  await store.commit(first); await store.commit(second);
  assert.deepEqual(await store.snapshot(), second);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'previous.json'), 'utf8')), first);
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'snapshot.json'))).mode & 0o777, 0o600);
}));

test('settings reject invalid delay without overwriting existing values', async () => withStore(async store => {
  await store.settings({ ignoreCourses: ['course:class'], delayMs: 2000 });
  await assert.rejects(store.settings({ delayMs: -1 }), e => e.code === 'INVALID_INPUT');
  assert.equal((await store.settings()).delayMs, 2000);
  assert.deepEqual((await store.settings()).ignoreCourses, ['course:class']);
}));

test('exclusive synchronization refuses overlap and releases on errors', async () => withStore(async store => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const first = store.exclusive(async () => { entered(); await gate; throw new Error('controlled'); });
  await started;
  await assert.rejects(store.exclusive(async () => {}), e => e.code === 'BUSY');
  release(); await assert.rejects(first, /controlled/);
  assert.equal(await store.exclusive(async () => 7), 7);
}));

const snapshot = {
  finishedAt: '2025-01-01T00:00:00.000Z', scope: { course: 'Fixture' },
  tasks: [
    { id: '1', kind: 'assignment', title: 'One', courseId: 'c', classId: 'k', courseName: 'Fixture', status: 'pending', deadline: { iso: '2025-01-02T00:00:00Z' } },
    { id: '2', kind: 'exam', title: 'Two', courseId: 'c', classId: 'k', courseName: 'Fixture', status: 'unknown', deadline: { iso: null } },
    { id: '3', kind: 'activity', title: 'Three', courseId: 'c', classId: 'k', courseName: 'Fixture', status: 'ended', deadline: { iso: null } },
    { id: '4', kind: 'assignment', title: 'Four', courseId: 'd', classId: 'l', courseName: 'Another', status: 'submitted', deadline: { iso: null } }
  ], coverage: { complete: false, checks: [{ source: 'one', status: 'ok' }, { source: 'two', status: 'failed', error: { code: 'NOT_AVAILABLE' } }] }
};

test('todo includes unknown but excludes submitted and ended; paging is explicit', () => {
  const page = selectTasks(snapshot, { status: 'todo', limit: 1 }, {});
  assert.equal(page.total, 2); assert.equal(page.items[0].id, '1'); assert.equal(page.nextOffset, 1);
  assert.equal(page.stale, true); assert.deepEqual(page.scope, snapshot.scope);
});
test('ignore settings and deadlines do not silently erase the uncertainty count', () => {
  const result = selectTasks(snapshot, { status: 'todo', dueHours: 48, now: Date.parse('2025-01-01T00:00:00Z') }, {});
  assert.equal(result.total, 1); assert.equal(result.unknownDeadlineCount, 1);
  assert.equal(selectTasks(snapshot, {}, { ignoreCourses: ['c:k'] }).total, 1);
});
test('invalid filters are reported rather than producing an empty answer', () => {
  for (const args of [{ status: 'wrong' }, { kind: 'wrong' }, { offset: -1 }, { limit: 0 }])
    assert.throws(() => selectTasks(snapshot, args, {}), e => e.code === 'INVALID_INPUT');
});
test('coverage summaries preserve failed checks', () => {
  const result = summaryCoverage(snapshot.coverage);
  assert.equal(result.failedCount, 1); assert.equal(result.checkCount, 2);
  assert.equal(result.complete, false); assert.equal(result.failures[0].source, 'two');
});
