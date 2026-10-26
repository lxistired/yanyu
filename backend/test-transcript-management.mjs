let scopeHeaders;
import {fork,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
const here=import.meta.dirname,prep=spawnSync(process.execPath,[join(here,'prepare-backend.mjs')],{encoding:'utf8'});assert.equal(prep.status,0,prep.stderr);
const build=prep.stdout.trim(),root=mkdtempSync(join(tmpdir(),'yanyu-transcript-test-'));let child,origin;const checks=[];
async function start(){await new Promise((ok,no)=>{child=fork(join(here,'server.mjs'),[build,root,join(root,'events.jsonl'),'0'],{stdio:['ignore','pipe','inherit','ipc']});child.once('message',m=>{origin=m.origin;ok()});child.once('error',no)})}
async function stop(){if(child?.exitCode===null)await new Promise(ok=>{child.once('exit',ok);child.kill('SIGTERM')})}
const id='12345678-1234-1234-1234-123456789abc',missing='12345678-1234-1234-1234-123456789abd',processing='12345678-1234-1234-1234-123456789abe';
const path=()=>`/api/local-asr/jobs/${id}/transcript`;
const post=(path,input,headers={})=>fetch(origin+path,{method:'POST',headers:{...scopeHeaders,'Content-Type':'application/json',...headers},body:JSON.stringify(input)});
const get=async()=>{const r=await fetch(origin+path(),{headers:scopeHeaders});assert.equal(r.status,200);return r.json()};
const put=(expectedRevision,text)=>post(path(),{expectedRevision,text});
const exp=(expectedRevision,variant)=>post(`/api/local-asr/jobs/${id}/export`,{expectedRevision,variant});
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name)}
try{await start();
// Discover once for this synthetic store; retain the captured scope across restarts.
const identityResponse=await fetch(origin+'/api/local-asr/identity');
assert.equal(identityResponse.status,200);
const identityBody=await identityResponse.json();
assert.deepEqual(Object.keys(identityBody),['transcriptionStoreId']);
assert.equal(identityResponse.headers.get('x-transcription-store-id'),identityBody.transcriptionStoreId);
assert.match(identityBody.transcriptionStoreId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
scopeHeaders=Object.freeze({'X-Transcription-Store-Id':identityBody.transcriptionStoreId});
const db=new DatabaseSync(join(root,'long-transcription.sqlite'));const raw=JSON.stringify({text:'原始文字\nhello <script> & =1',duration_seconds:2,inference_seconds:1,language:'zh'});db.prepare('INSERT INTO transcription_jobs(id,filename,status,created,result) VALUES(?,?,?,?,?)').run(id,'synthetic.wav','completed',new Date().toISOString(),raw);db.prepare('INSERT INTO transcription_jobs(id,filename,status,created) VALUES(?,?,?,?)').run(processing,'synthetic.wav','processing',new Date().toISOString());
await check('existing completed jobs have revision zero and unchanged immutable original',async()=>{assert.deepEqual(await get(),{status:'completed',raw:JSON.parse(raw).text,revision:0,corrected:null,updated:null})});
await check('UTF-8 correction persists separately with increasing revision',async()=>{assert.equal((await put(0,'人工校对\nHello 🌱')).status,200);assert.equal((await get()).revision,1);assert.equal((await get()).corrected,'人工校对\nHello 🌱');assert.equal(db.prepare('SELECT result FROM transcription_jobs WHERE id=?').get(id).result,raw)});
await check('concurrent stale saves cannot overwrite a newer revision',async()=>{const results=await Promise.all([put(1,'winner A'),put(1,'winner B')]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await get()).revision,2)});
await check('raw and corrected TXT preserve exact bytes and have safe distinct filenames and privacy headers',async()=>{for(const variant of ['raw','corrected']){const r=await exp(2,variant),t=await get();assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'text/plain; charset=utf-8');assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.match(r.headers.get('content-disposition'),new RegExp(`filename="transcript-${id}-${variant}-r2.txt"`));const b=Buffer.from(await r.arrayBuffer());assert.equal(b.length,Number(r.headers.get('content-length')));assert.deepEqual(b,Buffer.from(variant==='raw'?t.raw:t.corrected));assert(!b.includes(Buffer.from(root)))}});
await check('stale export and unsupported variants fail closed',async()=>{assert.equal((await exp(1,'raw')).status,409);for(const variant of ['srt','../secret','RAW'])assert.equal((await exp(2,variant)).status,400)});
await check('unknown, incomplete and malformed routes are rejected',async()=>{assert.equal((await fetch(origin+`/api/local-asr/jobs/${missing}/transcript`,{headers:scopeHeaders})).status,404);assert.equal((await fetch(origin+`/api/local-asr/jobs/${processing}/transcript`,{headers:scopeHeaders})).status,409);for(const route of ['/api/local-asr/jobs/..%2fsecret/transcript','/api/local-asr/jobs/x/transcript'])assert.equal((await fetch(origin+route,{headers:scopeHeaders})).status,404)});
await check('invalid revision, unknown fields, controls, type and UTF-8 size fail without changing saved data',async()=>{for(const input of [{text:'x'},{expectedRevision:-1,text:'x'},{expectedRevision:2.5,text:'x'},{expectedRevision:2,text:5},{expectedRevision:2,text:'\0'},{expectedRevision:2,text:'中'.repeat(90000)},{expectedRevision:2,text:'x',raw:'rewritten'}])assert.equal((await post(path(),input)).status,400);assert.equal((await post(path(),{expectedRevision:2,text:'x'},{'Content-Type':'text/plain'})).status,415);assert.equal((await get()).revision,2)});
await check('origin isolation rejects cross-site changes',async()=>{assert.equal((await post(path(),{expectedRevision:2,text:'x'},{Origin:'https://invalid.example'})).status,403)});
await check('empty correction is intentional and exported as zero exact bytes',async()=>{assert.equal((await put(2,'')).status,200);const r=await exp(3,'corrected');assert.equal(r.status,200);assert.equal((await r.arrayBuffer()).byteLength,0)});
await check('explicit revert retains original and advances revision; corrected export unavailable',async()=>{assert.equal((await put(3,null)).status,200);assert.equal((await get()).corrected,null);assert.equal((await get()).revision,4);assert.equal((await exp(4,'corrected')).status,409);assert.equal(db.prepare('SELECT result FROM transcription_jobs WHERE id=?').get(id).result,raw)});
await check('restart keeps correction revision and raw result',async()=>{await put(4,'重启保存 🌱');await stop();await start();assert.equal((await get()).corrected,'重启保存 🌱');assert.equal((await get()).revision,5);assert.equal((await get()).raw,JSON.parse(raw).text)});
db.close();mkdirSync(join(here,'../transcript-evidence'),{recursive:true});writeFileSync(join(here,'../transcript-evidence/HTTP_RESULT.json'),JSON.stringify({passed:true,count:checks.length,checks},null,2));
}finally{await stop()}
