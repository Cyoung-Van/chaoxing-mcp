import { ClientFault } from '../core/errors.mjs';
import { assertPageUsable } from '../adapters/parse.mjs';

const READ_POSTS=new Set([
  'https://task.chaoxing.com/userStudyPlan/getGroupData',
  'https://task.chaoxing.com/userStudyPlan/getPlanDataByGroupId',
  'https://task.chaoxing.com/userStudyPlan/getToStudyUrl',
  'https://stat2-ans.chaoxing.com/stat2/study-data/point',
]);
const LOOPBACK=new Set(['127.0.0.1','localhost','[::1]']);
const STOP=new Set(['AUTH_REQUIRED','CHALLENGE','CANCELLED']);
function cancelled(signal){if(signal?.aborted)throw new ClientFault('CANCELLED','Browser operation cancelled.');}
function validatedUrl(raw,{opening=false,method='GET'}={}){
  let url;try{url=new URL(raw);}catch{throw new ClientFault('INVALID_INPUT','A valid platform URL is required.');}
  if(url.protocol!=='https:'||!/(^|\.)chaoxing\.com$/i.test(url.hostname)||url.username||url.password||(url.port&&url.port!=='443'))throw new ClientFault('INVALID_INPUT','Only HTTPS Chaoxing addresses are allowed.');
  if(!['GET','POST'].includes(method)||method==='POST'&&!READ_POSTS.has(url.origin+url.pathname))throw new ClientFault('INVALID_INPUT','This is not an allowed read request.');
  const dangerous=/(?:^|\/)[^/]*(?:submit|delete|signin|checkin|player|video|teststart|starttest|startexam|goexam|doexam|examstart)[^/]*(?:\/|$)/i;
  if(dangerous.test(url.pathname)||/(?:^|\/)start(?:\/|$)/i.test(url.pathname))throw new ClientFault('INVALID_INPUT','Action and playback routes are not allowed.');
  if(!opening&&/(?:^|\/)[^/]*(?:answer|dohomework|workdo)[^/]*(?:\/|$)/i.test(url.pathname))throw new ClientFault('INVALID_INPUT','Answer pages are not automatic metadata sources.');
  if(opening&&/\/exam[^/]*\//i.test(url.pathname)&&!/(?:\/examnotes|\/look|\/examcode|\/examlist)\/?$/i.test(url.pathname))throw new ClientFault('INVALID_INPUT','Only exam metadata or completed-exam viewing links may be opened.');
  return url;
}
function wait(ms,signal){cancelled(signal);return new Promise((resolve,reject)=>{const finish=()=>{signal?.removeEventListener('abort',abort);resolve();};const timer=setTimeout(finish,ms);const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new ClientFault('CANCELLED','Browser operation cancelled.'));};signal?.addEventListener('abort',abort,{once:true});});}

/** Browser-only authenticated transport. It never reads or exports cookies. */
export class ChromeSession {
  constructor({endpoint=process.env.CHAOXING_CDP_URL||'http://127.0.0.1:9444',intervalMs=1500,requestTimeoutMs=30000,signal}={}){
    if(!Number.isFinite(intervalMs)||intervalMs<0||!Number.isFinite(requestTimeoutMs)||requestTimeoutMs<1)throw new ClientFault('INVALID_INPUT','Browser timing options must be finite positive values (interval may be zero).');
    this.endpoint=endpoint;this.intervalMs=intervalMs;this.requestTimeoutMs=requestTimeoutMs;this.signal=signal;this.requestCount=0;
    this._socket=null;this._pending=new Map();this._listeners=new Set();this._pages=new Map();this._origins=new Map();this._courses=new Map();this._serial=Promise.resolve();this._nextId=0;this._lastRequest=0;this._closed=false;this._stopped=null;
  }
  async connect(){
    cancelled(this.signal);if(this._socket?.readyState===1)return this;
    let endpoint;try{endpoint=new URL(this.endpoint);}catch{throw new ClientFault('INVALID_INPUT','A loopback CDP HTTP endpoint is required.');}
    if(!['http:','https:'].includes(endpoint.protocol)||!LOOPBACK.has(endpoint.hostname)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new ClientFault('INVALID_INPUT','CDP must use a loopback HTTP endpoint.');
    try{
      const signal=this.signal?AbortSignal.any([this.signal,AbortSignal.timeout(this.requestTimeoutMs)]):AbortSignal.timeout(this.requestTimeoutMs);
      const response=await fetch(new URL('/json/version',endpoint),{signal,redirect:'error'});if(!response.ok)throw new Error('CDP metadata unavailable');
      const metadata=await response.json();const socketUrl=new URL(metadata.webSocketDebuggerUrl);
      if(!['ws:','wss:'].includes(socketUrl.protocol)||!LOOPBACK.has(socketUrl.hostname)||socketUrl.username||socketUrl.password)throw new ClientFault('CDP_UNAVAILABLE','CDP returned a non-loopback debugger address.');
      const socket=new WebSocket(socketUrl);this._socket=socket;
      socket.addEventListener('message',event=>this._message(event));
      socket.addEventListener('close',()=>this._disconnectPending());
      await new Promise((resolve,reject)=>{
        const cleanup=()=>{clearTimeout(timer);socket.removeEventListener('open',opened);socket.removeEventListener('error',failed);this.signal?.removeEventListener('abort',aborted);};
        const opened=()=>{cleanup();resolve();};const failed=()=>{cleanup();reject(new ClientFault('CDP_UNAVAILABLE','Could not connect to the Chromium debugger.'));};
        const aborted=()=>{cleanup();socket.close();reject(new ClientFault('CANCELLED','Browser connection cancelled.'));};
        const timer=setTimeout(()=>{cleanup();socket.close();reject(new ClientFault('CDP_UNAVAILABLE','Chromium debugger connection timed out.'));},this.requestTimeoutMs);
        socket.addEventListener('open',opened,{once:true});socket.addEventListener('error',failed,{once:true});this.signal?.addEventListener('abort',aborted,{once:true});
      });
      return this;
    }catch(error){if(error instanceof ClientFault)throw error;cancelled(this.signal);throw new ClientFault('CDP_UNAVAILABLE','Could not connect to the loopback Chromium debugger.');}
  }
  _message(event){
    let message;try{message=JSON.parse(typeof event.data==='string'?event.data:String(event.data));}catch{return;}
    if(message.id){const pending=this._pending.get(message.id);if(!pending)return;this._pending.delete(message.id);pending.cleanup();if(message.error)pending.reject(new ClientFault('CDP_UNAVAILABLE','Chromium rejected a browser operation.'));else pending.resolve(message.result??{});return;}
    for(const listener of this._listeners)listener(message);
  }
  _disconnectPending(){for(const pending of this._pending.values()){pending.cleanup();pending.reject(new ClientFault('CDP_UNAVAILABLE','Chromium debugger disconnected.'));}this._pending.clear();}
  _command(method,params={},sessionId,{cleanup=false}={}){
    if(!cleanup)cancelled(this.signal);
    if(this._socket?.readyState!==1)return Promise.reject(new ClientFault('CDP_UNAVAILABLE','Chromium debugger is not connected.'));
    const id=++this._nextId;
    return new Promise((resolve,reject)=>{
      const dispose=()=>{clearTimeout(timer);this.signal?.removeEventListener('abort',aborted);};
      const aborted=()=>{this._pending.delete(id);dispose();reject(new ClientFault('CANCELLED','Browser operation cancelled.'));};
      const timer=setTimeout(()=>{this._pending.delete(id);dispose();reject(new ClientFault('CDP_UNAVAILABLE','Chromium operation timed out.'));},this.requestTimeoutMs);
      this._pending.set(id,{resolve,reject,cleanup:dispose});if(!cleanup)this.signal?.addEventListener('abort',aborted,{once:true});
      try{this._socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}catch{this._pending.delete(id);dispose();reject(new ClientFault('CDP_UNAVAILABLE','Chromium debugger connection is unavailable.'));}
    });
  }
  _enqueue(operation){const run=this._serial.then(async()=>{cancelled(this.signal);if(this._stopped)throw this._stopped;if(this._closed)throw new ClientFault('CDP_UNAVAILABLE','Browser session is closed.');const delay=this.intervalMs-(Date.now()-this._lastRequest);if(delay>0)await wait(delay,this.signal);this._lastRequest=Date.now();try{return await operation();}catch(error){if(STOP.has(error?.code))this._stopped=error;throw error;}});this._serial=run.catch(()=>{});return run;}
  async _newPage({retained=false}={}){
    await this.connect();const {targetId}=await this._command('Target.createTarget',{url:'about:blank'});
    const page={targetId,sessionId:null,retained,frameId:null,responses:new Map(),url:'about:blank'};this._pages.set(targetId,page);
    const attached=await this._command('Target.attachToTarget',{targetId,flatten:true});page.sessionId=attached.sessionId;
    await this._command('Page.enable',{},page.sessionId);await this._command('Runtime.enable',{},page.sessionId);await this._command('Network.enable',{},page.sessionId);
    page.listener=event=>{if(event.sessionId!==page.sessionId)return;if(event.method==='Network.responseReceived'&&event.params?.type==='Document')page.responses.set(event.params.frameId,{url:event.params.response.url,status:event.params.response.status,requestId:event.params.requestId});};this._listeners.add(page.listener);return page;
  }
  async _evaluate(page,expression){const result=await this._command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},page.sessionId);if(result.exceptionDetails)throw new ClientFault('BAD_RESPONSE','The platform page could not be read in its browser context.');return result.result?.value;}
  async _navigate(page,url,referer){
    page.responses.clear();let loaded=false;
    const listener=event=>{if(event.sessionId===page.sessionId&&event.method==='Page.loadEventFired')loaded=true;};this._listeners.add(listener);
    try{const result=await this._command('Page.navigate',{url,...(referer?{referrer:referer}:{})},page.sessionId);if(result.errorText)throw new ClientFault('BAD_RESPONSE','Chromium could not load the platform page.');page.frameId=result.frameId;
      const start=Date.now();while(!loaded){cancelled(this.signal);if(Date.now()-start>this.requestTimeoutMs)throw new ClientFault('CDP_UNAVAILABLE','Platform page load timed out.');await wait(50,this.signal);}
      const body=await this._evaluate(page,'({text:/json|text\\/plain/i.test(document.contentType)?document.body?.innerText??"":document.documentElement.outerHTML,url:location.href,title:document.title})');
      if(!body||typeof body.text!=='string')throw new ClientFault('BAD_RESPONSE','Platform page had no readable document.');page.url=body.url;
      const response=page.responses.get(page.frameId);
      // Network bytes preserve JSON delivered with text/html MIME and avoid the
      // document wrapper Chromium adds while rendering such responses.
      if(response?.requestId){
        try{const original=await this._command('Network.getResponseBody',{requestId:response.requestId},page.sessionId);
          if(typeof original.body==='string')body.text=original.base64Encoded?new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(original.body,'base64')):original.body;
        }catch(error){if(error?.code==='CANCELLED')throw error;/* Response body unavailable: retain the readable DOM fallback. */}
      }
      return {...body,status:response?.status??0};
    }finally{this._listeners.delete(listener);}
  }
  _accept(page,response){
    try{assertPageUsable(response.text,response.url);if(response.status===401||response.status===403)throw new ClientFault('AUTH_REQUIRED','The platform denied access; sign in or verify the session.');if(!Number.isFinite(response.status)||response.status<200||response.status>=300)throw new ClientFault('BAD_RESPONSE',`Platform returned HTTP ${Number.isFinite(response.status)?response.status:'unknown'}.`);validatedUrl(response.url);return response;}
    catch(error){if(['AUTH_REQUIRED','CHALLENGE'].includes(error?.code))page.retained=true;throw error;}
  }
  async read(url,{method='GET',form,referer}={}){
    method=String(method).toUpperCase();const target=validatedUrl(url,{method});if(referer)validatedUrl(referer);if(method==='GET'&&form)throw new ClientFault('INVALID_INPUT','GET read requests cannot have a form body.');
    return this._enqueue(async()=>{this.requestCount++;let page=this._origins.get(target.origin);if(!page){page=await this._newPage();this._origins.set(target.origin,page);}
      if(method==='GET')return this._accept(page,await this._navigate(page,target.href,referer));
      if(new URL(page.url).origin!==target.origin){const bootstrap=await this._navigate(page,referer&&new URL(referer).origin===target.origin?referer:target.origin+'/');try{assertPageUsable(bootstrap.text,bootstrap.url);}catch(error){if(['AUTH_REQUIRED','CHALLENGE'].includes(error?.code))page.retained=true;throw error;}page.url=bootstrap.url;if(new URL(page.url).origin!==target.origin){page.retained=true;throw new ClientFault('AUTH_REQUIRED','The read request could not establish the platform origin.');}}
      const request={url:target.href,method,timeoutMs:Math.max(1,this.requestTimeoutMs-Math.min(250,this.requestTimeoutMs/10)),...(form?{body:new URLSearchParams(Object.entries(form).filter(([,v])=>v!==null&&v!==undefined).map(([k,v])=>[k,String(v)])).toString()}:{}),...(referer?{referrer:referer}:{})};
      const expression=`(async()=>{const request=${JSON.stringify(request)};const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),request.timeoutMs);try{const response=await fetch(request.url,{method:request.method,credentials:'include',signal:controller.signal,redirect:'follow',...(request.body!==undefined?{body:request.body,headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'}}:{}),...(request.referrer?{referrer:request.referrer}:{})});return {text:await response.text(),url:response.url,status:response.status};}finally{clearTimeout(timer);}})()`;
      const result=await this._evaluate(page,expression);return this._accept(page,result);
    });
  }
  async navigateCourseTab(course,tabName){
    if(!['作业','考试','学习记录'].includes(tabName)||!course?.id||!course?.classId||!course?.contextId)throw new ClientFault('INVALID_INPUT','A catalog course and supported read tab are required.');
    return this._enqueue(async()=>{this.requestCount++;const courseKey=`${course.id}:${course.classId}`;let page=this._courses.get(courseKey);
      if(!page){page=this._courses.values().next().value??await this._newPage();this._courses.clear();this._courses.set(courseKey,page);page.lastTab=null;const entry=new URL('https://mooc1.chaoxing.com/visit/stucoursemiddle');for(const [name,value]of Object.entries({courseid:course.id,clazzid:course.classId,cpi:course.contextId,ismooc2:1,v:2}))entry.searchParams.set(name,String(value));this._accept(page,await this._navigate(page,entry.href));}
      const selection=await this._evaluate(page,`(()=>{const wanted=${JSON.stringify(tabName)};const link=[...document.querySelectorAll('a[data-url]')].find(item=>item.textContent.replace(/NEW/gi,'').replace(/\\s+/g,'')===wanted);if(!link)return null;const rawTarget=link.getAttribute('data-url');if(!rawTarget)return null;let targetUrl;try{targetUrl=new URL(rawTarget,location.href).href;}catch{return null;}link.click();return {targetUrl};})()`);
      if(!selection?.targetUrl)throw new ClientFault('NOT_AVAILABLE','The course read tab did not expose a usable target URL.');
      validatedUrl(selection.targetUrl);
      const start=Date.now();let frameUrl;
      while(Date.now()-start<this.requestTimeoutMs){
        cancelled(this.signal);
        frameUrl=await this._evaluate(page,`(()=>{const targetUrl=${JSON.stringify(selection.targetUrl)};const desired=new URL(targetUrl);for(const frame of document.querySelectorAll('iframe')){try{const current=new URL(frame.src,location.href);if(current.origin===desired.origin&&current.pathname===desired.pathname)return current.href;}catch{}}return null;})()`);
        if(frameUrl)break;
        await wait(100,this.signal);
      }
      if(!frameUrl)throw new ClientFault('NOT_AVAILABLE','The course tab did not provide a matching signed frame URL.');
      validatedUrl(frameUrl);page.lastTab=tabName;
      // A second owned document reads the URL generated by the real click. The course UI stays reusable.
      if(!page.reader)page.reader=await this._newPage();
      return this._accept(page.reader,await this._navigate(page.reader,frameUrl,page.url));
    });
  }
  async openTask(url){const target=validatedUrl(url,{opening:true});return this._enqueue(async()=>{const page=await this._newPage({retained:true});const response=await this._navigate(page,target.href);try{assertPageUsable(response.text,response.url);}catch(error){if(STOP.has(error?.code))this._stopped=error;throw error;}if(response.status<200||response.status>=300)throw new ClientFault('BAD_RESPONSE',`Platform returned HTTP ${response.status}.`);return {title:response.title??'',status:response.status};});}
  async close(){
    this._closed=true;await this._serial.catch(()=>{});
    for(const page of this._pages.values()){
      if(page.listener)this._listeners.delete(page.listener);
      if(!page.retained){try{await this._command('Target.closeTarget',{targetId:page.targetId},undefined,{cleanup:true});}catch{}}
      else if(page.sessionId){try{await this._command('Target.detachFromTarget',{sessionId:page.sessionId},undefined,{cleanup:true});}catch{}}
    }
    this._pages.clear();this._origins.clear();this._courses.clear();this._socket?.close();this._disconnectPending();this._socket=null;
  }
}
