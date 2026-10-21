// SPDX-License-Identifier: MIT
// Fresh synthetic examples authored only from docs/IMPLEMENTATION_CONTRACT.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCourseCatalog, readTaskPage, readActivities, readTaskPackages,
  normalizeLearningPlan, packageTask, parseStatistics, pageToken,
  readDeadline, assertPageUsable,
} from '../src/adapters/parse.mjs';

const course = { id: 'c7', classId: 'k4', name: 'Synthetic course', contextId: 'ctx8' };
const now = new Date('2026-10-21T04:00:00.000Z');
const opts = { kind: 'assignment', course, source: 'course-work', baseUrl: 'https://mooc1.chaoxing.com/work/list', now };
const fault = code => error => error.code === code;

test('catalog preserves separate classes and string identifiers', () => {
  const input = { channelList: [
    { cpi: 8, content: { id: 4, course: { data: [{ id: 7, name: 'A' }] } } },
    { content: { cpi: '9', clazz: { data: [{ id: 5 }] }, course: { data: [{ id: 7, name: 'A' }] } } },
  ] };
  assert.deepEqual(parseCourseCatalog(JSON.stringify(input)), [
    { id: '7', classId: '4', name: 'A', contextId: '8' },
    { id: '7', classId: '5', name: 'A', contextId: '9' },
  ]);
});

test('catalog rejects broken payload instead of reporting an empty account', () => {
  assert.throws(() => parseCourseCatalog('{'), fault('BAD_RESPONSE'));
  assert.throws(() => parseCourseCatalog({ data: [] }), fault('BAD_RESPONSE'));
  assert.deepEqual(parseCourseCatalog({ channelList: [] }), []);
});

test('deadlines respect explicit zones and platform Shanghai time', () => {
  assert.deepEqual(readDeadline('2026-10-22T18:30:00+09:00', now), { raw: '2026-10-22T18:30:00+09:00', iso: '2026-10-22T09:30:00.000Z', certainty: 'explicit' });
  assert.equal(readDeadline('截止：2026年10月22日 18:30', now).iso, '2026-10-22T10:30:00.000Z');
  assert.equal(readDeadline('2026/10/22 18:30', now).iso, '2026-10-22T10:30:00.000Z');
  assert.equal(readDeadline('2026-10-22', now).iso, null);
  assert.equal(readDeadline('10-22 18:30', now).certainty, 'inferred-year');
});

test('deadlines handle relative durations and epoch timestamps without guessing invalid dates', () => {
  assert.equal(readDeadline('剩余1天2小时30分钟', now).iso, '2026-10-22T06:30:00.000Z');
  assert.equal(readDeadline('2 days 3 hours remaining', now).iso, '2026-10-23T07:00:00.000Z');
  assert.equal(readDeadline(1792641600000, now).certainty, 'timestamp');
  for (const value of ['2026-02-30 12:00', '2026-13-01 12:00', '2026-10-22 25:00', '2026-02-30T12:00:00Z', '暂无', null]) {
    assert.equal(readDeadline(value, now).iso, null, String(value));
  }
});

test('range deadline chooses its ending date and avoids date-only midnight invention', () => {
  assert.equal(readDeadline('2026-10-21 09:00 至 2026-10-23 20:00', now).iso, '2026-10-23T12:00:00.000Z');
  assert.equal(readDeadline('2026-10-21 至 2026-10-23', now).iso, null);
});

test('login and challenge pages cause explicit stopping faults', () => {
  assert.throws(() => assertPageUsable('<h1>登录</h1>', 'https://passport2.chaoxing.com/login'), fault('AUTH_REQUIRED'));
  assert.throws(() => assertPageUsable('<form action="/login"><input type="password"><button>登录</button></form>', 'https://mooc1.chaoxing.com/a'), fault('AUTH_REQUIRED'));
  assert.throws(() => assertPageUsable('<p>【9010】操作异常，请输入图片中的验证码</p>', 'https://mooc1.chaoxing.com/a'), fault('CHALLENGE'));
  assert.doesNotThrow(() => assertPageUsable('<p>学习登录协议的作业</p>', opts.baseUrl));
});

test('token extraction reads hidden fields and quoted assignments without executing code', () => {
  assert.equal(pageToken('<input type="hidden" name="pEnc" value="a&amp;b">', 'pEnc'), 'a&b');
  assert.equal(pageToken('<script>window.pEnc = "abc-12"; throw new Error("never run");</script>', 'pEnc'), 'abc-12');
  assert.equal(pageToken('<script>var pEnc = makeSignature();</script>', 'pEnc'), null);
  assert.equal(pageToken('<input type="text" name="pEnc" value="not-a-token">', 'pEnc'), null);
});

test('global assignment cards preserve title, status, URL and source', () => {
  const html = `<ul class="nav"><li data="/work/view?workId=w9&amp;courseId=c7&amp;clazzId=k4"><div role="option"><p>Exercise 97</p><span>Synthetic course</span><span>To be marked</span><em class="fr">剩余2小时</em></div></li></ul>`;
  const result = readTaskPage(html, opts);
  assert.equal(result.items.length, 1);
  const task = result.items[0];
  assert.equal(task.externalId, 'w9');
  assert.equal(task.id, 'assignment:c7:k4:w9');
  assert.equal(task.status, 'submitted');
  assert.equal(task.title, 'Exercise 97');
  assert.equal(task.deadline.iso, '2026-10-21T06:00:00.000Z');
  assert.deepEqual(task.sources, ['course-work']);
  assert.equal('score' in task, false);
});

test('current cards accept nested data links and retain unknown handlers as missing identity', () => {
  const html = `<ul><li><div class="right-content"><h3 class="overHidden2">Alpha</h3><span class="status">未提交</span><a data-url="/work/view?workId=z1">Open</a></div></li><li onclick="mystery(42)"><div class="right-content"><h3 class="overHidden2">Alpha</h3><span class="status">未识别状态</span></div></li></ul>`;
  const { items } = readTaskPage(html, opts);
  assert.equal(items[0].courseId, 'c7');
  assert.equal(items[0].classId, 'k4');
  assert.equal(items[0].status, 'pending');
  assert.equal(items[1].externalId, null);
  assert.equal(items[1].id, null);
  assert.equal(items[1].url, null);
  assert.equal(items[1].status, 'unknown');
  assert.ok(items[1].warnings.length);
});

test('exam table distinguishes ended exam from personal completion and decodes nested reference', () => {
  const nested = encodeURIComponent('https://mooc1.chaoxing.com/exam/view?examId=e1&courseId=c7&clazzId=k4');
  const html = `<table class="dataTable"><tr class="dataTr"><td>1</td><td>Final 100</td><td>2026-10-20 10:00 至 2026-10-20 12:00</td><td>120</td><td>Finished</td><td>Not submitted</td><td>--</td><td>Online</td><td><a onclick="go('/exam/jump?refer=${nested}')">View</a></td></tr></table>`;
  const task = readTaskPage(html, { ...opts, kind: 'exam' }).items[0];
  assert.equal(task.status, 'expired');
  assert.equal(task.externalId, 'e1');
  assert.equal(task.title, 'Final 100');
});

test('phone exam expiration artwork is not completion evidence', () => {
  const html = '<ul class="ks_list"><li data="/exam/view?examId=e2"><dl><dt>Exam B</dt><dd>2026-10-22 18:30</dd></dl><span class="ks_state">Finished</span><img src="/images/ks_02.png"></li></ul>';
  assert.equal(readTaskPage(html, { ...opts, kind: 'exam' }).items[0].status, 'expired');
});

test('recognized empty pages differ from unknown layout and unknown pagination', () => {
  assert.deepEqual(readTaskPage('<p>暂无作业</p>', opts).items, []);
  assert.throws(() => readTaskPage('<main>Something different</main>', opts), fault('PAGE_UNRECOGNIZED'));
  const html = '<p>No assignment yet</p><a rel="next" href="?page=2">Next</a>';
  assert.equal(readTaskPage(html, opts).nextUrl, 'https://mooc1.chaoxing.com/work/list?page=2');
  assert.equal(readTaskPage('<p>暂无作业</p><button onclick="loadPage(2)">下一页</button>', opts).hasMoreUnknown, true);
});

test('activity timing is separate from personal completion and unknown numeric type is safe', () => {
  const items = readActivities({ data: { activeList: [
    { id: 11, nameOne: 'Discussion', activeType: 9999, status: 2, endTime: '2026-10-20 10:00' },
    { activeId: '12', title: 'Survey', status: null },
    { id: '13', name: 'Later', status: 0 },
  ] } }, course, now);
  assert.deepEqual(items.map(item => item.status), ['ended', 'unknown', 'upcoming']);
  assert.deepEqual(items.map(item => item.kind), ['activity', 'activity', 'activity']);
  assert.throws(() => readActivities({ data: {} }, course, now), fault('BAD_RESPONSE'));
});

test('task packages retain metadata and provide visible unknown fallback', () => {
  const packages = readTaskPackages({ data: [{ id: 41, name: 'Package', planCount: '3', encryptGroupId: 'encrypted-g', userTaskQualifyStatus: 9 }] }, course);
  assert.equal(packages[0].id, '41');
  assert.equal(packages[0].planFinishCount, null);
  assert.equal(packages[0].encryptGroupId, 'encrypted-g');
  const fallback = packageTask(packages[0], course);
  assert.equal(fallback.kind, 'task-package');
  assert.equal(fallback.status, 'unknown');
  assert.equal(fallback.externalId, '41');
  assert.ok(fallback.warnings.some(value => /unverified/i.test(value)));
});

test('learning plans use explicit type text and reconcile contradictory completion flags', () => {
  const packageInfo = { id: 'p5', name: 'Package' };
  const completed = normalizeLearningPlan({ planId: 31, encryptPlanId: 'enc31', name: 'Exam 88', planTypeName: '考试', isFinish: true }, course, packageInfo, { now });
  assert.equal(completed.kind, 'exam');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.externalId, '31');
  const conflict = normalizeLearningPlan({ planId: '32', name: 'Conflict', isFinish: true, planUser: { finish: false } }, course, packageInfo, { now });
  assert.equal(conflict.status, 'unknown');
  assert.ok(conflict.warnings.some(value => /conflict/i.test(value)));
  const unknown = normalizeLearningPlan({ name: 'Unverified', planType: 987 }, course, packageInfo, { now });
  assert.equal(unknown.id, null);
  assert.equal(unknown.status, 'unknown');
});

test('statistics use explicit fields, keep zeros, and do not invent missing metrics', () => {
  const result = parseStatistics({ job: { data: { job: 0, publishJobNum: 5, jobPer: '0%', jobRank: 9 } }, point: { data: { ponits: 12 } }, ai: null, group: { data: { taskNum: 2, publishTaskNum: 4 } } }, course);
  assert.equal(result.available, true);
  assert.deepEqual(result.metrics.taskPoints, { completed: 0, total: 5, percent: 0 });
  assert.equal(result.metrics.points, 12);
  assert.equal(result.metrics.rank, 9);
  assert.deepEqual(result.metrics.aiPractice, { completed: null, total: null });
  assert.deepEqual(result.metrics.groupTask, { completed: 2, total: 4 });
  assert.ok(result.errors.length);
  assert.equal(parseStatistics({ job: null, point: null, ai: null, group: null }, course).available, false);
});

test('same-day schedule ranges use the final clock time', () => {
  assert.equal(readDeadline('2026-10-22 09:00 至 11:30', now).iso, '2026-10-22T03:30:00.000Z');
  assert.equal(readDeadline('剩余-2天', now).iso, null);
});

test('course names cannot supply a false completion status', () => {
  const html = '<ul class="nav"><li data="/work/view?workId=w0"><div role="option"><p>Task</p><span>Completed systems</span><span>Uncommitted</span></div></li></ul>';
  assert.equal(readTaskPage(html, opts).items[0].status, 'pending');
  assert.equal(readTaskPage(html.replace('Uncommitted', 'Not completed'), opts).items[0].status, 'pending');
});

test('conflicting linked identities disable automatic merging and completion claims', () => {
  const html = '<li><div class="right-content"><span class="overHidden2">Task</span><span class="status">Completed</span><a href="/work/view?workId=w0&amp;courseId=another-course">View</a></div></li>';
  const task = readTaskPage(html, opts).items[0];
  assert.equal(task.id, null);
  assert.equal(task.status, 'unknown');
  assert.equal(task.courseId, course.id);
  assert.ok(task.warnings.some(value => /conflict/.test(value)));
});

test('script template empty strings and opaque data actions do not fabricate page data', () => {
  assert.throws(() => readTaskPage('<script>const empty = "暂无作业";</script><p>New layout</p>', opts), fault('PAGE_UNRECOGNIZED'));
  const html = '<li data="opaque-action"><div class="right-content"><span class="overHidden2">Task</span><span class="status">Unknown</span></div></li>';
  assert.equal(readTaskPage(html, opts).items[0].url, null);
});

test('error payloads and unknown statistics structures remain unavailable with diagnostics', () => {
  assert.throws(() => readActivities({ success: false, data: { activeList: [] } }, course, now), fault('BAD_RESPONSE'));
  assert.throws(() => readTaskPackages({ data: null }, course), fault('BAD_RESPONSE'));
  const stats = parseStatistics({ job: { data: {} }, point: { data: 'error' }, ai: { data: { unrelated: 0 } }, group: null }, course);
  assert.equal(stats.available, false);
  assert.equal(stats.errors.length, 4);
});

test('explicit type text determines plan kind while numeric type remains unclassified', () => {
  const plans = [
    normalizeLearningPlan({ planId: 'a', name: 'Exam preparation', planType: 12345, isFinish: false }, course, {}, { now }),
    normalizeLearningPlan({ planId: 'b', name: 'Assignment', planTypeName: '作业', isFinish: false }, course, {}, { now }),
  ];
  assert.deepEqual(plans.map(plan => plan.kind), ['activity', 'assignment']);
});

test('object identifiers and array metrics never become invented strings or zero counts', () => {
  const activity = readActivities({ data: { activeList: [{ id: {}, name: 'Unknown', status: null }] } }, course, now)[0];
  assert.equal(activity.externalId, null);
  const metrics = parseStatistics({ job: { data: { job: [], publishJobNum: [5] } }, point: null, ai: null, group: null }, course).metrics;
  assert.equal(metrics.taskPoints.completed, null);
  assert.equal(metrics.taskPoints.total, null);
});

test('token-like text in JavaScript comments or string literals is not an assignment', () => {
  assert.equal(pageToken('<script>// pEnc = "fake";\nconst x = 1;</script>', 'pEnc'), null);
  assert.equal(pageToken('<script>/* pEnc = "fake"; */ const x = 1;</script>', 'pEnc'), null);
  assert.equal(pageToken(`<script>const sample = ' pEnc = "fake";'; window.pEnc = "real";</script>`, 'pEnc'), 'real');
});
