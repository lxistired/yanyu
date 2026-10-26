let scopeHeaders;
import {fork,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
const here=import.meta.dirname,prep=spawnSync(process.execPath,[join(here,'prepare-backend.mjs')],{encoding:'utf8'});assert.equal(prep.status,0,prep.stderr);
const build=prep.stdout.trim(),root=mkdtempSync(join(tmpdir(),'yanyu-history-test-'));let child,origin;const checks=[];
async function start(){await new Promise((ok,no)=>{child=fork(join(here,'server.mjs'),[build,root,join(root,'events.jsonl'),'0'],{stdio:['ignore','pipe','inherit','ipc']});child.once('message',m=>{origin=m.origin;ok()});child.once('error',no)})}
async function stop(){if(child?.exitCode===null)await new Promise(ok=>{child.once('exit',ok);child.kill('SIGTERM')})}
const id='12345678-1234-1234-1234-123456789abc',legacy='12345678-1234-1234-1234-123456789abd',invalid='12345678-1234-1234-1234-123456789abe';
const path=(action,job=id)=>`/api/local-asr/jobs/${job}/${action}`;
const post=(action,input,job=id)=>fetch(origin+path(action,job),{method:'POST',headers:{...scopeHeaders,'Content-Type':'application/json'},body:JSON.stringify(input)});
const get=async(action='transcript',job=id)=>{const r=await fetch(origin+path(action,job),{headers:scopeHeaders});assert.equal(r.status,200);return r.json()};
const put=(expectedRevision,text)=>post('transcript',{expectedRevision,text});
const restore=(expectedRevision,sourceRevision,job=id)=>post('transcript-restore',{expectedRevision,sourceRevision},job);
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name)}
let db;
try{
// Start the current host once to initialize unrelated schema, then emulate exactly the prior correction schema.
await start();
// Discover once for this synthetic store; retain the captured scope across restarts.
const identityResponse=await fetch(origin+'/api/local-asr/identity');
assert.equal(identityResponse.status,200);
const identityBody=await identityResponse.json();
assert.deepEqual(Object.keys(identityBody),['transcriptionStoreId']);
assert.equal(identityResponse.headers.get('x-transcription-store-id'),identityBody.transcriptionStoreId);
assert.match(identityBody.transcriptionStoreId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
scopeHeaders=Object.freeze({'X-Transcription-Store-Id':identityBody.transcriptionStoreId});
await stop();db=new DatabaseSync(join(root,'long-transcription.sqlite'));
db.exec('DROP TRIGGER transcript_versions_no_update; DROP TRIGGER transcript_versions_no_delete; DROP TABLE transcript_versions;');
const raw=JSON.stringify({text:'原始 ASR 🌱\n<script>literal</script>',duration_seconds:2});
for(const job of [id,legacy,invalid])db.prepare('INSERT INTO transcription_jobs(id,filename,status,created,result) VALUES(?,?,?,?,?)').run(job,'synthetic.wav','completed','2026-10-01T00:00:00.000Z',raw);
db.prepare('INSERT INTO transcript_corrections VALUES(?,?,?,?)').run(legacy,7,'迁移校对版本七','2026-10-02T00:00:00.000Z');
db.prepare('INSERT INTO transcript_corrections VALUES(?,?,?,?)').run(invalid,3,'x'.repeat(262145),'2026-10-02T00:00:00.000Z');
await start();
await check('prior-schema migration preserves only surviving snapshot without invented history',async()=>{const h=await get('history',legacy);assert.deepEqual(h,{versions:[{revision:7,updated:'2026-10-02T00:00:00.000Z',kind:'migration',sourceRevision:null}],earliestRevision:7,legacyGap:true});assert.equal((await get('history/7',legacy)).text,'迁移校对版本七');assert.equal((await fetch(origin+path('history/6',legacy),{headers:scopeHeaders})).status,404);assert.equal((await get('transcript',legacy)).revision,7)});
await check('new job starts with no fabricated revision-zero correction',async()=>{assert.deepEqual(await get('history'),{versions:[],earliestRevision:null,legacyGap:false})});
await check('edits, empty edits and original-reset each append an immutable snapshot',async()=>{for(const [rev,text] of [[0,'校对一 🌱\n e\u0301'],[1,''],[2,null]])assert.equal((await put(rev,text)).status,200);assert.deepEqual((await get('history')).versions.map(v=>[v.revision,v.kind]),[[3,'original'],[2,'correction'],[1,'correction']]);assert.equal((await get('history/1')).text,'校对一 🌱\n e\u0301');assert.equal((await get('history/2')).text,'');assert.equal((await get('history/3')).text,null)});
const archive=()=>db.prepare('SELECT * FROM transcript_versions WHERE job_id=? ORDER BY revision').all(id);
const before=archive();
await check('restore creates new revision with provenance and keeps all previous bytes and raw ASR unchanged',async()=>{assert.equal((await restore(3,1)).status,200);assert.equal((await get()).revision,4);assert.equal((await get()).corrected,before[0].text);assert.deepEqual(archive().slice(0,3),before);assert.equal((await get('history/4')).sourceRevision,1);assert.equal(db.prepare('SELECT result FROM transcription_jobs WHERE id=?').get(id).result,raw);assert.throws(()=>db.prepare('UPDATE transcript_versions SET text=? WHERE job_id=?').run('tamper',id),/immutable/);assert.throws(()=>db.prepare('DELETE FROM transcript_versions WHERE job_id=?').run(id),/immutable/)});
await check('simultaneous stale restore permits one append only and preserves winning state',async()=>{const responses=await Promise.all([restore(4,1),restore(4,2)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal((await get()).revision,5);assert.equal(archive().length,5);assert.deepEqual(archive().slice(0,3),before)});
await check('restore validates source revision, fields and missing version without mutations',async()=>{for(const input of [{expectedRevision:5,sourceRevision:0},{expectedRevision:5,sourceRevision:-1},{expectedRevision:5,sourceRevision:1.5},{expectedRevision:5,sourceRevision:'1'},{expectedRevision:5,sourceRevision:1,text:'bad'}])assert.equal((await post('transcript-restore',input)).status,400);assert.equal((await restore(5,99)).status,404);assert.equal((await get()).revision,5)});
await check('Unicode controls, lone surrogates, malformed UTF-8 and byte limits reject safely',async()=>{for(const text of ['\ud800','\udfff','\0','中'.repeat(87382)])assert.equal((await put(5,text)).status,400);const r=await fetch(origin+path('transcript'),{method:'POST',headers:{...scopeHeaders,'Content-Type':'application/json'},body:Buffer.from([123,34,120,34,58,34,255,34,125])});assert.equal(r.status,400);assert.equal((await restore(3,3,invalid)).status,400);assert.equal((await get()).revision,5);assert.equal((await put(5,'🌱'.repeat(65536))).status,200);assert.equal((await get()).revision,6)});
await check('null historical snapshot restores original state as new revision and maintains exports',async()=>{assert.equal((await restore(6,3)).status,200);assert.equal((await get()).corrected,null);assert.equal((await post('export',{expectedRevision:7,variant:'corrected'})).status,409);const r=await post('export',{expectedRevision:7,variant:'raw'});assert.equal(await r.text(),JSON.parse(raw).text);assert.equal((await post('export',{expectedRevision:6,variant:'raw'})).status,409)});
await check('restart preserves exact archive; old revision can still restore afterward',async()=>{const snapshots=archive();await stop();await start();assert.deepEqual(archive(),snapshots);assert.equal((await restore(7,1)).status,200);assert.equal((await get()).revision,8);assert.equal((await get()).corrected,before[0].text);await stop();await start();assert.equal((await get()).revision,8);assert.equal((await get()).corrected,before[0].text);assert.equal((await get('history',legacy)).versions.length,1)});
await check('recoverable trash hides history and restore; recovery retains every version',async()=>{const snapshots=archive();db.prepare('UPDATE transcription_jobs SET deleted_at=? WHERE id=?').run(new Date().toISOString(),id);assert.equal((await fetch(origin+path('history'),{headers:scopeHeaders})).status,404);assert.equal((await restore(8,1)).status,404);db.prepare('UPDATE transcription_jobs SET deleted_at=NULL WHERE id=?').run(id);assert.deepEqual(archive(),snapshots);assert.equal((await get('history')).versions.length,8)});
mkdirSync(join(here,'../history-evidence'),{recursive:true});writeFileSync(join(here,'../history-evidence/HTTP_RESULT.json'),JSON.stringify({passed:true,count:checks.length,checks,scope:'Synthetic fixtures only; HTTP, SQLite and child process restarts. No browser deletion action.'},null,2));
}finally{db?.close();await stop()}
