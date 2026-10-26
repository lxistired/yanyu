// Durable upload receipts are bound to an explicit operation, never content deduplication.
import {createHash,randomUUID} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=(status,message)=>{throw Object.assign(Error(message),{status})};
export const uploadOperationId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function documentUploadOperations(db){
 db.exec(`CREATE TABLE IF NOT EXISTS document_upload_operations(
 operation_id TEXT PRIMARY KEY, document_id TEXT NOT NULL UNIQUE REFERENCES research_documents(id),
 request_sha256 TEXT NOT NULL, receipt_json TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS upload_operations_immutable_update BEFORE UPDATE ON document_upload_operations BEGIN SELECT RAISE(ABORT,'Immutable upload operation'); END;
 CREATE TRIGGER IF NOT EXISTS upload_operations_immutable_delete BEFORE DELETE ON document_upload_operations BEGIN SELECT RAISE(ABORT,'Immutable upload operation'); END;`);
 db.exec('CREATE TABLE IF NOT EXISTS document_upload_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),scope TEXT NOT NULL)');
 db.prepare('INSERT OR IGNORE INTO document_upload_identity VALUES(1,?)').run(randomUUID());
 const scope=db.prepare('SELECT scope FROM document_upload_identity WHERE singleton=1').get().scope;
 const fingerprint=input=>digest(JSON.stringify(['upload-v1',input.name,input.format,input.bytes,input.sha256,input.workspaceId,input.folderId]));
 function get(operationId){
  if(operationId===null)return null;
  const row=db.prepare('SELECT * FROM document_upload_operations WHERE operation_id=?').get(operationId);
  return row?{fingerprint:row.request_sha256,receipt:JSON.parse(row.receipt_json)}:null;
 }
 return {
  scope,
  get,
  replay(operationId,input){
   const prior=get(operationId);if(!prior)return null;
   if(prior.fingerprint!==fingerprint(input))fail(409,'Upload operation already used with different content or destination');
   return prior.receipt;
  },
  commit(operationId,input,documentId,createdAt){
   if(operationId===null)return null;
   const receipt={operationId,documentId,...input,createdAt};
   db.prepare('INSERT INTO document_upload_operations VALUES(?,?,?,?)').run(operationId,documentId,fingerprint(input),JSON.stringify(receipt));
   return receipt;
  },
 };
}
