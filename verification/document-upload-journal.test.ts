import {webcrypto,createHash} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {
 UPLOAD_JOURNAL_PREFIX,forgetUploadRecord,newUploadRecord,readUploadRecords,
 retainUploadRecord,validUploadScope,verifyUploadFile,verifyUploadReceipt,
 type UploadRecord,type UploadReceipt,
} from '../candidate/src/components/document-upload-journal';

// Every fixture is synthetic. These tests use no network, browser account or file content from the user.
const scope='10000000-0000-4000-8000-000000000001';
const otherScope='20000000-0000-4000-8000-000000000002';
const operationId='30000000-0000-4000-8000-000000000003';
const otherOperation='40000000-0000-4000-8000-000000000004';
const folderId='50000000-0000-4000-8000-000000000005';
const documentId='60000000-0000-4000-8000-000000000006';
const content='SYNTHETIC_ONLY_PRIVATE_FILE_BYTES';
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const record=(overrides:Partial<UploadRecord>={}):UploadRecord=>({version:1,scope,operationId,name:'synthetic.md',format:'md',bytes:Buffer.byteLength(content),sha256:digest(content),workspaceId:'synthetic-workspace',folderId,createdAt:'2026-10-17T12:00:00.000Z',...overrides});
const key=(item:UploadRecord)=>`${UPLOAD_JOURNAL_PREFIX}${item.scope}:${item.operationId}`;
const receipt=(item:UploadRecord):UploadReceipt=>({operationId:item.operationId,documentId,name:item.name,format:item.format,bytes:item.bytes,sha256:item.sha256,workspaceId:item.workspaceId,folderId:item.folderId,createdAt:'2026-10-17T12:01:00.000Z'});
function syntheticFile(text=content,name='synthetic.md'){
 const file=new File([text],name,{type:'text/markdown'}),bytes=new TextEncoder().encode(text);
 // JSDOM File does not provide arrayBuffer in all installed versions. Use real synthetic bytes.
 Object.defineProperty(file,'arrayBuffer',{value:async()=>Uint8Array.from(bytes).buffer});
 return file;
}
function memoryStorage():Storage{
 const data=new Map<string,string>();
 return {get length(){return data.size},key:i=>[...data.keys()][i]??null,getItem:key=>data.get(key)??null,setItem:(key,value)=>{data.set(key,String(value))},removeItem:key=>{data.delete(key)},clear:()=>data.clear()};
}
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto)});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()});

describe('metadata-only per-store upload journal',()=>{
 it('keeps separate operation keys and isolates reads and settlement by server store scope',()=>{
  const storage=memoryStorage(),one=record(),two=record({operationId:otherOperation}),foreign=record({scope:otherScope});
  retainUploadRecord(storage,one);retainUploadRecord(storage,two);retainUploadRecord(storage,foreign);
  storage.setItem(`${UPLOAD_JOURNAL_PREFIX}${otherScope}:invalid`,'broken other-store data');
  expect(readUploadRecords(storage,scope)).toEqual([one,two]);
  expect(storage.length).toBe(4);
  forgetUploadRecord(storage,one);
  expect(readUploadRecords(storage,scope)).toEqual([two]);
  expect(storage.getItem(key(foreign))).toBe(JSON.stringify(foreign));
  expect(storage.getItem(`${UPLOAD_JOURNAL_PREFIX}${otherScope}:invalid`)).toBe('broken other-store data');
 });

 it('preserves both operations when two tab writes interleave instead of replacing a shared array',()=>{
  const storage=memoryStorage(),one=record(),two=record({operationId:otherOperation});
  const write=storage.setItem.bind(storage);let interleaved=false;
  storage.setItem=(name,value)=>{
   if(!interleaved){interleaved=true;retainUploadRecord(storage,two)}
   write(name,value);
  };
  retainUploadRecord(storage,one);
  expect(readUploadRecords(storage,scope)).toEqual([one,two]);
  forgetUploadRecord(storage,two);expect(readUploadRecords(storage,scope)).toEqual([one]);
 });

 it('persists only the fixed recovery metadata schema and never file bytes, text or base64',async()=>{
  const storage=memoryStorage(),item=await newUploadRecord(scope,syntheticFile(),'synthetic-workspace',folderId);
  retainUploadRecord(storage,item);
  const raw=storage.getItem(key(item))!,saved=JSON.parse(raw);
  expect(saved).toEqual(item);
  expect(Object.keys(saved).sort()).toEqual(['bytes','createdAt','folderId','format','name','operationId','scope','sha256','version','workspaceId']);
  expect(saved.sha256).toBe(digest(content));
  expect(raw).not.toContain(content);expect(raw).not.toContain(Buffer.from(content).toString('base64'));
  expect(raw.length).toBeLessThan(4096);
 });

 it('accepts an identical retained operation idempotently and rejects changed payload under that operation',()=>{
  const storage=memoryStorage(),item=record();retainUploadRecord(storage,item);retainUploadRecord(storage,{...item});
  expect(storage.length).toBe(1);
  expect(()=>retainUploadRecord(storage,{...item,sha256:'a'.repeat(64)})).toThrow();
  expect(storage.getItem(key(item))).toBe(JSON.stringify(item));
  expect(()=>forgetUploadRecord(storage,{...item,workspaceId:null})).toThrow();
  expect(readUploadRecords(storage,scope)).toEqual([item]);
 });

 it('generates distinct operation IDs for deliberate new uploads of identical content',async()=>{
  const file=syntheticFile(),one=await newUploadRecord(scope,file,null,null),two=await newUploadRecord(scope,file,null,null),storage=memoryStorage();
  expect(one.operationId).not.toBe(two.operationId);expect(one.sha256).toBe(two.sha256);
  expect(validUploadScope(one.operationId)).toBe(true);expect(validUploadScope(two.operationId)).toBe(true);
  retainUploadRecord(storage,one);retainUploadRecord(storage,two);expect(readUploadRecords(storage,scope)).toHaveLength(2);
 });

 it('sorts recovered operations deterministically and only removes an exact matching record',()=>{
  const storage=memoryStorage(),newer=record({createdAt:'2026-10-17T13:00:00.000Z'}),older=record({operationId:otherOperation});
  retainUploadRecord(storage,newer);retainUploadRecord(storage,older);
  expect(readUploadRecords(storage,scope)).toEqual([older,newer]);
  forgetUploadRecord(storage,older);forgetUploadRecord(storage,older);
  expect(readUploadRecords(storage,scope)).toEqual([newer]);
 });

 it('bounds pending metadata without clearing any unresolved operation',()=>{
  const storage=memoryStorage();
  const items=Array.from({length:16},(_,i)=>record({operationId:`30000000-0000-4000-8000-${String(i).padStart(12,'0')}`}));
  for(const item of items)retainUploadRecord(storage,item);
  expect(()=>retainUploadRecord(storage,record({operationId:otherOperation}))).toThrow(/16/);
  expect(readUploadRecords(storage,scope)).toHaveLength(16);
  retainUploadRecord(storage,items[0]);expect(readUploadRecords(storage,scope)).toHaveLength(16);
 });

 it.each(['length','key','getItem','setItem'] as const)('fails closed when storage %s is unavailable',part=>{
  const storage=memoryStorage(),item=record();
  if(part==='length')Object.defineProperty(storage,'length',{get(){throw Error('Synthetic storage denial')}});
  else if(part==='key'){storage.setItem(key(item),JSON.stringify(item));storage.key=()=>{throw Error('Synthetic storage denial')}}
  else if(part==='getItem'){storage.setItem(key(item),JSON.stringify(item));storage.getItem=()=>{throw Error('Synthetic storage denial')}}
  else storage.setItem=()=>{throw Error('Synthetic quota exceeded')};
  expect(()=>retainUploadRecord(storage,item)).toThrow(/停止新上传/);
 });

 it('detects silent write loss instead of treating the operation as durably retained',()=>{
  const storage=memoryStorage();storage.setItem=()=>{};
  expect(()=>retainUploadRecord(storage,record())).toThrow(/停止新上传/);
  expect(readUploadRecords(storage,scope)).toEqual([]);
 });

 it.each(['throw','silent'] as const)('keeps pending metadata when removal %s fails',mode=>{
  const storage=memoryStorage(),item=record();retainUploadRecord(storage,item);
  storage.removeItem=()=>{if(mode==='throw')throw Error('Synthetic removal failure')};
  expect(()=>forgetUploadRecord(storage,item)).toThrow();
  expect(readUploadRecords(storage,scope)).toEqual([item]);
 });

 it.each([
  ['bad JSON',()=>'{'],
  ['extra content field',()=>JSON.stringify({...record(),fileContent:content})],
  ['mismatched scope',()=>JSON.stringify(record({scope:otherScope}))],
  ['mismatched operation key',()=>JSON.stringify(record({operationId:otherOperation}))],
  ['overlong record',()=>`"${'x'.repeat(4097)}"`],
  ['empty value',()=>''],
 ] as const)('refuses corrupted own-scope metadata: %s',(_label,value)=>{
  const storage=memoryStorage();storage.setItem(key(record()),value());
  expect(()=>readUploadRecords(storage,scope)).toThrow(/停止新上传/);
  expect(()=>retainUploadRecord(storage,record({operationId:otherOperation}))).toThrow();
  expect(storage.length).toBe(1);
 });

 it.each([
  {scope:'not-a-store'}, {operationId:'not-an-operation'}, {name:'../synthetic.md'},
  {name:'synthetic\u0000.md'}, {name:'synthetic.pdf'}, {format:'html'},
  {bytes:0}, {bytes:8*1024*1024+1}, {bytes:1.5}, {sha256:'short'},
  {workspaceId:'bad/workspace'}, {folderId:'not-a-folder'}, {createdAt:'not-a-date'},
 ] as unknown as Partial<UploadRecord>[])('rejects invalid metadata before storage: %j',patch=>{
  const storage=memoryStorage();expect(()=>retainUploadRecord(storage,record(patch))).toThrow();expect(storage.length).toBe(0);
 });
});

describe('original-file and server-receipt identity',()=>{
 it('accepts a newly selected byte-identical original file without relying on File object identity',async()=>{
  await expect(verifyUploadFile(record(),syntheticFile())).resolves.toBeUndefined();
 });

 it.each([
  ['different filename',()=>syntheticFile(content,'renamed.md')],
  ['different byte count',()=>syntheticFile(content+'!')],
  ['same size but different bytes',()=>syntheticFile('X'+content.slice(1))],
 ] as const)('rejects a reselected %s before an original-operation retry',async(_label,file)=>{
  await expect(verifyUploadFile(record(),file())).rejects.toThrow(/原来同名、同内容/);
 });

 it('accepts a matching committed receipt with its server commit time',()=>{
  const item=record(),proof=receipt(item);expect(verifyUploadReceipt(item,proof)).toEqual(proof);
  expect(proof.createdAt).not.toBe(item.createdAt);
 });

 it.each([
  ['operationId',otherOperation],['name','different.md'],['format','txt'],['bytes',1],
  ['sha256','b'.repeat(64)],['workspaceId',null],['folderId',null],
 ] as const)('rejects a receipt with mismatched %s and does not clear pending metadata', (field,value)=>{
  const storage=memoryStorage(),item=record();retainUploadRecord(storage,item);
  expect(()=>verifyUploadReceipt(item,{...receipt(item),[field]:value})).toThrow(/原操作不符/);
  expect(readUploadRecords(storage,scope)).toEqual([item]);
 });

 it.each([
  null,[],{}, {...receipt(record()),documentId:'not-a-document'},
  {...receipt(record()),createdAt:'not-a-date'}, {...receipt(record()),extra:content},
 ])('rejects incomplete or malformed receipt: %j',value=>{
  expect(()=>verifyUploadReceipt(record(),value)).toThrow();
 });

 it('rejects empty, oversized, and unsupported files before generating retained metadata',async()=>{
  await expect(newUploadRecord(scope,syntheticFile(''),null,null)).rejects.toThrow(/非空/);
  const large=syntheticFile();Object.defineProperty(large,'size',{value:8*1024*1024+1});
  await expect(newUploadRecord(scope,large,null,null)).rejects.toThrow(/8 MiB/);
  await expect(newUploadRecord(scope,syntheticFile(content,'synthetic.html'),null,null)).rejects.toThrow();
 });
});
