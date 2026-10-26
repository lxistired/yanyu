import {manualInventoryRoutes} from './manual-inventory-routes.mjs';
import {publishPdfImage} from './pdf-image-response.mjs';
import {acquireFence} from './worker-fence.mjs';
import {assertStorageNotRetired} from './disposable-storage.mjs';
import {privateDemoFromEnvironment,handlePrivateDemo} from './jp-private-provider.mjs';
const privateDemo=privateDemoFromEnvironment();
import {inventoryScheduler} from './inventory-scheduler.mjs';
import {createServer} from 'node:http';
import {readFileSync,appendFileSync,readdirSync,lstatSync,existsSync} from 'node:fs';
import {join,extname} from 'node:path';
import {researchDocuments} from './research-documents.mjs';
import {localTranscription} from './local-transcription.mjs';
import {compose} from './composition.mjs';
const [build,storage,log,portText='0']=process.argv.slice(2);
let app,transcription,documents,inventory,storageOwner,disposePromise,port=Number(portText),origin;
function dispose(){return disposePromise??=(async()=>{
 const failures=[];
 for(const resource of [transcription,privateDemo,inventory,app])try{await resource?.close()}catch(error){failures.push(error)}
 // Failure retains the owner's fd; process exit or its surviving inheritors still own it.
 if(failures.length)throw new AggregateError(failures,'Storage disposal incomplete');
 // The server keeps the owner until HTTP drain + disposal succeed, or actual process exit.
})()}
try{
 storageOwner=acquireFence(join(storage,'local-transcription-owner.lock'));
 assertStorageNotRetired(storage,storageOwner);
 app=await compose(build,storage,{createLocalSources(authority){
  const sourceWorkspace={get:(kind,id)=>authority.workspace.get(authority.context(),{kind,id}),list:kind=>{const rows=[];let offset=0;do{const page=authority.workspace.list(authority.context(),{kind,offset,limit:200});rows.push(...page.items);offset=page.nextOffset;}while(offset!==null);return rows;}};
  documents=researchDocuments(storage,sourceWorkspace);
  try{return {resource:documents,port:documents.createReportSourcePort(authority),manualInventory:documents.createManualInventoryObserverPort(authority.manualInventoryAuthority,authority.manualInventoryProtocol)}}catch(error){documents.close();throw error}
 }});
 const workspace={get:(kind,id)=>app.workspace.get(app.context(),{kind,id}),list:kind=>{const rows=[];let offset=0;do{const page=app.workspace.list(app.context(),{kind,offset,limit:200});rows.push(...page.items);offset=page.nextOffset;}while(offset!==null);return rows;}};
 transcription=localTranscription(storage,workspace,storageOwner);inventory=inventoryScheduler(storage);
}catch(error){try{await dispose()}catch(rollback){throw new AggregateError([error,rollback],'Initialization and rollback failed')}throw error}
const inventoryRoutes=manualInventoryRoutes(app.manualInventory,app.context);
const routes={'manual-plans':new Set(['get','list','create','update','setState','reopen','remove','restore','sessionChoices','linkedSession','setSessionLink','setMaterialLink','setDocumentLink','addMaterialLinks','removeMaterialLink']),automation:new Set(['listSkills','getSkill','createSkill','updateSkill','deleteSkill','restoreSkill','listDataSources','getDataSource','createDataSource','updateDataSource','deleteDataSource','restoreDataSource','listSchedules','getSchedule','createSchedule','updateSchedule','setScheduleState','deleteSchedule','restoreSchedule','listRuns','listNotifications']),workspace:new Set(['list','get','create','update','remove','restore','previewDelete','batchDelete','importWatchlist']),organization:new Set(['list','get','create','update','remove','restore','serviceStatistics','inspectTarget']),'service-reports':new Set(['scope','customers','sourceChoices','inspectSource','openActivitySource','openReportSource','listActivities','getActivity','createActivity','correctActivity','archiveActivity','createReport','getReport','archiveReport','listReports','previewServiceRecord','importServiceRecord','exportReport','recoverCommand','cancelCommand'])};
const dist=join(import.meta.dirname,'../dist'),assets=new Map();
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
function collect(dir,prefix=''){for(const name of readdirSync(dir)){const path=join(dir,name),st=lstatSync(path);if(st.isSymbolicLink())throw Error('Static symlink blocked');if(st.isDirectory())collect(path,prefix+'/'+name);else if(mime[extname(name)])assets.set(prefix+'/'+name,{body:readFileSync(path),type:mime[extname(name)]});}}
try{collect(dist);assets.set('/',assets.get('/index.html'))}catch(error){try{await dispose()}catch(rollback){throw new AggregateError([error,rollback],'Initialization and rollback failed')}throw error}
const event=x=>appendFileSync(log,JSON.stringify({time:new Date().toISOString(),pid:process.pid,...x})+'\n');
const server=createServer(async(req,res)=>{
 const send=(status,payload)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(payload))};
 const fail=(status,code,message)=>send(status,{error:{code,message,retryable:false}});
 if(req.headers.host!==`127.0.0.1:${port}`)return fail(403,'FORBIDDEN','Host rejected');
 if(req.headers.origin&&req.headers.origin!==origin)return fail(403,'FORBIDDEN','Origin rejected');
 if(req.headers['sec-fetch-site']==='cross-site')return fail(403,'FORBIDDEN','Cross-site request rejected');
 const raw=req.url||'';if(!raw.startsWith('/')||raw.startsWith('//')||raw.includes('\\')||raw.split('?')[0].includes('%')||raw.split('?')[0].split('/').includes('..'))return fail(404,'NOT_FOUND','Path not admitted');
 const pathname=raw.split('?')[0];
 if(req.method==='GET'&&assets.has(pathname)){const asset=assets.get(pathname);res.writeHead(200,{'Content-Type':asset.type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"});return res.end(asset.body)}
 if(await inventoryRoutes.handle(req,send,fail,bytes=>{res.writeHead(200,{'Content-Type':'application/json','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes)}))return;
 if(await handlePrivateDemo(privateDemo,req,send,fail,event))return;
 if(await inventory.handle(req,send,fail))return;
 if(raw==='/api/demo/identity'&&req.method==='GET')return send(200,app.identity);
 if(await documents.handle(req,send,fail,(filename,bytes,hash,scope)=>{res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${filename}"`,'Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'X-Document-Sha256':hash,'X-Document-Store-Id':scope});res.end(bytes)},(bytes,identity,checkPublication)=>publishPdfImage(res,bytes,identity,checkPublication)))return;
 if(await transcription.handle(req,send,fail,(filename,content,revision)=>{res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Length':content.length,'Content-Disposition':`attachment; filename="${filename}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Transcript-Revision':String(revision)});res.end(content)},{setHeader:(name,value)=>res.setHeader(name,value),onAdmitted:()=>{if(raw==='/api/local-asr/relationships')event({module:'transcript-relationships',operation:'choices',method:req.method})}}))return;
 const m=/^\/api\/(workspace|organization|service-reports|automation|manual-plans)\/([A-Za-z]+)$/.exec(raw);
 if(!m||!routes[m[1]].has(m[2]))return fail(404,'NOT_FOUND','Operation not admitted');
 if(req.method!=='POST')return fail(405,'INVALID_REQUEST','POST required');
 if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))return fail(415,'INVALID_REQUEST','JSON required');
 if(req.headers['content-encoding'])return fail(415,'INVALID_REQUEST','Encoded bodies not admitted');
 let size=0,parts=[];try{for await(const part of req){size+=part.length;if(size>32768)return fail(413,'INVALID_REQUEST','Request too large');parts.push(part)}}catch{return}
 let input;try{input=JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{return fail(400,'INVALID_REQUEST','Malformed JSON')}
 if(!input||typeof input!=='object'||Array.isArray(input))return fail(400,'INVALID_REQUEST','Object required');
 const ctx=app.context();
 const organizationWrite=m[1]==='organization'&&['create','update','remove','restore'].includes(m[2]);
 if(organizationWrite){
  // Only the DOMAIN invocation may yield a privately branded committed terminal rejection.
  // Publication/logging failures are outside this catch and can never mint its proof.
  let status=200,payload,diagnosticCode;
  try{payload=await app.organization[m[2]](ctx,input)}catch(cause){
   const code=['INVALID_REQUEST','NOT_FOUND','CONFLICT','FORBIDDEN','RATE_LIMITED','CANCELLED'].includes(cause?.code)?cause.code:'UNAVAILABLE';
   status={INVALID_REQUEST:400,NOT_FOUND:404,CONFLICT:409,FORBIDDEN:403,RATE_LIMITED:429,CANCELLED:409}[code]||500;
   diagnosticCode=code;
   const proof=app.organizationCommandRejection(cause);
   const trusted=proof&&proof.operation===`organization.${m[2]}`&&proof.idempotencyKey===input.idempotencyKey&&['INVALID_REQUEST','CONFLICT'].includes(code);
   const message=trusted?(code==='INVALID_REQUEST'?'Invalid organization request':'Organization record conflict'):(status===500?'Local synthetic server error':'Local organization request rejected');
   payload={error:{code,message,retryable:false},...(trusted?{commandOutcome:proof}:{})};
  }
  try{event({module:'organization',operation:m[2],status,...(diagnosticCode?{code:diagnosticCode}:{})});send(status,payload)}
  catch{try{fail(500,'UNAVAILABLE','Local synthetic server error')}catch{}}
  return;
 }
 const automationWrite=m[1]==='automation'&&['createSkill','updateSkill','deleteSkill','restoreSkill','createDataSource','updateDataSource','deleteDataSource','restoreDataSource','createSchedule','updateSchedule','setScheduleState','deleteSchedule','restoreSchedule'].includes(m[2]);
 if(automationWrite){
  // Only the DOMAIN invocation may yield a privately branded committed terminal rejection.
  // Publication/logging failures are outside this catch and can never mint its proof.
  let status=200,payload,diagnosticCode;
  try{payload=await app.automation[m[2]](ctx,input)}catch(cause){
   const code=['INVALID_REQUEST','NOT_FOUND','CONFLICT','FORBIDDEN','RATE_LIMITED','CANCELLED'].includes(cause?.code)?cause.code:'UNAVAILABLE';
   status={INVALID_REQUEST:400,NOT_FOUND:404,CONFLICT:409,FORBIDDEN:403,RATE_LIMITED:429,CANCELLED:409}[code]||500;
   diagnosticCode=code;
   const proof=app.automationCommandRejection(cause);
   const trusted=proof&&proof.operation===`automation.${m[2]}`&&proof.idempotencyKey===input.idempotencyKey&&['INVALID_REQUEST','CONFLICT'].includes(code);
   const message=trusted?(code==='INVALID_REQUEST'?'Invalid automation request':'Automation record conflict'):(status===500?'Local synthetic server error':'Local automation request rejected');
   payload={error:{code,message,retryable:false},...(trusted?{commandOutcome:proof}:{})};
  }
  try{event({operation:m[2],status,...(diagnosticCode?{code:diagnosticCode}:{})});send(status,payload)}
  catch{try{fail(500,'UNAVAILABLE','Local synthetic server error')}catch{}}
  return;
 }
 if(m[1]==='workspace'){
  // Only the DOMAIN invocation may yield a privately branded committed terminal rejection.
  // Publication/logging failures are outside this catch and can never mint its proof.
  let status=200,payload,diagnosticCode;
  try{payload=await app.workspace[m[2]](ctx,input)}catch(cause){
   const code=['INVALID_REQUEST','NOT_FOUND','CONFLICT','FORBIDDEN','RATE_LIMITED','CANCELLED'].includes(cause?.code)?cause.code:'UNAVAILABLE';
   status={INVALID_REQUEST:400,NOT_FOUND:404,CONFLICT:409,FORBIDDEN:403,RATE_LIMITED:429,CANCELLED:409}[code]||500;
   diagnosticCode=code;
   const proof=['create','update','remove','restore','batchDelete','importWatchlist'].includes(m[2])?app.workspaceCommandRejection(cause):null;
   const trusted=proof&&proof.operation===`workspace.${m[2]}`&&proof.idempotencyKey===input.idempotencyKey&&['INVALID_REQUEST','CONFLICT'].includes(code);
   const message=trusted?(code==='INVALID_REQUEST'?'Invalid workspace request':'Workspace record conflict'):(status===500?'Local synthetic server error':'Local workspace request rejected');
   payload={error:{code,message,retryable:false},...(trusted?{commandOutcome:proof}:{})};
  }
  try{event({operation:m[2],status,...(diagnosticCode?{code:diagnosticCode}:{})});send(status,payload)}
  catch{try{fail(500,'UNAVAILABLE','Local synthetic server error')}catch{}}
  return;
 }
 try{if(m[1]==='service-reports'&&input.activity?.ordinarySource){if(m[2]==='createActivity')return fail(400,'INVALID_REQUEST','Ordinary provenance is assigned only by explicit projection');if(m[2]==='correctActivity'){const prior=(await app.reports.getActivity(ctx,{id:input.id})).activity.version.value.ordinarySource;if(JSON.stringify(prior)!==JSON.stringify(input.activity.ordinarySource))return fail(400,'INVALID_REQUEST','Ordinary provenance changes require projection preview');}}let result;if(m[1]==='service-reports'&&m[2]==='scope'){if(Object.keys(input).length)return fail(400,'INVALID_REQUEST','Unexpected field');result=app.reports.scope(ctx)}else if(m[1]==='service-reports'&&m[2]==='inspectSource')result=await app.inspectSource(ctx,input);else if(m[1]==='service-reports'&&m[2]==='sourceChoices')result=app.sourceChoices(ctx,input);else if(m[1]==='service-reports'&&['openActivitySource','openReportSource'].includes(m[2])){if(input.from!==(m[2]==='openActivitySource'?'activity':'report'))return fail(400,'INVALID_REQUEST','Source open route mismatch');result=await app.reports.openPinnedSource(ctx,input);}else if(m[1]==='service-reports'&&m[2]==='customers')result=app.customers(ctx,input);else if(m[1]==='service-reports'&&['previewServiceRecord','importServiceRecord'].includes(m[2]))result=await app.bridge[m[2]](ctx,input);else result=await app[m[1]==='service-reports'?'reports':m[1]==='manual-plans'?'manualPlans':m[1]][m[2]](ctx,input);
 if(m[1]==='service-reports'&&m[2]==='exportReport'){
  result.checkPublication();
  if(!/^[A-Za-z0-9_-]+\.(json|csv|html)$/.test(result.filename)||Buffer.byteLength(result.filename)>180)throw Object.assign(Error('Invalid download filename'),{code:'INVALID_REQUEST'});
  res.writeHead(200,{...result.headers,'Content-Type':result.mediaType,'Content-Length':result.content.length,'Content-Disposition':`attachment; filename="${result.filename}"`,'X-Service-Report-Scope':result.scope,'X-Service-Report-Id':result.reportId,'X-Service-Report-Revision':String(result.revision),'X-Service-Report-Snapshot-Sha256':result.snapshotSha256});
  event({module:m[1],operation:m[2],status:200});return res.end(result.content);
 }
 // All admitted generic routes log only fixed route identifiers and finite status/code values.
 // Never copy authored text, queries, command keys, proofs, results or raw errors into diagnostics.
 if(m[1]==='service-reports'&&(['inspectSource','openActivitySource','openReportSource'].includes(m[2])||input.schema===2&&['previewServiceRecord','importServiceRecord'].includes(m[2]))){const {checkPublication,...payload}=result;checkPublication();event({module:m[1],operation:m[2],status:200});send(200,payload);return;}
 event({module:m[1],operation:m[2],status:200});send(200,result);
 }catch(e){
  // Read an untrusted code once; null, hostile getters and non-allowlisted values are unavailable.
  let code='UNAVAILABLE',status=500;
  try{const value=e?.code;if(typeof value==='string'&&['INVALID_REQUEST','NOT_FOUND','CONFLICT','FORBIDDEN','RATE_LIMITED','CANCELLED'].includes(value))code=value}catch{}
  switch(code){
   case 'INVALID_REQUEST':status=400;break;
   case 'NOT_FOUND':status=404;break;
   case 'CONFLICT':case 'CANCELLED':status=409;break;
   case 'FORBIDDEN':status=403;break;
   case 'RATE_LIMITED':status=429;break;
  }
  event({module:m[1],operation:m[2],status,code});
  fail(status,code,status===500?'Local synthetic server error':e.message);
 }
});
server.requestTimeout=120000;server.headersTimeout=5000;
server.once('error',async()=>{await dispose();process.exitCode=1});
server.listen(port,'127.0.0.1',()=>{inventory.start();port=server.address().port;origin=`http://127.0.0.1:${port}`;event({event:'started',origin});console.log(`READY ${origin} pid=${process.pid}`);process.send?.({origin,pid:process.pid})});
let stopping;
function stop(){
 if(stopping)return stopping;
 // Stop uploads/workers immediately, not after HTTP waits for uploads to finish.
 // Observe each rejection immediately, even if the other branch stays pending.
 const drained=dispose().then(()=>({ok:true}),error=>({ok:false,error}));
 const httpClosed=new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections()})
  .then(()=>({ok:true}),error=>({ok:false,error}));
 stopping=Promise.all([httpClosed,drained]).then(results=>{
  const failures=results.filter(result=>!result.ok).map(result=>result.error);
  if(failures.length)throw new AggregateError(failures,'HTTP drain or storage disposal failed');
  storageOwner?.close();storageOwner=null;process.exit(0);
 });
 stopping.catch(()=>{process.exitCode=1});return stopping;
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
