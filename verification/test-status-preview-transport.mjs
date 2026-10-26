// In-process synthetic transport plus real production handler / synthetic SQLite. Never HTTP.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
registerHooks({resolve(s,c,next){if(s.startsWith('.')&&c.parentURL){const u=new URL(s,c.parentURL);if(!/\.[a-z]+$/i.test(u.pathname)&&existsSync(fileURLToPath(u)+'.ts'))return {url:u.href+'.ts',shortCircuit:true};}return next(s,c);},load(u,c,next){if(u.endsWith('.ts'))return {format:'module',source:stripTypeScriptTypes(readFileSync(new URL(u),'utf8')),shortCircuit:true};return next(u,c);}});
const {boundedTransport,durableOperations}=await import('../visual-harness/bounded-transport.ts');
const {OrdinaryRequestLifetime}=await import('../candidate/src/components/ordinary-navigation.ts');
const {transcriptionLibrary}=await import('../backend/transcription-library.mjs');
const base='/api/local-asr/jobs',statuses=['interrupted','processing','completed','cancelled','failed'];
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE transcription_jobs(id TEXT PRIMARY KEY,filename TEXT,status TEXT,created TEXT,result TEXT,error TEXT,progress TEXT,requested_language TEXT,pending_expires_at INTEGER); CREATE TABLE transcript_corrections(job_id TEXT PRIMARY KEY,text TEXT); CREATE TABLE transcript_relationships(job_id TEXT,workspace_id TEXT,session_id TEXT);`);
 const library=transcriptionLibrary(db,{enrich:row=>row});
 for(const [i,status] of [...statuses,'legacy'].entries())db.prepare('INSERT INTO transcription_jobs(id,filename,status,created) VALUES(?,?,?,?)').run(String(i),'fixture.wav',status,'2026-01-01');
 const direct=path=>{let out;library.list(path,(status,value)=>out={status,value},(status,code)=>out={status,value:{code}},{});return out;};
 const calls=[];const transport=boundedTransport(new OrdinaryRequestLifetime(),async(input,init)=>{calls.push({input,init});const out=direct(input);return new Response(JSON.stringify(out.value),{status:out.status});});
 return {db,direct,calls,transport};
}
function permutations(values,prefix=[]){return values.flatMap((value,i)=>{const next=[...prefix,value];return [next,...permutations(values.filter((_,j)=>j!==i),next)];});}
test('all 325 status permutations reach real handler unchanged with synthetic SQLite',async()=>{
 const f=fixture();try{
  for(const selected of permutations(statuses)){
   const input=base+'?'+new URLSearchParams({statuses:selected.join(','),limit:'10'}),r=await f.transport(input),body=await r.json();
   assert.equal(r.status,200,input);assert.equal(body.total,selected.length);assert.deepEqual(body.jobs.map(j=>j.status).sort(),[...selected].sort());
   assert.equal(f.calls.at(-1).input,input);assert.deepEqual(f.calls.at(-1).init,{credentials:'same-origin',redirect:'error',cache:'no-store'});
  }
  assert.equal(f.calls.length,325);assert.equal((await (await f.transport(base)).json()).total,6);assert.equal((await (await f.transport(base+'?statuses='+statuses.join(','))).json()).total,5);
 }finally{f.db.close();}
});
test('invalid statuses/repeated keys blocked before fetch and rejected independently by production',async()=>{
 const f=fixture();try{
  const queries=['statuses=','statuses=completed,','statuses=,failed','statuses=completed,,failed','statuses=completed,completed','statuses=Completed','statuses=completed%20','statuses=%20completed','statuses=completed+','statuses=all','statuses=1','statuses=cancelling','statuses=queued','statuses=completed&statuses=failed','statuses=completed&%73tatuses=failed','statuses=completed%00','statuses=%FF','statuses=completed%252Cfailed','statuses='+encodeURIComponent("completed') OR 1=1--"),'statuses='+statuses.concat('failed').join(','),'status=completed','statuses=completed&unexpected=x','statuses=completed&q=a&q=b','statuses=completed?garbage','statuses=completed?&statuses=failed','statuses=completed?&unexpected=x','q=fixture?&statuses=completed&statuses=failed','q=fixture?&statuses=completed&unexpected=x','statuses=completed%3Fgarbage','statuses=completed%26statuses%3Dfailed','statuses=completed%23','statuses=completed%2F','statuses=completed%0A'];
  for(const q of queries){const path=base+'?'+q;assert.equal((await f.transport(path)).status,503,path);assert.equal(f.direct(path).status,400,path);assert.equal(f.direct(path).value.code,'INVALID_REQUEST');}assert.equal(f.calls.length,0);
 }finally{f.db.close();}
});
test('combines existing query filters; other value validation remains in production',async()=>{
 const f=fixture();try{
  for(const q of ['statuses=completed&q=fixture&scope=active&offset=0&limit=10&jobId=2','%73tatuses=completed','statuses=failed%2Ccompleted','statuses=%63ompleted','statuses=completed&q=fixture?tail','statuses=completed&q=fixture%3Ftail%26value%3Dx'])assert.equal((await f.transport(base+'?'+q)).status,200);
  assert.equal((await (await f.transport(base+'?statuses=completed&jobId=2')).json()).total,1);
  assert.equal((await (await f.transport(base+'?statuses=completed&scope=trash&workspaceId=w&sessionId=s')).json()).total,0);
  for(const q of ['statuses=completed&limit=31','statuses=completed&offset=1001','statuses=completed&scope=bogus'])assert.equal((await f.transport(base+'?'+q)).status,400);
 }finally{f.db.close();}
});
test('forbidden route/host/method/fragment bounds and existing durable routes preserved',async()=>{
 let calls=0;const t=boundedTransport(new OrdinaryRequestLifetime(),async()=>{calls++;return new Response('{}');});
 const id='12345678-abcd-4abc-8abc-123456789abc';
 const paths=[base+'/?statuses=completed',base+'?statuses=completed#x','https://evil.test'+base+'?statuses=completed','//evil.test'+base+'?statuses=completed',base+'/delete?statuses=completed','/api/documents?statuses=completed','/api/private-demo/companies?statuses=completed','/api/local-scheduler/schedules?statuses=completed','/api/integrations?statuses=completed','/api/workspace/list?statuses=completed',base+'/'+id+'/history?statuses=completed',base+'/'+id+'/transcript?statuses=completed',base+'/'+id+'/retry?statuses=completed','/api/files','/api/login','/api/feedback/create','/api/service-report-mail/send','/api/workspace/constructor','/api/service-reports/openReportSource/extra'];
 for(const path of paths)for(const method of ['GET','POST'])assert.equal((await t(path,{method})).status,503,method+' '+path);
 for(const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS'])assert.equal((await t(base+'?statuses=completed',{method})).status,503);
 for(const input of [new URL('https://evil.test'+base+'?statuses=completed'),new Request('https://evil.test'+base+'?statuses=completed')])assert.equal((await t(input)).status,503);
 assert.equal(calls,0);assert.equal((await t('/api/integrations')).status,200);assert.equal(calls,0);
 for(const [mod,ops] of Object.entries(durableOperations))for(const op of ops)await t(`/api/${mod}/${op}`,{method:'POST',body:'{}'});
 assert.equal(calls,Object.values(durableOperations).flat().length);
});
