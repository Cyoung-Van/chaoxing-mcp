// SPDX-License-Identifier: MIT
// Independently authored from docs/IMPLEMENTATION_CONTRACT.md and synthetic tests.
import { parseHTML } from 'linkedom';
import { ClientFault } from '../core/errors.mjs';

const clean = value => value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
const identifier = value => {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  return typeof value === 'string' && clean(value) !== '' ? value : null;
};
const text = node => clean(node?.nodeType === 9 ? [...node.childNodes].map(child => child.textContent).join(' ') : node?.textContent);
const documentOf = html => parseHTML(String(html ?? '')).document;
const fault = (code, message) => { throw new ClientFault(code, message); };
const valueNumber = value => {
  if (!['string', 'number'].includes(typeof value) || clean(value) === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/%$/, ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

function decoded(payload, label) {
  let value = payload;
  if (typeof payload === 'string') {
    assertPageUsable(payload);
    try { value = JSON.parse(payload); }
    catch { fault('BAD_RESPONSE', `${label} is not valid JSON`); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fault('BAD_RESPONSE', `${label} has an unexpected shape`);
  if (value.success === false || value.result === false || value.status === false) fault('BAD_RESPONSE', `${label} reports an unsuccessful response`);
  return value;
}

export function parseCourseCatalog(payload) {
  const root = decoded(payload, 'Course catalog');
  if (!Array.isArray(root.channelList)) fault('BAD_RESPONSE', 'Course catalog has no channel list');
  const courses = new Map();
  for (const channel of root.channelList) {
    const content = channel?.content;
    const entries = content?.course?.data;
    if (!Array.isArray(entries)) fault('BAD_RESPONSE', 'A course catalog channel has no course list');
    const classId = identifier(content.id ?? content.clazz?.data?.[0]?.id);
    for (const raw of entries) {
      const id = identifier(raw?.id);
      if (!id || !classId) fault('BAD_RESPONSE', 'A course catalog entry is missing its course or class identifier');
      const course = { id, classId, name: clean(raw.name), contextId: identifier(channel.cpi ?? content.cpi) };
      const key = JSON.stringify([id, classId]);
      const previous = courses.get(key);
      if (previous && (previous.contextId !== course.contextId || previous.name !== course.name)) {
        fault('BAD_RESPONSE', 'Duplicate course identities disagree');
      }
      courses.set(key, course);
    }
  }
  return [...courses.values()];
}

function validDateParts(year, month, day, hour = 0, minute = 0, second = 0) {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return false;
  const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
}

export function readDeadline(value, now = new Date()) {
  const raw = value == null ? null : String(value);
  const unknown = { raw, iso: null, certainty: 'unknown' };
  const input = clean(value);
  if (!input) return unknown;
  const reference = now instanceof Date ? now : new Date(now);
  if (/^\d{10}(?:\d{3})?$/.test(input)) {
    const epoch = Number(input) * (input.length === 10 ? 1000 : 1);
    const date = new Date(epoch);
    return Number.isFinite(date.getTime()) ? { raw, iso: date.toISOString(), certainty: 'timestamp' } : unknown;
  }
  // Explicit offsets take priority over the platform's default timezone.
  const zoned = [...input.matchAll(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})/gi)].at(-1);
  if (zoned) {
    const [, year, month, day, hour, minute, second = '0', , zone] = zoned;
    if (!validDateParts(+year, +month, +day, +hour, +minute, +second)) return unknown;
    if (zone !== 'Z' && zone !== 'z') {
      const zoneParts = zone.slice(1).replace(':', '');
      if (+zoneParts.slice(0, 2) > 23 || +zoneParts.slice(2) > 59) return unknown;
    }
    const date = new Date(zoned[0].replace(' ', 'T'));
    return Number.isFinite(date.getTime()) ? { raw, iso: date.toISOString(), certainty: 'explicit' } : unknown;
  }
  const absolute = [...input.matchAll(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/g)].at(-1);
  if (absolute) {
    let [, year, month, day, hour, minute, second] = absolute;
    const finalClock = input.slice(absolute.index + absolute[0].length).match(/^\s*(?:至|到|[-~—–]|to)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/i);
    if (finalClock) [, hour, minute, second] = finalClock;
    if (!validDateParts(+year, +month, +day, +(hour ?? 0), +(minute ?? 0), +(second ?? 0))) return unknown;
    return { raw, iso: hour == null ? null : new Date(Date.UTC(+year, +month - 1, +day, +hour - 8, +minute, +(second ?? 0))).toISOString(), certainty: 'explicit' };
  }
  const inferred = [...input.matchAll(/(?<!\d[-/])(\d{1,2})[-/月](\d{1,2})(?:日)?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/g)].at(-1);
  if (inferred && Number.isFinite(reference.getTime())) {
    const year = new Date(reference.getTime() + 8 * 3600000).getUTCFullYear();
    const [, month, day, hour, minute, second = '0'] = inferred;
    if (!validDateParts(year, +month, +day, +hour, +minute, +second)) return unknown;
    return { raw, iso: new Date(Date.UTC(year, +month - 1, +day, +hour - 8, +minute, +second)).toISOString(), certainty: 'inferred-year' };
  }
  if (/-\s*\d+(?:\.\d+)?\s*(?:天|日|小时|时|分钟|分|秒|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)/i.test(input)) return unknown;
  const durations = [...input.matchAll(/(\d+(?:\.\d+)?)\s*(天|日|小时|时|分钟|分|秒钟|秒|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)/gi)];
  if (durations.length && Number.isFinite(reference.getTime())) {
    let duration = 0;
    for (const [, amount, unit] of durations) {
      const factor = /^(天|日|day)/i.test(unit) ? 86400000 : /^(小时|时|hour|hr)/i.test(unit) ? 3600000 : /^(分钟|分|minute|min)/i.test(unit) ? 60000 : 1000;
      duration += +amount * factor;
    }
    if (/\bago\b|之前|以前|已过/.test(input)) duration *= -1;
    const date = new Date(reference.getTime() + duration);
    if (Number.isFinite(date.getTime())) return { raw, iso: date.toISOString(), certainty: 'relative' };
  }
  return unknown;
}

export function assertPageUsable(html, url = '') {
  const input = String(html ?? '');
  if (/antispiderShowVerify\.ac/i.test(String(url)) || /【9010】操作异常|操作异常[，,]?请[输輸]入.{0,15}验证码/.test(input)) {
    fault('CHALLENGE', 'The platform requires human verification');
  }
  let host = '';
  try { host = new URL(url).hostname; } catch { /* A URL is optional for decoded payload checks. */ }
  if (host === 'passport2.chaoxing.com') fault('AUTH_REQUIRED', 'The platform requires login');
  const doc = documentOf(input);
  if (doc.querySelector('form input[type="password"]') && /登录|登錄|\blog\s*in\b|\bsign\s*in\b/i.test(input)) {
    fault('AUTH_REQUIRED', 'The platform requires login');
  }
}

export function pageToken(html, name) {
  const doc = documentOf(html);
  for (const input of doc.querySelectorAll('input[type="hidden"]')) {
    if (input.getAttribute('name') === name || input.getAttribute('id') === name) return input.getAttribute('value') || null;
  }
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assignment = new RegExp(`(?:^|[;\\s])(?:(?:var|let|const)\\s+|window\\.)?${escaped}\\s*=\\s*(["'])([^"'\\r\\n]*)\\1`, 'gm');
  for (const script of doc.querySelectorAll('script')) {
    const source = script.textContent;
    const ignored = [...source.matchAll(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g)].map(match => [match.index, match.index + match[0].length]);
    for (const match of source.matchAll(assignment)) {
      if (!ignored.some(([start, end]) => match.index >= start && match.index < end)) return match[2];
    }
  }
  return null;
}

function address(value, baseUrl) {
  if (!value) return null;
  const input = clean(value);
  if (/^(?:javascript|data|file):/i.test(input) || input === '#') return null;
  if (!/[/?]/.test(input) || /[<>"'{}()\\]/.test(input)) return null;
  try {
    const result = new URL(input, baseUrl);
    return result.protocol === 'https:' && !result.username && !result.password && /(?:^|\.)chaoxing\.com$/i.test(result.hostname) ? result.href : null;
  } catch { return null; }
}

function nodeAddress(node, baseUrl) {
  for (const candidate of [node, ...node.querySelectorAll('[data],[data-url],[data-href],[data-link],a[href],[onclick]')]) {
    for (const attribute of ['data-url', 'data-href', 'data-link', 'data', 'href']) {
      const raw = candidate.getAttribute(attribute);
      if (!raw) continue;
      if (/^\s*\{/.test(raw)) {
        try {
          const parsed = JSON.parse(raw);
          const found = address(parsed.url ?? parsed.href ?? parsed.link, baseUrl);
          if (found) return found;
        } catch { /* Unrecognized action metadata remains unrecognized. */ }
      } else {
        const found = address(raw, baseUrl);
        if (found) return found;
      }
    }
    const handler = candidate.getAttribute('onclick')?.match(/^\s*(?:return\s+)?go\(\s*(['"])(.*?)\1\s*\)\s*;?\s*$/s);
    if (handler) {
      const found = address(handler[2], baseUrl);
      if (found) return found;
    }
  }
  return null;
}

function addressIdentity(url) {
  const found = { externalId: null, courseId: null, classId: null };
  let next = url;
  for (let depth = 0; next && depth < 4; depth++) {
    let current;
    try { current = new URL(next, url); } catch { break; }
    for (const [name, value] of current.searchParams) {
      const key = name.toLowerCase();
      if (['taskrefid', 'workid', 'examid'].includes(key) && !found.externalId) found.externalId = identifier(value);
      if (['courseid', 'moocid'].includes(key) && !found.courseId) found.courseId = identifier(value);
      if (['clazzid', 'classid'].includes(key) && !found.classId) found.classId = identifier(value);
    }
    next = current.searchParams.get('refer') ?? current.searchParams.get('referer');
  }
  return found;
}

function statusOf(value) {
  const input = clean(value).toLowerCase().replace(/\s*[(:：].*$/, '').trim();
  if (!input) return 'unknown';
  if (/^(?:not submitted|not completed|uncommitted|未提交|未交|待提交|未完成|待完成)$/.test(input)) return 'pending';
  if (/^(?:to be marked|submitted|待批[阅改]|已提交|已交)$/.test(input)) return 'submitted';
  if (/^(?:graded|marked|已批[阅改]|已评分)$/.test(input)) return 'graded';
  if (/^(?:completed|已完成)$/.test(input)) return 'completed';
  if (/^(?:expired|已过期|逾期|已截止)$/.test(input)) return 'expired';
  if (/^(?:not started|upcoming|未开始|尚未开始)$/.test(input)) return 'upcoming';
  if (/^(?:ongoing|in progress|进行中)$/.test(input)) return 'ongoing';
  if (/^(?:finished|ended|已结束)$/.test(input)) return 'ended';
  return 'unknown';
}

function taskShape({ externalId, kind, course, courseName, title, status = 'unknown', deadline, url = null, source, warnings = [], linkedIdentity }) {
  const known = linkedIdentity ?? {};
  const courseId = identifier(course?.id) ?? known.courseId ?? null;
  const classId = identifier(course?.classId) ?? known.classId ?? null;
  const platformId = identifier(externalId);
  const notices = [...warnings];
  const conflict = (known.courseId && course?.id && known.courseId !== String(course.id)) || (known.classId && course?.classId && known.classId !== String(course.classId));
  if (conflict) notices.push('Course or class identity conflicts with the task link; automatic merging is disabled.');
  if (!platformId || !courseId || !classId) notices.push('Stable task identity is incomplete; this item must remain separate.');
  if (status === 'unknown') notices.push('Personal task status is unknown.');
  return {
    id: !conflict && platformId && courseId && classId ? `${kind}:${courseId}:${classId}:${platformId}` : null,
    externalId: platformId, kind, courseId, classId, courseName: clean(course?.name) || clean(courseName), title: clean(title),
    status: conflict ? 'unknown' : status, deadline: deadline ?? readDeadline(null), url, sources: source ? [source] : [], warnings: notices,
  };
}

export function readTaskPage(html, { kind, course = null, source = 'task-page', baseUrl, now } = {}) {
  if (!['assignment', 'exam'].includes(kind)) fault('INVALID_INPUT', 'Task page kind must be assignment or exam');
  assertPageUsable(html, baseUrl);
  const doc = documentOf(html);
  const cards = [];
  for (const node of doc.querySelectorAll('li')) {
    if (node.querySelector('.right-content')) cards.push({ node, format: 'course' });
    else if (node.parentElement?.matches('ul.nav') && node.querySelector('[role="option"]')) cards.push({ node, format: 'work' });
    else if (node.parentElement?.matches('ul.ks_list')) cards.push({ node, format: 'phone-exam' });
  }
  for (const node of doc.querySelectorAll('table.dataTable tr.dataTr')) cards.push({ node, format: 'table-exam' });
  const items = cards.map(({ node, format }) => {
    let title = '', status = 'unknown', deadlineText = '', courseName = '';
    if (format === 'course') {
      title = text(node.querySelector('.overHidden2'));
      status = statusOf(text(node.querySelector('.status')));
      deadlineText = text(node.querySelector('.time'));
    } else if (format === 'work') {
      const content = node.querySelector('[role="option"]');
      title = text(content.querySelector('p'));
      const spans = [...content.querySelectorAll('span')].map(text);
      const statuses = [...new Set(spans.map(statusOf).filter(value => value !== 'unknown'))];
      status = statuses.length === 1 ? statuses[0] : 'unknown';
      courseName = spans.find(value => statusOf(value) === 'unknown') ?? '';
      deadlineText = text(node.querySelector('.fr'));
    } else if (format === 'phone-exam') {
      title = text(node.querySelector('dt'));
      status = statusOf(text(node.querySelector('.ks_state')));
      deadlineText = [...node.querySelectorAll('dd')].map(text).join(' ');
      if ([...node.querySelectorAll('img')].some(image => /ks_02/.test(image.getAttribute('src') ?? ''))) status = 'expired';
    } else {
      const cells = [...node.querySelectorAll('td')].map(text);
      if (cells.length < 6) fault('PAGE_UNRECOGNIZED', 'An exam table row has insufficient fields');
      title = cells[1];
      deadlineText = cells[2];
      const examState = statusOf(cells[4]);
      const answerState = statusOf(cells[5]);
      status = ['ended', 'expired'].includes(examState) && answerState === 'pending' ? 'expired' : answerState !== 'unknown' ? answerState : examState;
    }
    const url = nodeAddress(node, baseUrl);
    const linkedIdentity = addressIdentity(url);
    return taskShape({ externalId: linkedIdentity.externalId, kind, course, courseName, title, status, deadline: readDeadline(deadlineText || null, now), url, source, linkedIdentity, warnings: !url ? ['No recognized task link is available.'] : [] });
  });
  // A plain empty label is affirmative evidence; an unrecognized document is not.
  const visible = doc.cloneNode(true);
  for (const node of visible.querySelectorAll('script,style,template')) node.remove();
  if (!items.length && !/暂无作业|暂无考试|No assignment yet|No exam\b/i.test(text(visible))) fault('PAGE_UNRECOGNIZED', 'Task page layout is not recognized');
  let nextUrl = null, hasMoreUnknown = false;
  for (const node of doc.querySelectorAll('a,button')) {
    if (node.getAttribute('rel') !== 'next' && !/^(?:下一页|下页|next(?: page)?|›|»|>)$/i.test(text(node))) continue;
    if (node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true' || /(?:^|\s)disabled(?:\s|$)/.test(node.className ?? '')) continue;
    const found = address(node.getAttribute('href') ?? node.getAttribute('data-url'), baseUrl);
    if (found && found !== baseUrl) nextUrl ??= found;
    else hasMoreUnknown = true;
  }
  if (!nextUrl && [...doc.querySelectorAll('script')].some(script => /\bhasMore\s*[:=]\s*true\b|\b(?:loadMore|nextPage)\s*\(/i.test(script.textContent))) hasMoreUnknown = true;
  return { items, nextUrl, hasMoreUnknown };
}

function kindFromText(value) {
  const input = clean(value);
  if (/考试|测验|\bexam\b|\btest\b/i.test(input)) return 'exam';
  if (/作业|\bassignment\b|\bhomework\b/i.test(input)) return 'assignment';
  return 'activity';
}

export function readActivities(payload, course, now = new Date()) {
  const root = decoded(payload, 'Activities');
  if (!Array.isArray(root.data?.activeList)) fault('BAD_RESPONSE', 'Activity response has no activity list');
  return root.data.activeList.map(raw => {
    if (!raw || typeof raw !== 'object') fault('BAD_RESPONSE', 'Activity list contains an invalid item');
    const status = raw.status == null ? 'unknown' : ({ 0: 'upcoming', 1: 'ongoing', 2: 'ended' }[String(raw.status)] ?? 'unknown');
    const typeName = raw.activeTypeName ?? raw.typeName ?? (typeof raw.activeType === 'string' && !/^\d+$/.test(raw.activeType) ? raw.activeType : null);
    return taskShape({ externalId: raw.id ?? raw.activeId, kind: kindFromText(typeName), course, title: raw.nameOne ?? raw.name ?? raw.title, status, deadline: readDeadline(raw.endTime, now), url: address(raw.url ?? raw.link, 'https://mobilelearn.chaoxing.com/'), source: 'activities' });
  });
}

export function readTaskPackages(payload, course) {
  const root = decoded(payload, 'Task packages');
  if (!Array.isArray(root.data)) fault('BAD_RESPONSE', 'Task package response has no package list');
  return root.data.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fault('BAD_RESPONSE', 'Task package list contains an invalid item');
    return { ...raw, id: identifier(raw.id), name: clean(raw.name), planCount: valueNumber(raw.planCount), planFinishCount: valueNumber(raw.planFinishCount) };
  });
}

export function packageTask(packageInfo, course) {
  const total = valueNumber(packageInfo.planCount), done = valueNumber(packageInfo.planFinishCount);
  const status = total != null && done != null && done <= total ? (total > 0 && done === total ? 'completed' : total > done ? 'pending' : 'unknown') : 'unknown';
  return taskShape({ externalId: packageInfo.id, kind: 'task-package', course, title: packageInfo.name, status, url: address(packageInfo.url, 'https://task.chaoxing.com/'), source: 'task-engine', warnings: ['Task package children were not resolved; real-account nonempty task-engine behavior remains unverified.'] });
}

function completionFlag(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

export function normalizeLearningPlan(rawPlan, course, packageInfo, { url, deadlineText, now = new Date() } = {}) {
  if (!rawPlan || typeof rawPlan !== 'object') fault('BAD_RESPONSE', 'Learning plan is invalid');
  const warnings = ['Real-account nonempty task-engine behavior remains unverified.'];
  const flags = [rawPlan.isFinish, rawPlan.planUser?.finish, rawPlan.score?.completed].map(completionFlag).filter(value => value != null);
  const states = new Set(flags);
  let status = states.size === 1 ? (flags[0] ? 'completed' : 'pending') : 'unknown';
  if (states.size > 1) warnings.push('Completion flags conflict; personal completion is unknown.');
  const deadline = readDeadline(deadlineText ?? rawPlan.endDateStr, now);
  const start = readDeadline(rawPlan.startDateStr, now);
  const timestamp = new Date(now).getTime();
  if (status === 'pending' && start.iso && Date.parse(start.iso) > timestamp) status = 'upcoming';
  else if (status === 'pending' && deadline.iso && Date.parse(deadline.iso) < timestamp) status = 'expired';
  const direct = address(url, 'https://task.chaoxing.com/');
  if (!direct) warnings.push('A direct study link is unavailable; use the task package to inspect this plan.');
  return taskShape({ externalId: rawPlan.planId ?? rawPlan.encryptPlanId, kind: kindFromText(rawPlan.planTypeName), course, title: rawPlan.name, status, deadline, url: direct ?? address(packageInfo?.url, 'https://task.chaoxing.com/'), source: 'task-engine', warnings });
}

export function parseStatistics({ job, point, ai, group } = {}, course) {
  const errors = [];
  const fields = { job: ['job', 'publishJobNum', 'jobPer', 'jobRank'], point: ['ponits'], ai: ['aiEvaluateReachCount', 'publishLibraryNum'], group: ['taskNum', 'publishTaskNum'] };
  const body = (value, source) => {
    if (value == null) { errors.push({ source, code: 'NOT_AVAILABLE', message: 'This statistics source is unavailable.' }); return {}; }
    try {
      const root = decoded(value, `Statistics ${source}`);
      const data = root.data ?? root;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ClientFault('BAD_RESPONSE', 'Statistics data has an unexpected shape');
      if (!fields[source].some(name => Object.hasOwn(data, name))) throw new ClientFault('BAD_RESPONSE', 'Statistics data has no recognized metrics');
      return data;
    } catch (error) {
      if (error.code === 'AUTH_REQUIRED' || error.code === 'CHALLENGE') throw error;
      errors.push({ source, code: error.code ?? 'BAD_RESPONSE', message: 'This statistics source could not be parsed.' });
      return {};
    }
  };
  const j = body(job, 'job'), p = body(point, 'point'), a = body(ai, 'ai'), g = body(group, 'group');
  const percentage = valueNumber(j.jobPer);
  const metrics = {
    taskPoints: { completed: valueNumber(j.job), total: valueNumber(j.publishJobNum), percent: percentage != null && percentage <= 100 ? percentage : null },
    points: valueNumber(p.ponits), rank: valueNumber(j.jobRank),
    aiPractice: { completed: valueNumber(a.aiEvaluateReachCount), total: valueNumber(a.publishLibraryNum) },
    groupTask: { completed: valueNumber(g.taskNum), total: valueNumber(g.publishTaskNum) },
  };
  const available = Object.values(metrics).some(value => typeof value === 'object' && value !== null ? Object.values(value).some(metric => metric != null) : value != null);
  return { courseId: identifier(course?.id), classId: identifier(course?.classId), courseName: clean(course?.name), available, metrics, errors };
}
