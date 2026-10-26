// Socket-free tests over the exact production journal and extracted upload actions.
// This is not React rendering, a browser reload, or service/device acceptance.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {
  makeUploadRecoveryRecord, readUploadRecoveryRecord, retainUploadRecoveryRecord,
  forgetUploadRecoveryRecord, UPLOAD_REFRESH_PREFIX, UPLOAD_REFRESH_MAX_RECORDS,
} from '../candidate/src/components/upload-refresh-recovery.ts';
const source = readFileSync(new URL('../candidate/src/components/LocalTranscription.tsx',import.meta.url),'utf8');
const scope='11111111-1111-4111-8111-111111111111', otherScope='22222222-2222-4222-8222-222222222222';
const operationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', job='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const envelope={scope,operationId,filename:'recording.wav',byteLength:96,mime:'audio/wav',format:'wav',sha256:'d'.repeat(64),language:'zh',origin:'recording-draft',expiresAt:Date.now()+100000,checkpoint:true};
class Storage {
  values=new Map(); mode='normal';
  get length(){return this.values.size;}
  key(i){return [...this.values.keys()][i]??null;}
  getItem(key){if(this.mode==='read-fail')throw Error('read blocked');return this.values.get(key)??null;}
  setItem(key,value){if(this.mode==='write-fail')throw Error('quota');if(this.mode!=='silent-write')this.values.set(key,value);if(this.mode==='write-then-throw')throw Error('uncertain write');}
  removeItem(key){if(this.mode!=='silent-remove')this.values.delete(key);}
}
const record=()=>makeUploadRecoveryRecord(envelope);
const block=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const validators=block('const uploadUuid =','// SHA-256');
const actions=block('  const assertRecordingCurrent =','  const submit =') + block('  const recoverUpload =','  const abandonUpload =');
const runActions=new Function('env','return (' + stripTypeScriptTypes(`(function (env) {
  const {storage, transport, pendingUploadRef, events, scope, blocked} = env;
  const window={sessionStorage:storage};
  const statusOrder=['interrupted','processing','completed','cancelled','failed'];
  const recordingClockGuard={observe:value=>value};
  const uploadMounted={current:true}, submitting={current:false};
  const store={scope, blocked, assertActive(){if(this.blocked)throw Error('scope blocked');}};
  const scopedFetch=transport;
  const setPending=value=>{pendingUploadRef.current=value;events.push(['pending',value]);};
  const clearSelection=()=>events.push(['clear-selection']);
  const setError=value=>events.push(['error',value]);
  const setUploadedId=value=>events.push(['uploaded',value]);
  const setUploadedDeleted=value=>events.push(['deleted',value]);
  const setRefresh=()=>events.push(['refresh']);
  const setRecoverySaved=value=>events.push(['saved',value]);
  const setRetainForRefresh=value=>events.push(['opt-in',value]);
  const setUploading=value=>events.push(['uploading',value]);
  const setCheckingUpload=value=>events.push(['checking',value]);
  const {retainUploadRecoveryRecord,forgetUploadRecoveryRecord}=env;
  ${validators}
  ${actions}
  return {postUpload,recoverUpload,acceptUpload};
})`,{mode:'strip'}) + ')(env);');
function harness(storage,pending,transport,{currentScope=scope,blocked=false}={}) {
  const env={storage,transport,pendingUploadRef:{current:pending},events:[],scope:currentScope,blocked,retainUploadRecoveryRecord,forgetUploadRecoveryRecord};
  return {...env,...runActions(env)};
}
function committed(pending, overrides={}) {
  return {operationId:pending.operationId,state:'committed',reconciliationFinal:true,id:job,status:'completed',filename:pending.filename,uploadOrigin:pending.origin,
    receipt:{version:1,sha256:pending.sha256,byteLength:pending.byteLength,declaredMime:pending.mime,acceptedFormat:pending.format,language:pending.language,
      settings:{profile:'local-asr-upload-v1',maxSeconds:300,maxBytes:16777216,deadlineSeconds:100,requestedRecognizer:{model:'faster-whisper-small',device:'cpu',computeType:'int8',beamSize:5,temperature:0,vadFilter:false,conditionOnPreviousText:false,wordTimestamps:true,cpuThreads:4,numWorkers:1,windowSeconds:30,strideSeconds:29,seedPolicy:'ctranslate2-sha256-source-chunk-v1'}}},
    deleted:false,replayed:false,...overrides};
}
const response=(value,status=200)=>({status,json:async()=>value});
function restored(storage){const metadata=readUploadRecoveryRecord(storage,scope);return Object.freeze({...metadata,expiresAt:metadata.expiresAt??undefined,file:null,recoveryRecord:metadata});}

test('opt-in whitelists metadata, preserves it across reload, and never serializes audio',()=>{
  const storage=new Storage(),r=makeUploadRecoveryRecord({...envelope,file:new Blob(['private synthetic bytes']),transcript:'not allowed'});
  retainUploadRecoveryRecord(storage,r);
  assert.deepEqual(readUploadRecoveryRecord(storage,scope),r);
  assert.equal(Object.hasOwn(r,'file'),false);assert.equal(Object.hasOwn(r,'transcript'),false);
  const raw=storage.getItem(UPLOAD_REFRESH_PREFIX+scope);assert(raw.length<2048);assert(!raw.includes('private synthetic bytes'));
  assert.equal(readUploadRecoveryRecord(storage,otherScope),null);
  const expired=makeUploadRecoveryRecord({...envelope,expiresAt:1});storage.values.clear();retainUploadRecoveryRecord(storage,expired);
  assert.deepEqual(readUploadRecoveryRecord(storage,scope),expired,'audio expiry must not erase evidence of an uncertain upload');
});

test('malformed, oversized, wrong-scope and extra-field records are not mistaken for absence',()=>{
  const storage=new Storage(),key=UPLOAD_REFRESH_PREFIX+scope;
  for(const raw of ['', '{bad', 'x'.repeat(2049),JSON.stringify({...record(),scope:otherScope}),JSON.stringify({...record(),file:{}}),JSON.stringify({...record(),checkpoint:'true'}),JSON.stringify({...record(),mime:'audio/other'})]){
    storage.values.set(key,raw);assert.throws(()=>readUploadRecoveryRecord(storage,scope));assert.equal(storage.getItem(key),raw);
  }
  storage.mode='read-fail';assert.throws(()=>readUploadRecoveryRecord(storage,scope));
});

test('capacity is bounded; existing operations remain recoverable; exact clearing cannot erase a newer operation',()=>{
  const storage=new Storage();
  for(let n=0;n<UPLOAD_REFRESH_MAX_RECORDS;n++)retainUploadRecoveryRecord(storage,makeUploadRecoveryRecord({...envelope,scope:`${n.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`}));
  assert.throws(()=>retainUploadRecoveryRecord(storage,record()));assert.equal(storage.length,16);
  const first=readUploadRecoveryRecord(storage,'00000000-1111-4111-8111-111111111111');retainUploadRecoveryRecord(storage,first);forgetUploadRecoveryRecord(storage,first);assert.equal(storage.length,15);
  retainUploadRecoveryRecord(storage,record());
  const newer=makeUploadRecoveryRecord({...envelope,operationId:job});
  assert.throws(()=>retainUploadRecoveryRecord(storage,newer));
  storage.values.set(UPLOAD_REFRESH_PREFIX+scope,JSON.stringify(newer));
  assert.throws(()=>forgetUploadRecoveryRecord(storage,record()));assert.deepEqual(readUploadRecoveryRecord(storage,scope),newer);
});

test('lost ACK → refreshed metadata → exact committed receipt resolves with one POST only',async()=>{
  const storage=new Storage(),calls=[],pending=Object.freeze({...envelope,file:new Blob(['synthetic']),recoveryRecord:record()});
  const first=harness(storage,pending,async(url,init)=>{calls.push({url,init});assert.deepEqual(readUploadRecoveryRecord(storage,scope),record(),'metadata must be confirmed before POST');throw Error('lost ACK');});
  await assert.rejects(()=>first.postUpload(pending),/lost ACK/);assert.equal(calls.length,1);
  const recovered=restored(storage);assert.equal(recovered.file,null);
  const reload=harness(storage,recovered,async(url,init)=>{calls.push({url,init});return response(committed(recovered));});
  assert.equal(calls.length,1,'constructing recovered state performs no request');
  await reload.recoverUpload(false);
  assert.equal(calls.filter(x=>x.init.method==='POST').length,1);assert.equal(calls.at(-1).init.method,'GET');
  assert.equal(calls.at(-1).url,'/api/local-asr/transcribe?operationId='+operationId);
  assert.equal(reload.pendingUploadRef.current,null);assert.equal(readUploadRecoveryRecord(storage,scope),null);
  assert(reload.events.some(([key,value])=>key==='uploaded'&&value===job));
});

test('unconfirmed or mismatched lookup never clears identity; even forced retry cannot POST a restored record',async()=>{
  for(const result of ['unconfirmed','mismatch','legacy']){
    const storage=new Storage();retainUploadRecoveryRecord(storage,record());const pending=restored(storage),calls=[];
    const body=result==='unconfirmed'?{operationId,state:'unconfirmed',reconciliationFinal:false}:result==='legacy'?{id:job,status:'processing'}:committed(pending,{filename:'different.wav'});
    const h=harness(storage,pending,async(url,init)=>{calls.push(init);return response(body);});
    await h.recoverUpload(result==='unconfirmed');
    assert.equal(h.pendingUploadRef.current,pending);assert.deepEqual(readUploadRecoveryRecord(storage,scope),record());assert.equal(calls.filter(x=>x.method==='POST').length,0);
  }
});

test('expired recording metadata still resolves committed or trashed upload without file or recording checks',async()=>{
  const storage=new Storage(),expired=makeUploadRecoveryRecord({...envelope,expiresAt:1});retainUploadRecoveryRecord(storage,expired);const pending=restored(storage);
  const h=harness(storage,pending,async()=>response(committed(pending,{deleted:true})));
  await h.recoverUpload(false);assert.equal(h.pendingUploadRef.current,null);assert(h.events.some(([key,value])=>key==='deleted'&&value===true));
});

test('opt-in storage failures stop before POST, retain the same operation, and never claim a saved record',async()=>{
  for(const mode of ['write-fail','silent-write','write-then-throw']){
    const storage=new Storage();storage.mode=mode;const pending={...envelope,file:new Blob(['synthetic']),recoveryRecord:record()};let posts=0;
    const h=harness(storage,pending,async()=>{posts++;throw Error('must not run');});
    await assert.rejects(()=>h.postUpload(pending),/刷新核对记录/);assert.equal(posts,0);assert.equal(h.pendingUploadRef.current,pending);assert(!h.events.some(([key,value])=>key==='saved'&&value===true));
    if(mode==='write-then-throw'){storage.mode='normal';assert.equal(restored(storage).operationId,operationId);}
  }
});

test('opt-out same-page upload does not depend on storage and retains its exact File',async()=>{
  const storage=new Storage();storage.mode='read-fail';const pending={...envelope,file:new Blob(['synthetic'])};const calls=[];
  const h=harness(storage,pending,async(url,init)=>{calls.push({url,init});return response(committed(pending),202);});
  await h.postUpload(pending);assert.equal(calls.length,1);assert.equal(calls[0].init.body,pending.file);assert.equal(h.pendingUploadRef.current,null);
});

test('wrong store blocks restored GET, and a late ACK cannot clear a replacement record',async()=>{
  const storage=new Storage();retainUploadRecoveryRecord(storage,record());const pending=restored(storage);let calls=0;
  const wrong=harness(storage,pending,async()=>{calls++;throw Error('must not run');},{currentScope:otherScope});
  await wrong.recoverUpload(false);assert.equal(calls,0);assert.equal(wrong.pendingUploadRef.current,pending);
  const h=harness(storage,pending,async()=>response(committed(pending)));
  const newer=makeUploadRecoveryRecord({...envelope,operationId:job});storage.values.set(UPLOAD_REFRESH_PREFIX+scope,JSON.stringify(newer));
  await h.recoverUpload(false);assert.equal(h.pendingUploadRef.current,pending);assert.deepEqual(readUploadRecoveryRecord(storage,scope),newer);
  storage.mode='silent-remove';storage.values.set(UPLOAD_REFRESH_PREFIX+scope,JSON.stringify(record()));
  await h.recoverUpload(false);assert.equal(h.pendingUploadRef.current,pending);
});

test('JSX/source wiring gates new uploads and limits restored operations to explicit lookup or warned abandonment',()=>{
  assert(source.includes('const recoveryReadBlocked = !!refreshRecovery.error && !skipUnreadableRecovery;'));
  assert(source.includes('if (store.blocked || recoveryReadBlocked || pendingUploadRef.current || !file'));
  assert(source.includes('const busy = store.blocked || recoveryReadBlocked || uploading || uploadUncertain'));
  assert(source.includes('pendingUpload.file && <button'));
  assert(source.includes('file:null, recoveryRecord:refreshRecovery.record'));
  assert(source.includes("const [retainForRefresh, setRetainForRefresh] = useState(false)"));
  assert(source.includes('不会取消已发出的上传或识别，也不会删除录音草稿。再次普通上传可能创建重复任务'));
  assert(source.includes('不会取消旧上传或删除旧记录；新上传可能重复'));
  assert(source.includes("pendingUpload.file ? '核对同源资料库（保留文件）' : '核对同源资料库（保留核对信息）'"));
  assert(source.includes('核对信息已恢复，未恢复音频'));
  assert(source.includes('{file && <p>待上传文件仅保留在当前页面内存中'));
});
