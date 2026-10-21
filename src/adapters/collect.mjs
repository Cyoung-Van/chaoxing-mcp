import { ClientFault, describeError } from '../core/errors.mjs';
import { parseCourseCatalog, readTaskPage, readActivities, readTaskPackages, normalizeLearningPlan, packageTask, parseStatistics, pageToken, readDeadline, assertPageUsable } from './parse.mjs';

const SECTIONS = ['assignments','exams','activities','task-engine','progress'];
const HALT = new Set(['AUTH_REQUIRED','CHALLENGE','CANCELLED']);
// Minute-rounded countdowns read serially can differ slightly. Only relative
// evidence receives this 60-second tolerance; explicit dates must agree exactly.
const RELATIVE_DEADLINE_TOLERANCE_MS = 60_000;
const CATALOG = 'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1';
const key = course => `${course.id}:${course.classId}`;
const address = (base, values) => { const url=new URL(base); for(const [name,value] of Object.entries(values)) if(value!==null && value!==undefined)url.searchParams.set(name,String(value));return url.href; };
const fault = message => new ClientFault('BAD_RESPONSE',message);
function checkSignal(signal) { if(signal?.aborted)throw new ClientFault('CANCELLED','Collection cancelled.'); }
function responseText(response) {
  if(!response || typeof response.text!=='string')throw fault('Browser response did not include text.');
  if(response.status===401 || response.status===403)throw new ClientFault('AUTH_REQUIRED','The platform denied access; sign in or verify the session.');
  if(!Number.isFinite(response.status) || response.status<200 || response.status>=300)throw fault(`Platform returned HTTP ${Number.isFinite(response.status)?response.status:'unknown'}.`);
  assertPageUsable(response.text,response.url??'');return response.text;
}
function decoded(response) {
  const text=responseText(response);let payload;
  try {payload=JSON.parse(text);}catch{throw fault('Expected JSON from a platform data source.');}
  if(!payload || typeof payload!=='object')throw fault('Platform data was not an object or array.');
  if(payload.result===false || payload.success===false || (Number.isFinite(payload.code)&&payload.code!==0&&payload.code!==200))throw fault('Platform reported a failed data request.');
  return payload;
}
function listData(payload, field) {
  const data=payload.data??payload;
  if(Array.isArray(data))return data;
  if(Array.isArray(data?.[field]))return data[field];
  throw fault(`Task engine did not return a recognized ${field} array.`);
}
export async function fetchCourses(session) { return parseCourseCatalog(responseText(await session.read(CATALOG))); }

/** Serial, evidence-preserving collection of implemented platform sources. */
export async function collectSnapshot(session,options={}) {
  const sections=options.sections??SECTIONS;
  if(!Array.isArray(sections)||sections.some(section=>!SECTIONS.includes(section)))throw new ClientFault('INVALID_INPUT','Unknown collection section.');
  const maxCourses=options.maxCourses??null;
  if(maxCourses!==null && (!Number.isSafeInteger(maxCourses)||maxCourses<1))throw new ClientFault('INVALID_INPUT','maxCourses must be a positive integer.');
  const snapshot={schemaVersion:1,startedAt:new Date().toISOString(),finishedAt:null,
    scope:{course:options.course??null,sections:[...new Set(sections)],maxCourses,verifyCourseLists:Boolean(options.verifyCourseLists)},
    courses:[],tasks:[],progress:[],coverage:{complete:false,interrupted:false,truncated:false,checkedCourses:0,selectedCourses:0,discoveredCourses:0,checks:[]},warnings:[]};
  let catalog=[];
  const status = value => options.onStatus?.(value);
  async function checked(source,course,operation) {
    const record={source,courseId:course?.id??null,classId:course?.classId??null,status:'failed'};
    snapshot.coverage.checks.push(record);
    try {checkSignal(options.signal);status({source,courseId:record.courseId,state:'reading'});const value=await operation();checkSignal(options.signal);record.status='ok';if(Array.isArray(value))record.count=value.length;status({source,courseId:record.courseId,state:'ok'});return value;}
    catch(error) {record.error=describeError(error);status({source,courseId:record.courseId,state:'failed',error:record.error});if(HALT.has(error?.code))throw error;return null;}
  }
  function enrich(item) {
    const candidates=catalog.filter(c=>(!item.courseId||c.id===String(item.courseId))&&(!item.classId||c.classId===String(item.classId))&&(item.courseId||item.classId||(item.courseName&&item.courseName===c.name)));
    const c=candidates.length===1?candidates[0]:null;
    if(c){item={...item,courseId:c.id,classId:c.classId,courseName:c.name};if(item.externalId)item.id=`${item.kind}:${c.id}:${c.classId}:${item.externalId}`;}
    return item;
  }
  function add(items) {
    for(let item of items){item=enrich(item);const scoped=snapshot.courses.some(c=>c.id===item.courseId&&c.classId===item.classId);
      if(item.courseId&&item.classId&&!scoped)continue;
      if(!item.courseId||!item.classId){item={...item,warnings:[...(item.warnings??[]),'Course identity is unresolved; this task cannot be confirmed within the selected scope.']};}
      const existing=item.externalId&&item.courseId&&item.classId?snapshot.tasks.find(t=>t.externalId===item.externalId&&t.courseId===item.courseId&&t.classId===item.classId&&t.kind===item.kind):null;
      if(!existing){snapshot.tasks.push(item);continue;}
      existing.sources=[...new Set([...(existing.sources??[]),...(item.sources??[])])];existing.warnings=[...new Set([...(existing.warnings??[]),...(item.warnings??[])])];
      if(existing.status!==item.status){existing.status='unknown';existing.warnings.push('Sources disagree about task status.');}
      if(existing.deadline?.iso&&item.deadline?.iso){
        const delta=Math.abs(Date.parse(existing.deadline.iso)-Date.parse(item.deadline.iso));
        const relative=existing.deadline.certainty==='relative'||item.deadline.certainty==='relative';
        const agrees=existing.deadline.iso===item.deadline.iso||(relative&&Number.isFinite(delta)&&delta<=RELATIVE_DEADLINE_TOLERANCE_MS);
        if(!agrees){existing.deadline={raw:[existing.deadline.raw,item.deadline.raw].filter(Boolean).join(' | '),iso:null,certainty:'unknown'};existing.warnings.push('Sources disagree about task deadline.');}
        else if(existing.deadline.certainty==='relative'&&['explicit','timestamp'].includes(item.deadline.certainty))existing.deadline=item.deadline;
      }else if(!existing.deadline?.iso&&item.deadline?.iso&&!existing.warnings.includes('Sources disagree about task deadline.'))existing.deadline=item.deadline;
      if(!existing.url&&item.url)existing.url=item.url;
    }
  }
  async function pageList(source,kind,course,initial) {
    let response=typeof initial==='string'?await session.read(initial):initial;const visited=new Set();const collected=[];
    for(;;){checkSignal(options.signal);const html=responseText(response);const url=response.url;
      if(visited.has(url))throw fault('Pagination repeated an already visited page.');visited.add(url);
      const page=readTaskPage(html,{kind,course,source,baseUrl:url,now:new Date()});add(page.items);collected.push(...page.items);
      if(page.hasMoreUnknown)throw new ClientFault('NOT_AVAILABLE','The page indicates additional results, but its pagination is not a recognized read link.');
      if(!page.nextUrl)return collected;
      response=await session.read(new URL(page.nextUrl,url).href);
    }
  }
  async function packages(course) {
    const base={courseId:course.id,classId:course.classId,DB_STRATEGY:'DEFAULT'};
    const packages=await checked('task-engine:packages',course,async()=>readTaskPackages(decoded(await session.read(address('https://mobilelearn.chaoxing.com/v2/apis/active/getData',base))),course));
    if(!packages)return;
    if(packages.length)snapshot.warnings.push('Nonempty task-engine responses have synthetic coverage; real-account interoperability remains unverified.');
    for(const pkg of packages){checkSignal(options.signal);const landingUrl=address('https://task.chaoxing.com/api/v1/middlePageApi/jumpStudyPlanList',{taskId:pkg.id,moocClassId:course.classId});pkg.url=landingUrl;add([packageTask(pkg,course)]);
      await checked('task-engine:children',course,async()=>{
        if(!pkg.id)throw fault('Task package has no stable identifier.');
        let landing;
        try{landing=await session.read(landingUrl);responseText(landing);}catch(error){if(HALT.has(error?.code))throw error;landing=await session.read(address('https://task.chaoxing.com/userStudyPlan/studyPlanSubPage',{taskId:pkg.id,encryJumpGroupId:'null'}));responseText(landing);}
        const encryTaskUserId=new URL(landing.url).searchParams.get('encryTaskUserId')||pageToken(landing.text,'eTaskUserId');
        if(!encryTaskUserId)throw fault('Task package did not expose its required user token.');
        const post=async(endpoint,params)=>decoded(await session.read(address(`https://task.chaoxing.com/userStudyPlan/${endpoint}`,{encryTaskUserId,...params}),{method:'POST',referer:landing.url}));
        const groups=listData(await post('getGroupData',{}),'groupList');const plans=[];
        for(const group of groups){checkSignal(options.signal);if(!group.encryptGroupId)throw fault('Task group did not include its platform identifier.');
          const children=listData(await post('getPlanDataByGroupId',{encryGroupId:group.encryptGroupId}),'planList');
          for(const raw of children){checkSignal(options.signal);let task=normalizeLearningPlan(raw,course,pkg,{url:landing.url,now:new Date()});add([task]);plans.push(task);
            if(!raw.encryptPlanId)continue;
            await checked('task-engine:link',course,async()=>{
              const resolved=await post('getToStudyUrl',{encryptPlanId:raw.encryptPlanId,studyJumpType:0,isInterface:false});
              const data=resolved.data;if(typeof data?.url!=='string'||!data.url)throw fault('Task engine did not return a readable task link.');
              let link;try{link=new URL(data.url,data.domainName||landing.url).href;}catch{throw fault('Task engine returned an invalid task link.');}
              const parsed=new URL(link);if(parsed.protocol!=='https:'||!/(^|\.)chaoxing\.com$/i.test(parsed.hostname))throw fault('Task engine returned an unsupported task host.');
              task={...task,url:link};
              if(options.resolveDeadlines!==false&&!task.deadline?.iso&&/\/exam\/test\/examcode\/examnotes\/?$/.test(parsed.pathname)){
                const metadata=await session.read(link);const html=responseText(metadata);
                const plain=html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
                const deadlineText=pageToken(html,'endTime')||plain.match(/(?:截止时间|结束时间|Deadline|End time)\s*[:：]?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/i)?.[1];
                if(deadlineText)task={...task,deadline:readDeadline(deadlineText,new Date())};
              }
              const index=snapshot.tasks.findIndex(item=>task.id&&item.id===task.id);if(index>=0)snapshot.tasks[index]={...snapshot.tasks[index],url:task.url,deadline:task.deadline};
              return [task];
            });
          }
        }
        if(Number.isFinite(pkg.planCount)&&plans.length<pkg.planCount)throw new ClientFault('NOT_AVAILABLE','Task package declares more plans than its readable children.');
        return plans;
      });
    }
  }
  async function statistics(course) {
    const values={job:null,point:null,ai:null,group:null};const errors=[];
    try {
    const page=await checked('progress:page',course,async()=>{const result=await session.navigateCourseTab(course,'学习记录');responseText(result);return result;});
    if(page){const pEnc=pageToken(page.text,'pEnc');
      if(!pEnc){const error={code:'NOT_AVAILABLE',message:'Statistics page did not expose pEnc.'};errors.push(error);snapshot.coverage.checks.push({source:'progress:token',courseId:course.id,classId:course.classId,status:'failed',error});}
      else for(const [name,path] of [['job','job'],['point','point'],['ai','ai-evaluate-stat'],['group','groupTask']]){
        const params={clazzid:course.classId,courseid:course.id,cpi:course.contextId,ut:'s',pEnc};
        values[name]=await checked(`progress:${name}`,course,async()=>decoded(await session.read(name==='point'?`https://stat2-ans.chaoxing.com/stat2/study-data/${path}`:address(`https://stat2-ans.chaoxing.com/stat2/study-data/${path}`,params),name==='point'?{method:'POST',form:params,referer:page.url}:{referer:page.url})));
        if(values[name]===null)errors.push(snapshot.coverage.checks.at(-1).error);
      }
    }else errors.push(snapshot.coverage.checks.at(-1).error);
    } finally {
    const lastCheck=snapshot.coverage.checks.at(-1);if(lastCheck?.status==='failed'&&lastCheck.source.startsWith('progress:')&&!errors.includes(lastCheck.error))errors.push(lastCheck.error);
    const progress=parseStatistics(values,course);progress.errors=[...(progress.errors??[]),...errors];snapshot.progress.push(progress);for(const error of progress.errors){if(error?.source&&!snapshot.coverage.checks.some(check=>check.courseId===course.id&&check.classId===course.classId&&check.source===`progress:${error.source}`&&check.status==='failed'))snapshot.coverage.checks.push({source:`progress:${error.source}`,courseId:course.id,classId:course.classId,status:'failed',error:describeError(error)});}
    }
  }
  try{
    catalog=await checked('courses',null,()=>fetchCourses(session));
    if(!catalog)throw new ClientFault('NOT_AVAILABLE','Course catalog was unavailable.');
    snapshot.coverage.discoveredCourses=catalog.length;
    const ignored=new Set(options.ignoreCourses??[]);const filter=options.course;
    let selected=catalog.filter(c=>!ignored.has(key(c))&&(!filter||[c.id,c.classId,key(c),c.name].some(value=>String(value).toLowerCase().includes(String(filter).toLowerCase()))));
    if(filter&&!selected.length){const error=new ClientFault('NOT_AVAILABLE','No catalog courses matched the requested filter.');snapshot.coverage.checks.push({source:'selection',courseId:null,classId:null,status:'failed',count:0,error:describeError(error)});throw error;}
    if(maxCourses!==null&&selected.length>maxCourses){selected=selected.slice(0,maxCourses);snapshot.coverage.truncated=true;}
    snapshot.courses=selected;snapshot.coverage.selectedCourses=selected.length;
    if(sections.includes('assignments'))await checked('assignments:global',null,()=>pageList('assignments:global','assignment',null,'https://mooc1-api.chaoxing.com/work/stu-work'));
    if(sections.includes('exams')){
      await checked('exams:phone',null,()=>pageList('exams:phone','exam',null,'https://mooc1-api.chaoxing.com/exam-ans/exam/phone/examcode'));
      await checked('exams:table',null,()=>pageList('exams:table','exam',null,'https://mooc1.chaoxing.com/exam-ans/exam/test/examcode/examlist?edition=1&nohead=0&fid='));
    }
    for(const course of selected){checkSignal(options.signal);
      if(options.verifyCourseLists){
        if(sections.includes('assignments'))await checked('assignments:course',course,async()=>pageList('assignments:course','assignment',course,await session.navigateCourseTab(course,'作业')));
        if(sections.includes('exams'))await checked('exams:course',course,async()=>pageList('exams:course','exam',course,await session.navigateCourseTab(course,'考试')));
      }
      if(sections.includes('activities')){const items=await checked('activities',course,async()=>readActivities(decoded(await session.read(address('https://mobilelearn.chaoxing.com/v2/apis/active/student/activelist',{fid:0,courseId:course.id,classId:course.classId,showNotStartedActive:1}))),course,new Date()));if(items)add(items);}
      if(sections.includes('task-engine'))await packages(course);
      if(sections.includes('progress'))await statistics(course);
      snapshot.coverage.checkedCourses++;snapshot.finishedAt=new Date().toISOString();if(options.onCheckpoint)await options.onCheckpoint(structuredClone(snapshot));
    }
  }catch(error){if(HALT.has(error?.code))snapshot.coverage.interrupted=true;
    if(!snapshot.coverage.checks.some(check=>check.error?.code===error?.code))snapshot.coverage.checks.push({source:'collection',courseId:null,classId:null,status:'failed',error:describeError(error)});
  }
  snapshot.finishedAt=new Date().toISOString();snapshot.coverage.complete=!snapshot.coverage.interrupted&&!snapshot.coverage.truncated&&snapshot.coverage.checks.length>0&&snapshot.coverage.checks.every(check=>check.status==='ok');
  snapshot.warnings=[...new Set(snapshot.warnings)];return snapshot;
}
