// Fixed read-only metadata reader. No handler registration, document content or remote calls.
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
const fail=()=>{throw Object.assign(Error('INVALID_SCOPE'),{code:'INVALID_SCOPE'})};
export function validateScope(s){
 if(!s||Object.getPrototypeOf(s)!==Object.prototype||Object.keys(s).sort().join(',')!=='folderId,workspaceId')fail();
 if(s.workspaceId!==null&&(typeof s.workspaceId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(s.workspaceId)))fail();
 if(s.folderId!==null&&(typeof s.folderId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s.folderId)))fail();
 return {workspaceId:s.workspaceId,folderId:s.folderId};
}
export function readInventory(storage,scope){
 validateScope(scope);const db=new DatabaseSync(join(storage,'research-documents.sqlite'),{readOnly:true});
 try{const where=['d.trashed_at IS NULL'],args=[];for(const [k,col] of [['workspaceId','workspace_id'],['folderId','folder_id']])if(scope[k]!==null){where.push(`d.${col}=?`);args.push(scope[k])}
 const rows=db.prepare(`SELECT d.id,d.name,d.bytes,d.sha256,d.text_sha256 AS textSha256,d.workspace_id AS workspaceId,d.folder_id AS folderId,f.name AS folderName,d.revision FROM research_documents d LEFT JOIN document_folders f ON f.id=d.folder_id WHERE ${where.join(' AND ')} ORDER BY d.id LIMIT 251`).all(...args);
 if(rows.length>250)throw Object.assign(Error('DOCUMENT_QUOTA'),{code:'DOCUMENT_QUOTA'});return rows;
 }finally{db.close()}
}
