// @vitest-environment node
// Real application transport + loopback HTTP, fresh synthetic SQLite only.
import {beforeAll,afterAll,it,expect} from 'vitest';
import {fork,spawnSync,type ChildProcess} from 'node:child_process';
import {mkdtempSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {boundedTransport} from '../visual-harness/bounded-transport';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
let child:ChildProcess,origin:string;
const root=mkdtempSync(join(tmpdir(),'yanyu-citation-transport-'));
const nativeFetch=globalThis.fetch;
beforeAll(async()=>{
 // npm test is supported before an explicit build on a clean source extraction.
 if(!existsSync('dist/index.html')){
  const build=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build'],{encoding:'utf8'});
  expect(build.status,build.stderr).toBe(0);
 }
 const prep=spawnSync(process.execPath,['backend/prepare-backend.mjs'],{encoding:'utf8'});expect(prep.status,prep.stderr).toBe(0);
 const storage=join(root,'store');mkdirSync(storage);
 await new Promise<void>((resolve,reject)=>{
  child=fork(join(process.cwd(),'backend/server.mjs'),[prep.stdout.trim(),storage,join(root,'events.jsonl'),'0'],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,HOME:root}});
  let errors='';child.stderr!.on('data',data=>errors+=data);
  child.once('message',(message:any)=>{origin=message.origin;resolve();});
  child.once('exit',code=>reject(Error(`Synthetic server exited ${code}: ${errors}`)));child.once('error',reject);
 });
},30000);
afterAll(async()=>{if(child?.exitCode===null)await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill('SIGTERM');});});
it('the installed application transport carries actual citation save/list/reopen/trash/restore requests',async()=>{
 const calls:string[]=[];
 const send:typeof fetch=async(input,init)=>{calls.push(String(input));return nativeFetch(origin+String(input),init);};
 const transport=boundedTransport(new OrdinaryRequestLifetime(),send),text='Synthetic 😀 quote\nSynthetic 😀 quote';
 async function request(method:string,path:string,body?:string|Buffer,status=200){
  const response=await transport(path,{method,...(body===undefined?{}:{body:body as BodyInit,headers:{'Content-Type':Buffer.isBuffer(body)?'application/octet-stream':'application/json'}})});
  const data=await response.json();expect(response.status,JSON.stringify(data)).toBe(status);return data;
 }
 let doc=(await request('POST','/api/documents/upload?name=transport-synthetic.txt',Buffer.from(text),201)).document;
 const base=`/api/documents/${doc.id}`,quote='Synthetic 😀 quote',start=text.lastIndexOf(quote);
 expect((await request('GET',base+'/citations')).citations).toEqual([]);
 const draft={operationId:randomUUID(),documentRevision:doc.revision,documentSha256:doc.sha256,textSha256:doc.textSha256,start,end:start+quote.length,quote,quoteSha256:createHash('sha256').update(quote).digest('hex'),rangeUnit:'utf16-code-unit',note:'Transport synthetic note'};
 const citation=(await request('POST',base+'/citations',JSON.stringify(draft),201)).citation;
 expect((await request('GET',base+'/citations')).citations).toEqual([citation]);
 expect((await request('GET',base+'/citations/'+citation.id)).citation).toEqual(citation);
 doc=(await request('PUT',base+'/trash',JSON.stringify({revision:doc.revision}))).document;
 await request('GET',base+'/citations/'+citation.id,undefined,409);
 doc=(await request('PUT',base+'/restore',JSON.stringify({revision:doc.revision}))).document;
 expect((await request('GET',base+'/citations/'+citation.id)).citation).toEqual(citation);
 expect(calls.filter(path=>path.includes('/citations')).length).toBe(6);
 const count=calls.length;
 await request('DELETE',base+'/citations/'+citation.id,undefined,503);
 await request('GET',base+'/citations?unapproved=1',undefined,503);
 expect(calls).toHaveLength(count);
});
