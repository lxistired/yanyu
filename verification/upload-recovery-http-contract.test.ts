// @vitest-environment node
// Production server and installed application transport, restricted to loopback and fresh synthetic SQLite.
import {beforeAll,afterAll,it,expect} from 'vitest';
import {fork,spawnSync,type ChildProcess} from 'node:child_process';
import {mkdtempSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {boundedTransport} from '../visual-harness/bounded-transport';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';

let child:ChildProcess,origin:string;
const root=mkdtempSync(join(tmpdir(),'yanyu-upload-recovery-transport-'));
const nativeFetch=globalThis.fetch;
beforeAll(async()=>{
 if(!existsSync('dist/index.html')){
  const build=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build'],{encoding:'utf8'});
  expect(build.status,build.stderr||build.stdout).toBe(0);
 }
 const prep=spawnSync(process.execPath,['backend/prepare-backend.mjs'],{encoding:'utf8'});expect(prep.status,prep.stderr).toBe(0);
 const storage=join(root,'store');mkdirSync(storage);
 await new Promise<void>((resolve,reject)=>{
  child=fork(join(process.cwd(),'backend/server.mjs'),[prep.stdout.trim(),storage,join(root,'events.jsonl'),'0'],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,HOME:root,YANYU_PYTHON:'/nonexistent/synthetic-test-python'}});
  let errors='';child.stderr!.on('data',data=>errors+=data);
  child.once('message',(message:any)=>{origin=message.origin;resolve()});
  child.once('exit',code=>reject(Error(`Synthetic upload server exited ${code}: ${errors}`)));child.once('error',reject);
 });
 expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
},30000);
afterAll(async()=>{if(child?.exitCode===null)await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill('SIGTERM')})});

function connection(){
 const calls:{path:string;method:string;headers:Headers;body:BodyInit|null|undefined}[]=[];
 let dropNextUpload=false;
 const send:typeof fetch=async(input,init)=>{
  const path=String(input);calls.push({path,method:init?.method??'GET',headers:new Headers(init?.headers),body:init?.body});
  // A regression in route admission must never make this test contact an external service.
  if(!path.startsWith('/api/')||path.startsWith('//')||path.includes('://'))throw Error('Synthetic transport permits loopback relative API paths only');
  const response=await nativeFetch(origin+path,init);
  if(dropNextUpload&&path.startsWith('/api/documents/upload?')){
   dropNextUpload=false;expect(response.status).toBe(201);await response.arrayBuffer();
   throw new TypeError('Synthetic lost acknowledgement after real upload commit');
  }
  return response;
 };
 const transport=boundedTransport(new OrdinaryRequestLifetime(),send);
 async function request(path:string,init?:RequestInit,status=200){
  const response=await transport(path,init),data=await response.json();expect(response.status,JSON.stringify(data)).toBe(status);return data;
 }
 return {calls,transport,request,loseNextUploadAcknowledgement:()=>{dropNextUpload=true}};
}

it('the application transport recovers a real lost upload response and replays its original operation without another document',async()=>{
 const s=connection(),{uploadScope:scope}=await s.request('/api/documents/choices');
 expect(scope).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
 const operationId=randomUUID(),body=Buffer.from('Synthetic upload recovery through the actual application transport.\nNo user files or services.'),sha256=createHash('sha256').update(body).digest('hex');
 const path='/api/documents/upload?name=transport-recovery-synthetic.txt',lookup='/api/documents/upload-operations/'+operationId;
 const headers={'Content-Type':'application/octet-stream','X-Upload-Operation-Id':operationId,'X-Upload-Store-Id':scope};
 const before=await s.request('/api/documents?view=active&limit=10');expect(before.total).toBe(0);
 expect(await s.request(lookup)).toEqual({scope,operationId,outcome:'absent'});
 s.loseNextUploadAcknowledgement();
 await expect(s.transport(path,{method:'POST',headers,body})).rejects.toThrow('Synthetic lost acknowledgement after real upload commit');
 const checked=await s.request(lookup);
 expect(checked).toMatchObject({scope,operationId,outcome:'committed',receipt:{operationId,name:'transport-recovery-synthetic.txt',format:'txt',bytes:body.length,sha256,workspaceId:null,folderId:null},document:{name:'transport-recovery-synthetic.txt',sha256,bytes:body.length}});
 expect(checked.document.id).toBe(checked.receipt.documentId);
 const afterLoss=await s.request('/api/documents?view=active&limit=10');expect(afterLoss.total).toBe(1);expect(afterLoss.documents.map((doc:any)=>doc.id)).toEqual([checked.receipt.documentId]);
 const replay=await s.request(path,{method:'POST',headers,body},201);
 expect(replay.receipt).toEqual(checked.receipt);expect(replay.document.id).toBe(checked.document.id);
 const afterRetry=await s.request('/api/documents?view=active&limit=10');expect(afterRetry.total).toBe(afterLoss.total);expect(afterRetry.documents.map((doc:any)=>doc.id)).toEqual([checked.receipt.documentId]);
 const uploads=s.calls.filter(call=>call.path===path);expect(uploads).toHaveLength(2);
 for(const upload of uploads){expect(upload.headers.get('X-Upload-Operation-Id')).toBe(operationId);expect(upload.headers.get('X-Upload-Store-Id')).toBe(scope);expect(upload.body).toBe(body)}
 // Reusing that UUID for changed content remains a conflict, with the original receipt and one document intact.
 await s.request(path,{method:'POST',headers,body:Buffer.from('Different synthetic content')},409);
 expect((await s.request(lookup)).receipt).toEqual(checked.receipt);expect((await s.request('/api/documents?view=active&limit=10')).total).toBe(1);
});

it('recovery query, fragment, method and encoded-path widening are rejected before real network dispatch',async()=>{
 const s=connection(),lookup='/api/documents/upload-operations/'+randomUUID();
 await s.request(lookup);expect(s.calls).toHaveLength(1);const before=s.calls.length;
 for(const [path,method] of [
  [lookup+'?extra=1','GET'],[lookup+'?operationId='+randomUUID(),'GET'],[lookup+'?','GET'],[lookup+'#fragment','GET'],
  [lookup,'POST'],[lookup,'DELETE'],[lookup+'/','GET'],[lookup.replace('/upload-operations/','/upload-operations%2f'),'GET'],
  [lookup+'%3fextra=1','GET'],['https://external.invalid'+lookup,'GET'],['//external.invalid'+lookup,'GET'],
 ]){
  const result=await s.request(path,{method},503);expect(result.error.code).toBe('UNAVAILABLE');
 }
 expect(s.calls).toHaveLength(before);
});
