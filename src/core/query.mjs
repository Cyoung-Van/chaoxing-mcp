import { ClientFault } from './errors.mjs';

export const TASK_KINDS = ['all', 'assignment', 'exam', 'activity', 'task-package'];
export const TASK_STATES = ['all', 'todo', 'pending', 'submitted', 'graded', 'completed', 'upcoming', 'ongoing', 'ended', 'expired', 'unknown'];
const finished = new Set(['submitted', 'graded', 'completed', 'ended', 'expired']);

export function pageOptions(input = {}) {
  const offset = input.offset ?? 0, limit = input.limit ?? 50;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new ClientFault('INVALID_INPUT', 'offset must be nonnegative; limit must be from 1 to 200');
  return { offset, limit };
}
export function page(items, input = {}) {
  const { offset, limit } = pageOptions(input);
  return { total: items.length, offset, limit, nextOffset: offset + limit < items.length ? offset + limit : null, items: items.slice(offset, offset + limit) };
}
export function summaryCoverage(coverage = {}) {
  const { checks = [], ...rest } = coverage;
  const failures = checks.filter(check => check.status !== 'ok');
  return { ...rest, checkCount: checks.length, failedCount: failures.length, failures: failures.slice(0, 20), failuresTruncated: failures.length > 20, universalCoverage: 'unverified' };
}
export function freshness(snapshot, now = Date.now()) {
  const age = now - Date.parse(snapshot.finishedAt);
  return { finishedAt: snapshot.finishedAt, stale: !Number.isFinite(age) || age > 300000, ageSeconds: Number.isFinite(age) ? Math.max(0, Math.floor(age / 1000)) : null };
}
export function selectTasks(snapshot, input = {}, settings = {}) {
  pageOptions(input);
  const kind = input.kind ?? 'all', status = input.status ?? 'all';
  if (!TASK_KINDS.includes(kind) || !TASK_STATES.includes(status)) throw new ClientFault('INVALID_INPUT', 'Unrecognized task filter');
  if (input.dueHours !== undefined && (!Number.isFinite(input.dueHours) || input.dueHours < 0 || input.dueHours > 8760))
    throw new ClientFault('INVALID_INPUT', 'dueHours must be between 0 and 8760');
  const now = input.now ?? Date.now();
  let items = snapshot.tasks.filter(item => {
    if (kind !== 'all' && item.kind !== kind) return false;
    if (input.course && !String(item.courseName ?? '').includes(input.course)) return false;
    if (status === 'todo' && finished.has(item.status)) return false;
    if (!['all', 'todo'].includes(status) && item.status !== status) return false;
    if (!input.includeIgnored && ((settings.ignoreTasks ?? []).includes(item.id) || (settings.ignoreCourses ?? []).includes(`${item.courseId}:${item.classId}`))) return false;
    return true;
  });
  const unknownDeadlineCount = items.filter(item => !Number.isFinite(Date.parse(item.deadline?.iso))).length;
  if (input.dueHours !== undefined) items = items.filter(item => {
    const due = Date.parse(item.deadline?.iso);
    return Number.isFinite(due) && due <= now + input.dueHours * 3600000;
  });
  const dueOrder = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : Infinity;
  items.sort((a, b) => dueOrder(a.deadline?.iso) - dueOrder(b.deadline?.iso));
  return { ...freshness(snapshot, now), scope: snapshot.scope, coverage: summaryCoverage(snapshot.coverage), unknownDeadlineCount, ...page(items, input) };
}
