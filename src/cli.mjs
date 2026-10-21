#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createApp } from './core/app.mjs';
import { ClientFault, describeError } from './core/errors.mjs';
import { summaryCoverage } from './core/query.mjs';

const app = createApp();
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, course: { type: 'string' }, sections: { type: 'string' },
    'max-courses': { type: 'string' }, 'verify-course-lists': { type: 'boolean' }, 'no-detail-deadlines': { type: 'boolean' },
    kind: { type: 'string' }, status: { type: 'string' }, 'due-hours': { type: 'string' },
    offset: { type: 'string' }, limit: { type: 'string' }, all: { type: 'boolean' }, id: { type: 'string' },
    'include-ignored': { type: 'boolean' }, delay: { type: 'string' },
    'ignore-course': { type: 'string', multiple: true }, 'ignore-task': { type: 'string', multiple: true }, 'clear-ignored': { type: 'boolean' }
  } });
  const number = (name, minimum, maximum) => {
    if (values[name] === undefined) return undefined;
    const value = Number(values[name]);
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new ClientFault('INVALID_INPUT', `${name} must be an integer between ${minimum} and ${maximum}`);
    return value;
  };
  const pagination = () => ({ offset: number('offset', 0, 1000000), limit: number('limit', 1, 200) });
  if (positionals.length > 1) throw new ClientFault('INVALID_INPUT', 'Unexpected positional arguments. Select a course with --course.');
  const command = values.help ? 'help' : positionals[0] ?? 'help';
  let data;
  switch (command) {
    case 'help': data = {
      commands: ['doctor', 'courses', 'sync', 'tasks', 'todo', 'progress', 'coverage', 'open', 'settings'],
      examples: ['sync --course "示例课程" --verify-course-lists', 'tasks --kind exam --limit 50', 'todo --due-hours 168', 'open --id "task-id"', 'settings --delay 2000'],
      cache: 'tasks/todo/progress/coverage query the most recent local snapshot; sync refreshes it.',
      exitCodes: { 0: 'success', 1: 'error', 2: 'synchronization returned partial results' }
    }; break;
    case 'doctor': data = await app.doctor(); break;
    case 'courses': data = await app.courses(); break;
    case 'sync': {
      const controller = new AbortController(), interrupt = () => controller.abort();
      process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
      try {
        const snapshot = await app.sync({ course: values.course, sections: values.sections?.split(','), maxCourses: number('max-courses', 1, 1000),
          verifyCourseLists: values['verify-course-lists'], resolveDeadlines: !values['no-detail-deadlines'] }, {
          signal: controller.signal, onStatus: value => process.stderr.write(`${JSON.stringify(value)}\n`)
        });
        data = { finishedAt: snapshot.finishedAt, scope: snapshot.scope, courseCount: snapshot.courses.length, taskCount: snapshot.tasks.length, coverage: summaryCoverage(snapshot.coverage) };
        if (!snapshot.coverage.complete) process.exitCode = 2;
      } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
      break;
    }
    case 'tasks': case 'todo': data = await app.tasks({ ...pagination(), course: values.course, kind: values.kind, status: command === 'todo' ? 'todo' : values.status,
      dueHours: number('due-hours', 0, 8760), includeIgnored: values['include-ignored'] }); break;
    case 'progress': data = await app.progress({ ...pagination(), course: values.course }); break;
    case 'coverage': data = await app.coverage({ ...pagination(), failedOnly: !values.all }); break;
    case 'open': if (!values.id) throw new ClientFault('INVALID_INPUT', 'open requires --id'); data = await app.openTask(values.id); break;
    case 'settings': data = await app.settings({ ...(values.delay !== undefined ? { delayMs: number('delay', 1500, 30000) } : {}),
      ...(values['ignore-course'] ? { ignoreCourses: values['ignore-course'] } : {}), ...(values['ignore-task'] ? { ignoreTasks: values['ignore-task'] } : {}),
      ...(values['clear-ignored'] ? { ignoreCourses: [], ignoreTasks: [] } : {}) }); break;
    default: throw new ClientFault('INVALID_INPUT', 'Unknown command. Use --help.');
  }
  process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: describeError(error) })}\n`);
  process.exitCode = 1;
}
