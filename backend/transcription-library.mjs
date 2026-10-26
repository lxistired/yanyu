import {relationshipIdentifier} from './relationship-identifier.mjs';
import {initializeTranscriptionOrigin,publicUploadOrigin} from './transcription-origin.mjs';
import {createdDateBounds, storedCreatedInstant} from '../candidate/src/components/transcription-created-date.mjs';
import {initializeUploadReceipts,uploadReceiptAvailable} from './upload-receipts.mjs';
import {publicTranscriptionError} from './transcription-errors.mjs';
// Library metadata is independent of immutable recognition and correction revisions.
export function transcriptionLibrary(db,relationships) {
 initializeUploadReceipts(db);
 initializeTranscriptionOrigin(db);
 db.function('transcription_created_utc', {deterministic:true}, storedCreatedInstant);
 const columns=db.prepare('PRAGMA table_info(transcription_jobs)').all().map(c=>c.name);
 for(const [name,type] of [['title','TEXT'],['library_revision','INTEGER NOT NULL DEFAULT 0'],['deleted_at','TEXT']])if(!columns.includes(name))db.exec(`ALTER TABLE transcription_jobs ADD COLUMN ${name} ${type}`);
 db.exec('CREATE INDEX IF NOT EXISTS transcription_library_order ON transcription_jobs(deleted_at,created DESC,id DESC)');
 const select=`j.original_upload_origin,j.original_upload_receipt,j.id,j.filename,j.pending_expires_at,j.status,j.created,j.error,j.progress,j.requested_language,COALESCE(j.title,j.filename) AS title,j.library_revision,j.deleted_at, CASE WHEN j.result IS NULL THEN NULL ELSE json_object('text',substr(json_extract(j.result,'$.text'),1,4096),'text_preview_truncated',length(json_extract(j.result,'$.text'))>4096,'duration_seconds',json_extract(j.result,'$.duration_seconds'),'inference_seconds',json_extract(j.result,'$.inference_seconds'),'language',json_extract(j.result,'$.language'),'language_source',json_extract(j.result,'$.language_source'),'boundaries_truncated',json_array_length(j.result,'$.boundaries')>32,'boundaries',json((SELECT json_group_array(json(value)) FROM (SELECT value FROM json_each(j.result,'$.boundaries') LIMIT 32)))) END AS result`;
 const decode=({original_upload_origin,original_upload_receipt,...r})=>({...r,...publicUploadOrigin(original_upload_origin),uploadReceiptAvailable:uploadReceiptAvailable(original_upload_receipt,r.requested_language),...publicTranscriptionError(r.error),result:r.result?(()=>{const result=JSON.parse(r.result);result.text_preview_truncated=!!result.text_preview_truncated;result.boundaries_truncated=!!result.boundaries_truncated;return result})():null,progress:r.progress?JSON.parse(r.progress):null});
 const row=id=>{const r=db.prepare(`SELECT ${select} FROM transcription_jobs j WHERE j.id=?`).get(id);return r?relationships.enrich(decode(r)):null};
 function list(url,send,fail,model){
  const u=new URL(url,'http://localhost'),p=u.searchParams;
  if([...p.keys()].some(k=>!['q','scope','offset','limit','workspaceId','sessionId','jobId','statuses','createdFrom','createdThrough','origin'].includes(k))||[...p.keys()].some(k=>p.getAll(k).length!==1)){fail(400,'INVALID_REQUEST','Unknown or repeated query parameter');return}
  const q=p.get('q')??'',scope=p.get('scope')??'active',offsetText=p.get('offset')??'0',limitText=p.get('limit')??'10';
  if(Buffer.byteLength(q)>512||/[\u0000-\u001f\u007f\ufffd]/.test(q)||!['active','trash'].includes(scope)||!/^\d{1,4}$/.test(offsetText)||!/^\d{1,2}$/.test(limitText)||+offsetText>1000||+limitText<1||+limitText>30){fail(400,'INVALID_REQUEST','Query max 512 UTF-8 bytes; offset 0–1000; limit 1–30; scope active or trash');return}
  const allowedStatuses=['interrupted','processing','completed','cancelled','failed'];
  const statuses=p.has('statuses')?p.get('statuses').split(','):[];
  if(statuses.length>5||new Set(statuses).size!==statuses.length||statuses.some(value=>!allowedStatuses.includes(value))){fail(400,'INVALID_REQUEST','Invalid status filter');return}
  const origin=p.has('origin')?p.get('origin'):null;
  if(origin!==null&&!['unknown','file-selection','recording-draft'].includes(origin)){fail(400,'INVALID_REQUEST','Invalid client-declared origin filter');return}
  const dates=createdDateBounds(p.has('createdFrom')?p.get('createdFrom'):undefined,p.has('createdThrough')?p.get('createdThrough'):undefined);
  if(!dates){fail(400,'INVALID_REQUEST','Creation dates must be real YYYY-MM-DD UTC dates (0001–9999), start not after end');return}
  const filters=['workspaceId','sessionId','jobId'].map(k=>p.get(k));
  if(filters.slice(0,2).some(v=>v!==null&&!relationshipIdentifier(v)) || (filters[2]!==null&&!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(filters[2]))){fail(400,'INVALID_REQUEST','Invalid relationship filter');return}
  const where=`j.deleted_at IS ${scope==='trash'?'NOT ':''}NULL AND (?='' OR instr(lower(COALESCE(j.title,j.filename)),lower(?))>0 OR instr(lower(j.filename),lower(?))>0 OR instr(lower(COALESCE(json_extract(j.result,'$.text'),'')),lower(?))>0 OR instr(lower(COALESCE(c.text,'')),lower(?))>0)`;
  const extra=` AND (? IS NULL OR j.id IN (SELECT job_id FROM transcript_relationships WHERE workspace_id=?)) AND (? IS NULL OR j.id IN (SELECT job_id FROM transcript_relationships WHERE session_id=?)) AND (? IS NULL OR j.id=?)`;
  const statusPredicate=statuses.length?` AND j.status IN (${statuses.map(()=>'?').join(',')})`:'';
  const datePredicate=p.has('createdFrom')||p.has('createdThrough')?' AND transcription_created_utc(j.created) IS NOT NULL AND (? IS NULL OR transcription_created_utc(j.created)>=?) AND (? IS NULL OR transcription_created_utc(j.created)<?)':'';
  const originPredicate=origin===null?'':" AND (CASE WHEN j.original_upload_origin IN ('file-selection','recording-draft') THEN j.original_upload_origin ELSE 'unknown' END)=?";
  const params=[q,q,q,q,q,...filters.flatMap(v=>[v,v]),...statuses,...(datePredicate?[dates.start,dates.start,dates.endExclusive,dates.endExclusive]:[]),...(origin===null?[]:[origin])];
  // SQLite evaluates full text one row at a time; the JS response contains bounded previews only.
  const total=db.prepare(`SELECT count(*) n FROM transcription_jobs j LEFT JOIN transcript_corrections c ON c.job_id=j.id WHERE ${where}${extra}${statusPredicate}${datePredicate}${originPredicate}`).get(...params).n;
  const jobs=db.prepare(`SELECT ${select} FROM transcription_jobs j LEFT JOIN transcript_corrections c ON c.job_id=j.id WHERE ${where}${extra}${statusPredicate}${datePredicate}${originPredicate} ORDER BY j.created DESC,j.id DESC LIMIT ? OFFSET ?`).all(...params,+limitText,+offsetText).map(decode).map(relationships.enrich);
  send(200,{jobs,model,total,offset:+offsetText,limit:+limitText,hasMore:+offsetText+jobs.length<total,activeJobCount:db.prepare("SELECT count(*) n FROM transcription_jobs WHERE status='processing'").get().n});
 }
 return {list,async handle(req,send,fail){
  const m=/^\/api\/local-asr\/jobs\/([a-f0-9-]{36})\/(rename|trash|restore)$/.exec(req.url);if(!m)return false;
  if(req.method!=='POST'){fail(405,'INVALID_REQUEST','POST required');return true}
  if(req.headers['content-type']!=='application/json'||req.headers['content-encoding']){fail(415,'INVALID_REQUEST','Unencoded JSON required');return true}
  let body;try{let size=0,parts=[];for await(const p of req){size+=p.length;if(size>4096){fail(413,'INVALID_REQUEST','Request exceeds 4 KiB');return true}parts.push(p)}body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)))}catch{fail(400,'INVALID_REQUEST','Malformed UTF-8 JSON');return true}
  const action=m[2],keys=action==='rename'?['expectedRevision','title']:['expectedRevision'];
  if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).length!==keys.length||Object.keys(body).some(k=>!keys.includes(k))||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||(action==='rename'&&(typeof body.title!=='string'||!body.title.trim()||Buffer.byteLength(body.title)>512||/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(body.title)))){fail(400,'INVALID_REQUEST','Expected metadata revision and valid title (1–512 UTF-8 bytes) required');return true}
  db.exec('BEGIN IMMEDIATE');try{
   const job=row(m[1]);if(!job){db.exec('ROLLBACK');fail(404,'NOT_FOUND','Task not found');return true}
   if(job.library_revision!==body.expectedRevision){db.exec('ROLLBACK');fail(409,'CONFLICT','记录版本已变化，请刷新后重试');return true}
   if(action==='trash'&&['processing','interrupted'].includes(job.status)){db.exec('ROLLBACK');fail(409,'RUNNING','正在识别的任务不能移入回收站；请等待完成或明确点击取消转写');return true}
   if((action==='restore'&&!job.deleted_at)||(action!=='restore'&&job.deleted_at)){db.exec('ROLLBACK');fail(409,'CONFLICT','记录所在列表已变化，请刷新后重试');return true}
   if(action==='rename')db.prepare('UPDATE transcription_jobs SET title=?,library_revision=library_revision+1 WHERE id=?').run(body.title.trim(),m[1]);
   else db.prepare('UPDATE transcription_jobs SET deleted_at=?,library_revision=library_revision+1 WHERE id=?').run(action==='trash'?new Date().toISOString():null,m[1]);
   const updated=row(m[1]);db.exec('COMMIT');send(200,{job:updated});return true;
  }catch{try{db.exec('ROLLBACK')}catch{}fail(500,'UNAVAILABLE','Local library storage unavailable');return true}
 }};
}
