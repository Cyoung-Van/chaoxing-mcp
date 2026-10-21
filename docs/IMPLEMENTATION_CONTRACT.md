# Interface contract

This specification describes required behavior and platform interface facts. It contains no third-party implementation. New implementation contributors must not read or copy earlier review directories, previous source files, vendor snapshots, or the OpenCLI/chaoxing-list implementations.

## Product

Node.js 22 ESM. A local MCP server and JSON CLI query the account currently signed into a loopback Chromium CDP session. No passwords, Cookie files, submission, attendance, playback, exam start or captcha solving. Operations are serial and limited by an adjustable delay (default 1500ms). Stop on authentication loss or verification challenge; keep partial results. Do not treat unknown or failed data as empty or complete.

## Shared errors

Import ClientFault / describeError from `src/core/errors.mjs`. Standard codes: AUTH_REQUIRED, CHALLENGE, BAD_RESPONSE, PAGE_UNRECOGNIZED, CDP_UNAVAILABLE, NOT_AVAILABLE, CANCELLED, INVALID_INPUT. No signed URL query strings or raw credential values in diagnostic messages.

## Data

- Course: `{id, classId, name, contextId}`. IDs are strings; contextId is the platform cpi field.
- Deadline: `{raw, iso, certainty}`. iso is a UTC ISO string or null. certainty is explicit, timestamp, relative, inferred-year or unknown. Unzoned platform dates use Asia/Shanghai. Date-only values have no assumed hour. Validate dates. Explicit ISO timezone offsets take priority. Relative English and Chinese durations are supported.
- Task: `{id, externalId, kind, courseId, classId, courseName, title, status, deadline, url, sources, warnings}`. kind is assignment, exam, activity, task-package. status is pending, submitted, graded, completed, upcoming, ongoing, ended, expired, unknown. Never conflate an ended activity with personal completion. unknown remains visible in todo. Deduplicate only with stable identifiers plus course and class; preserve disagreements as unknown with a warning. No title-only identity merging. Do not derive scores from title numbers.
- Progress: `{courseId,classId,courseName,available,metrics,errors}`. metrics contain taskPoints `{completed,total,percent}`, points, rank, aiPractice `{completed,total}`, groupTask `{completed,total}`; unknown values are null.
- Snapshot: `{schemaVersion:1,startedAt,finishedAt,scope,courses,tasks,progress,coverage,warnings}`. scope contains course filter, sections, maxCourses, verifyCourseLists. coverage contains complete, interrupted, truncated, checkedCourses, selectedCourses, discoveredCourses, checks. Each check has source, courseId, classId, status (ok/failed), optional count/error. complete means selected implemented sources checked successfully, never a universal coverage guarantee.

## Parser module: src/adapters/parse.mjs

Public exports (functions must not access network or filesystem):

- `parseCourseCatalog(payload)` accepts JSON object or text, returns Course[].
- `readTaskPage(html, {kind, course, source, baseUrl, now})` returns `{items,nextUrl,hasMoreUnknown}`.
- `readActivities(payload, course, now)` returns Task[].
- `readTaskPackages(payload, course)` returns array with id/name/planCount/planFinishCount and platform metadata needed for plan requests.
- `normalizeLearningPlan(rawPlan, course, packageInfo, {url,deadlineText,now}={})` returns Task.
- `packageTask(packageInfo,course)` returns a visible task-package fallback.
- `parseStatistics({job,point,ai,group},course)` returns Progress; inputs are decoded JSON or null.
- `pageToken(html,name)` reads a named hidden input or quoted script assignment; does not evaluate scripts.
- `readDeadline(value,now)` returns Deadline.
- `assertPageUsable(html,url)` rejects login/challenge pages. HTML raw source must never be executed by parsers.

## Browser transport: src/cdp/session.mjs

Export `ChromeSession`. Constructor options `{endpoint,intervalMs,requestTimeoutMs,signal}`. Defaults endpoint from CHAOXING_CDP_URL or http://127.0.0.1:9444. `connect()` returns this; `close()` closes only owned worker pages and disconnects, preserving user Chrome and human verification pages. Other methods:

- `read(url,{method='GET',form,referer}={})` => `{text,url,status}`. Request uses browser credentials in its page context. Only HTTPS Chaoxing hosts and explicitly listed read POST endpoints. No Cookie export to Node or storage.
- `navigateCourseTab(course,tabName)` => `{text,url,status}`. Reuse a worker course page for its tabs. Browser click generates required signed iframe URL. Return page HTML without performing task actions.
- `openTask(url)` opens an explicitly requested task/metadata link and retains the user tab, returning title and status. Never dispatch exam/start/submit actions.
- `requestCount` counts reads. A new session must have requestCount=0.

## Orchestration: src/adapters/collect.mjs

Exports `collectSnapshot(session,options={})` and `fetchCourses(session)`.
Options: `{course,sections,maxCourses,verifyCourseLists,resolveDeadlines,ignoreCourses,signal,onStatus,onCheckpoint}`.
Sections: assignments, exams, activities, task-engine, progress; default all. onStatus emits compact progress, onCheckpoint is awaited after each completed course. ignoreCourses keys are `id:classId`.
Collect global work and two exam lists, then course-specific activity / task-engine / progress sources. verifyCourseLists additionally queries course 作业/考试 tabs. On source failure record a diagnostic; stop the run on CHALLENGE/AUTH_REQUIRED/CANCELLED. Preserve task packages if children cannot be read. Unknown pagination is partial. Filtered snapshots replace old data, with explicit scope. No invented IDs, signatures, time limits or completion flags.

## Platform observations and interface facts

These are URL/DOM/JSON interface facts used for interoperability, not source code:

- Course catalog GET `https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1`. JSON channelList; each channel has cpi and content. content.id is a class ID, or content.clazz.data[0].id. content.course.data entries have id/name. cpi may also appear in content.
- Global work GET `https://mooc1-api.chaoxing.com/work/stu-work`. Cards: `ul.nav > li`, link in data attribute, child `[role=option]` with paragraph title, span status/course, `.fr` remaining time. Observed statuses include uncommitted, To be marked, Completed.
- Global exams GET `https://mooc1-api.chaoxing.com/exam-ans/exam/phone/examcode`. Cards: `ul.ks_list > li`, dl/dt title, dd schedule, `.ks_state` status. data may contain relative link. Image names containing ks_02 indicate an expired exam.
- Additional exam list GET `https://mooc1.chaoxing.com/exam-ans/exam/test/examcode/examlist?edition=1&nohead=0&fid=`. `table.dataTable tr.dataTr` columns: index/title/time range/duration/exam state/answer state/score/method/action. Action can be a `go('URL')` handler; do not execute it. Link may carry a nested refer URL. A Finished exam plus Not submitted answer is expired, not personally completed.
- Current course cards use li with `.right-content`, title `.overHidden2`, state `.status`, remaining time `.time`. An action may be a nested data attribute. Unknown handlers should preserve a missing URL/ID rather than fabricate values.
- Empty labels: 暂无作业, 暂无考试, No assignment yet, No exam. Unknown HTML layout must raise PAGE_UNRECOGNIZED. Recognize explicit next-page links; report script pagination that cannot be followed.
- Link parameters can include taskrefId/workId/examId, courseId/courseid/moocId, clazzId/clazzid/classId. Preserve signed URLs locally, do not print them in diagnostics.
- Course entry GET `https://mooc1.chaoxing.com/visit/stucoursemiddle` with courseid, clazzid, cpi, ismooc2=1, v=2. It navigates to the course UI. `a[data-url]` labels may include NEW. Clicking 作业 / 考试 / 学习记录 replaces or updates a course iframe; its ID is not stable. Live DOM inspection observed initial `frame_content-hd` at `/page/active/stuActiveList`, then `frame_content-ks` at `/exam-ans/mooc2/exam/exam-list` after clicking 考试. Inspect all iframe elements and select the one whose src origin and path match the chosen anchor's resolved data-url, regardless of iframe ID. The static data-url does not include all required parameters. Do not fabricate stuenc or pEnc.
- Activities GET `https://mobilelearn.chaoxing.com/v2/apis/active/student/activelist` with fid=0, courseId, classId, showNotStartedActive=1. Response data.activeList. Fields include id/activeId, nameOne/name/title, activeType/type, status (1 running, 2 ended, 0 not started), startTime/endTime. Null or unknown status stays unknown. Classify by explicit type name or textual evidence; do not copy an unverified numeric type catalog.
- Task packages GET `https://mobilelearn.chaoxing.com/v2/apis/active/getData` with DB_STRATEGY=DEFAULT, courseId,classId. data is an array; id/name/planCount/planFinishCount/taskStudyProgress/userTaskQualifyStatus may appear. Endpoints are known but real nonempty payloads still require validation.
- Package landing GET `https://task.chaoxing.com/api/v1/middlePageApi/jumpStudyPlanList` with taskId,moocClassId. Alternate page `/userStudyPlan/studyPlanSubPage` with taskId,encryJumpGroupId=null. HTML can expose eTaskUserId; URL can expose encryTaskUserId.
- Task read POSTs under `https://task.chaoxing.com/userStudyPlan/`: getGroupData(encryTaskUserId), getPlanDataByGroupId(encryTaskUserId,encryGroupId), getToStudyUrl(encryTaskUserId,encryptPlanId,studyJumpType=0,isInterface=false). Parameters use query strings. Groups have encryptGroupId; plans have planId/encryptPlanId/name/planTypeName/planType/startDateStr/endDateStr/isFinish/planAllowStudy/planUser.finish/score.completed. Returned direct link is data.url with optional data.domainName. Completed exam viewing paths end in `/exam/test/look`.
- Only recognized exam-instruction metadata pages ending `/exam/test/examcode/examnotes` may be automatically read for missing deadlines. Never navigate an answer/start/player URL just to enrich metadata; retain a package link and unknown deadline.
- Statistics page is obtained by the course 学习记录 tab. pEnc comes from hidden input or assignment in its HTML. Read GET `https://stat2-ans.chaoxing.com/stat2/study-data/job`, `ai-evaluate-stat`, `groupTask`, and POST `point` using clazzid,courseid,cpi,ut=s,pEnc (form body for point). job.data contains job/publishJobNum/jobPer/jobRank; point JSON historically spells points `ponits`; ai.data has aiEvaluateReachCount/publishLibraryNum; group.data has taskNum/publishTaskNum. Missing fields stay unknown; no fabricated fallback credentials.
- Platform verification can use `/antispiderShowVerify.ac` and the text “【9010】操作异常，请输入图片中的验证码”. Stop, do not retry around it. Login redirects use passport2.chaoxing.com.

## Provenance and tests

Do not import or read earlier implementations. Write a genuinely new design, not renamed/reordered old code. Use fresh synthetic fixtures from these interface facts; mark nonempty task-engine behavior as unverified on a real account. Test errors and unknowns, not only the happy path. Never copy live personal data into committed tests.
