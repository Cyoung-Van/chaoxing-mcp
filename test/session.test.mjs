import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromeSession } from '../src/cdp/session.mjs';

test('session request counter starts at zero',()=>assert.equal(new ChromeSession().requestCount,0));
test('CDP endpoint must remain on loopback',async()=>{
  await assert.rejects(()=>new ChromeSession({endpoint:'http://example.org:9222'}).connect(),{code:'INVALID_INPUT'});
});
test('transport rejects arbitrary hosts and dangerous automatic routes before connection',async()=>{
  const s=new ChromeSession({intervalMs:0});
  for(const url of ['http://mooc1.chaoxing.com/work/list','https://evilchaoxing.com/work/list','https://mooc1.chaoxing.com/exam/test/start','https://mooc1.chaoxing.com/ananas/modules/video/index.html'])await assert.rejects(()=>s.read(url),{code:'INVALID_INPUT'});
  await assert.rejects(()=>s.read('https://task.chaoxing.com/userStudyPlan/submit',{method:'POST'}),{code:'INVALID_INPUT'});
  assert.equal(s.requestCount,0);
});
test('only named read POSTs allowed',async()=>{
  const s=new ChromeSession({intervalMs:0});
  await assert.rejects(()=>s.read('https://task.chaoxing.com/userStudyPlan/getGroupData',{method:'DELETE'}),{code:'INVALID_INPUT'});
  await assert.rejects(()=>s.openTask('https://mooc1.chaoxing.com/exam/test/answer'),{code:'INVALID_INPUT'});
});
test('already aborted sessions never connect',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>new ChromeSession({signal:controller.signal}).connect(),{code:'CANCELLED'});
});

async function withDebugger(run,{pageResponse,initialFrame=null,suppressClick=false,dynamicFrameIds=false}={}){
  const originalFetch=globalThis.fetch, OriginalWebSocket=globalThis.WebSocket;
  const commands=[],navigations=[],pages=new Map();let seq=0;
  class SyntheticSocket extends EventTarget{
    constructor(){super();this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
    emit(message){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(message)}));}
    send(raw){const call=JSON.parse(raw);commands.push(call);let result={};const page=pages.get(call.sessionId);
      if(call.method==='Target.createTarget'){result={targetId:`owned-${++seq}`};pages.set(`session-${seq}`,{targetId:result.targetId,frameId:`frame-${seq}`,url:'about:blank',frame:initialFrame,iframeDomId:'frame_content-hd'});}
      if(call.method==='Target.attachToTarget')result={sessionId:`session-${call.params.targetId.split('-').at(-1)}`};
      if(call.method==='Page.navigate'){page.url=call.params.url;navigations.push({url:page.url,time:Date.now(),sessionId:call.sessionId});const response=pageResponse?.(page.url)??{};page.data={text:response.text??'<html>Synthetic page</html>',url:response.url??page.url,title:'Synthetic title',status:response.status??200,rawBody:response.rawBody,base64Encoded:response.base64Encoded??false};result={frameId:page.frameId};
        queueMicrotask(()=>{this.emit({sessionId:call.sessionId,method:'Network.responseReceived',params:{type:'Document',frameId:page.frameId,requestId:`request-${page.frameId}`,response:{url:page.data.url,status:page.data.status}}});this.emit({sessionId:call.sessionId,method:'Page.loadEventFired',params:{}});});}
      if(call.method==='Network.getResponseBody'&&typeof page?.data?.rawBody==='string')result={body:page.data.rawBody,base64Encoded:page.data.base64Encoded};
      if(call.method==='Runtime.evaluate'){
        const expr=call.params.expression;let value;
        if(expr.startsWith('({text:'))value=page.data;
        else if(expr.includes('const request='))value={text:'{"data":[]}',url:JSON.parse(expr.match(/const request=(.*?);const (?:response|controller)/)[1]).url,status:200};
        else if(expr.includes('const wanted=')){const label=JSON.parse(expr.match(/const wanted=(.*?);const link/)[1]);const targetUrl=`https://mooc1.chaoxing.com/${label==='作业'?'work/list':label==='考试'?'exam/list':'stats/list'}`;const alreadySelected=page.frame?new URL(page.frame).origin===new URL(targetUrl).origin&&new URL(page.frame).pathname===new URL(targetUrl).pathname:false;if(!suppressClick){page.frame=targetUrl+'?synthetic=signed';if(dynamicFrameIds)page.iframeDomId=label==='作业'?'frame_content-zy':label==='考试'?'frame_content-ks':'frame_content-xj';}value=expr.includes('targetUrl')?{targetUrl,alreadySelected}:true;}
        else if(expr.includes('#frame_content-hd'))value=page.iframeDomId==='frame_content-hd'?page.frame:null;
        else if(expr.includes("querySelectorAll('iframe')")){const targetUrl=JSON.parse(expr.match(/const targetUrl=(.*?);/)[1]);value=page.frame&&new URL(page.frame).origin===new URL(targetUrl).origin&&new URL(page.frame).pathname===new URL(targetUrl).pathname?page.frame:null;}
        result={result:{value}};
      }
      queueMicrotask(()=>this.emit({id:call.id,result}));
    }
    close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
  }
  globalThis.fetch=async()=>({ok:true,json:async()=>({webSocketDebuggerUrl:'ws://127.0.0.1:9444/devtools/browser/synthetic'})});globalThis.WebSocket=SyntheticSocket;
  try{await run({commands,navigations,pages});}finally{globalThis.fetch=originalFetch;globalThis.WebSocket=OriginalWebSocket;}
}

test('native CDP reads are serial, reuse origin pages, and close only owned pages',async()=>withDebugger(async({commands,navigations})=>{
  const s=new ChromeSession({intervalMs:25,requestTimeoutMs:300});
  const result=await Promise.all([s.read('https://mobilelearn.chaoxing.com/example/one'),s.read('https://mobilelearn.chaoxing.com/example/two')]);
  assert.equal(result.length,2);assert.equal(s.requestCount,2);
  assert.equal(commands.filter(c=>c.method==='Target.createTarget').length,1);
  assert.ok(navigations[1].time-navigations[0].time>=20);
  assert.equal(commands.some(c=>/Cookie/.test(c.method)),false);
  await s.close();assert.deepEqual(commands.filter(c=>c.method==='Target.closeTarget').map(c=>c.params.targetId),['owned-1']);
}));
test('read POST executes credentialed fetch within the same browser origin',async()=>withDebugger(async({commands})=>{
  const s=new ChromeSession({intervalMs:0,requestTimeoutMs:300});
  const result=await s.read('https://task.chaoxing.com/userStudyPlan/getGroupData?encryTaskUserId=synthetic',{method:'POST'});
  assert.equal(result.status,200);assert.equal(result.text,'{"data":[]}');
  const expression=commands.find(c=>c.method==='Runtime.evaluate'&&c.params.expression.includes('const request=')).params.expression;
  assert.match(expression,/credentials:'include'/);assert.equal(commands.some(c=>/Cookie/.test(c.method)),false);
  await s.close();
}));
test('course tabs reuse their course page and use URLs produced by the click',async()=>withDebugger(async({commands,navigations})=>{
  const s=new ChromeSession({intervalMs:0,requestTimeoutMs:300});const course={id:'c',classId:'k',contextId:'ctx'};
  const work=await s.navigateCourseTab(course,'作业');const exams=await s.navigateCourseTab(course,'考试');
  assert.match(work.url,/work\/list\?synthetic=signed/);assert.match(exams.url,/exam\/list\?synthetic=signed/);
  assert.equal(navigations.filter(n=>n.url.includes('stucoursemiddle')).length,1);
  assert.equal(commands.filter(c=>c.method==='Target.createTarget').length,2);
  await s.close();
}));
test('verification pages are retained and later reads stop',async()=>withDebugger(async({commands})=>{
  const s=new ChromeSession({intervalMs:0,requestTimeoutMs:300});
  await assert.rejects(()=>s.read('https://mooc1.chaoxing.com/work/list'),{code:'CHALLENGE'});
  await assert.rejects(()=>s.read('https://mooc1.chaoxing.com/work/another'),{code:'CHALLENGE'});
  assert.equal(s.requestCount,1);await s.close();assert.equal(commands.filter(c=>c.method==='Target.closeTarget').length,0);
},{pageResponse:()=>({text:'【9010】操作异常，请输入图片中的验证码',url:'https://mooc1.chaoxing.com/antispiderShowVerify.ac'})}));
test('explicit task metadata opens survive session close',async()=>withDebugger(async({commands})=>{
  const s=new ChromeSession({intervalMs:0,requestTimeoutMs:300});
  assert.deepEqual(await s.openTask('https://mooc1.chaoxing.com/exam/test/examcode/examnotes?examId=synthetic'),{title:'Synthetic title',status:200});
  await s.close();assert.equal(commands.filter(c=>c.method==='Target.closeTarget').length,0);
}));
test('many courses share a bounded worker pair',async()=>withDebugger(async({commands})=>{
  const s=new ChromeSession({intervalMs:0,requestTimeoutMs:300});
  await s.navigateCourseTab({id:'c1',classId:'k1',contextId:'ctx'},'作业');
  await s.navigateCourseTab({id:'c2',classId:'k2',contextId:'ctx'},'考试');
  assert.equal(commands.filter(c=>c.method==='Target.createTarget').length,2);await s.close();
}));
test('browser POST fetch has an abortable deadline',async()=>withDebugger(async({commands})=>{
  const s=new ChromeSession({intervalMs:0,requestTimeoutMs:300});
  await s.read('https://task.chaoxing.com/userStudyPlan/getGroupData',{method:'POST'});
  const expression=commands.find(c=>c.method==='Runtime.evaluate'&&c.params.expression.includes('const request=')).params.expression;
  assert.match(expression,/AbortController/);assert.match(expression,/signal:controller.signal/);assert.match(expression,/clearTimeout/);await s.close();
}));
test('verification during POST origin establishment is retained',async()=>withDebugger(async({commands})=>{
  const s=new ChromeSession({intervalMs:0,requestTimeoutMs:300});
  await assert.rejects(()=>s.read('https://task.chaoxing.com/userStudyPlan/getGroupData',{method:'POST'}),{code:'CHALLENGE'});
  await s.close();assert.equal(commands.filter(c=>c.method==='Target.closeTarget').length,0);
},{pageResponse:()=>({text:'【9010】操作异常，请输入图片中的验证码',url:'https://task.chaoxing.com/antispiderShowVerify.ac'})}));


test('JSON served as text/html uses original main-document response instead of Chrome wrapper',async()=>withDebugger(async({commands})=>{
  const s=new ChromeSession({intervalMs:0,requestTimeoutMs:300});
  const result=await s.read('https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json');
  assert.deepEqual(JSON.parse(result.text),{result:1,channelList:[]});
  assert.ok(commands.some(c=>c.method==='Network.getResponseBody'&&c.params.requestId));await s.close();
},{pageResponse:()=>({text:'<html><head></head><body>{"result":1,"channelList":[]}</body></html>',rawBody:'{"result":1,"channelList":[]}'})}));
test('base64 network response bodies decode as UTF-8 without executing page source',async()=>withDebugger(async()=>{
  const s=new ChromeSession({intervalMs:0,requestTimeoutMs:300});
  const result=await s.read('https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json');
  assert.deepEqual(JSON.parse(result.text),{msg:'合成数据',channelList:[]});await s.close();
},{pageResponse:()=>({text:'<html><body>Chromium wrapper</body></html>',rawBody:Buffer.from(JSON.stringify({msg:'合成数据',channelList:[]}),'utf8').toString('base64'),base64Encoded:true})}));


test('a fresh course with the requested tab already active accepts its existing signed iframe',async()=>withDebugger(async({navigations})=>{
  const s=new ChromeSession({intervalMs:0,requestTimeoutMs:120});
  const result=await s.navigateCourseTab({id:'c1',classId:'k1',contextId:'ctx'},'作业');
  assert.equal(result.url,'https://mooc1.chaoxing.com/work/list?synthetic=signed');
  assert.equal(navigations.filter(item=>item.url.includes('/work/list')).length,1);await s.close();
},{initialFrame:'https://mooc1.chaoxing.com/work/list?synthetic=signed'}));
test('an unchanged iframe for a different tab is still rejected',async()=>withDebugger(async()=>{
  const s=new ChromeSession({intervalMs:0,requestTimeoutMs:120});
  await assert.rejects(()=>s.navigateCourseTab({id:'c1',classId:'k1',contextId:'ctx'},'考试'),{code:'NOT_AVAILABLE'});
  await s.close();
},{initialFrame:'https://mooc1.chaoxing.com/work/list?synthetic=signed',suppressClick:true}));


test('course tab reads follow the matching iframe when its DOM id changes',async()=>withDebugger(async({navigations})=>{
  const s=new ChromeSession({intervalMs:0,requestTimeoutMs:120});const course={id:'c1',classId:'k1',contextId:'ctx'};
  const exam=await s.navigateCourseTab(course,'考试');
  const work=await s.navigateCourseTab(course,'作业');
  assert.equal(exam.url,'https://mooc1.chaoxing.com/exam/list?synthetic=signed');
  assert.equal(work.url,'https://mooc1.chaoxing.com/work/list?synthetic=signed');
  assert.equal(navigations.filter(item=>item.url.includes('stucoursemiddle')).length,1);await s.close();
},{initialFrame:'https://mooc1.chaoxing.com/page/active/stuActiveList',dynamicFrameIds:true}));
