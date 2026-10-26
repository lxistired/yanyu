// Append-only local evidence references. Integrity is not factual verification.
import {createHash,randomUUID} from 'node:crypto';
const hash=s=>createHash('sha256').update(s,'utf8').digest('hex');
const fail=(status,message)=>{throw Object.assign(Error(message),{status})};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const boundary=(s,n)=>n===0||n===s.length||!(s.charCodeAt(n-1)>=0xd800&&s.charCodeAt(n-1)<=0xdbff&&s.charCodeAt(n)>=0xdc00&&s.charCodeAt(n)<=0xdfff);
export function documentCitations(db){
 db.exec(`CREATE TABLE IF NOT EXISTS document_citations(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES research_documents(id),document_sha256 TEXT NOT NULL,text_sha256 TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,quote TEXT NOT NULL,quote_sha256 TEXT NOT NULL,note TEXT NOT NULL,label_at_creation TEXT NOT NULL,created TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS citations_immutable_update BEFORE UPDATE ON document_citations BEGIN SELECT RAISE(ABORT,'Immutable citation'); END;
 CREATE TRIGGER IF NOT EXISTS citations_immutable_delete BEFORE DELETE ON document_citations BEGIN SELECT RAISE(ABORT,'Immutable citation'); END;
 CREATE TABLE IF NOT EXISTS document_citation_operations(operation_id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES research_documents(id),request_sha256 TEXT NOT NULL,citation_id TEXT NOT NULL REFERENCES document_citations(id));
 CREATE TRIGGER IF NOT EXISTS citation_operations_immutable_update BEFORE UPDATE ON document_citation_operations BEGIN SELECT RAISE(ABORT,'Immutable citation operation'); END;
 CREATE TRIGGER IF NOT EXISTS citation_operations_immutable_delete BEFORE DELETE ON document_citation_operations BEGIN SELECT RAISE(ABORT,'Immutable citation operation'); END;`);
 function validateSource(r){
  if(!r||typeof r.text!=='string'||!r.text.isWellFormed()||Buffer.from(r.original).length!==r.bytes||Buffer.byteLength(r.text)!==r.text_bytes||hash(Buffer.from(r.original))!==r.sha256||hash(r.text)!==r.text_sha256)fail(409,'Citation source integrity mismatch');
 }
 function validateReference(r,c){
  if(!c||c.document_id!==r.id||r.sha256!==c.document_sha256||r.text_sha256!==c.text_sha256)fail(409,'Citation source integrity mismatch');
  if(!Number.isSafeInteger(c.start)||!Number.isSafeInteger(c.end)||c.start<0||c.end<=c.start||c.end>r.text.length||!boundary(r.text,c.start)||!boundary(r.text,c.end))fail(422,'Invalid UTF-16 range or split surrogate pair');
  if(typeof c.quote!=='string'||!c.quote.isWellFormed()||r.text.slice(c.start,c.end)!==c.quote||hash(c.quote)!==c.quote_sha256)fail(409,'Citation quote or quote hash mismatch');
 }
 function validate(r,c){validateSource(r);validateReference(r,c)}
 const dto=c=>({id:c.id,documentId:c.document_id,documentSha256:c.document_sha256,textSha256:c.text_sha256,start:c.start,end:c.end,rangeUnit:'utf16-code-unit',rangeConvention:'half-open',quote:c.quote,quoteSha256:c.quote_sha256,note:c.note,labelAtCreation:c.label_at_creation,createdAt:c.created,level:'document-text',page:null});
 return {
  list(r){validateSource(r);return {citations:db.prepare('SELECT * FROM document_citations WHERE document_id=? ORDER BY created,id').all(r.id).map(c=>{validateReference(r,c);return dto(c)}),documentName:r.name,trashed:!!r.trashed_at}},
  recover(r,operationId){
   if(typeof operationId!=='string'||!uuid.test(operationId))fail(400,'Valid citation operation UUID required');
   // This is a receipt check, not a new association: retained immutable evidence
   // remains verifiable after metadata changes or trash, with access checked by
   // the caller against the document's current workspace before entering here.
   validateSource(r);
   const prior=db.prepare('SELECT * FROM document_citation_operations WHERE operation_id=?').get(operationId);
   if(!prior)return {operationId,outcome:'absent'};
   if(prior.document_id!==r.id)fail(409,'Citation operation does not belong to this document');
   const citation=db.prepare('SELECT * FROM document_citations WHERE id=?').get(prior.citation_id);validateReference(r,citation);
   if(typeof prior.request_sha256!=='string'||! /^[a-f0-9]{64}$/.test(prior.request_sha256))fail(409,'Citation operation integrity mismatch');
   return {operationId,outcome:'committed',requestSha256:prior.request_sha256,citation:dto(citation)};
  },
  create(r,data,validateNewAssociation=()=>{},validateCurrentAccess=()=>{}){
   const keys=['documentRevision','documentSha256','end','note','operationId','quote','quoteSha256','rangeUnit','start','textSha256'];
   if(!data||Array.isArray(data)||Object.keys(data).sort().join(',')!==keys.join(',')||data.rangeUnit!=='utf16-code-unit'||!Number.isSafeInteger(data.documentRevision)||data.documentRevision<0||typeof data.operationId!=='string'||!uuid.test(data.operationId))fail(400,'Exact citation fields, UUID operationId and UTF-16 range unit required');
   if(typeof data.note!=='string'||!data.note.isWellFormed()||/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(data.note)||Buffer.byteLength(data.note)>4096)fail(422,'Invalid or over-limit human note');
   if(typeof data.quote!=='string'||Buffer.byteLength(data.quote)>16384)fail(422,'Quote exceeds 16 KiB');
   const requestHash=hash(JSON.stringify(keys.map(key=>[key,data[key]])));
   db.exec('BEGIN IMMEDIATE');
   try{
    // A delayed request may have crossed another tab's rename/trash operation.
    r=db.prepare('SELECT * FROM research_documents WHERE id=?').get(r.id);
    // The locked row may have moved since the caller's initial access check.
    // Replays need the same current-source permission check as new writes.
    validateCurrentAccess(r);
    const prior=db.prepare('SELECT * FROM document_citation_operations WHERE operation_id=?').get(data.operationId);
    if(prior){
     if(prior.document_id!==r.id||prior.request_sha256!==requestHash)fail(409,'Citation operation already used with different content');
     const citation=db.prepare('SELECT * FROM document_citations WHERE id=?').get(prior.citation_id);validate(r,citation);
     db.exec('COMMIT');return {operationId:data.operationId,requestSha256:prior.request_sha256,citation:dto(citation)};
    }
    // A committed receipt is immutable evidence, not a new association write.
    // Only new citations need an association that still exists.
    validateNewAssociation(r);
    if(r.trashed_at)fail(409,'Restore document before citing');
    if(r.revision!==data.documentRevision)fail(409,'Document metadata changed; reopen before citing');
    const c={id:randomUUID(),document_id:r.id,document_sha256:data.documentSha256,text_sha256:data.textSha256,start:data.start,end:data.end,quote:data.quote,quote_sha256:data.quoteSha256,note:data.note,label_at_creation:r.name,created:new Date().toISOString()};validate(r,c);
    if(db.prepare('SELECT count(*) n FROM document_citations').get().n>=2000)fail(429,'Local citation quota reached');
    db.prepare('INSERT INTO document_citations VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(c.id,c.document_id,c.document_sha256,c.text_sha256,c.start,c.end,c.quote,c.quote_sha256,c.note,c.label_at_creation,c.created);
    db.prepare('INSERT INTO document_citation_operations VALUES(?,?,?,?)').run(data.operationId,r.id,requestHash,c.id);
    db.exec('COMMIT');return {operationId:data.operationId,requestSha256:requestHash,citation:dto(c)};
   }catch(error){db.exec('ROLLBACK');throw error;}
  },
  reopen(r,id){const c=db.prepare('SELECT * FROM document_citations WHERE id=? AND document_id=?').get(id,r.id);if(!c)fail(404,'Citation not found for document');if(r.trashed_at)fail(409,'Source is in trash; restore document before reopening');validate(r,c);return {citation:dto(c),text:r.text}}
 };
}
