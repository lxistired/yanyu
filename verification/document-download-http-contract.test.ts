// @vitest-environment node
// Actual installed transport and production server; only generated files and loopback SQLite.
import {beforeAll,afterAll,it,expect} from 'vitest';
import {fork,spawnSync,type ChildProcess} from 'node:child_process';
import {mkdtempSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {boundedTransport} from '../visual-harness/bounded-transport';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {bindDocumentDownload,verifyDocumentDownload} from '../candidate/src/components/document-download';

const root=mkdtempSync(join(tmpdir(),'yanyu-download-transport-'));
const nativeFetch=globalThis.fetch;
let child:ChildProcess,origin:string;
beforeAll(async()=>{
 if(!existsSync('dist/index.html')){
  const build=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build'],{encoding:'utf8',timeout:30000});expect(build.status,build.stderr||build.stdout).toBe(0);
 }
 const prep=spawnSync(process.execPath,['backend/prepare-backend.mjs'],{encoding:'utf8',timeout:30000});expect(prep.status,prep.stderr).toBe(0);
 const storage=join(root,'synthetic-store');mkdirSync(storage);
 await new Promise<void>((resolve,reject)=>{
  let errors='';child=fork(join(process.cwd(),'backend/server.mjs'),[prep.stdout.trim(),storage,join(root,'synthetic-events.jsonl'),'0'],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,HOME:root,YANYU_PYTHON:'/nonexistent/synthetic-test-python'}});
  child.stdout!.resume();child.stderr!.on('data',data=>errors+=data);
  const timer=setTimeout(()=>reject(Error('Synthetic download server readiness timed out: '+errors)),15000);
  child.once('message',(message:any)=>{clearTimeout(timer);origin=message.origin;resolve()});
  child.once('exit',code=>{clearTimeout(timer);reject(Error(`Synthetic download server exited ${code}: ${errors}`))});child.once('error',error=>{clearTimeout(timer);reject(error)});
 });
 expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
},30000);
afterAll(async()=>{
 if(child?.exitCode===null)await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Synthetic download server failed to stop'))},15000);
  child.once('exit',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM');
 });
});
function connection(){
 const calls:{path:string;method:string;headers:Headers;credentials:RequestCredentials|undefined;redirect:RequestRedirect|undefined;cache:RequestCache|undefined}[]=[];
 const send:typeof fetch=async(input,init)=>{
  const path=String(input);
  // Even a route-admission regression cannot send this synthetic test off-loopback.
  if(!path.startsWith('/api/')||path.startsWith('//')||path.includes('://'))throw Error('Synthetic transport permits relative API paths only');
  calls.push({path,method:init?.method??'GET',headers:new Headers(init?.headers),credentials:init?.credentials,redirect:init?.redirect,cache:init?.cache});
  return nativeFetch(origin+path,init);
 };
 const transport=boundedTransport(new OrdinaryRequestLifetime(),send);
 async function request(path:string,init?:RequestInit,status=200){const response=await transport(path,init),body=await response.json();expect(response.status,JSON.stringify(body)).toBe(status);return body;}
 return {calls,transport,request};
}
const content=Buffer.from('\ufeffTransport 合成 😀 cafe\u0301\r\nLiteral <script>not executed</script>\r\n');
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(s:ReturnType<typeof connection>,name='transport-synthetic.txt'){
 const {storeScope}=await s.request('/api/documents?view=active&limit=10');
 const created=await s.request('/api/documents/upload?'+new URLSearchParams({name}),{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Upload-Store-Id':storeScope},body:content},201);
 const list=await s.request('/api/documents?view=active&limit=30',{headers:{'X-Document-Store-Id':storeScope}});
 expect(list.storeScope).toBe(storeScope);const row=list.documents.find((item:any)=>item.id===created.document.id);expect(row).toBeDefined();
 return {binding:bindDocumentDownload(row,list.storeScope),row};
}

it('real boundedTransport list → pinned original download → actual SHA-256 verification preserves exact original bytes',async()=>{
 const s=connection(),{binding}=await fixture(s),path=`/api/documents/${binding.id}/download`;
 const response=await s.transport(path,{headers:{'X-Document-Store-Id':binding.scope}});
 expect(response.headers.get('X-Document-Store-Id')).toBe(binding.scope);expect(response.headers.get('X-Document-Sha256')).toBe(digest(content));expect(response.headers.get('Content-Length')).toBe(String(content.length));
 const verified=await verifyDocumentDownload(response,binding);expect(Buffer.from(await verified.arrayBuffer())).toEqual(content);
 const listed=s.calls.find(call=>call.path==='/api/documents?view=active&limit=30')!;
 const downloaded=s.calls.find(call=>call.path===path)!;
 for(const call of [listed,downloaded]){expect(call.headers.get('X-Document-Store-Id')).toBe(binding.scope);expect(call.credentials).toBe('same-origin');expect(call.redirect).toBe('error');expect(call.cache).toBe('no-store');expect(call.method).toBe('GET');}
});

it('missing malformed duplicate and wrong scopes cross the installed transport and the production server rejects them',async()=>{
 const s=connection(),{binding}=await fixture(s),path=`/api/documents/${binding.id}/download`;
 for(const [headers,status] of [[{},400],[{'X-Document-Store-Id':'bad'},400],[{'X-Document-Store-Id':binding.scope+', '+binding.scope},400],[{'X-Document-Store-Id':randomUUID()},409]] as const){
  const before=s.calls.length,response=await s.transport(path,{headers});expect(response.status).toBe(status);expect(s.calls.length).toBe(before+1);
  expect(response.headers.get('X-Document-Sha256')).toBeNull();expect(response.headers.get('X-Document-Store-Id')).toBeNull();
  await expect(verifyDocumentDownload(response,binding)).rejects.toThrow();
 }
 const rejected=await s.request('/api/documents?view=active',{headers:{'X-Document-Store-Id':randomUUID()}},409);expect(Object.keys(rejected)).toEqual(['error']);
});

it('metadata-only rename and move do not turn valid immutable original bytes into a content change',async()=>{
 const s=connection(),{binding,row}=await fixture(s),workspaceId='download-transport-'+randomUUID();
 await s.request('/api/workspace/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'workspace',id:workspaceId,data:{name:'Synthetic moved workspace'},idempotencyKey:randomUUID()})});
 const changed=await s.request(`/api/documents/${binding.id}/metadata`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'../renamed-display.pdf',workspaceId,folderId:null,revision:row.revision})});
 expect(changed.document.revision).toBe(row.revision+1);expect(changed.document.sha256).toBe(binding.sha256);expect(changed.document.format).toBe(binding.format);
 const response=await s.transport(`/api/documents/${binding.id}/download`,{headers:{'X-Document-Store-Id':binding.scope}});
 expect(response.headers.get('Content-Disposition')).toBe(`attachment; filename="${binding.id}.txt"`);
 expect(Buffer.from(await(await verifyDocumentDownload(response,binding)).arrayBuffer())).toEqual(content);
});

it('download route widening remains blocked before any real network dispatch',async()=>{
 const s=connection(),{binding}=await fixture(s),path=`/api/documents/${binding.id}/download`,before=s.calls.length;
 for(const [target,method] of [[path+'?extra=1','GET'],[path+'#fragment','GET'],[path+'/','GET'],[path,'POST'],[path,'DELETE'],['https://external.invalid'+path,'GET'],['//external.invalid'+path,'GET'],['/api/documents?q=a&q=b','GET']]){
  const rejected=await s.request(target,{method,headers:{'X-Document-Store-Id':binding.scope}},503);expect(rejected.error.code).toBe('UNAVAILABLE');
 }
 expect(s.calls).toHaveLength(before);
});
