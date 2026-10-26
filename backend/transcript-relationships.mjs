import {relationshipIdentifier as identifier} from './relationship-identifier.mjs';
// Organizational references only. No transcript is promoted into report evidence.
export function transcriptRelationships(db, workspace) {
 db.exec(`CREATE TABLE IF NOT EXISTS transcript_relationships(job_id TEXT PRIMARY KEY,workspace_id TEXT,session_id TEXT,revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS transcript_relationship_ops(key TEXT PRIMARY KEY,payload TEXT NOT NULL,response TEXT NOT NULL);`);
 const get=(kind,id)=>{try{return workspace.get(kind,id)}catch(e){if(e.code==='NOT_FOUND')return null;throw e}};
 function relationship(id){const r=db.prepare('SELECT * FROM transcript_relationships WHERE job_id=?').get(id);if(!r)return null;const w=r.workspace_id?get('workspace',r.workspace_id):null,s=r.session_id?get('session',r.session_id):null;return {workspaceId:r.workspace_id,sessionId:r.session_id,revision:r.revision,workspaceName:w?.data.name??null,sessionTitle:s?.data.title??null,stale:!!((r.workspace_id&&!w)||(r.session_id&&(!s||s.data.workspaceId!==r.workspace_id)))};}
 const enrich=j=>({...j,relationship:relationship(j.id)});
 function choices(){
  const workspaces=workspace.list('workspace'),sessions=workspace.list('session');
  const counts=db.prepare("SELECT r.workspace_id,r.session_id,count(*) n FROM transcript_relationships r JOIN transcription_jobs j ON j.id=r.job_id WHERE j.status='completed' AND j.deleted_at IS NULL GROUP BY r.workspace_id,r.session_id").all();
  const validSessions=new Map(sessions.map(s=>[s.id,s.data.workspaceId]));
  return {workspaces:workspaces.map(w=>({id:w.id,name:w.data.name,count:counts.filter(c=>c.workspace_id===w.id&&(!c.session_id||validSessions.get(c.session_id)===w.id)).reduce((n,c)=>n+c.n,0)})),sessions:sessions.filter(s=>workspaces.some(w=>w.id===s.data.workspaceId)).map(s=>({id:s.id,title:s.data.title,workspaceId:s.data.workspaceId,count:counts.filter(c=>c.session_id===s.id&&c.workspace_id===s.data.workspaceId).reduce((n,c)=>n+c.n,0)}))};
 }
 return {enrich,async handle(req,send,fail){
  if(req.url==='/api/local-asr/relationships'){if(req.method!=='GET')fail(405,'INVALID_REQUEST','GET required');else {try{send(200,choices())}catch{fail(503,'UNAVAILABLE','Workspace choices unavailable')}}return true}
  const m=/^\/api\/local-asr\/jobs\/([a-f0-9-]{36})\/relationship$/.exec(req.url);if(!m)return false;
  if(req.method!=='POST'){fail(405,'INVALID_REQUEST','POST required');return true}
  if(req.headers['content-type']!=='application/json'||req.headers['content-encoding']){fail(415,'INVALID_REQUEST','Unencoded JSON required');return true}
  let body;try{let size=0,parts=[];for await(const p of req){size+=p.length;if(size>4096){fail(413,'INVALID_REQUEST','Request exceeds 4 KiB');return true}parts.push(p)}body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)))}catch{fail(400,'INVALID_REQUEST','Malformed UTF-8 JSON');return true}
  const keys=['expectedRevision','workspaceId','sessionId','idempotencyKey'];
  if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).length!==4||Object.keys(body).some(k=>!keys.includes(k))||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||!(body.workspaceId===null||identifier(body.workspaceId))||!(body.sessionId===null||identifier(body.sessionId))||(!body.workspaceId&&body.sessionId)||typeof body.idempotencyKey!=='string'||! /^[a-f0-9-]{36}$/.test(body.idempotencyKey)){fail(400,'INVALID_REQUEST','Valid relationship, revision and operation UUID required');return true}
  const payload=JSON.stringify([m[1],body.expectedRevision,body.workspaceId,body.sessionId]);
  db.exec('BEGIN IMMEDIATE');try{
   const job=db.prepare('SELECT status,deleted_at FROM transcription_jobs WHERE id=?').get(m[1]);
   if(!job||job.deleted_at){db.exec('ROLLBACK');fail(404,'NOT_FOUND','请先恢复转写');return true}
   if(job.status!=='completed'){db.exec('ROLLBACK');fail(409,'CONFLICT','只有已完成的转写可以关联');return true}
   const replay=db.prepare('SELECT * FROM transcript_relationship_ops WHERE key=?').get(body.idempotencyKey);
   if(replay){db.exec('ROLLBACK');if(replay.payload!==payload)fail(409,'CONFLICT','操作编号已用于其他内容');else send(200,{...JSON.parse(replay.response),replayed:true});return true}
   const current=relationship(m[1]);
   if((current?.revision??0)!==body.expectedRevision){db.exec('ROLLBACK');fail(409,'CONFLICT','关联已变化，请刷新后重试');return true}
   const w=body.workspaceId?get('workspace',body.workspaceId):null,s=body.sessionId?get('session',body.sessionId):null;
   if((body.workspaceId&&!w)||(body.sessionId&&(!s||s.data.workspaceId!==body.workspaceId))){db.exec('ROLLBACK');fail(409,'CONFLICT','工作区或会话已失效，或会话不属于此工作区，请重新选择');return true}
   if(db.prepare('SELECT count(*) n FROM transcript_relationship_ops').get().n>=10000){db.exec('ROLLBACK');fail(429,'RATE_LIMITED','Relationship operation history limit reached');return true}
   db.prepare('INSERT INTO transcript_relationships VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET workspace_id=excluded.workspace_id,session_id=excluded.session_id,revision=excluded.revision').run(m[1],body.workspaceId,body.sessionId,body.expectedRevision+1);
   const response={relationship:relationship(m[1])};db.prepare('INSERT INTO transcript_relationship_ops VALUES(?,?,?)').run(body.idempotencyKey,payload,JSON.stringify(response));db.exec('COMMIT');send(200,response);return true;
  }catch{try{db.exec('ROLLBACK')}catch{}fail(503,'UNAVAILABLE','Relationship storage unavailable');return true}
 }};
}
