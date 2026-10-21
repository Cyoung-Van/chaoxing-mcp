import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSnapshot, fetchCourses } from '../src/adapters/collect.mjs';
import { ClientFault } from '../src/core/errors.mjs';

const course = { id:'course-1', classId:'class-1', name:'Synthetic', contextId:'ctx' };
const catalog = JSON.stringify({channelList:[{cpi:'ctx',content:{id:'class-1',course:{data:[{id:'course-1',name:'Synthetic'}]}}}]});
function session(overrides={}) {
  const calls=[];
  return { calls, async read(url, options) { calls.push({url,options});
    if (overrides.read) { const value=await overrides.read(url,options); if(value!==undefined)return value; }
    if(url.includes('backclazzdata'))return {text:catalog,url,status:200};
    if(url.includes('stu-work'))return {text:'<html>暂无作业</html>',url,status:200};
    if(url.includes('examcode'))return {text:'<html>暂无考试</html>',url,status:200};
    if(url.includes('activelist'))return {text:'{"data":{"activeList":[]}}',url,status:200};
    if(url.includes('getData'))return {text:'{"data":[]}',url,status:200};
    throw new Error('Unexpected synthetic endpoint');
  }, async navigateCourseTab(c, name) { calls.push({tab:name}); if(overrides.tab)return overrides.tab(c,name);return {text:'<input type="hidden" name="pEnc" value="synthetic">',url:'https://stat2-ans.chaoxing.com/stat2/study-data/index',status:200}; }};
}

test('catalog keeps class and context identifiers',async()=>assert.deepEqual(await fetchCourses(session()),[course]));
test('empty selected sources are explicitly checked and checkpoint awaited',async()=>{
  let saved=false;
  const s=session();
  const result=await collectSnapshot(s,{sections:['assignments','exams','activities','task-engine'],onCheckpoint:async snapshot=>{assert.equal(snapshot.coverage.checkedCourses,1);await Promise.resolve();saved=true;}});
  assert.equal(saved,true);assert.equal(result.coverage.complete,true);assert.equal(result.coverage.interrupted,false);
  assert.equal(result.coverage.checks.filter(c=>c.status==='ok').length,6);
  assert.equal(s.calls.filter(c=>c.url?.includes('examcode')).length,2);
  assert.deepEqual(result.tasks,[]);
});
test('activity failure produces failed coverage rather than an empty success',async()=>{
  const s=session({read:async url=>{if(url.includes('activelist'))throw new ClientFault('BAD_RESPONSE','Synthetic failure');}});
  const result=await collectSnapshot(s,{sections:['activities']});
  assert.equal(result.coverage.complete,false);assert.equal(result.coverage.interrupted,false);
  assert.equal(result.coverage.checks.at(-1).error.code,'BAD_RESPONSE');
});
test('challenge stops later sources and retains preceding tasks',async()=>{
  const s=session({read:async url=>{
    if(url.includes('activelist'))return {text:JSON.stringify({data:{activeList:[{id:'a-1',nameOne:'Synthetic activity',status:2}]}}),url,status:200};
    if(url.includes('getData'))throw new ClientFault('CHALLENGE','Verification required');
  }});
  const result=await collectSnapshot(s,{sections:['activities','task-engine','progress']});
  assert.equal(result.coverage.interrupted,true);assert.equal(result.coverage.complete,false);
  assert.equal(result.tasks.length,1);assert.equal(result.tasks[0].status,'ended');
  assert.equal(s.calls.some(c=>c.tab),false);
});
test('task package survives unreadable child groups',async()=>{
  const s=session({read:async url=>{
    if(url.includes('getData'))return {text:JSON.stringify({data:[{id:'pkg-1',name:'Synthetic package',planCount:3,planFinishCount:1}]}),url,status:200};
    if(url.includes('jumpStudyPlanList'))return {text:'<input type="hidden" name="eTaskUserId" value="synthetic-user">',url:'https://task.chaoxing.com/userStudyPlan/studyPlanSubPage?encryTaskUserId=synthetic-user',status:200};
    if(url.includes('getGroupData'))throw new ClientFault('BAD_RESPONSE','Synthetic group failure');
  }});
  const result=await collectSnapshot(s,{sections:['task-engine']});
  assert.equal(result.coverage.complete,false);assert.equal(result.tasks[0].kind,'task-package');
  assert.equal(result.coverage.checks.at(-1).status,'failed');
});
test('cancel before catalog returns an interrupted partial snapshot',async()=>{
  const controller=new AbortController();controller.abort();const s=session();
  const result=await collectSnapshot(s,{sections:['activities'],signal:controller.signal});
  assert.equal(s.calls.length,0);assert.equal(result.coverage.interrupted,true);assert.equal(result.coverage.complete,false);
});
test('course truncation is explicit, ignored classes excluded',async()=>{
  const s=session({read:async url=>{if(url.includes('backclazzdata'))return {text:JSON.stringify({channelList:[1,2,3].map(i=>({cpi:'ctx',content:{id:`class-${i}`,course:{data:[{id:`course-${i}`,name:`Synthetic ${i}`}]}}}))}),url,status:200};}});
  const result=await collectSnapshot(s,{sections:['activities'],maxCourses:1,ignoreCourses:['course-1:class-1']});
  assert.equal(result.coverage.discoveredCourses,3);assert.equal(result.coverage.selectedCourses,1);assert.equal(result.coverage.truncated,true);assert.equal(result.courses[0].id,'course-2');
});
test('HTTP errors are rejected even if transport returns parseable empty JSON',async()=>{
  const s=session({read:async url=>{if(url.includes('activelist'))return {text:'{"data":{"activeList":[]}}',url,status:503};}});
  const result=await collectSnapshot(s,{sections:['activities']});assert.equal(result.coverage.complete,false);assert.equal(result.coverage.checks.at(-1).error.code,'BAD_RESPONSE');
});
test('package fallback retains a usable platform landing link and declared missing children stay partial',async()=>{
  const s=session({read:async url=>{
    if(url.includes('getData'))return {text:'{"data":[{"id":"pkg-x","name":"Synthetic package","planCount":2}]}',url,status:200};
    if(url.includes('jumpStudyPlanList'))return {text:'<input type="hidden" name="eTaskUserId" value="synthetic">',url,status:200};
    if(url.includes('getGroupData'))return {text:'{"data":[]}',url,status:200};
  }});
  const result=await collectSnapshot(s,{sections:['task-engine']});
  assert.match(result.tasks[0].url,/jumpStudyPlanList/);assert.equal(result.coverage.complete,false);
});
test('unknown statistics payloads keep coverage partial',async()=>{
  const s=session({read:async url=>{if(url.includes('/study-data/'))return {text:'{"data":{"unrecognized":1}}',url,status:200};}});
  const result=await collectSnapshot(s,{sections:['progress']});
  assert.equal(result.progress[0].available,false);assert.equal(result.coverage.complete,false);assert.ok(result.progress[0].errors.length>0);
});
test('a later statistics challenge preserves earlier available metrics',async()=>{
  const s=session({read:async url=>{
    if(url.includes('/study-data/job'))return {text:'{"data":{"job":2,"publishJobNum":5,"jobPer":40}}',url,status:200};
    if(url.includes('/study-data/point'))throw new ClientFault('CHALLENGE','Synthetic verification required');
  }});
  const result=await collectSnapshot(s,{sections:['progress']});
  assert.equal(result.coverage.interrupted,true);assert.equal(result.progress[0].metrics.taskPoints.completed,2);
  assert.equal(result.progress[0].metrics.taskPoints.total,5);
});

test('maxCourses truncation cannot report complete collection',async()=>{
  const s=session({read:async url=>{if(url.includes('backclazzdata'))return {text:JSON.stringify({channelList:[1,2].map(i=>({cpi:'ctx',content:{id:`class-${i}`,course:{data:[{id:`course-${i}`,name:`Synthetic ${i}`}]}}}))}),url,status:200};}});
  const result=await collectSnapshot(s,{sections:['activities'],maxCourses:1});
  assert.equal(result.coverage.truncated,true);assert.equal(result.coverage.complete,false);
});
test('unmatched explicit course filter fails selection without querying global sources',async()=>{
  const s=session();const result=await collectSnapshot(s,{course:'missing-synthetic-course'});
  assert.equal(s.calls.length,1);assert.equal(result.coverage.complete,false);
  assert.equal(result.coverage.checks.at(-1).source,'selection');assert.equal(result.coverage.checks.at(-1).status,'failed');
  assert.equal(result.coverage.checks.at(-1).error.code,'NOT_AVAILABLE');
});

async function deadlineSnapshot(t,firstDeadline,secondDeadline,elapsed=30000){
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-21T02:00:00.000Z')});
  const taskUrl='https://mooc1.chaoxing.com/work/item?workId=synthetic-work&courseId=course-1&clazzId=class-1';
  const s=session({read:async url=>{if(url.includes('stu-work'))return {text:`<ul class="nav"><li data-url="${taskUrl}"><div role="option"><p>Synthetic task</p><span>uncommitted</span><span>Synthetic</span><span class="fr">${firstDeadline}</span></div></li></ul>`,url,status:200};},tab:async()=>{
    t.mock.timers.tick(elapsed);
    return {text:`<ul><li data-url="${taskUrl}"><div class="right-content"><div class="overHidden2">Synthetic task</div><div class="status">uncommitted</div><div class="time">${secondDeadline}</div></div></li></ul>`,url:'https://mooc1.chaoxing.com/work/list',status:200};
  }});
  const result=await collectSnapshot(s,{sections:['assignments'],verifyCourseLists:true});
  assert.equal(result.tasks.length,1);return result.tasks[0];
}
test('relative deadlines sampled 30 seconds apart remain consistent',async t=>{
  const task=await deadlineSnapshot(t,'剩余1小时','剩余1小时');
  assert.equal(task.deadline.certainty,'relative');assert.equal(task.deadline.iso,'2026-10-21T03:00:00.000Z');
  assert.equal(task.warnings.includes('Sources disagree about task deadline.'),false);
});
test('a consistent explicit deadline takes precedence over a relative estimate',async t=>{
  const task=await deadlineSnapshot(t,'剩余1小时','2026-10-21 11:00:30');
  assert.equal(task.deadline.certainty,'explicit');assert.equal(task.deadline.iso,'2026-10-21T03:00:30.000Z');
});
test('a relative estimate cannot replace a consistent explicit deadline',async t=>{
  const task=await deadlineSnapshot(t,'2026-10-21 11:00:00','剩余1小时');
  assert.equal(task.deadline.certainty,'explicit');assert.equal(task.deadline.iso,'2026-10-21T03:00:00.000Z');
});
test('different explicit deadlines remain conflicting even within 60 seconds',async t=>{
  const task=await deadlineSnapshot(t,'2026-10-21 11:00:00','2026-10-21 11:00:30');
  assert.equal(task.deadline.certainty,'unknown');assert.equal(task.deadline.iso,null);
  assert.ok(task.warnings.includes('Sources disagree about task deadline.'));
});
test('relative deadline disagreement greater than 60 seconds remains visible',async t=>{
  const task=await deadlineSnapshot(t,'剩余1小时','剩余1小时',90000);
  assert.equal(task.deadline.certainty,'unknown');assert.equal(task.deadline.iso,null);
});
