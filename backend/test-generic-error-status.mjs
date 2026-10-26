import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {ServerResponse} from 'node:http';
import {fileURLToPath} from 'node:url';
// SOURCE ONLY: not executed on this candidate. Run only after separate validation approval.
// No imports of production modules, server/listener, database, provider or network.
const candidate=fileURLToPath(new URL('../',import.meta.url));
const base=process.argv[2]??fileURLToPath(new URL('../../route-log-final-runtime-candidate-20261021/',import.meta.url));
const MARK='SYNTHETIC_PRIVACY_CANARY_42';
const codes=['INVALID_REQUEST','NOT_FOUND','CONFLICT','FORBIDDEN','RATE_LIMITED','CANCELLED','UNAVAILABLE'];
const groups={organization:['list','get','serviceStatistics','inspectTarget'],automation:['listSkills','getSkill','listDataSources','getDataSource','listSchedules','getSchedule','listRuns','listNotifications'],'service-reports':['scope','customers','inspectSource','listActivities','getActivity','createActivity','correctActivity','archiveActivity','createReport','getReport','archiveReport','listReports','previewServiceRecord','importServiceRecord','exportReport','recoverCommand','cancelCommand'],'manual-plans':['get','list','create','update','setState','reopen','remove','restore']};
const source=path=>fs.readFileSync(path+'/backend/server.mjs','utf8');
const normalize=x=>JSON.parse(JSON.stringify(x,(_,v)=>typeof v==='function'?'[function]':v));
function handler(src,state){
 const routes=src.slice(src.indexOf('const routes='),src.indexOf('\nconst dist='));
 const start=src.indexOf('const server=createServer(')+'const server=createServer('.length;
 const end=src.indexOf('\n});\nserver.requestTimeout');
 const callback=src.slice(start,end+2);
 assert(callback.startsWith('async(req,res)=>{'));
 const domain=async(_ctx,input)=>{state.calls.push(normalize(input));if(state.scenario.domainThrow)throw state.scenario.error;if(state.scenario.export){return {checkPublication(){state.publications++;if(state.scenario.publicationThrow)throw state.scenario.error},filename:state.scenario.badFilename?'../'+MARK:'synthetic.json',headers:{'Cache-Control':'no-store','X-Synthetic':MARK},mediaType:'application/json',content:Buffer.from(MARK),scope:MARK,reportId:MARK,revision:7,snapshotSha256:MARK};}return state.scenario.result??{payload:MARK,id:MARK,query:MARK,body:MARK,idempotencyKey:MARK,commandOutcome:{proof:MARK}};};
 const service=new Proxy({}, {get(){return domain}});
 const app={context(){return {}},identity:{identityScope:MARK,syntheticSourcePin:{documentId:'synthetic-doc',revisionId:'v1'}},organization:service,automation:service,manualPlans:service,reports:service,bridge:service,customers:(_ctx,input)=>{state.calls.push(normalize(input));if(state.scenario.domainThrow)throw state.scenario.error;return {customers:MARK}}};
 // Scope is synchronous in the actual app. The synthetic stub must match it.
 app.reports=new Proxy({}, {get(_t,key){return key==='scope'?(_ctx)=>{state.calls.push({});if(state.scenario.domainThrow)throw state.scenario.error;return {scope:MARK}}:domain}});
 const event=x=>{state.events.push(normalize(x));state.logCalls++;if(state.scenario.logFail==='always'||state.scenario.logFail==='first'&&state.logCalls===1)throw Object.assign(Error(MARK),{code:'LOG_'+MARK});};
 const context={app,Buffer,port:12345,origin:'http://127.0.0.1:12345',assets:new Map(),privateDemo:{},handlePrivateDemo:async()=>false,inventory:{handle:async()=>false},documents:{handle:async()=>false},transcription:{handle:async()=>false},event};
 return vm.runInNewContext(routes+'\n('+callback+')',context);
}
async function run(src,scenario){
 const state={scenario,calls:[],events:[],writes:[],ends:[],publications:0,logCalls:0};
 const fn=handler(src,state);
 const body=scenario.body??JSON.stringify(scenario.input??{query:MARK,id:MARK,idempotencyKey:MARK,body:MARK});
 const req={url:scenario.url??`/api/${scenario.module}/${scenario.operation}`,method:scenario.method??'POST',headers:{host:'127.0.0.1:12345','content-type':'application/json',...scenario.headers},async *[Symbol.asyncIterator](){if(scenario.streamThrow)throw Error(MARK);yield Buffer.from(body)}};
 const res={writeHead(status,headers){state.writes.push(normalize({status,headers}));new ServerResponse({method:'POST'}).writeHead(status,headers);if(scenario.writeFail)throw Object.assign(Error(MARK),{code:'WRITE_'+MARK})},end(value){state.ends.push(Buffer.isBuffer(value)?{bytes:value.toString('hex')}:{text:value});if(scenario.endFail)throw Object.assign(Error(MARK),{code:'END_'+MARK})}};
 try{await fn(req,res)}catch(e){state.rejected=e===null?'null':String(e)}
 // Apply to every observed event in every branch, including escaping log/message failures.
 for(const event of state.events){
  assert(Object.keys(event).every(key=>['module','operation','status','code'].includes(key)),'safe event fields');
  assert.equal(event.module,scenario.module,'fixed route module');
  assert.equal(event.operation,scenario.operation,'fixed route operation');
  assert([200,400,403,404,409,429,500].includes(event.status),'finite numeric event status');
  if('code' in event)assert(codes.includes(event.code),'finite event code');
  assert(!JSON.stringify(event).includes(MARK),'no authored canary in any diagnostic');
 }
 for(const end of state.ends){
  if(!end.text)continue;
  const payload=JSON.parse(end.text);
  if(payload.error){
   assert.deepEqual(Object.keys(payload),['error'],'generic failures cannot mint proofs');
   assert.deepEqual(Object.keys(payload.error).sort(),['code','message','retryable'],'error schema');
  }
 }
 return state;
}

const before=source(base),after=source(candidate);let count=0;
const expectedStatuses={INVALID_REQUEST:400,NOT_FOUND:404,CONFLICT:409,FORBIDDEN:403,RATE_LIMITED:429,CANCELLED:409};
const response=s=>({calls:s.calls,writes:s.writes,ends:s.ends,publications:s.publications,rejected:s.rejected});
function assertUnavailable(state,label){
 assert.equal(state.rejected,undefined,label+' must settle');
 assert.equal(state.writes.length,1,label+' one response');
 assert.equal(state.writes[0].status,500,label+' numeric fallback');
 assert.deepEqual(JSON.parse(state.ends[0].text),{error:{code:'UNAVAILABLE',message:'Local synthetic server error',retryable:false}},label+' constant body with no proof');
 assert.deepEqual(state.events.at(-1),{module:state.scenario.module,operation:state.scenario.operation,status:500,code:'UNAVAILABLE'},label+' finite diagnostic');
 count++;
}
for(const [module,ops]of Object.entries(groups))for(const operation of ops){
 const input=operation==='scope'?{}:operation==='inspectSource'?{documentId:'synthetic-doc',revisionId:'v1'}:undefined;
 const common={module,operation,input,export:operation==='exportReport'};
 assert.deepEqual(response(await run(after,common)),response(await run(before,common)),module+'.'+operation+' success/export parity');count++;
 if(operation==='inspectSource')continue; // This path does not invoke domain dependencies.
 for(const [code,status]of Object.entries(expectedStatuses)){
  const scenario={...common,domainThrow:true,error:{code,message:MARK}};
  const a=await run(before,scenario),b=await run(after,scenario);
  assert.deepEqual(response(b),response(a),module+'.'+operation+' '+code+' parity');
  assert.equal(b.writes[0].status,status);assert.equal(JSON.parse(b.ends[0].text).error.message,MARK);count++;
 }
 const errors=[null,undefined,0,false,'raw error',{},...['toString','constructor','__proto__','hasOwnProperty','UNAVAILABLE','UNKNOWN',400,Symbol('synthetic'),{},new String('NOT_FOUND')].map(code=>({code,message:MARK})),{code:{toString(){throw Error('must not coerce')}},message:MARK},Object.create({code:'constructor'})];
 for(const error of errors)assertUnavailable(await run(after,{...common,domainThrow:true,error}),module+'.'+operation+' unknown/null/inherited');
 const unknownMessage={code:'UNKNOWN',get message(){throw Error('fallback must not read message')}};
 assertUnavailable(await run(after,{...common,domainThrow:true,error:unknownMessage}),module+'.'+operation+' untouched unknown message');
 const hostileProxy=new Proxy({},{get(){throw Error(MARK)}});
 assertUnavailable(await run(after,{...common,domainThrow:true,error:hostileProxy}),module+'.'+operation+' hostile proxy');
 const messageThrows={code:'NOT_FOUND',get message(){throw Error(MARK)}};
 const messageScenario={...common,domainThrow:true,error:messageThrows};
 assert.deepEqual(response(await run(after,messageScenario)),response(await run(before,messageScenario)),'known message getter escape parity');count++;
 const inheritedKnown=Object.assign(Object.create({code:'NOT_FOUND'}),{message:MARK});
 const inheritedScenario={...common,domainThrow:true,error:inheritedKnown};
 assert.deepEqual(response(await run(after,inheritedScenario)),response(await run(before,inheritedScenario)),'known inherited code parity');count++;
 let reads=0;
 const hostile={get code(){reads++;throw Error(MARK)},get message(){throw Error('fallback must not read message')}};
 assertUnavailable(await run(after,{...common,domainThrow:true,error:hostile}),module+'.'+operation+' hostile getter');assert.equal(reads,1);
 let knownReads=0;
 const known={get code(){knownReads++;return 'NOT_FOUND'},message:MARK};
 const knownState=await run(after,{...common,domainThrow:true,error:known});assert.equal(knownReads,1);assert.equal(knownState.writes[0].status,404);assert.equal(JSON.parse(knownState.ends[0].text).error.message,MARK);count++;
 for(const logFail of ['first','always']){
  const scenario={...common,logFail};assert.deepEqual(response(await run(after,scenario)),response(await run(before,scenario)),'log failure placement '+module+'.'+operation);count++;
 }
}
for(const operation of ['listActivities','exportReport'])for(const failure of ['writeFail','endFail','publicationThrow','badFilename']){
 if(operation!=='exportReport'&&['publicationThrow','badFilename'].includes(failure))continue;
 const scenario={module:'service-reports',operation,export:operation==='exportReport',[failure]:true,error:{code:'CONFLICT',message:MARK}};
 assert.deepEqual(response(await run(after,scenario)),response(await run(before,scenario)),'export/publication/send failure parity '+operation+' '+failure);count++;
}
for(const code of ['toString','constructor','__proto__']){
 const state=await run(after,{module:'service-reports',operation:'exportReport',export:true,publicationThrow:true,error:{code,message:MARK}});
 assertUnavailable(state,'publication unknown '+code);assert.equal(state.publications,1);
}
// Unchanged request admission and local guards must retain response parity and emit no event.
for(const module of Object.keys(groups))for(const malformed of [
 {body:'{'},{body:'null'},{body:'[]'},{body:'3'},{body:'"'+MARK+'"'},
 {body:JSON.stringify({text:MARK.repeat(1800)})},{method:'GET'},
 {headers:{'content-type':'text/plain'}},{headers:{'content-encoding':'gzip'}},
 {streamThrow:true},{url:`/api/${module}/list?${MARK}`},{url:`/api/${module}/${MARK}`}
]){
 const scenario={module,operation:groups[module][0],...malformed};
 const a=await run(before,scenario),b=await run(after,scenario);
 assert.deepEqual(response(b),response(a),'request admission parity');assert.equal(a.events.length,0);assert.equal(b.events.length,0);count++;
}
for(const guard of [
 {operation:'scope',input:{query:MARK}},
 {operation:'inspectSource',input:{documentId:MARK,revisionId:MARK}},
 {operation:'createActivity',input:{activity:{ordinarySource:MARK}}}
]){
 const scenario={module:'service-reports',...guard};
 const a=await run(before,scenario),b=await run(after,scenario);
 assert.deepEqual(response(b),response(a),'local guard parity');assert.equal(a.events.length,0);assert.equal(b.events.length,0);count++;
}
console.log(JSON.stringify({passed:count,scope:'Actual extracted handler under synthetic dependencies with socket-free native status validation; no listener/DB/browser/provider/full-product acceptance'}));
