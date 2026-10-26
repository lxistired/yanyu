let scopeHeaders;
import {fork,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
const here=import.meta.dirname,prep=spawnSync(process.execPath,[join(here,'prepare-backend.mjs')],{encoding:'utf8'});assert.equal(prep.status,0,prep.stderr);
const root=mkdtempSync(join(tmpdir(),'yanyu-relationships-'));let child,origin;const checks=[];
async function start(){await new Promise((ok,no)=>{child=fork(join(here,'server.mjs'),[prep.stdout.trim(),root,join(root,'events.jsonl'),'0'],{stdio:['ignore','pipe','inherit','ipc']});child.once('message',m=>{origin=m.origin;ok()});child.once('error',no)})}
async function stop(){if(child?.exitCode===null)await new Promise(ok=>{child.once('exit',ok);child.kill('SIGTERM')})}
const id=n=>`12345678-1234-1234-1234-${String(n).padStart(12,'0')}`;
const call=async(path,body)=>{const r=await fetch(origin+'/api/'+path,body===undefined?{headers:path.startsWith('local-asr/')?scopeHeaders:{}}:{method:'POST',headers:{...(path.startsWith('local-asr/')?scopeHeaders:{}),'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()}};
const good=async(path,body)=>{const r=await call(path,body);assert.equal(r.status,200,JSON.stringify(r));return r.body};
const assign=(n,revision,workspaceId,sessionId=null,key=randomUUID())=>call(`local-asr/jobs/${id(n)}/relationship`,{expectedRevision:revision,workspaceId,sessionId,idempotencyKey:key});
const job=async n=>(await good('local-asr/jobs?jobId='+id(n))).jobs[0];
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name)}
const create=(kind,id,data)=>good('workspace/create',{kind,id,data,idempotencyKey:randomUUID()});
const mutate=(op,kind,id,expectedRevision,patch)=>good('workspace/'+op,{kind,id,expectedRevision,idempotencyKey:randomUUID(),...(patch?{patch}:{})});
try{await start();
// Discover once for this synthetic store; retain the captured scope across restarts.
const identityResponse=await fetch(origin+'/api/local-asr/identity');
assert.equal(identityResponse.status,200);
const identityBody=await identityResponse.json();
assert.deepEqual(Object.keys(identityBody),['transcriptionStoreId']);
assert.equal(identityResponse.headers.get('x-transcription-store-id'),identityBody.transcriptionStoreId);
assert.match(identityBody.transcriptionStoreId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
scopeHeaders=Object.freeze({'X-Transcription-Store-Id':identityBody.transcriptionStoreId});
const db=new DatabaseSync(join(root,'long-transcription.sqlite'));const raw=JSON.stringify({text:'合成识别原文 searchable needle',duration_seconds:2,inference_seconds:1,language:'zh'});for(let n=1;n<=5;n++)db.prepare('INSERT INTO transcription_jobs(id,filename,status,created,result) VALUES(?,?,?,?,?)').run(id(n),`synthetic-${n}.wav`,n===5?'failed':'completed','2026-01-01',n===5?null:raw);
await create('workspace','wa',{name:'工作区 A'});await create('workspace','wb',{name:'工作区 B'});await create('session','sa',{title:'会话 A',workspaceId:'wa'});await create('session','sb',{title:'会话 B',workspaceId:'wb'});
await check('only completed active jobs accept explicit assignments',async()=>{assert.equal((await assign(5,0,'wa')).status,409);assert.equal((await assign(1,0,'wa','sa')).status,200);assert.equal((await job(1)).relationship.workspaceName,'工作区 A')});
await check('cross-workspace session and session without workspace rejected',async()=>{assert.equal((await assign(1,1,'wb','sa')).status,409);assert.equal((await assign(2,0,null,'sa')).status,400);assert.equal((await job(1)).relationship.revision,1)});
const key=randomUUID();let command={expectedRevision:0,workspaceId:'wb',sessionId:'sb',idempotencyKey:key};
await check('same idempotency key replays without advancing revision; mismatched reuse rejects',async()=>{const path=`local-asr/jobs/${id(2)}/relationship`;const first=await good(path,command),second=await good(path,command);assert.deepEqual(second.relationship,first.relationship);assert(second.replayed);assert.equal((await call(path,{...command,workspaceId:'wa',sessionId:null})).status,409);assert.equal((await job(2)).relationship.revision,1)});
await check('concurrent edits have one revision winner',async()=>{const results=await Promise.all([assign(1,1,'wa',null),assign(1,1,'wb','sb')]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409])});
await assign(1,2,'wa','sa');
await check('workspace/session counts and combined text filters match current records',async()=>{const c=await good('local-asr/relationships');assert.equal(c.workspaces.find(w=>w.id==='wa').count,1);assert.equal(c.sessions.find(s=>s.id==='sb').count,1);assert.equal((await good('local-asr/jobs?workspaceId=wa&sessionId=sa&q=needle')).total,1);assert.equal((await good('local-asr/jobs?q=needle')).total,4)});
await check('rename changes live labels without changing IDs, relationship revision or raw text',async()=>{await mutate('update','workspace','wa',1,{name:'更名工作区'});await mutate('update','session','sa',1,{title:'更名会话'});const r=(await job(1)).relationship;assert.equal(r.workspaceName,'更名工作区');assert.equal(r.sessionTitle,'更名会话');assert.equal(r.revision,3);assert.equal(db.prepare('SELECT result FROM transcription_jobs WHERE id=?').get(id(1)).result,raw)});
await check('trash hides links/counts and disallows relation writes; restore preserves valid relation',async()=>{await good(`local-asr/jobs/${id(2)}/trash`,{expectedRevision:0});assert.equal((await good('local-asr/jobs?workspaceId=wb')).total,0);assert.equal((await assign(2,1,'wa')).status,404);assert.equal((await good('local-asr/relationships')).workspaces.find(w=>w.id==='wb').count,0);await good(`local-asr/jobs/${id(2)}/restore`,{expectedRevision:1});assert.equal((await job(2)).relationship.sessionId,'sb')});
await check('deleting a selected workspace while editing rejects assignment without modifying job',async()=>{await create('workspace','wc',{name:'will delete'});await mutate('remove','workspace','wc',1);assert.equal((await assign(3,0,'wc')).status,409);assert.equal((await job(3)).relationship,null)});
await check('deleted session marks association stale; transcript retained; counts exclude stale relationship',async()=>{await mutate('remove','session','sa',2);const r=(await job(1)).relationship;assert(r.stale);assert.equal(r.sessionTitle,null);assert.equal((await good('local-asr/relationships')).workspaces.find(w=>w.id==='wa').count,0);assert.equal(db.prepare('SELECT result FROM transcription_jobs WHERE id=?').get(id(1)).result,raw)});
await check('deleted workspace causes no transcript cascade; stale association survives trash restore',async()=>{await mutate('remove','workspace','wa',2);await good(`local-asr/jobs/${id(1)}/trash`,{expectedRevision:0});await good(`local-asr/jobs/${id(1)}/restore`,{expectedRevision:1});assert((await job(1)).relationship.stale);assert.equal((await good('local-asr/jobs?q=needle')).total,4)});
await check('stale relationship can be explicitly cleared, revision still enforced',async()=>{assert.equal((await assign(1,2,null)).status,409);assert.equal((await assign(1,3,null)).status,200);const r=(await job(1)).relationship;assert.equal(r.workspaceId,null);assert.equal(r.revision,4);assert.equal(r.stale,false)});
await check('malformed unknown duplicated filter and relationship fields fail closed',async()=>{assert.equal((await call('local-asr/jobs?workspaceId=wa&workspaceId=wb')).status,400);assert.equal((await call('local-asr/jobs?workspaceId=%00')).status,400);assert.equal((await call(`local-asr/jobs/${id(3)}/relationship`,{...command,raw:'mutated'})).status,400)});
await check('restart retains references, revisions, idempotency and generic search',async()=>{await stop();await start();assert.equal((await job(2)).relationship.sessionId,'sb');assert.equal((await job(1)).relationship.revision,4);const replay=await good(`local-asr/jobs/${id(2)}/relationship`,command);assert(replay.replayed);assert.equal((await good('local-asr/jobs?q=needle')).total,4)});
db.close();mkdirSync(join(here,'../workspace-evidence'),{recursive:true});writeFileSync(join(here,'../workspace-evidence/HTTP_RESULT.json'),JSON.stringify({passed:true,count:checks.length,checks,scope:'Actual local HTTP and SQLite with synthetic completed jobs; no new audio or model inference'},null,2));
}finally{await stop()}
