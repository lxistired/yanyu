import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {transcriptionLibrary} from './transcription-library.mjs';
const db=new DatabaseSync(':memory:');
// Include a permissive historical column to exercise label/filter normalization too.
db.exec(`CREATE TABLE transcription_jobs(id TEXT PRIMARY KEY,filename TEXT,status TEXT,created TEXT,result TEXT,error TEXT,progress TEXT,requested_language TEXT,pending_expires_at INTEGER,original_upload_origin TEXT); CREATE TABLE transcript_corrections(job_id TEXT PRIMARY KEY,text TEXT); CREATE TABLE transcript_relationships(job_id TEXT,workspace_id TEXT,session_id TEXT);`);
const library=transcriptionLibrary(db,{enrich:r=>r});
const insert=db.prepare('INSERT INTO transcription_jobs(id,filename,status,created,result,deleted_at,original_upload_origin) VALUES(?,?,?,?,?,?,?)');
const add=(id,origin,status='completed',trash=null,created='2024-02-29')=>insert.run(id,`synthetic-${id}.wav`,status,created,JSON.stringify({text:'raw needle',boundaries:[]}),trash,origin);
for(let i=0;i<25;i++)add('page'+String(i).padStart(2,'0'),'file-selection');
add('draft','recording-draft');add('legacy','unknown');add('null-legacy',null);add('invalid-legacy','unsupported');add('busy','recording-draft','processing',null,'2020-01-01');add('trash','unknown','failed','deleted');
for(const id of ['page00','draft','legacy'])db.prepare('INSERT INTO transcript_relationships VALUES(?,?,?)').run(id,'w','s');
db.prepare('INSERT INTO transcript_corrections VALUES(?,?)').run('legacy','corrected-only');
const list=(query='')=>{let result;library.list('/api/local-asr/jobs?'+query,(status,data)=>result={status,...data},(status,code)=>result={status,code},{});return result};
assert.equal(list().total,30);
for(const [origin,total] of [['file-selection',25],['recording-draft',2],['unknown',3]]){const ids=[];for(let offset=0;offset<total;offset+=10){const r=list(`origin=${origin}&offset=${offset}`);assert.equal(r.status,200);assert.equal(r.total,total);assert.equal(r.hasMore,offset+r.jobs.length<total);assert.equal(r.activeJobCount,1);assert(r.jobs.every(j=>j.uploadOrigin===origin));ids.push(...r.jobs.map(j=>j.id))}assert.equal(new Set(ids).size,total)}
assert.deepEqual(list('origin=file-selection&offset=20').jobs.map(j=>j.id),['page04','page03','page02','page01','page00']);
const combined='workspaceId=w&sessionId=s&statuses=completed&createdFrom=2024-02-29&createdThrough=2024-02-29';
for(const origin of ['file-selection','recording-draft','unknown'])assert.equal(list(combined+'&q=needle&origin='+origin).total,1);
assert.equal(list(combined+'&origin=unknown&jobId=legacy&q=corrected-only').total,1);
assert.equal(list(combined+'&origin=file-selection&jobId=legacy').total,0);
assert.equal(list(combined+'&origin=recording-draft&sessionId=other').status,400);
assert.equal(list('origin=unknown&scope=trash&statuses=failed').total,1);
assert.equal(list('origin=unknown&scope=trash&q=missing').activeJobCount,1);
assert.equal(list('origin=recording-draft&createdFrom=2024-02-29').total,1);
for(const query of ['origin=','origin=all','origin=File-selection','origin=recording','origin=1','origin=null','origin=%20unknown','origin=unknown%20','origin=unknown,file-selection','origin=unknown&origin=unknown','origin=unknown&origin=file-selection','origin='+('x'.repeat(1000)),'origins=unknown'])assert.equal(list(query).status,400,query);
assert.equal(list('origin=unknown&offset=30').hasMore,false);
db.close();console.log('PASS origin enum, strict duplicates, normalized legacy unknown, stable count/pages, intersections, global processing; synthetic in-memory SQLite only');
