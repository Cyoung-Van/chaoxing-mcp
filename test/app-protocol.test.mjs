import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StateStore } from '../src/core/state.mjs';
import { createApp } from '../src/core/app.mjs';

test('background refresh is observable, blocks overlap, and commits before its terminal state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chaoxing-job-'));
  let connections = 0, closed = 0;
  const factory = () => ({
    requestCount: 0,
    async connect() { connections++; return this; },
    async read(url) {
      this.requestCount++;
      return { status: 200, url, text: url.includes('backclazzdata')
        ? JSON.stringify({ channelList: [{ cpi: 'context', content: { id: 'class-one', course: { data: [{ id: 'course-one', name: 'Synthetic course' }] } } }] })
        : '<html><body><p>暂无作业</p></body></html>' };
    },
    async close() { closed++; }
  });
  const store = new StateStore(dir), app = createApp({ store, sessionFactory: factory });
  try {
    const started = app.refresh({ sections: ['assignments'] });
    assert.equal(started.status, 'running');
    assert.throws(() => app.refresh({ sections: ['assignments'] }), e => e.code === 'BUSY');
    let job;
    for (let i = 0; i < 200; i++) {
      job = app.job(started.jobId);
      if (job.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(job.status, 'completed', JSON.stringify(job));
    assert.equal((await store.snapshot()).courses.length, 1);
    assert.equal(connections, 1); assert.equal(closed, 1);
    assert.equal('controller' in job, false);
  } finally { app.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('stdio MCP exposes nine tools and paginated cache results without a browser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chaoxing-protocol-'));
  const snapshot = { schemaVersion: 1, finishedAt: '2020-01-01T00:00:00Z', scope: { sections: ['assignments'] }, courses: [], progress: [],
    coverage: { complete: false, checks: [{ source: 'fixture', status: 'failed', error: { code: 'NOT_AVAILABLE' } }] },
    tasks: Array.from({ length: 3 }, (_, i) => ({ id: `fixture-${i}`, kind: 'assignment', title: `Synthetic item ${i}`, status: 'pending', courseId: 'c', classId: 'k', courseName: 'Example', deadline: { iso: null } })) };
  await writeFile(join(dir, 'snapshot.json'), JSON.stringify(snapshot));
  const client = new Client({ name: 'protocol-test', version: '1.0.0' });
  const env = { PATH: process.env.PATH, CHAOXING_DATA_DIR: dir, CHAOXING_CDP_URL: 'http://127.0.0.1:1' };
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url))], env, stderr: 'pipe' }));
    assert.equal((await client.listTools()).tools.length, 9);
    const reply = await client.callTool({ name: 'chaoxing_tasks', arguments: { status: 'todo', limit: 2 } });
    const result = JSON.parse(reply.content[0].text);
    assert.equal(result.ok, true); assert.equal(result.data.total, 3); assert.equal(result.data.items.length, 2);
    assert.equal(result.data.nextOffset, 2); assert.equal(result.data.stale, true);
    const coverage = await client.callTool({ name: 'chaoxing_coverage', arguments: {} });
    assert.equal(JSON.parse(coverage.content[0].text).data.total, 1);
    const invalid = await client.callTool({ name: 'chaoxing_tasks', arguments: { status: 'invented' } });
    assert.equal(invalid.isError, true);
    const command = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'tasks', '--status', 'invented'], { env, encoding: 'utf8' });
    assert.equal(command.status, 1); assert.equal(JSON.parse(command.stdout).error.code, 'INVALID_INPUT');
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});

test('CLI refuses stray positional arguments before any live operation', () => {
  const entry = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  for (const args of [['help', 'unexpected'], ['sync', 'Example course']]) {
    const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, CHAOXING_CDP_URL: 'http://127.0.0.1:1' } });
    assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_INPUT');
  }
});

test('live commands cannot overlap and course fallback retains its catalog context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chaoxing-live-lock-'));
  const store = new StateStore(dir);
  let entered, release, opened;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const app = createApp({ store, sessionFactory: () => ({
    async connect() { return this; }, async close() {},
    async read(url) { entered(); await gate; return { url, status: 200, text: JSON.stringify({ channelList: [] }) }; },
    async openTask(url) { opened = new URL(url); return { status: 200 }; }
  }) });
  try {
    const first = app.doctor(); await enteredPromise;
    const second = app.courses();
    const result = await Promise.race([second.then(() => 'overlap', error => error.code), new Promise(resolve => setTimeout(() => resolve('blocked-without-error'), 100))]);
    release(); await first; await second.catch(() => {});
    assert.equal(result, 'BUSY');
    await store.commit({ schemaVersion: 1, courses: [{ id: 'c', classId: 'k', contextId: 'context' }], tasks: [{ id: 'task', courseId: 'c', classId: 'k', url: null }] });
    await app.openTask('task');
    assert.equal(opened.searchParams.get('cpi'), 'context');
  } finally { release(); await rm(dir, { recursive: true, force: true }); }
});
