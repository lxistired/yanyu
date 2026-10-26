import {createManualInventoryObserver} from './manual-inventory-observer.mjs';
import {realpathSync,statSync} from 'node:fs';
import {reportDocumentSources} from './report-document-sources.mjs';
import {relationshipIdentifier as identifier} from './relationship-identifier.mjs';
// Local immutable document bytes and derived text. No remote retrieval or executable rendering.
import {documentCitations} from './document-citations.mjs';
import {pdfAnnotations} from './pdf-annotations.mjs';
import {pdfPageReader} from './pdf-page-reader.mjs';
import {documentUploadOperations,uploadOperationId} from './document-upload-operations.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
export const DOCUMENT_LIMITS=Object.freeze({bytes:8*1024*1024,textBytes:1024*1024,pages:40,count:250,totalBytes:64*1024*1024,totalTextBytes:64*1024*1024,queryBytes:512,parserTimeoutMs:5000});
const sha=b=>createHash('sha256').update(b).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const norm=s=>s.normalize('NFC').toLowerCase();
function failure(status,message){throw Object.assign(Error(message),{status})}
function cleanText(s,max=DOCUMENT_LIMITS.textBytes){if(!s.isWellFormed()||/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(s)||Buffer.byteLength(s)>max)failure(422,'Text contains unsupported controls, invalid Unicode or exceeds byte limit');return s}
function nameValue(s){if(typeof s!=='string'||!s.trim()||/[\\/\u0000-\u001f\u007f]/u.test(s))failure(400,'A plain nonempty filename/name is required');return cleanText(s,512)}
function displayValue(s){if(typeof s!=='string'||!s.trim()||/[\u0000-\u001f\u007f]/u.test(s))failure(400,'A nonempty display name without controls is required');return cleanText(s,512)}
function params(url,allowed){const p=new URL(url,'http://local').searchParams;for(const k of p.keys())if(!allowed.includes(k)||p.getAll(k).length!==1)failure(400,'Unknown or repeated query parameter');return p}
function association(p){const workspaceId=p.get('workspaceId')??null,folderId=p.get('folderId')??null;if(workspaceId!==null&&!identifier(workspaceId)||folderId!==null&&!uuid.test(folderId))failure(400,'Invalid association identifier');return {workspaceId,folderId}}
async function body(req,limit){if(req.headers['content-encoding'])failure(415,'Encoded request bodies are unsupported');const n=req.headers['content-length'];if(n&&(!/^\d+$/.test(n)||Number(n)>limit))failure(413,'Body exceeds byte limit');const parts=[];let size=0;for await(const p of req){size+=p.length;if(size>limit)failure(413,'Body exceeds byte limit');parts.push(p)}return Buffer.concat(parts)}
function runPdf(binary,args,maxBuffer,bytes){return new Promise((resolve,reject)=>{const child=execFile('/usr/bin/prlimit',['--as=536870912','--cpu=4','--fsize=2097152','--nofile=64','--',binary,...args],{encoding:'buffer',timeout:DOCUMENT_LIMITS.parserTimeoutMs,maxBuffer,killSignal:'SIGKILL',env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'}},(err,out,stderr)=>{if(err||stderr.length)return reject(Object.assign(Error('PDF parser rejected malformed, encrypted, unsupported or over-limit document'),{status:422}));resolve(out)});child.stdin.on('error',()=>{});child.stdin.end(bytes)})}
export async function extractDocument(bytes,format){
 if(!bytes.length||bytes.length>DOCUMENT_LIMITS.bytes)failure(413,'Empty or over-limit document');
 if(format!=='pdf'){let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}catch{failure(422,'TXT and Markdown must use valid UTF-8')};return {text:cleanText(text),pages:null}}
 if(!bytes.subarray(0,8).toString('ascii').match(/^%PDF-1\.[0-7]|^%PDF-2\.0/)||!bytes.subarray(-2048).toString('latin1').match(/%%EOF\s*$/))failure(422,'PDF header or end marker missing');
 const info=(await runPdf('/usr/bin/pdfinfo',['-'],65536,bytes)).toString('utf8');const pages=Number(/^Pages:\s+(\d+)\s*$/m.exec(info)?.[1]);if(!pages||pages>DOCUMENT_LIMITS.pages||!/^Encrypted:\s+no\s*$/m.test(info))failure(422,'PDF exceeds 40 pages or is encrypted');const output=await runPdf('/usr/bin/pdftotext',['-enc','UTF-8','-layout','-nopgbrk','-','-'],DOCUMENT_LIMITS.textBytes,bytes);let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(output)}catch{failure(422,'Invalid extracted UTF-8')};return {text:cleanText(text),pages};
}
export function researchDocuments(storage,workspace){
 const inventoryPath=resolve(storage,'research-documents.sqlite');
 const db=new DatabaseSync(inventoryPath);
 const inventoryResolvedPath=realpathSync(inventoryPath),inventoryOpenedFile=statSync(inventoryResolvedPath,{bigint:true});
 let inventoryGeneration=0;
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS document_folders(id TEXT PRIMARY KEY,name TEXT NOT NULL,workspace_id TEXT,created TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS folder_name ON document_folders(coalesce(workspace_id,''),name);
 CREATE TABLE IF NOT EXISTS research_documents(id TEXT PRIMARY KEY,name TEXT NOT NULL,format TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,text_sha256 TEXT NOT NULL,created TEXT NOT NULL,pages INTEGER,workspace_id TEXT,folder_id TEXT REFERENCES document_folders(id),original BLOB NOT NULL,text TEXT NOT NULL,search_value TEXT NOT NULL,text_bytes INTEGER NOT NULL);
 CREATE TRIGGER IF NOT EXISTS document_immutable_update BEFORE UPDATE ON research_documents BEGIN SELECT RAISE(ABORT,'Immutable documents'); END;
 CREATE TRIGGER IF NOT EXISTS document_immutable_delete BEFORE DELETE ON research_documents BEGIN SELECT RAISE(ABORT,'Immutable documents'); END;`);
 // Metadata is mutable; original identity, bytes and extracted text remain database-protected.
 const fields=db.prepare('PRAGMA table_info(research_documents)').all().map(x=>x.name);
 if(!fields.includes('revision'))db.exec('ALTER TABLE research_documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
 if(!fields.includes('trashed_at'))db.exec('ALTER TABLE research_documents ADD COLUMN trashed_at TEXT');
 db.exec(`DROP TRIGGER IF EXISTS document_immutable_update;
 CREATE TRIGGER document_immutable_update BEFORE UPDATE OF id,format,bytes,sha256,text_sha256,created,pages,original,text,text_bytes ON research_documents BEGIN SELECT RAISE(ABORT,'Immutable document content'); END;`);
 const reader=pdfPageReader(storage,db);
 const annotations=pdfAnnotations(db);
 const citations=documentCitations(db);
 const uploads=documentUploadOperations(db);
 let busy=false,closed=false;
 const workspaceGet=id=>{if(id===null)return null;try{return workspace.get('workspace',id)}catch(e){if(e.code==='NOT_FOUND')return null;if(e.code==='FORBIDDEN'&&!e.status)e.status=403;throw e}};
 // Downloads must bind to the SQLite-backed store identity. Lists allow legacy
 // unpinned reads so the current identity can be discovered without a second ID.
 const documentScope=(req,required=false)=>{
  const expected=req.headers['x-document-store-id'];
  const repeated=(req.rawHeaders??[]).filter((name,index)=>index%2===0&&name.toLowerCase()==='x-document-store-id').length>1;
  if(expected===undefined&&!required&&!repeated)return;
  if(repeated||typeof expected!=='string'||expected.length!==36||!uuid.test(expected))failure(400,'One valid X-Document-Store-Id UUID required');
  if(expected!==uploads.scope)throw Object.assign(Error('Local document store changed; reopen documents'),{status:409,code:'DOCUMENT_STORE_MISMATCH'});
 };
 const citationScope=req=>{const expected=req.headers['x-citation-store-id'];if(expected!==undefined&&expected!==uploads.scope)failure(409,'Local document store changed; reopen documents before citing')};
 const folderGet=id=>id?db.prepare('SELECT * FROM document_folders WHERE id=?').get(id):null;
 function validateAssociation(w,f){if(w!==null&&!workspaceGet(w))failure(409,'Workspace no longer exists');const folder=folderGet(f);if(f!==null&&(!folder||folder.workspace_id!==w))failure(409,'Folder no longer exists or belongs to another workspace')}
 const columns='id,name,format,bytes,sha256,text_sha256,created,pages,workspace_id,folder_id,revision,trashed_at';
 // PDF reads bind a live local store and exact current metadata before any
 // original BLOB read. Checks are synchronous and repeated after every await.
 function observePdf(id){
  const liveScope=()=>db.prepare('SELECT CASE WHEN length(CAST(scope AS BLOB))=36 THEN scope ELSE NULL END AS scope FROM document_upload_identity WHERE singleton=1').get()?.scope;
  const scope=liveScope();
  if(closed||typeof scope!=='string'||!uuid.test(scope))failure(503,'Local document identity unavailable');
  if(scope!==uploads.scope)throw Object.assign(Error('Local document store changed; reopen documents'),{status:409,code:'DOCUMENT_STORE_MISMATCH'});
  const select=()=>db.prepare(`SELECT ${columns} FROM research_documents WHERE id=?`).get(id);
  const row=select();if(!row||row.trashed_at)failure(404,'Active document not found');if(row.format!=='pdf')failure(415,'Page reading requires a PDF');
  if(typeof row.id!=='string'||!uuid.test(row.id)||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256)||typeof row.text_sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.text_sha256))failure(409,'Invalid PDF identity');
  if(!Number.isSafeInteger(row.bytes)||row.bytes<1||row.bytes>DOCUMENT_LIMITS.bytes||!Number.isSafeInteger(row.pages)||row.pages<1||row.pages>DOCUMENT_LIMITS.pages||!Number.isSafeInteger(row.revision)||row.revision<0)failure(409,'Invalid PDF metadata');
  validateAssociation(row.workspace_id,row.folder_id);
  const snapshot=JSON.stringify(row);
  function check(){
   if(closed)failure(503,'Local document service unavailable');
   if(liveScope()!==scope)throw Object.assign(Error('Local document store changed; reopen documents'),{status:409,code:'DOCUMENT_STORE_MISMATCH'});
   const current=select();if(!current||current.trashed_at)failure(404,'Active document not found');
   // Re-authorize the current association even if the metadata also changed.
   validateAssociation(current.workspace_id,current.folder_id);
   if(JSON.stringify(current)!==snapshot)failure(409,'PDF changed; reopen the document');
  }
  return {row,scope,check};
 }
 function metadata(r){const w=workspaceGet(r.workspace_id),f=folderGet(r.folder_id);return {revision:r.revision,trashedAt:r.trashed_at,id:r.id,name:r.name,format:r.format,bytes:r.bytes,sha256:r.sha256,textSha256:r.text_sha256,createdAt:r.created,pages:r.pages,workspaceId:r.workspace_id,folderId:r.folder_id,workspaceName:w?.data.name??null,folderName:f?.name??null,stale:!!((r.workspace_id&&!w)||(r.folder_id&&(!f||f.workspace_id!==r.workspace_id)))}}
 function quota(bytes,textBytes=0){const q=db.prepare('SELECT count(*) n,coalesce(sum(bytes),0) b,coalesce(sum(text_bytes),0) t FROM research_documents').get();if(q.n>=DOCUMENT_LIMITS.count||q.b+bytes>DOCUMENT_LIMITS.totalBytes||q.t+textBytes>DOCUMENT_LIMITS.totalTextBytes)failure(429,'Local document quota reached; trash retains bytes and still counts toward storage quota')}
 function uploadResult(receipt){
  // A committed receipt survives renamed/trashed/missing associations, but access denial still wins.
  workspaceGet(receipt.workspaceId);
  const row=db.prepare('SELECT * FROM research_documents WHERE id=?').get(receipt.documentId);
  if(!row||row.sha256!==receipt.sha256||row.bytes!==receipt.bytes||sha(Buffer.from(row.original))!==receipt.sha256)failure(409,'Upload receipt integrity mismatch');
  return {receipt,document:metadata(row)};
 }
 // These projections are dedicated to manual inventory. Every value is bounded
 // in SQLite BEFORE materialization. Never reuse the report/text resolver here.
 const bounded=(field,max,nullable=false)=>({
  valid:nullable?`(${field} IS NULL OR (typeof(${field})='text' AND length(CAST(${field} AS BLOB))<=${max}))`:`(typeof(${field})='text' AND length(CAST(${field} AS BLOB))<=${max})`,
  sql:`CASE WHEN typeof(${field})='text' AND length(CAST(${field} AS BLOB))<=${max} THEN ${field} ELSE NULL END`,
 });
 const inventoryStrings=[['id','id',36,false],['name','name',512,false],['format','format',3,false],['sha256','sha256',64,false],['text_sha256','textSha256',64,false],['created','createdAt',27,false],['workspace_id','workspaceId',160,true],['folder_id','folderId',36,true]];
 const inventoryNumbers=[['bytes',1,8388608,false],['pages',1,40,true],['revision',0,9007199254740991,false]];
 const numberValid=(field,min,max,nullable)=>nullable?`(${field} IS NULL OR (typeof(${field})='integer' AND ${field} BETWEEN ${min} AND ${max}))`:`(typeof(${field})='integer' AND ${field} BETWEEN ${min} AND ${max})`;
 const inventoryProjection=[...inventoryStrings.map(([field,alias,max,nullable])=>`${bounded(field,max,nullable).sql} AS ${alias}`),...inventoryNumbers.map(([field,min,max,nullable])=>`CASE WHEN ${numberValid(field,min,max,nullable)} THEN ${field} ELSE NULL END AS ${field}`),`(${[...inventoryStrings.map(([field,,max,nullable])=>bounded(field,max,nullable).valid),...inventoryNumbers.map(args=>numberValid(...args))].join(' AND ')}) AS metadata_valid`].join(',');
 const associationProjection=`${bounded('id',36).sql} AS id,${bounded('workspace_id',160,true).sql} AS workspaceId,${bounded('folder_id',36,true).sql} AS folderId,CASE WHEN trashed_at IS NULL THEN 1 ELSE 0 END AS active,(${bounded('id',36).valid} AND ${bounded('workspace_id',160,true).valid} AND ${bounded('folder_id',36,true).valid}) AS metadata_valid`;
 function createManualInventoryObserverPort(authority,protocol){
  const generation=inventoryGeneration;
  const sourceError=()=>{throw authority.error('SOURCE_UNAVAILABLE')};
  function live(scalar=()=>{}){
   scalar();if(closed||generation!==inventoryGeneration)sourceError();
   scalar();if(realpathSync(inventoryPath)!==inventoryResolvedPath)sourceError();
   scalar();const current=statSync(inventoryPath,{bigint:true});
   if(!current.isFile()||current.dev!==inventoryOpenedFile.dev||current.ino!==inventoryOpenedFile.ino)sourceError();
   scalar();const scope=db.prepare("SELECT CASE WHEN typeof(scope)='text' AND length(CAST(scope AS BLOB))=36 THEN scope ELSE NULL END AS scope FROM document_upload_identity WHERE singleton=1 LIMIT 1").get()?.scope;
   if(typeof scope!=='string'||scope.length!==36||!uuid.test(scope)||scope!==uploads.scope)sourceError();
   return scope;
  }
  // No handle, statement, SQL string, original bytes or content accessor escapes
  // this closure. read() ends its snapshot before publication rechecks start.
  const access=Object.freeze({live,
   read(work){
    if(closed||busy)sourceError();
    const timeout=db.prepare('PRAGMA busy_timeout').get()?.timeout;
    if(!Number.isSafeInteger(timeout)||timeout<0)sourceError();
    db.exec('PRAGMA busy_timeout=200');
    let began=false;
    try{db.exec('BEGIN');began=true;const value=work();if(value&&typeof value.then==='function')sourceError();db.exec('COMMIT');began=false;return value}
    finally{try{if(began)db.exec('ROLLBACK')}finally{db.exec(`PRAGMA busy_timeout=${timeout}`)}}
   },
   visit(selection,accept){
    let where='trashed_at IS NULL',args=[];
    if(selection.mode!=='all'){where+=' AND workspace_id IS ?';args.push(selection.workspaceId)}
    if(selection.mode==='folder'){where+=' AND folder_id=?';args.push(selection.folderId)}
    for(const row of db.prepare(`SELECT ${inventoryProjection} FROM research_documents WHERE ${where} ORDER BY id COLLATE BINARY ASC LIMIT 251`).iterate(...args))accept(row);
   },
   folder(id){return db.prepare(`SELECT ${bounded('id',36).sql} AS id,${bounded('workspace_id',160,true).sql} AS workspaceId,(${bounded('id',36).valid} AND ${bounded('workspace_id',160,true).valid}) AS metadata_valid FROM document_folders WHERE id=? LIMIT 1`).get(id)},
   historical(id){return db.prepare(`SELECT ${associationProjection} FROM research_documents WHERE id=? LIMIT 1`).get(id)},
  });
  const observer=createManualInventoryObserver(access,authority,protocol);
  return Object.freeze({observer,probe(ctx){
   try{const result=authority.assertCurrent(ctx);if(result&&typeof result.then==='function')sourceError();return Object.freeze({available:true,documentStoreScope:live()})}
   catch{return Object.freeze({available:false,documentStoreScope:null})}
  }});
 }
 return {close(){if(!closed){closed=true;inventoryGeneration++;db.close()}},createManualInventoryObserverPort,createReportSourcePort(authority){
  return reportDocumentSources({scope:uploads.scope,closed:()=>closed,
   liveScope:()=>db.prepare('SELECT CASE WHEN length(CAST(scope AS BLOB))=36 THEN scope ELSE NULL END AS scope FROM document_upload_identity WHERE singleton=1').get()?.scope,
   header:id=>db.prepare(`SELECT CASE WHEN id IS NULL OR length(CAST(id AS BLOB))<=36 THEN id ELSE NULL END AS id,CASE WHEN name IS NULL OR length(CAST(name AS BLOB))<=512 THEN name ELSE NULL END AS name,CASE WHEN format IS NULL OR length(CAST(format AS BLOB))<=8 THEN format ELSE NULL END AS format,CASE WHEN sha256 IS NULL OR length(CAST(sha256 AS BLOB))<=64 THEN sha256 ELSE NULL END AS sha256,CASE WHEN text_sha256 IS NULL OR length(CAST(text_sha256 AS BLOB))<=64 THEN text_sha256 ELSE NULL END AS text_sha256,CASE WHEN created IS NULL OR length(CAST(created AS BLOB))<=64 THEN created ELSE NULL END AS created,CASE WHEN workspace_id IS NULL OR length(CAST(workspace_id AS BLOB))<=160 THEN workspace_id ELSE NULL END AS workspace_id,CASE WHEN folder_id IS NULL OR length(CAST(folder_id AS BLOB))<=36 THEN folder_id ELSE NULL END AS folder_id,CASE WHEN trashed_at IS NULL OR length(CAST(trashed_at AS BLOB))<=64 THEN trashed_at ELSE NULL END AS trashed_at,bytes,pages,revision,text_bytes,length(CAST(text AS BLOB)) AS actual_text_bytes,length(original) AS actual_original_bytes,((id IS NULL OR length(CAST(id AS BLOB))<=36) AND (name IS NULL OR length(CAST(name AS BLOB))<=512) AND (format IS NULL OR length(CAST(format AS BLOB))<=8) AND (sha256 IS NULL OR length(CAST(sha256 AS BLOB))<=64) AND (text_sha256 IS NULL OR length(CAST(text_sha256 AS BLOB))<=64) AND (created IS NULL OR length(CAST(created AS BLOB))<=64) AND (workspace_id IS NULL OR length(CAST(workspace_id AS BLOB))<=160) AND (folder_id IS NULL OR length(CAST(folder_id AS BLOB))<=36) AND (trashed_at IS NULL OR length(CAST(trashed_at AS BLOB))<=64)) AS metadata_valid FROM research_documents WHERE id=?`).get(id),
   text:id=>db.prepare('SELECT CASE WHEN length(CAST(text AS BLOB))<=1048576 AND length(CAST(text AS BLOB))=text_bytes THEN text ELSE NULL END AS text FROM research_documents WHERE id=?').get(id)?.text,
   ids:(offset,limit)=>db.prepare('SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id ELSE NULL END AS id FROM research_documents WHERE trashed_at IS NULL ORDER BY created DESC,id DESC LIMIT ? OFFSET ?').all(limit,offset).map(row=>row.id),
   validateAssociation},authority);
 },async handle(req,send,fail,download,image){
  if(!req.url.startsWith('/api/documents'))return false;
  try{
   const pathname=req.url.split('?')[0];
   const uploadStatus=/^\/api\/documents\/upload-operations\/([^/]+)$/.exec(pathname);
   if(uploadStatus){
    if(req.method!=='GET')failure(405,'GET required');params(req.url,[]);
    const operationId=uploadStatus[1];if(!uploadOperationId(operationId))failure(400,'Valid upload operation UUID required');
    const prior=uploads.get(operationId);
    send(200,prior?{scope:uploads.scope,operationId,outcome:'committed',...uploadResult(prior.receipt)}:{scope:uploads.scope,operationId,outcome:'absent'});return true;
   }
   if(pathname==='/api/documents/upload'){
    if(req.method!=='POST')failure(405,'POST required');if(req.headers['content-type']!=='application/octet-stream')failure(415,'application/octet-stream required');if(busy)failure(429,'One local document upload at a time');
    const p=params(req.url,['name','workspaceId','folderId']);const name=nameValue(p.get('name'));const format=/\.([^.]+)$/.exec(name)?.[1].toLowerCase();if(!['txt','md','pdf'].includes(format))failure(415,'Only .txt, .md and .pdf are supported');const {workspaceId,folderId}=association(p);
    // Existing clients without a header retain their explicit legacy new-upload behavior.
    const operationId=req.headers['x-upload-operation-id']??null;
    if(operationId!==null&&!uploadOperationId(operationId))failure(400,'Valid upload operation UUID required');
    const expectedScope=req.headers['x-upload-store-id'];
    if(expectedScope!==undefined&&expectedScope!==uploads.scope)failure(409,'Local document store changed; reopen documents before uploading');
    if(!uploads.get(operationId)){validateAssociation(workspaceId,folderId);quota(0)}busy=true;
    try{
     const bytes=await body(req,DOCUMENT_LIMITS.bytes),input={name,format,bytes:bytes.length,sha256:sha(bytes),workspaceId,folderId};
     let receipt=uploads.replay(operationId,input);
     if(receipt){send(201,uploadResult(receipt));return true}
     quota(bytes.length);const {text,pages}=await extractDocument(bytes,format);const textBytes=Buffer.byteLength(text);
     const id=randomUUID(),created=new Date().toISOString();db.exec('BEGIN IMMEDIATE');
     try{
      // Recheck inside the same transaction as the original bytes and durable receipt.
      receipt=uploads.replay(operationId,input);
      if(!receipt){validateAssociation(workspaceId,folderId);quota(bytes.length,textBytes);db.prepare('INSERT INTO research_documents(id,name,format,bytes,sha256,text_sha256,created,pages,workspace_id,folder_id,original,text,search_value,text_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,name,format,bytes.length,input.sha256,sha(Buffer.from(text)),created,pages,workspaceId,folderId,bytes,text,norm(name+'\n'+text),textBytes);receipt=uploads.commit(operationId,input,id,created)}
      db.exec('COMMIT');
     }catch(e){db.exec('ROLLBACK');throw e}
     send(201,receipt?uploadResult(receipt):{document:metadata(db.prepare(`SELECT ${columns} FROM research_documents WHERE id=?`).get(id))});
    }finally{busy=false}return true;
   }
   if(pathname==='/api/documents/choices'){
    if(req.method!=='GET')failure(405,'GET required');params(req.url,[]);send(200,{uploadScope:uploads.scope,workspaces:workspace.list('workspace').map(w=>({id:w.id,name:w.data.name})),folders:db.prepare('SELECT * FROM document_folders ORDER BY created,id').all().map(f=>({id:f.id,name:f.name,workspaceId:f.workspace_id}))});return true;
   }
   if(pathname==='/api/documents/folders'){
    if(req.method!=='POST')failure(405,'POST required');params(req.url,[]);if(req.headers['content-type']!=='application/json')failure(415,'application/json required');let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await body(req,4096)))}catch(e){if(e.status)throw e;failure(400,'Invalid UTF-8 JSON')};if(!data||Array.isArray(data)||Object.keys(data).sort().join(',')!=='name,workspaceId')failure(400,'name and workspaceId required');const name=nameValue(data.name),w=data.workspaceId;if(w!==null&&!identifier(w))failure(400,'Invalid workspace');validateAssociation(w,null);if(db.prepare('SELECT count(*) n FROM document_folders').get().n>=250)failure(429,'Folder quota reached');const id=randomUUID();try{db.prepare('INSERT INTO document_folders VALUES(?,?,?,?)').run(id,name,w,new Date().toISOString())}catch(e){if(e.code?.startsWith('ERR_SQLITE'))failure(409,'A folder with this exact name already exists');throw e}send(201,{folder:{id,name,workspaceId:w}});return true;
   }
   if(pathname==='/api/documents'){
    if(req.method!=='GET')failure(405,'GET required');documentScope(req);const p=params(req.url,['q','workspaceId','folderId','offset','limit','view']);const q=cleanText(p.get('q')??'',DOCUMENT_LIMITS.queryBytes);const {workspaceId,folderId}=association(p);const parseIntBound=(k,def,min,max)=>{const s=p.get(k);if(s!==null&&!/^\d{1,4}$/.test(s))failure(400,'Invalid pagination');const n=s===null?def:Number(s);if(n<min||n>max)failure(400,'Invalid pagination');return n};const offset=parseIntBound('offset',0,0,250),limit=parseIntBound('limit',10,1,30);const view=p.get('view')??'active';if(!['active','trash'].includes(view))failure(400,'Invalid document view');const where=['instr(search_value,?)>0',view==='trash'?'trashed_at IS NOT NULL':'trashed_at IS NULL'],args=[norm(q)];if(workspaceId!==null){where.push('workspace_id=?');args.push(workspaceId)}if(folderId!==null){where.push('folder_id=?');args.push(folderId)}const condition=where.join(' AND ');const total=db.prepare('SELECT count(*) n FROM research_documents WHERE '+condition).get(...args).n;const documents=db.prepare(`SELECT ${columns} FROM research_documents WHERE ${condition} ORDER BY created DESC,id DESC LIMIT ? OFFSET ?`).all(...args,limit,offset).map(metadata);send(200,{storeScope:uploads.scope,documents,total,offset,limit});return true;
   }
   const manage=/^\/api\/documents\/([a-f0-9-]{36})\/(metadata|trash|restore)$/.exec(pathname);
   if(manage){
    params(req.url,[]);if(!uuid.test(manage[1]))failure(404,'Document not found');if(req.method!=='PUT')failure(405,'PUT required');
    if(req.headers['content-type']!=='application/json')failure(415,'application/json required');let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await body(req,4096)))}catch(e){if(e.status)throw e;failure(400,'Invalid UTF-8 JSON')}
    const operation=manage[2];const keys=operation==='metadata'?['folderId','name','revision','workspaceId']:['revision'];
    if(!data||Array.isArray(data)||Object.keys(data).sort().join(',')!==keys.join(',')||!Number.isSafeInteger(data.revision)||data.revision<0)failure(400,'Exact fields and nonnegative revision required');
    const r=db.prepare('SELECT * FROM research_documents WHERE id=?').get(manage[1]);if(!r)failure(404,'Document not found');if(r.revision!==data.revision)failure(409,'Document changed; refresh before retrying');
    if(operation==='metadata'){
     if(r.trashed_at)failure(409,'Restore document before editing');const name=displayValue(data.name);const w=data.workspaceId,f=data.folderId;
     if(w!==null&&!identifier(w)||f!==null&&(typeof f!=='string'||!uuid.test(f)))failure(400,'Invalid association');validateAssociation(w,f);
     const changed=db.prepare('UPDATE research_documents SET name=?,workspace_id=?,folder_id=?,search_value=?,revision=revision+1 WHERE id=? AND revision=?').run(name,w,f,norm(name+'\n'+r.text),r.id,r.revision).changes;if(changed!==1)failure(409,'Document changed; refresh before retrying');
    }else{
     if(operation==='trash'&&r.trashed_at||operation==='restore'&&!r.trashed_at)failure(409,'Document state changed; refresh before retrying');
     if(reader.isBusy(r.id))failure(409,'Page rendering is active; retry after it finishes');
     const changed=db.prepare('UPDATE research_documents SET trashed_at=?,revision=revision+1 WHERE id=? AND revision=?').run(operation==='trash'?new Date().toISOString():null,r.id,r.revision).changes;if(changed!==1)failure(409,'Document changed; refresh before retrying');
    }
    send(200,{document:metadata(db.prepare('SELECT * FROM research_documents WHERE id=?').get(r.id))});return true;
   }
   const citationOperation=/^\/api\/documents\/([a-f0-9-]{36})\/citation-operations\/([a-f0-9-]{36})$/.exec(pathname);
   if(citationOperation){
    if(req.method!=='GET')failure(405,'GET required');
    if(req.url!==pathname||citationOperation[0]!==pathname||!uuid.test(citationOperation[1])||!uuid.test(citationOperation[2]))failure(400,'Exact document and operation UUID path without query required');
    citationScope(req);
    const r=db.prepare('SELECT * FROM research_documents WHERE id=?').get(citationOperation[1]);if(!r)failure(404,'Citation source document missing');
    workspaceGet(r.workspace_id);
    send(200,{storeScope:uploads.scope,...citations.recover(r,citationOperation[2])});return true;
   }
   const citationMatch=/^\/api\/documents\/([a-f0-9-]{36})\/citations(?:\/([a-f0-9-]{36}))?$/.exec(pathname);
   if(citationMatch){
    params(req.url,[]);if(!uuid.test(citationMatch[1])||(citationMatch[2]&&!uuid.test(citationMatch[2])))failure(404,'Unknown citation route');
    citationScope(req);
    const r=db.prepare('SELECT * FROM research_documents WHERE id=?').get(citationMatch[1]);if(!r)failure(404,'Citation source document missing');
    if(req.method==='GET'){workspaceGet(r.workspace_id);send(200,citationMatch[2]?{...citations.reopen(r,citationMatch[2]),document:metadata(r)}:{storeScope:uploads.scope,...citations.list(r)});}
    else if(req.method==='POST'&&!citationMatch[2]){
     if(req.headers['content-type']!=='application/json')failure(415,'application/json required');let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await body(req,131072)))}catch(e){if(e.status)throw e;failure(400,'Invalid UTF-8 JSON')};
     const current=db.prepare('SELECT * FROM research_documents WHERE id=?').get(r.id);
     // Preserve workspace access failures even for receipt replay. A missing
     // association is allowed only for an exact, already committed operation.
     workspaceGet(current.workspace_id);
     send(201,{storeScope:uploads.scope,outcome:'committed',...citations.create(current,data,source=>validateAssociation(source.workspace_id,source.folder_id),source=>workspaceGet(source.workspace_id))});
    }else failure(405,'GET collection/reference or POST collection required');return true;
   }
   const noteMatch=/^\/api\/documents\/([a-f0-9-]{36})\/annotations(?:\/([a-f0-9-]{36}))?$/.exec(pathname);
   if(noteMatch){
    documentScope(req);
    params(req.url,[]);if(!uuid.test(noteMatch[1])||(noteMatch[2]&&!uuid.test(noteMatch[2])))failure(404,'Unknown annotation route');
    const r=db.prepare('SELECT * FROM research_documents WHERE id=?').get(noteMatch[1]);if(!r||r.trashed_at)failure(404,'Active document not found');
    if(req.method==='GET'&&!noteMatch[2])send(200,{...annotations.snapshot(r),storeScope:uploads.scope});
    else if((req.method==='POST'&&!noteMatch[2])||(req.method==='PUT'&&noteMatch[2])){
     if(req.headers['content-type']!=='application/json')failure(415,'application/json required');let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await body(req,32768)))}catch(e){if(e.status)throw e;failure(400,'Invalid UTF-8 JSON')};
     validateAssociation(r.workspace_id,r.folder_id);send(req.method==='POST'?201:200,{...annotations.write(r,data,noteMatch[2]??null),storeScope:uploads.scope});
    }else failure(405,'GET/POST collection or PUT annotation required');return true;
   }
   const readerMatch=/^\/api\/documents\/([a-f0-9-]{36})\/(reader|page)$/.exec(pathname);
   if(readerMatch){
    // Legacy headerless calls remain explicitly unbound. A supplied scope is
    // always validated before lookup, request-body consumption or raster work.
    documentScope(req);
    const pageParams=readerMatch[2]==='page'?params(req.url,['page','scale','storeScope']):null;
    if(pageParams?.has('storeScope')){
     const scope=pageParams.get('storeScope');
     if(typeof scope!=='string'||!uuid.test(scope)||scope.length!==36)failure(400,'One canonical storeScope UUID required');
     documentScope({headers:{'x-document-store-id':scope}});
    }
    if(!uuid.test(readerMatch[1]))failure(404,'Document not found');
    const observation=observePdf(readerMatch[1]),r=observation.row;
    if(readerMatch[2]==='page'){
     if(req.method!=='GET')failure(405,'GET required');const p=pageParams;
     if(!/^[1-9]\d?$/.test(p.get('page')??'')||! /^(75|100|150)$/.test(p.get('scale')??''))failure(400,'Valid page and scale required');
     observation.check();
     // Never allocate original bytes before current workspace access succeeds.
     const original=db.prepare('SELECT CASE WHEN length(original)=? THEN original ELSE NULL END AS original FROM research_documents WHERE id=?').get(r.bytes,r.id)?.original;
     if(original===null||original===undefined)failure(409,'Original byte integrity check failed');
     const rendered=await reader.image({...r,original},Number(p.get('page')),Number(p.get('scale')));
     const identity=Object.freeze({storeScope:observation.scope,documentId:r.id,sha256:r.sha256,pages:r.pages,page:Number(p.get('page')),scale:Number(p.get('scale')),imageSha256:sha(rendered)});
     observation.check();image(rendered,identity,observation.check);
    }else{
     params(req.url,[]);
     if(req.method==='GET'){const result={...reader.state(r),storeScope:observation.scope};observation.check();send(200,result)}
     else if(req.method==='PUT'){
      if(req.headers['content-type']!=='application/json')failure(415,'application/json required');let data;
      try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await body(req,1024)))}catch(e){if(e.status)throw e;failure(400,'Invalid JSON')}
      observation.check();const result={...reader.setState(r,data),storeScope:observation.scope};observation.check();send(200,result);
     }else failure(405,'GET or PUT required');
    }return true;
   }
   const match=/^\/api\/documents\/([a-f0-9-]{36})(\/download)?$/.exec(pathname);
   if(!match||!uuid.test(match[1]))failure(404,'Unknown document route');if(req.method!=='GET')failure(405,'GET required');params(req.url,[]);
   if(match[2])documentScope(req,true);else citationScope(req);
   const r=db.prepare(`SELECT ${match[2]?columns:'*'} FROM research_documents WHERE id=?`).get(match[1]);
   if(!r||r.trashed_at)failure(404,'Active document not found');
   if(match[2]){
    // Authorize the current association before reading the original BLOB. Display
    // names and moves do not change immutable content identity or its hash.
    workspaceGet(r.workspace_id);
    const bytes=Buffer.from(db.prepare('SELECT original FROM research_documents WHERE id=?').get(r.id).original);
    if(bytes.length!==r.bytes||sha(bytes)!==r.sha256)failure(409,'Original byte integrity check failed');
    download(`${r.id}.${r.format}`,bytes,r.sha256,uploads.scope);
   }else{if(sha(Buffer.from(r.text))!==r.text_sha256)failure(409,'Extracted text integrity check failed');send(200,{storeScope:uploads.scope,document:metadata(r),text:r.text})}return true;
  }catch(e){const status=e.status??503;fail(status,e.code==='DOCUMENT_STORE_MISMATCH'?e.code:status===503?'UNAVAILABLE':status===409?'CONFLICT':status===404?'NOT_FOUND':'INVALID_REQUEST',status===503?'Local document service unavailable':e.message);return true}
 }};
}
