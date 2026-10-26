// Sidecar raster-page notes. Never updates the PDF or its extracted text.
import {randomUUID,createHash} from 'node:crypto';
export const ANNOTATION_LIMITS=Object.freeze({count:250,commentBytes:4096,minSize:0.002});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=(status,message)=>{throw Object.assign(Error(message),{status})};
const hash=b=>createHash('sha256').update(b).digest('hex');
export function validateAnnotation(data,r){
 if(!data||Array.isArray(data)||Object.keys(data).sort().join(',')!=='comment,page,rect,revision,sha256')fail(400,'sha256, revision, page, rect and comment required');
 if(typeof data.sha256!=='string'||!/^[a-f0-9]{64}$/.test(data.sha256)||!Number.isSafeInteger(data.revision)||data.revision<0)fail(400,'Invalid annotation identity or revision');
 if(data.sha256!==r.sha256)fail(409,'Document identity changed; reload notes');
 if(!Number.isSafeInteger(data.page)||data.page<1||data.page>r.pages)fail(400,'Page outside document');
 if(typeof data.comment!=='string'||!data.comment.trim()||!data.comment.isWellFormed()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(data.comment)||Buffer.byteLength(data.comment)>ANNOTATION_LIMITS.commentBytes)fail(400,'Comment must be nonempty valid Unicode, at most 4096 UTF-8 bytes');
 const v=data.rect;if(v!==null){if(!v||Array.isArray(v)||Object.keys(v).length!==4||!['x','y','width','height'].every(k=>Object.hasOwn(v,k)&&typeof v[k]==='number'&&Number.isFinite(v[k]))||v.x<0||v.y<0||v.width<ANNOTATION_LIMITS.minSize||v.height<ANNOTATION_LIMITS.minSize||v.x+v.width>1||v.y+v.height>1)fail(400,'Invalid normalized rectangle');}
 return data;
}
export function pdfAnnotations(db){
 db.exec(`CREATE TABLE IF NOT EXISTS document_annotation_revisions(document_id TEXT PRIMARY KEY REFERENCES research_documents(id),sha256 TEXT NOT NULL,revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS document_annotations(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES research_documents(id),sha256 TEXT NOT NULL,page INTEGER NOT NULL,rect TEXT,comment TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS document_annotation_lookup ON document_annotations(document_id);`);
 function integrity(r){if(r.format!=='pdf')fail(415,'Annotations require a PDF');if(!Number.isSafeInteger(r.pages)||r.pages<1||r.pages>40||r.bytes!==r.original.length||hash(r.original)!==r.sha256||hash(Buffer.from(r.text))!==r.text_sha256)fail(409,'Document integrity check failed');}
 function snapshot(r){integrity(r);const revision=db.prepare('SELECT * FROM document_annotation_revisions WHERE document_id=?').get(r.id);if(revision&&revision.sha256!==r.sha256)fail(409,'Annotation document identity mismatch');const rows=db.prepare('SELECT * FROM document_annotations WHERE document_id=? ORDER BY created,id').all(r.id);if(rows.some(n=>n.sha256!==r.sha256))fail(409,'Annotation document identity mismatch');return {documentId:r.id,sha256:r.sha256,revision:revision?.revision??0,notes:rows.map(n=>({id:n.id,page:n.page,rect:n.rect===null?null:JSON.parse(n.rect),comment:n.comment,createdAt:n.created,updatedAt:n.updated}))};}
 return {snapshot,write(r,data,id=null){integrity(r);validateAnnotation(data,r);if(id!==null&&!uuid.test(id))fail(404,'Annotation not found');db.exec('BEGIN IMMEDIATE');try{const current=snapshot(r);if(current.revision!==data.revision)fail(409,'Notes changed in another tab. Reload notes before saving; your draft is retained.');if(id!==null&&!current.notes.some(n=>n.id===id))fail(404,'Annotation not found');if(id===null&&current.notes.length>=ANNOTATION_LIMITS.count)fail(429,'250 notes per document maximum');const now=new Date().toISOString();if(id===null)db.prepare('INSERT INTO document_annotations VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),r.id,r.sha256,data.page,data.rect===null?null:JSON.stringify(data.rect),data.comment,now,now);else db.prepare('UPDATE document_annotations SET page=?,rect=?,comment=?,updated=? WHERE id=? AND document_id=? AND sha256=?').run(data.page,data.rect===null?null:JSON.stringify(data.rect),data.comment,now,id,r.id,r.sha256);db.prepare('INSERT INTO document_annotation_revisions VALUES(?,?,?) ON CONFLICT(document_id) DO UPDATE SET revision=excluded.revision').run(r.id,r.sha256,current.revision+1);const result=snapshot(r);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e}}};
}
