// @vitest-environment node
// Actual installed transport and production server, fresh synthetic local stores only.
import {beforeAll,afterAll,it,expect} from 'vitest';
import {fork,spawnSync,type ChildProcess} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {mkdtempSync,mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {boundedTransport} from '../visual-harness/bounded-transport';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';

const root=mkdtempSync(join(tmpdir(),'yanyu-citation-recovery-transport-')),storage=join(root,'store');
const nativeFetch=globalThis.fetch,pids:number[]=[],checks:string[]=[];
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const fields=['documentRevision','documentSha256','end','note','operationId','quote','quoteSha256','rangeUnit','start','textSha256'];
const fingerprint=(value:Record<string,unknown>)=>hash(JSON.stringify(fields.map(key=>[key,value[key]])));
const sources=['backend/server.mjs','backend/document-citations.mjs','backend/research-documents.mjs','visual-harness/bounded-transport.ts','verification/citation-recovery-http-contract.test.ts'];
const sourceSha256=()=>Object.fromEntries(sources.map(path=>[path,hash(readFileSync(path))]));
const initialSources=sourceSha256();
let child:ChildProcess,origin:string,build:string;

async function start(store=storage){
 mkdirSync(store,{recursive:true});
 await new Promise<void>((resolve,reject)=>{
  child=fork(join(process.cwd(),'backend/server.mjs'),[build,store,join(root,'events.jsonl'),'0'],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,HOME:root,YANYU_PYTHON:'/nonexistent/synthetic-test-python'}});
  let errors='';child.stderr!.on('data',data=>errors+=data);
  const timer=setTimeout(()=>reject(Error('Production server readiness timed out: '+errors)),15000);
  child.once('message',(message:any)=>{clearTimeout(timer);origin=message.origin;pids.push(child.pid!);resolve()});
  child.once('exit',code=>{clearTimeout(timer);reject(Error(`Production server exited ${code}: ${errors}`))});child.once('error',error=>{clearTimeout(timer);reject(error)});
 });
 expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
}
async function stop(){if(child?.exitCode===null)await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill('SIGTERM')})}
beforeAll(async()=>{
 if(!existsSync('dist/index.html')){
  const result=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build'],{encoding:'utf8'});expect(result.status,result.stderr||result.stdout).toBe(0);
 }
 const prep=spawnSync(process.execPath,['backend/prepare-backend.mjs'],{encoding:'utf8'});expect(prep.status,prep.stderr).toBe(0);build=prep.stdout.trim();await start();
},30000);
afterAll(async()=>{
 await stop();const unchanged=JSON.stringify(sourceSha256())===JSON.stringify(initialSources);
 mkdirSync('citation-recovery-evidence',{recursive:true});
 writeFileSync('citation-recovery-evidence/HTTP_CONTRACT_RESULT.json',JSON.stringify({passed:checks.length===11&&unchanged,count:checks.length,checks,runtime:process.version,pids,storage,checkedAt:new Date().toISOString(),sourceSha256:initialSources,currentSourceSha256:sourceSha256(),transport:'Installed boundedTransport, actual production server over 127.0.0.1 HTTP and multiple server processes, real temporary SQLite',limitations:['Acknowledgement loss is simulated after a real successful response; no physical network disconnect','No browser, user device, credentials, model calls, private provider or external service used']},null,2)+'\n');
 expect(sourceSha256()).toEqual(initialSources);
});
function test(name:string,run:()=>Promise<void>){it(name,async()=>{await run();checks.push(name)},30000)}

function connection(){
 const calls:{path:string;method:string;headers:Headers;body:BodyInit|null|undefined;credentials:RequestCredentials|undefined;redirect:RequestRedirect|undefined;cache:RequestCache|undefined}[]=[];
 let loseAcknowledgement=false;
 const send:typeof fetch=async(input,init)=>{
  const path=String(input);
  if(!path.startsWith('/api/')||path.startsWith('//')||path.includes('://'))throw Error('Tests permit only relative loopback API requests');
  calls.push({path,method:init?.method??'GET',headers:new Headers(init?.headers),body:init?.body,credentials:init?.credentials,redirect:init?.redirect,cache:init?.cache});
  const response=await nativeFetch(origin+path,init);
  if(loseAcknowledgement&&path.endsWith('/citations')&&init?.method==='POST'){
   loseAcknowledgement=false;expect(response.status).toBe(201);await response.arrayBuffer();throw new TypeError('Synthetic lost acknowledgement after real citation commit');
  }
  return response;
 };
 const transport=boundedTransport(new OrdinaryRequestLifetime(),send);
 async function request(path:string,init?:RequestInit,status=200){const response=await transport(path,init),data=await response.json();expect(response.status,JSON.stringify(data)).toBe(status);return data}
 return {calls,transport,request,loseNextAcknowledgement:()=>{loseAcknowledgement=true}};
}
const json=(data:unknown,scope?:string):RequestInit=>({method:'POST',headers:{'Content-Type':'application/json',...(scope===undefined?{}:{'X-Citation-Store-Id':scope})},body:JSON.stringify(data)});
const pinned=(scope:string):RequestInit=>({headers:{'X-Citation-Store-Id':scope}});
const text='\ufeff合成😀 cafe\u0301\r\n重复 quote\r\n重复 quote\n<script>literal</script>尾';
async function fixture(s:ReturnType<typeof connection>,workspaceId?:string){
 const doc=(await s.request('/api/documents/upload?name=transport-synthetic.txt'+(workspaceId?'&workspaceId='+workspaceId:''),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Buffer.from(text)},201)).document;
 const base=`/api/documents/${doc.id}`,scope=(await s.request(base+'/citations')).storeScope,start=text.lastIndexOf('重复 quote'),quote='重复 quote';
 const draft={operationId:randomUUID(),documentRevision:doc.revision,documentSha256:doc.sha256,textSha256:doc.textSha256,start,end:start+quote.length,quote,quoteSha256:hash(quote),rangeUnit:'utf16-code-unit',note:'Synthetic human note 😀'};
 return {doc,base,scope,draft,lookup:`${base}/citation-operations/${draft.operationId}`};
}
async function raw(path:string,headers:Record<string,string|string[]>){
 return new Promise<{status:number;body:any}>((resolve,reject)=>{
  const req=httpRequest(origin,{path,headers},res=>{const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())}))});req.on('error',reject);req.end();
 });
}

test('lost acknowledgement recovers via the actual transport after a process restart and replays the original ID only',async()=>{
 const s=connection(),{base,scope,draft,lookup}=await fixture(s);
 expect(scope).toBe((await s.request('/api/documents/choices')).uploadScope);
 expect(await s.request(lookup,pinned(scope))).toEqual({storeScope:scope,operationId:draft.operationId,outcome:'absent'});
 s.loseNextAcknowledgement();await expect(s.transport(base+'/citations',json(draft,scope))).rejects.toThrow('Synthetic lost acknowledgement after real citation commit');
 const receipt=await s.request(lookup,pinned(scope));expect(receipt).toMatchObject({storeScope:scope,operationId:draft.operationId,outcome:'committed',requestSha256:fingerprint(draft)});
 expect((await s.request(base+'/citations',pinned(scope))).citations).toEqual([receipt.citation]);
 const oldPid=child.pid;await stop();await start();expect(child.pid).not.toBe(oldPid);
 expect(await s.request(lookup,pinned(scope))).toEqual(receipt);
 for(let i=0;i<3;i++)expect(await s.request(base+'/citations',json(draft,scope),201)).toEqual(receipt);
 expect((await s.request(base+'/citations',pinned(scope))).citations).toEqual([receipt.citation]);
 for(const call of s.calls.filter(call=>call.path===base+'/citations'&&call.method==='POST')){
  expect(JSON.parse(String(call.body)).operationId).toBe(draft.operationId);expect(call.headers.get('X-Citation-Store-Id')).toBe(scope);
  expect(call.credentials).toBe('same-origin');expect(call.redirect).toBe('error');expect(call.cache).toBe('no-store');
 }
});

test('an uncommitted operation is read-only absent and can explicitly save the same original ID',async()=>{
 const s=connection(),{base,scope,draft,lookup}=await fixture(s);
 for(let i=0;i<3;i++)expect(await s.request(lookup,pinned(scope))).toEqual({storeScope:scope,operationId:draft.operationId,outcome:'absent'});
 expect((await s.request(base+'/citations')).citations).toEqual([]);
 const saved=await s.request(base+'/citations',json(draft,scope),201);expect(saved.operationId).toBe(draft.operationId);expect(await s.request(lookup,pinned(scope))).toEqual(saved);
});

test('source detail carries its own database scope and rejects wrong or repeated store headers without leaking text',async()=>{
 const s=connection(),{doc,base,scope}=await fixture(s),expected={storeScope:scope,document:doc,text};
 expect(await s.request(base)).toEqual(expected);expect(await s.request(base,pinned(scope))).toEqual(expected);
 const rejected=await s.request(base,pinned(randomUUID()),409);expect(Object.keys(rejected)).toEqual(['error']);
 for(const secret of [doc.id,text,scope])expect(JSON.stringify(rejected)).not.toContain(secret);
 const repeated=await raw(base,{'X-Citation-Store-Id':[scope,scope]});expect(repeated.status).toBe(409);expect(Object.keys(repeated.body)).toEqual(['error']);expect(JSON.stringify(repeated.body)).not.toContain(doc.id);
 const initialRead=s.calls.find(call=>call.path===base&&call.headers.has('X-Citation-Store-Id'));expect(initialRead?.headers.get('X-Citation-Store-Id')).toBe(scope);
});

test('fresh source reads reconstruct the identical request hash including BOM CRLF repeated quote and original metadata revision',async()=>{
 const s=connection(),{base,scope,draft,lookup}=await fixture(s),saved=await s.request(base+'/citations',json(draft,scope),201);
 await s.request(base+'/metadata',{...json({name:'Renamed synthetic source',workspaceId:null,folderId:null,revision:0}),method:'PUT'});
 const reopened=await s.request(base,pinned(scope)),rebuilt={...draft,quote:reopened.text.slice(draft.start,draft.end)};
 expect(reopened.storeScope).toBe(scope);
 expect(reopened.text).toBe(text);expect(reopened.document.revision).not.toBe(draft.documentRevision);expect(rebuilt.quote).toBe(draft.quote);
 expect(fingerprint(rebuilt)).toBe(saved.requestSha256);expect(fingerprint({...rebuilt,documentRevision:reopened.document.revision})).not.toBe(saved.requestSha256);
 expect(await s.request(lookup,pinned(scope))).toEqual(saved);expect(saved.citation.start).toBe(text.lastIndexOf(draft.quote));
});

test('rename move missing association trash restore and restart retain the same committed citation',async()=>{
 const s=connection();
 const a=await s.request('/api/workspace/create',json({kind:'workspace',id:'recovery-a',idempotencyKey:'recovery-create-a',data:{name:'Recovery source'}}));
 const b=await s.request('/api/workspace/create',json({kind:'workspace',id:'recovery-b',idempotencyKey:'recovery-create-b',data:{name:'Recovery destination'}}));
 const {base,scope,draft,lookup}=await fixture(s,a.id),saved=await s.request(base+'/citations',json(draft,scope),201);
 let document=(await s.request(base+'/metadata',{...json({name:'Moved synthetic source',workspaceId:b.id,folderId:null,revision:0}),method:'PUT'})).document;
 await s.request('/api/workspace/remove',json({kind:'workspace',id:b.id,expectedRevision:b.revision,idempotencyKey:'recovery-remove-b'}));
 expect(await s.request(lookup,pinned(scope))).toEqual(saved);expect(await s.request(base+'/citations',json(draft,scope),201)).toEqual(saved);
 document=(await s.request(base+'/trash',{...json({revision:document.revision}),method:'PUT'})).document;
 expect(await s.request(lookup,pinned(scope))).toEqual(saved);await s.request(base+'/citations/'+saved.citation.id,pinned(scope),409);
 await stop();await start();expect(await s.request(lookup,pinned(scope))).toEqual(saved);expect(await s.request(base+'/citations',json(draft,scope),201)).toEqual(saved);
 document=(await s.request(base+'/restore',{...json({revision:document.revision}),method:'PUT'})).document;
 expect((await s.request(base+'/citations/'+saved.citation.id,pinned(scope))).citation).toEqual(saved.citation);expect(document.stale).toBe(true);
 expect((await s.request(base+'/citations',pinned(scope))).citations).toEqual([saved.citation]);
});

test('wrong store scopes reject every citation entry point and still reject after switching to a different database',async()=>{
 const s=connection(),{base,scope,draft,lookup}=await fixture(s),saved=await s.request(base+'/citations',json(draft,scope),201),wrong=randomUUID();
 for(const [path,init] of [[base,pinned(wrong)],[base+'/citations',pinned(wrong)],[base+'/citations/'+saved.citation.id,pinned(wrong)],[base+'/citations',json(draft,wrong)],[lookup,pinned(wrong)]] as [string,RequestInit][]){
  const rejected=await s.request(path,init,409);expect(Object.keys(rejected)).toEqual(['error']);expect(JSON.stringify(rejected)).not.toContain(saved.citation.id);expect(JSON.stringify(rejected)).not.toContain(scope);
 }
 await stop();await start(join(root,'other-store'));
 try{
  const freshScope=(await s.request('/api/documents/choices')).uploadScope;expect(freshScope).not.toBe(scope);
  for(const [path,init] of [[base,pinned(scope)],[base+'/citations',pinned(scope)],[base+'/citations/'+saved.citation.id,pinned(scope)],[base+'/citations',json(draft,scope)],[lookup,pinned(scope)]] as [string,RequestInit][])await s.request(path,init,409);
  await s.request(lookup,pinned(freshScope),404);
 }finally{await stop();await start()}
 expect(await s.request(lookup,pinned(scope))).toEqual(saved);
});

test('cross-document lookup and altered original payload fields fail without exposing or replacing the original receipt',async()=>{
 const s=connection(),{base,scope,draft,lookup}=await fixture(s),saved=await s.request(base+'/citations',json(draft,scope),201),other=await fixture(s);
 const denied=await s.request(other.base+'/citation-operations/'+draft.operationId,pinned(scope),409);expect(Object.keys(denied)).toEqual(['error']);expect(JSON.stringify(denied)).not.toContain(saved.citation.id);
 await s.request(other.base+'/citations',json(draft,scope),409);
 for(const change of [{documentRevision:1},{documentSha256:'0'.repeat(64)},{textSha256:'0'.repeat(64)},{start:draft.start-1},{end:draft.end-1},{quote:'different'},{quoteSha256:'0'.repeat(64)},{note:'changed'}])await s.request(base+'/citations',json({...draft,...change},scope),409);
 await s.request(base+'/citations',json({...draft,rangeUnit:'codepoint'},scope),400);await s.request(base+'/citations',json({...draft,extra:true},scope),400);
 expect(await s.request(lookup,pinned(scope))).toEqual(saved);expect((await s.request(base+'/citations')).citations).toEqual([saved.citation]);
});

test('whole emoji and combining marks survive real HTTP while split surrogates cannot create operations',async()=>{
 const s=connection(),{base,scope,draft}=await fixture(s),emoji=text.indexOf('😀'),combining=text.indexOf('cafe');
 for(const [start,end] of [[emoji,emoji+1],[emoji+1,emoji+2]]){
  const quote=text.slice(start,end),attempt={...draft,operationId:randomUUID(),start,end,quote,quoteSha256:hash(quote)};
  await s.request(base+'/citations',json(attempt,scope),422);expect((await s.request(base+'/citation-operations/'+attempt.operationId,pinned(scope))).outcome).toBe('absent');
 }
 for(const [start,end] of [[emoji,emoji+2],[combining,combining+5]]){
  const quote=text.slice(start,end),attempt={...draft,operationId:randomUUID(),start,end,quote,quoteSha256:hash(quote)};
  const saved=await s.request(base+'/citations',json(attempt,scope),201);expect(saved.citation.quote).toBe(quote);expect(saved.requestSha256).toBe(fingerprint(attempt));
  expect(await s.request(base+'/citation-operations/'+attempt.operationId,pinned(scope))).toEqual(saved);
 }
});

test('host origin and cross-site production guards protect committed absent and legacy citation access',async()=>{
 const s=connection(),{base,scope,draft,lookup}=await fixture(s),saved=await s.request(base+'/citations',json(draft,scope),201);
 for(const extra of [{Origin:'https://invalid.example'},{'Sec-Fetch-Site':'cross-site'}])for(const path of [lookup,base+'/citation-operations/'+randomUUID(),base+'/citations',base+'/citations/'+saved.citation.id]){
  const result=await s.request(path,{headers:{'X-Citation-Store-Id':scope,...extra}},403);expect(Object.keys(result)).toEqual(['error']);expect(JSON.stringify(result)).not.toContain(saved.citation.id);
 }
 const host=await raw(lookup,{Host:'foreign.invalid','X-Citation-Store-Id':scope});expect(host.status).toBe(403);expect(Object.keys(host.body)).toEqual(['error']);
 const repeated=await raw(lookup,{'X-Citation-Store-Id':[scope,scope]});expect(repeated.status).toBe(409);expect(JSON.stringify(repeated.body)).not.toContain(saved.citation.id);
 expect(await s.request(lookup,{headers:{'X-Citation-Store-Id':scope,Origin:origin,'Sec-Fetch-Site':'same-origin'}})).toEqual(saved);
});

test('clients without a store header remain compatible for list create reopen and operation recovery',async()=>{
 const s=connection(),{base,draft,lookup}=await fixture(s),saved=await s.request(base+'/citations',json(draft),201);
 expect((await s.request(base+'/citations')).citations).toEqual([saved.citation]);expect((await s.request(base+'/citations/'+saved.citation.id)).citation).toEqual(saved.citation);
 expect(await s.request(lookup)).toEqual(saved);expect(await s.request(base+'/citations',json(draft),201)).toEqual(saved);
});

test('only the exact UUID GET recovery path without query fragment suffix or encoding reaches the real network',async()=>{
 const s=connection(),{lookup,scope}=await fixture(s);await s.request(lookup,pinned(scope));const before=s.calls.length;
 for(const [path,method] of [
  [lookup+'?','GET'],[lookup+'?extra=1','GET'],[lookup+'?operationId='+randomUUID(),'GET'],[lookup+'#fragment','GET'],[lookup+'/','GET'],
  [lookup,'POST'],[lookup,'DELETE'],[lookup,'PUT'],[lookup,'HEAD'],[lookup,'OPTIONS'],
  [lookup.replace('/citation-operations/','/citation-operations%2f'),'GET'],[lookup+'%3fextra=1','GET'],[lookup.replace('/citation-operations/','/citations-operations/'),'GET'],
  [lookup.slice(0,-1),'GET'],[lookup.toUpperCase(),'GET'],[lookup+'\n','GET'],[lookup+'\r\n','GET'],['https://external.invalid'+lookup,'GET'],['//external.invalid'+lookup,'GET'],
 ]){const result=await s.request(path,{method},503);expect(result.error.code).toBe('UNAVAILABLE')}
 expect(s.calls).toHaveLength(before);
 // The production route also rejects query widening when the transport is not involved.
 for(const suffix of ['?','?extra=1']){const result=await raw(lookup+suffix,{'X-Citation-Store-Id':scope});expect(result.status).toBe(400)}
});
