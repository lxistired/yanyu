// Synthetic delayed-body tests with real SQLite. No private files, network or model.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createHash,randomUUID} from 'node:crypto';
import {researchDocuments} from './research-documents.mjs';
const root=mkdtempSync(join(tmpdir(),'yanyu-citation-race-'));
const app=researchDocuments(root,{get(){throw Object.assign(Error('missing'),{code:'NOT_FOUND'});},list(){return [];}});
const text='Synthetic 😀 repeated quote repeated quote';
const hash=s=>createHash('sha256').update(s).digest('hex');
const checks=[];
async function request(method,url,data,stream){
 const bytes=Buffer.isBuffer(data)?data:Buffer.from(data===undefined?'':JSON.stringify(data));
 const req=stream??Readable.from([bytes]);Object.assign(req,{method,url,headers:{'content-type':Buffer.isBuffer(data)?'application/octet-stream':'application/json'}});
 let result;await app.handle(req,(status,body)=>result={status,body},(status,code,message)=>result={status,body:{error:{code,message}}},()=>{});return result;
}
async function race(operation){
 let doc=(await request('POST','/api/documents/upload?name=synthetic.txt',Buffer.from(text))).body.document;
 const url=`/api/documents/${doc.id}`,start=text.lastIndexOf('repeated quote'),quote=text.slice(start);
 const draft={operationId:randomUUID(),documentRevision:doc.revision,documentSha256:doc.sha256,textSha256:doc.textSha256,start,end:text.length,quote,quoteSha256:hash(quote),rangeUnit:'utf16-code-unit',note:'synthetic note'};
 let bodyStarted,release;const started=new Promise(r=>bodyStarted=r),gate=new Promise(r=>release=r);
 const stream=Readable.from((async function*(){bodyStarted();await gate;yield Buffer.from(JSON.stringify(draft));})());
 const pending=request('POST',url+'/citations',draft,stream);await started;
 const update=operation==='metadata'?{revision:doc.revision,name:'renamed during body',workspaceId:null,folderId:null}:{revision:doc.revision};
 assert.equal((await request('PUT',url+'/'+operation,update)).status,200);
 release();const result=await pending;
 assert.equal(result.status,409,`${operation} changed during request body: expected 409, received ${JSON.stringify(result)}`);
 assert.equal((await request('GET',url+'/citations')).body.citations.length,0,'Rejected racing save must not persist');
 checks.push(operation+' during delayed citation body rejects stale save without persisting');
}
let failure;
try{await race('trash');await race('metadata');console.log('PASS',checks.join('\nPASS '));}catch(error){failure=error;throw error;}finally{
 app.close();writeFileSync(new URL('../integration-evidence/CITATION_CONCURRENCY.json',import.meta.url),JSON.stringify({passed:!failure,checks,storage:root,transport:'Synthetic delayed in-process request bodies and real SQLite',runtime:process.version,...(failure?{failure:failure.message}:{})},null,2)+'\n');
}
