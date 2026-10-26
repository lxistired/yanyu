
// Capture only at fixture setup, never from a later operation or a replacement store.
async function discoverScope(service){
 let body,responseHeader;
 const handled=await service.handle({url:'/api/local-asr/identity',method:'GET',headers:{}},
  (status,value)=>{assert.equal(status,200);body=value},
  (...args)=>assert.fail(JSON.stringify(args)),undefined,
  {setHeader(name,value){assert.equal(name,'x-transcription-store-id');responseHeader=value}});
 assert.equal(handled,true);assert.deepEqual(Object.keys(body),['transcriptionStoreId']);
 assert.equal(responseHeader,body.transcriptionStoreId);
 assert.match(body.transcriptionStoreId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 return Object.freeze({'x-transcription-store-id':body.transcriptionStoreId});
}
import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, rmSync, copyFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localTranscription} from './local-transcription.mjs';
import {initializeTranscriptionStoreIdentity as initialize, readTranscriptionStoreIdentity as read,
 bindTranscriptionStoreIdentity as bind, parseTranscriptionStoreScope as parse,
 validateTranscriptionStoreScope as validate, isTranscriptionStoreId as valid,
 transcriptionStoreHeader as header} from './transcription-store-identity.mjs';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const unavailable = {code: 'STORE_IDENTITY_UNAVAILABLE'};
const snapshot = db => JSON.stringify({schema: db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),
 identity: db.prepare('SELECT * FROM transcription_store_identity').all(), changes: db.prepare('SELECT total_changes() AS n').get()});

test('legacy migration is atomic, idempotent and read helpers never initialize', () => {
 const db = new DatabaseSync(':memory:');
 try {
  assert.throws(() => read(db), unavailable); assert.throws(() => bind(db), unavailable);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema").get().n, 0);
  const id = initialize(db); assert(valid(id)); const before = snapshot(db);
  assert.equal(initialize(db), id); const bound = bind(db);
  for (let i = 0; i < 3; i++) {
   assert.equal(read(db), id); assert.equal(bound.transcriptionStoreId, id);
   assert.equal(bound.validateRequest({[header]: id}).ok, true);
   assert.equal(bound.validateRequest({[header]: A}).code, 'STORE_CHANGED');
  }
  assert.equal(snapshot(db), before);
 } finally {db.close();}
});

test('independent stores differ; bindings do not switch to the latest connection', () => {
 const a = new DatabaseSync(':memory:'), b = new DatabaseSync(':memory:');
 try {
  const idA = initialize(a), idB = initialize(b); assert.notEqual(idA, idB);
  const boundA = bind(a), boundB = bind(b);
  assert.equal(boundA.validateRequest({[header]: idA}).ok, true);
  assert.deepEqual(boundB.validateRequest({[header]: idA}), {ok:false,status:409,code:'STORE_CHANGED'});
  assert.equal(boundA.transcriptionStoreId, idA);
  b.prepare('UPDATE transcription_store_identity SET store_id=?').run(A);
  assert.throws(() => boundB.transcriptionStoreId, unavailable);
  assert.throws(() => boundB.validateRequest({[header]: A}), unavailable);
  a.exec('DELETE FROM transcription_store_identity');
  assert.throws(() => boundA.transcriptionStoreId, unavailable);
 } finally {a.close();b.close();}
});

test('missing, malformed, extra and wrong singleton identities fail closed without repair', () => {
 for (const rows of [[], [[1,'invalid']], [[1,A+'\n']], [[1,A+'\r']], [[1,A+'\r\n']], [[1,A.toUpperCase()]], [[2,A]], [[1,A],[2,B]], [[1,null]]]) {
  const db = new DatabaseSync(':memory:');
  try {
   db.exec('CREATE TABLE transcription_store_identity(singleton, store_id)');
   for (const row of rows) db.prepare('INSERT INTO transcription_store_identity VALUES(?,?)').run(...row);
   const before = snapshot(db);
   assert.throws(() => initialize(db), unavailable); assert.throws(() => read(db), unavailable);
   assert.equal(snapshot(db), before);
  } finally {db.close();}
 }
 const db = new DatabaseSync(':memory:');
 try {
  db.exec(`CREATE VIEW transcription_store_identity AS SELECT 1 AS singleton, '${A}' AS store_id`);
  assert.throws(() => initialize(db), unavailable);
  assert.equal(db.prepare("SELECT type FROM sqlite_schema").get().type, 'view');
 } finally {db.close();}
});

test('pure scope validator rejects absent, repeated, malformed and inconsistent headers', () => {
 for (const value of [undefined, null, '', ' '+A, A+' ', A.toUpperCase(), A+','+B, [A], A+'\n', A+'\r', A+'\r\n', 1, {}, '11111111-1111-1111-1111-111111111111']) {
  assert.equal(parse({[header]:value}).code, 'INVALID_STORE_SCOPE');
 }
 for (const headers of [undefined,null,[],{}, {[header]:A,'X-Transcription-Store-Id':A}]) assert.equal(parse(headers).ok,false);
 for (const raw of [[], [header], [header,A,header,A], [header,A,'X-Transcription-Store-Id',B], [header,B], [header,[A]], 'invalid']) assert.equal(parse({[header]:A},raw).ok,false);
 assert.equal(parse({'X-Transcription-Store-Id':A}, ['X-Transcription-Store-Id',A]).ok,true);
 assert.deepEqual(validate(A,{[header]:B}),{ok:false,status:409,code:'STORE_CHANGED'});
 assert.equal(validate(A,{[header]:A}).transcriptionStoreId,A);
 assert.throws(() => validate('invalid',{[header]:A}),unavailable);
});

test('on-disk restart preserves UUID and synthetic DB clone retains logical lineage', () => {
 const root = mkdtempSync(join(tmpdir(),'yanyu-store-identity-')); const path = join(root,'synthetic.sqlite');
 let db;
 try {
  db = new DatabaseSync(path); const id=initialize(db);db.close();db=null;
  const bytes = readFileSync(path); db=new DatabaseSync(path); assert.equal(initialize(db),id);db.close();db=null;
  assert.deepEqual(readFileSync(path),bytes);
  copyFileSync(path,join(root,'synthetic-clone.sqlite'));
  db=new DatabaseSync(join(root,'synthetic-clone.sqlite'));assert.equal(initialize(db),id);
 } finally {db?.close();rmSync(root,{recursive:true,force:true});}
});

test('real transcription startup migrates before admission; scoped list and identity discovery preserve database bytes', async () => {
 const root=mkdtempSync(join(tmpdir(),'yanyu-store-startup-'));let service,db;
 const workspace={get(){throw Error('Unexpected workspace read');},list(){throw Error('Unexpected workspace list');}};
 try {
  service=localTranscription(root,workspace);db=new DatabaseSync(join(root,'long-transcription.sqlite'));
  const id=read(db), before=readFileSync(join(root,'long-transcription.sqlite'));
  const scopeHeaders=await discoverScope(service);assert.equal(scopeHeaders[header],id);
  let response;
  assert.equal(await service.handle({url:'/api/local-asr/jobs',method:'GET',headers:scopeHeaders},(status,body)=>{response={status,body};},()=>assert.fail('Unexpected failure')),true);
  assert.equal(response.status,200);assert.deepEqual(response.body.jobs,[]);
  assert.equal(read(db),id);assert.deepEqual(readFileSync(join(root,'long-transcription.sqlite')),before);
  db.close();db=null;await service.close();service=null;
  service=localTranscription(root,workspace);db=new DatabaseSync(join(root,'long-transcription.sqlite'));assert.equal(read(db),id);
 } finally {db?.close();await service?.close();rmSync(root,{recursive:true,force:true});}
});

test('corrupt identity aborts real startup before processing-job reconciliation', () => {
 const root=mkdtempSync(join(tmpdir(),'yanyu-store-corrupt-'));let db;
 try {
  db=new DatabaseSync(join(root,'long-transcription.sqlite'));
  db.exec(`CREATE TABLE transcription_store_identity(singleton INTEGER,store_id TEXT);
   CREATE TABLE transcription_jobs(id TEXT PRIMARY KEY,filename TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL,result TEXT,error TEXT,progress TEXT);
   INSERT INTO transcription_jobs VALUES('synthetic','synthetic.wav','processing','2026-01-01',NULL,NULL,NULL);`);
  const before=readFileSync(join(root,'long-transcription.sqlite'));
  assert.throws(()=>localTranscription(root,{}),/Local transcription initialization unavailable/);
  assert.equal(db.prepare('SELECT status FROM transcription_jobs').get().status,'processing');
  assert.deepEqual(readFileSync(join(root,'long-transcription.sqlite')),before);
 } finally {db?.close();rmSync(root,{recursive:true,force:true});}
});
