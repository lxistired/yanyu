// Original recognition JSON is never updated by these routes.
export function transcriptManagement(db){
 db.exec(`CREATE TABLE IF NOT EXISTS transcript_corrections(job_id TEXT PRIMARY KEY REFERENCES transcription_jobs(id),revision INTEGER NOT NULL,text TEXT,updated TEXT NOT NULL)`);
 // Migrate only the surviving current snapshot. Unknown earlier versions stay unknown.
 db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS transcript_versions(job_id TEXT NOT NULL REFERENCES transcription_jobs(id),revision INTEGER NOT NULL CHECK(revision>0),text TEXT,updated TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('correction','original','restore','migration')),source_revision INTEGER,PRIMARY KEY(job_id,revision));
 INSERT OR IGNORE INTO transcript_versions(job_id,revision,text,updated,kind,source_revision) SELECT job_id,revision,text,updated,'migration',NULL FROM transcript_corrections;
 CREATE TRIGGER IF NOT EXISTS transcript_versions_no_update BEFORE UPDATE ON transcript_versions BEGIN SELECT RAISE(ABORT,'Transcript versions are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS transcript_versions_no_delete BEFORE DELETE ON transcript_versions BEGIN SELECT RAISE(ABORT,'Transcript versions are immutable'); END;
 COMMIT;`);
 const version=(id,revision)=>db.prepare('SELECT revision,text,updated,kind,source_revision AS sourceRevision FROM transcript_versions WHERE job_id=? AND revision=?').get(id,revision);
 const validText=text=>text===null||(typeof text==='string'&&Buffer.byteLength(text)<=262144&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)&&text.isWellFormed());
 const read=id=>{const job=db.prepare('SELECT status,result FROM transcription_jobs WHERE id=? AND deleted_at IS NULL').get(id);if(!job)return null;const c=db.prepare('SELECT revision,text,updated FROM transcript_corrections WHERE job_id=?').get(id);return {status:job.status,raw:job.result?JSON.parse(job.result).text:null,revision:c?.revision??0,corrected:c?.text??null,updated:c?.updated??null}};
 return {async handle(req,send,fail,download){
 const m=/^\/api\/local-asr\/jobs\/([a-f0-9-]{36})\/(transcript|export|transcript-restore|history)(?:\/(0|[1-9][0-9]*))?$/.exec(req.url);if(!m)return false;
 const [_,id,action,requestedRevision]=m;
 if(requestedRevision!==undefined&&action!=='history'){fail(404,'NOT_FOUND','Route not found');return true}
 if(action==='history'){
 if(req.method!=='GET'){fail(405,'INVALID_REQUEST','GET required');return true}
 const t=read(id);if(!t){fail(404,'NOT_FOUND','Task not found');return true}if(t.status!=='completed'){fail(409,'NOT_READY','Only completed results have history');return true}
 if(requestedRevision!==undefined){const n=Number(requestedRevision),v=Number.isSafeInteger(n)?version(id,n):null;if(!v)fail(404,'NOT_FOUND','Version not archived');else send(200,v);return true}
 const versions=db.prepare('SELECT revision,updated,kind,source_revision AS sourceRevision FROM transcript_versions WHERE job_id=? ORDER BY revision DESC').all(id);
 const earliestRevision=versions.at(-1)?.revision??null;
 send(200,{versions,earliestRevision,legacyGap:earliestRevision!==null&&earliestRevision>1});return true
 }
 if(action==='transcript'&&req.method==='GET'){const t=read(id);if(!t)fail(404,'NOT_FOUND','Task not found');else if(t.status!=='completed')fail(409,'NOT_READY','Only completed results can be edited');else send(200,t);return true}
 if(req.method!=='POST'){fail(405,'INVALID_REQUEST','POST required');return true}
 if(req.headers['content-type']!=='application/json'||req.headers['content-encoding']){fail(415,'INVALID_REQUEST','Unencoded JSON required');return true}
 let size=0,parts=[];try{for await(const p of req){size+=p.length;if(size>1048576){fail(413,'INVALID_REQUEST','Request exceeds 1 MiB');return true}parts.push(p)}}catch{return true}
 let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)))}catch{fail(400,'INVALID_REQUEST','Malformed JSON');return true}
 if(!body||Array.isArray(body)||typeof body!=='object'||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0){fail(400,'INVALID_REQUEST','Expected revision required');return true}
 const allowed=action==='export'?['expectedRevision','variant']:action==='transcript-restore'?['expectedRevision','sourceRevision']:['expectedRevision','text'];
 if(Object.keys(body).length!==2||Object.keys(body).some(k=>!allowed.includes(k))||(action==='export'?!['raw','corrected'].includes(body.variant):action==='transcript-restore'?(!Number.isSafeInteger(body.sourceRevision)||body.sourceRevision<1):!validText(body.text))){fail(400,'INVALID_REQUEST','Invalid transcript fields (well-formed Unicode text limit 256 KiB)');return true}

 // Single synchronous transaction prevents competing connections from overwriting a revision.
 db.exec('BEGIN IMMEDIATE');try{
 const t=read(id);if(!t){db.exec('ROLLBACK');fail(404,'NOT_FOUND','Task not found');return true}
 if(t.status!=='completed'||typeof t.raw!=='string'){db.exec('ROLLBACK');fail(409,'NOT_READY','Only completed results can be edited');return true}
 if(t.revision!==body.expectedRevision){db.exec('ROLLBACK');fail(409,'CONFLICT','版本已变化；请载入最新版本后重新校对。未保存内容仍保留。');return true}
 if(action==='export'){
 if(body.variant==='corrected'&&t.corrected===null){db.exec('ROLLBACK');fail(409,'NO_CORRECTION','No saved correction');return true}
 const content=Buffer.from(body.variant==='raw'?t.raw:t.corrected,'utf8');if(content.length>16777216){db.exec('ROLLBACK');fail(413,'INVALID_REQUEST','Export exceeds 16 MiB');return true}
 db.exec('COMMIT');download(`transcript-${id}-${body.variant}-r${t.revision}.txt`,content,t.revision);return true;
 }
 let text=body.text,kind=text===null?'original':'correction',sourceRevision=null;
 if(action==='transcript-restore'){const v=version(id,body.sourceRevision);if(!v){db.exec('ROLLBACK');fail(404,'NOT_FOUND','Version not archived');return true}text=v.text;kind='restore';sourceRevision=v.revision;if(!validText(text)){db.exec('ROLLBACK');fail(400,'INVALID_REQUEST','Archived text cannot be restored: invalid Unicode or size');return true}}
 const next=t.revision+1,updated=new Date().toISOString();
 if(!Number.isSafeInteger(next)){db.exec('ROLLBACK');fail(409,'CONFLICT','Revision limit reached');return true}
 db.prepare('INSERT INTO transcript_versions(job_id,revision,text,updated,kind,source_revision) VALUES(?,?,?,?,?,?)').run(id,next,text,updated,kind,sourceRevision);
 db.prepare('INSERT INTO transcript_corrections(job_id,revision,text,updated) VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET revision=excluded.revision,text=excluded.text,updated=excluded.updated').run(id,next,text,updated);
 const result=read(id);db.exec('COMMIT');send(200,result);return true;
 }catch{try{db.exec('ROLLBACK')}catch{}fail(500,'UNAVAILABLE','Local transcript storage unavailable');return true}
 }};
}
