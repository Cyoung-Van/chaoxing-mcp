import { randomUUID } from 'node:crypto';
import { StateStore } from './state.mjs';
import { ClientFault, describeError } from './errors.mjs';
import { page, freshness, selectTasks, summaryCoverage } from './query.mjs';
import { ChromeSession } from '../cdp/session.mjs';
import { fetchCourses, collectSnapshot } from '../adapters/collect.mjs';

export function createApp({ store = new StateStore(), sessionFactory = (settings, signal) => new ChromeSession({ intervalMs: settings.delayMs, signal }) } = {}) {
  const jobs = new Map();
  let activeJob = null;
  let lastConnectionEnd = 0;
  async function connected(action, signal) {
    const settings = await store.settings();
    const remaining = settings.delayMs - (Date.now() - lastConnectionEnd);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    if (signal?.aborted) throw new ClientFault('CANCELLED', 'Operation cancelled');
    const session = sessionFactory(settings, signal);
    try { await session.connect(); return await action(session, settings); }
    finally { try { await session.close(); } finally { lastConnectionEnd = Date.now(); } }
  }
  async function synchronize(input = {}, events = {}) {
    return store.exclusive(() => connected(async (session, settings) => {
      const report = await collectSnapshot(session, { ...input, ignoreCourses: settings.ignoreCourses, signal: events.signal,
        onStatus: events.onStatus,
        onCheckpoint: value => store.write('checkpoint', value) });
      await store.commit(report);
      return report;
    }, events.signal));
  }
  function live(action) {
    if (activeJob) throw new ClientFault('BUSY', 'A synchronization is active; cached queries remain available');
    return store.exclusive(() => connected(action));
  }
  const api = {
    async doctor() {
      return live(async session => {
        const courses = await fetchCourses(session);
        return { cdp: 'connected', authentication: courses.length ? 'verified-by-course-response' : 'no-courses-returned', courseCount: courses.length };
      });
    },
    async courses() { return live(async session => ({ fetchedAt: new Date().toISOString(), items: await fetchCourses(session) })); },
    sync: synchronize,
    async tasks(input = {}) { return selectTasks(await store.snapshot(), input, await store.settings()); },
    async progress(input = {}) {
      const snapshot = await store.snapshot();
      const rows = snapshot.progress.filter(row => !input.course || String(row.courseName ?? '').includes(input.course));
      return { ...freshness(snapshot), scope: snapshot.scope, coverage: summaryCoverage(snapshot.coverage), ...page(rows, input) };
    },
    async coverage(input = {}) {
      const snapshot = await store.snapshot();
      const checks = snapshot.coverage.checks.filter(check => input.failedOnly === false || check.status !== 'ok');
      return { ...freshness(snapshot), scope: snapshot.scope, coverage: summaryCoverage(snapshot.coverage), ...page(checks, input) };
    },
    settings: update => store.settings(update),
    async openTask(id) {
      const snapshot = await store.snapshot();
      const item = snapshot.tasks.find(task => task.id === id && id);
      if (!item) throw new ClientFault('NOT_FOUND', 'Task identifier not present in the current snapshot');
      let address = item.url, target = 'task';
      if (!address && item.courseId && item.classId) {
        const course = snapshot.courses.find(course => course.id === item.courseId && course.classId === item.classId);
        if (!course?.contextId) throw new ClientFault('NOT_AVAILABLE', 'The current snapshot has no course context for this task');
        address = new URL('https://mooc1.chaoxing.com/visit/stucoursemiddle');
        address.search = new URLSearchParams({ courseid: item.courseId, clazzid: item.classId, cpi: course.contextId, ismooc2: '1' }).toString();
        address = address.href; target = 'course';
      }
      if (!address) throw new ClientFault('NOT_AVAILABLE', 'The source did not provide a usable task or course link');
      return live(async session => ({ ...await session.openTask(address), target }));
    },
    refresh(input = {}) {
      if (activeJob) throw new ClientFault('BUSY', `Synchronization already running: ${activeJob}`);
      if (jobs.size >= 20) jobs.delete(jobs.keys().next().value);
      const jobId = randomUUID(), controller = new AbortController();
      const job = { jobId, status: 'running', startedAt: new Date().toISOString(), controller };
      jobs.set(jobId, job); activeJob = jobId;
      synchronize(input, { signal: controller.signal, onStatus: value => { job.progress = value; } }).then(report => {
        job.status = report.coverage.complete ? 'completed' : 'partial';
        job.result = { finishedAt: report.finishedAt, courseCount: report.courses.length, taskCount: report.tasks.length, coverage: summaryCoverage(report.coverage) };
      }, error => { job.status = 'failed'; job.error = describeError(error); }).finally(() => {
        job.finishedAt = new Date().toISOString(); activeJob = null;
      });
      return { jobId, status: 'running' };
    },
    job(jobId) {
      const value = jobs.get(jobId);
      if (!value) throw new ClientFault('NOT_FOUND', 'This server process does not have the requested synchronization job');
      const { controller, ...publicValue } = value;
      return publicValue;
    },
    stop() { for (const job of jobs.values()) if (job.status === 'running') job.controller.abort(); }
  };
  return api;
}
