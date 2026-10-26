import {createHash,webcrypto} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {
 PREFIX,MAX_RECORD_BYTES,MAX_RECORDS,DRAFT_TTL_MS,beginCitationSave,clearCitationDraft,
 createCitationDraft,listCitationDrafts,persistCitationDraft,readCitationDraft,
 rebuildCitationPayload,updateCitationDraftNote,validateCitationDraft,verifyCitationReceipt,
 type CitationDraftRecord,type CitationDraftSource,
} from '../candidate/src/components/citation-draft-journal';

// Synthetic-only tests. No network, browser account or user source content.
const scope='10000000-0000-4000-8000-000000000001';
const otherScope='20000000-0000-4000-8000-000000000002';
const documentId='30000000-0000-4000-8000-000000000003';
const otherDocumentId='40000000-0000-4000-8000-000000000004';
const citationId='50000000-0000-4000-8000-000000000005';
const otherOperationId='60000000-0000-4000-8000-000000000006';
const now=Date.parse('2026-10-17T12:00:00.000Z');
const text='SYNTHETIC_ONLY_SOURCE 😀 repeated quote / middle / repeated quote / cafe\u0301';
const quote='repeated quote';
const start=text.lastIndexOf(quote),end=start+quote.length;
const digest=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const source: CitationDraftSource={id:documentId,revision:4,sha256:digest('synthetic original bytes'),textSha256:digest(text),format:'txt'};
const requestFields=['documentRevision','documentSha256','end','note','operationId','quote','quoteSha256','rangeUnit','start','textSha256'] as const;
const rangeFields=['scope','documentId','documentRevision','documentSha256','textSha256','start','end','quoteSha256'] as const;
const withRangeHash=(item:CitationDraftRecord):CitationDraftRecord=>({...item,rangeSha256:digest(JSON.stringify(rangeFields.map(field=>[field,item[field]])))});
const key=(item:Pick<CitationDraftRecord,'scope'|'documentId'>)=>`${PREFIX}${item.scope}:${item.documentId}`;
const makeDraft=(note='User-authored synthetic note 😀')=>createCitationDraft(scope,source,text,{start,end},note,now);
const makePending=async()=>beginCitationSave(await makeDraft(),source,text,now+100);
function memoryStorage():Storage{
 const data=new Map<string,string>();
 return {get length(){return data.size},key:i=>[...data.keys()][i]??null,getItem:key=>data.get(key)??null,setItem:(key,value)=>{data.set(key,String(value))},removeItem:key=>{data.delete(key)},clear:()=>data.clear()};
}
async function receipt(record:CitationDraftRecord){
 const request=await rebuildCitationPayload(record,source,text);
 return {storeScope:record.scope,operationId:record.operationId,outcome:'committed',requestSha256:record.requestSha256,citation:{id:citationId,documentId:record.documentId,documentSha256:record.documentSha256,textSha256:record.textSha256,start:record.start,end:record.end,quote:request.quote,quoteSha256:record.quoteSha256,note:record.note,labelAtCreation:'synthetic original filename.txt',createdAt:'2026-10-17T12:00:01.000Z',level:'document-text',page:null,rangeUnit:'utf16-code-unit',rangeConvention:'half-open'}};
}
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto)});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()});

describe('session-only, exact-schema and per-store citation metadata',()=>{
 it('exports the documented per-record, per-library and draft age bounds',()=>{
  expect(MAX_RECORD_BYTES).toBe(8192);expect(MAX_RECORDS).toBe(20);expect(DRAFT_TTL_MS).toBe(7*24*60*60*1000);
 });

 it('persists only hashes, range, user note and operation metadata, never source content or labels',async()=>{
  const item=await createCitationDraft(scope,{...source,name:'NEVER_PERSIST_NAME',title:'NEVER_PERSIST_TITLE'} as CitationDraftSource,text,{start,end},'Explicit user note',now);
  const storage=memoryStorage();expect(persistCitationDraft(storage,item,now)).toEqual(item);
  const raw=storage.getItem(key(item))!,saved=JSON.parse(raw);
  expect(Object.keys(saved).sort()).toEqual(['createdAt','documentId','documentRevision','documentSha256','end','note','operationId','quoteSha256','rangeSha256','requestSha256','scope','start','textSha256','updatedAt','version']);
  expect(item.rangeSha256).toBe(digest(JSON.stringify(rangeFields.map(field=>[field,item[field]]))));
  expect(saved).toEqual(item);expect(saved.operationId).toBeNull();expect(saved.requestSha256).toBeNull();
  expect(raw).not.toContain(text);expect(raw).not.toContain(quote);expect(raw).not.toContain('NEVER_PERSIST');
  expect(raw).not.toContain(Buffer.from(text).toString('base64'));expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(MAX_RECORD_BYTES);
  expect(readCitationDraft(storage,scope,documentId,now)).toEqual(item);
 });

 it('isolates reads and cleanup from every other verified library scope',async()=>{
  const storage=memoryStorage(),item=await makeDraft(),foreign=withRangeHash({...item,scope:otherScope});
  persistCitationDraft(storage,item,now);persistCitationDraft(storage,foreign,now);
  storage.setItem(`${PREFIX}${otherScope}:invalid`,'foreign damaged metadata');
  expect(listCitationDrafts(storage,scope,now)).toEqual([item]);
  clearCitationDraft(storage,item);expect(readCitationDraft(storage,scope,documentId,now)).toBeNull();
  expect(storage.getItem(key(foreign))).toBe(JSON.stringify(foreign));expect(storage.length).toBe(2);
 });

 it('returns independent snapshots and compares whole records independent of JSON key order',async()=>{
  const storage=memoryStorage(),item=await makeDraft();persistCitationDraft(storage,item,now);
  const loaded=readCitationDraft(storage,scope,documentId,now)!;loaded.note='not persisted';
  expect(readCitationDraft(storage,scope,documentId,now)!.note).toBe(item.note);
  storage.setItem(key(item),JSON.stringify(Object.fromEntries(Object.entries(item).reverse())));
  clearCitationDraft(storage,item);expect(storage.length).toBe(0);clearCitationDraft(storage,item);
 });

 it('updates only an unsubmitted note and keeps creation time and all source bindings',async()=>{
  const item=await makeDraft(),updated=updateCitationDraftNote(item,'Changed human note',now+500);
  expect(updated).toEqual({...item,note:'Changed human note',updatedAt:now+500});expect(item.note).not.toBe(updated.note);
  expect(updateCitationDraftNote(updated,'Clock moved back',now).updatedAt).toBe(now+500);
  const storage=memoryStorage();persistCitationDraft(storage,item,now);persistCitationDraft(storage,updated,now+500);
  expect(()=>persistCitationDraft(storage,item,now+500)).toThrow();
  expect(readCitationDraft(storage,scope,documentId,now+500)).toEqual(updated);
 });

 it('bounds each scope at 20 entries, never evicts pending work, and still allows same-record persistence',async()=>{
  const storage=memoryStorage(),item=await makePending();
  const entries=Array.from({length:20},(_,i)=>withRangeHash({...item,documentId:`30000000-0000-4000-8000-${String(i).padStart(12,'0')}`}));
  entries.forEach(record=>persistCitationDraft(storage,record,now+100));
  expect(()=>persistCitationDraft(storage,withRangeHash({...item,documentId:otherDocumentId}),now+100)).toThrow(/20/);
  persistCitationDraft(storage,entries[0],now+100);expect(listCitationDrafts(storage,scope,now+100)).toHaveLength(20);
  persistCitationDraft(storage,withRangeHash({...item,scope:otherScope}),now+100);expect(storage.length).toBe(21);
 });

 it('rejects over-capacity corrupted scope without deleting any records',async()=>{
  const storage=memoryStorage(),item=await makePending();
  for(let i=0;i<21;i++){const record=withRangeHash({...item,documentId:`30000000-0000-4000-8000-${String(i).padStart(12,'0')}`});storage.setItem(key(record),JSON.stringify(record));}
  expect(()=>listCitationDrafts(storage,scope,now+100)).toThrow(/20/);expect(storage.length).toBe(21);
 });
});

describe('expiry, immutable pending operation and exact-match removal',()=>{
 it('expires only unsubmitted drafts after seven days since last edit, including the boundary',async()=>{
  const storage=memoryStorage(),item=await makeDraft();persistCitationDraft(storage,item,now);
  expect(readCitationDraft(storage,scope,documentId,now+DRAFT_TTL_MS-1)).toEqual(item);
  expect(readCitationDraft(storage,scope,documentId,now+DRAFT_TTL_MS)).toBeNull();expect(storage.length).toBe(0);
  const updated=updateCitationDraftNote(item,'Edited later',now+500);
  persistCitationDraft(storage,updated,now+500);expect(readCitationDraft(storage,scope,documentId,now+DRAFT_TTL_MS)).toEqual(updated);
 });

 it('never expires or mutates pending unknown-result records, even long after draft TTL',async()=>{
  const storage=memoryStorage(),item=await makePending();persistCitationDraft(storage,item,now+100);
  const future=now+DRAFT_TTL_MS*100;
  expect(readCitationDraft(storage,scope,documentId,future)).toEqual(item);
  expect(await beginCitationSave(item,{...source,revision:20},text,future)).toEqual(item);
  expect(()=>updateCitationDraftNote(item,'edit',future)).toThrow(/待确认/);
  expect(()=>persistCitationDraft(storage,{...item,operationId:null,requestSha256:null,updatedAt:future},future)).toThrow(/待确认/);
  expect(()=>persistCitationDraft(storage,{...item,note:'change',updatedAt:future},future)).toThrow(/待确认/);
  expect(readCitationDraft(storage,scope,documentId,future)).toEqual(item);
 });

 it('reclaims expired unsubmitted capacity without disturbing pending work',async()=>{
  const storage=memoryStorage(),draft=await makeDraft(),pending=await makePending();
  persistCitationDraft(storage,draft,now);
  for(let i=0;i<19;i++)persistCitationDraft(storage,withRangeHash({...pending,documentId:`70000000-0000-4000-8000-${String(i).padStart(12,'0')}`}),now+100);
  persistCitationDraft(storage,withRangeHash({...pending,documentId:otherDocumentId}),now+DRAFT_TTL_MS);
  expect(storage.length).toBe(20);expect(readCitationDraft(storage,scope,documentId,now+DRAFT_TTL_MS)).toBeNull();
 });

 it('refuses to delete a newer draft after a delayed prior save receipt',async()=>{
  const storage=memoryStorage(),pending=await makePending();persistCitationDraft(storage,pending,now+100);
  clearCitationDraft(storage,pending);
  const newer=await createCitationDraft(scope,source,text,{start:0,end:9},'New selection',now+200);
  persistCitationDraft(storage,newer,now+200);
  expect(()=>clearCitationDraft(storage,pending)).toThrow(/较新/);expect(readCitationDraft(storage,scope,documentId,now+200)).toEqual(newer);
 });

 it('requires the full current draft to match before changing it to pending',async()=>{
  const storage=memoryStorage(),draft=await makeDraft(),pending=await beginCitationSave(draft,source,text,now+100);
  persistCitationDraft(storage,draft,now);
  const updated=updateCitationDraftNote(draft,'New note while hashing',now+50);persistCitationDraft(storage,updated,now+50);
  expect(()=>persistCitationDraft(storage,pending,now+100)).toThrow(/草稿已变化/);
  expect(readCitationDraft(storage,scope,documentId,now+100)).toEqual(updated);
 });

 it('does not reintroduce an expired draft by persistence, editing or starting a new save',async()=>{
  const item=await makeDraft(),storage=memoryStorage(),future=now+DRAFT_TTL_MS;
  expect(()=>persistCitationDraft(storage,item,future)).toThrow(/7 天/);
  expect(()=>updateCitationDraftNote(item,'edit',future)).toThrow(/7 天/);
  await expect(beginCitationSave(item,source,text,future)).rejects.toThrow(/7 天/);expect(storage.length).toBe(0);
 });
});

describe('conservative handling of storage failures and corrupted metadata',()=>{
 it.each(['length','key','getItem','setItem'] as const)('fails closed when %s throws',async(part)=>{
  const storage=memoryStorage(),item=await makeDraft();
  if(part==='length')Object.defineProperty(storage,'length',{get(){throw Error('Denied')}});
  else if(part==='key'){storage.setItem('unrelated','value');storage.key=()=>{throw Error('Denied')}}
  else if(part==='getItem')storage.getItem=()=>{throw Error('Denied')};
  else storage.setItem=()=>{throw Error('Quota exceeded')};
  expect(()=>persistCitationDraft(storage,item,now)).toThrow(/停止/);
 });

 it('requires write read-back before treating a pending operation as retained',async()=>{
  const storage=memoryStorage(),item=await makePending();storage.setItem=()=>{};
  expect(()=>persistCitationDraft(storage,item,now+100)).toThrow(/停止/);expect(storage.length).toBe(0);
 });

 it('reports a post-write read denial without pretending the outcome is known',async()=>{
  const storage=memoryStorage(),item=await makePending(),write=storage.setItem.bind(storage),read=storage.getItem.bind(storage);
  let wrote=false;storage.setItem=(name,value)=>{write(name,value);wrote=true};
  storage.getItem=name=>{if(wrote)throw Error('Read denied');return read(name)};
  expect(()=>persistCitationDraft(storage,item,now+100)).toThrow(/停止/);
  storage.getItem=read;expect(readCitationDraft(storage,scope,documentId,now+100)).toEqual(item);
 });

 it.each(['throw','silent'] as const)('preserves pending record and warns when deletion is %s',async(mode)=>{
  const storage=memoryStorage(),item=await makePending();persistCitationDraft(storage,item,now+100);
  storage.removeItem=()=>{if(mode==='throw')throw Error('Denied')};
  expect(()=>clearCitationDraft(storage,item)).toThrow(/停止/);expect(readCitationDraft(storage,scope,documentId,now+100)).toEqual(item);
 });

 it('surfaces a failed TTL cleanup instead of silently ignoring it',async()=>{
  const storage=memoryStorage(),item=await makeDraft();persistCitationDraft(storage,item,now);storage.removeItem=()=>{};
  expect(()=>listCitationDrafts(storage,scope,now+DRAFT_TTL_MS)).toThrow(/停止/);expect(storage.length).toBe(1);
 });

 it.each([
  ['bad JSON',(item:CitationDraftRecord)=>'{'],
  ['empty value',(item:CitationDraftRecord)=>''],
  ['extra quote field',(item:CitationDraftRecord)=>JSON.stringify({...item,quote})],
  ['extra filename field',(item:CitationDraftRecord)=>JSON.stringify({...item,filename:'secret.txt'})],
  ['wrong scope',(item:CitationDraftRecord)=>JSON.stringify({...item,scope:otherScope})],
  ['wrong document key',(item:CitationDraftRecord)=>JSON.stringify({...item,documentId:otherDocumentId})],
  ['pending without request hash',(item:CitationDraftRecord)=>JSON.stringify({...item,operationId:otherOperationId})],
  ['request hash without operation',(item:CitationDraftRecord)=>JSON.stringify({...item,requestSha256:digest('x')})],
  ['missing range identity hash',(item:CitationDraftRecord)=>JSON.stringify(Object.fromEntries(Object.entries(item).filter(([field])=>field!=='rangeSha256')))],
  ['oversized JSON',(item:CitationDraftRecord)=>' '.repeat(MAX_RECORD_BYTES)+JSON.stringify(item)],
 ] as const)('retains and refuses damaged own-scope records: %s',async(_name,corrupt)=>{
  const storage=memoryStorage(),item=await makeDraft(),raw=corrupt(item);storage.setItem(key(item),raw);
  expect(()=>readCitationDraft(storage,scope,documentId,now)).toThrow();
  expect(()=>persistCitationDraft(storage,{...item,documentId:otherDocumentId},now)).toThrow();
  expect(()=>clearCitationDraft(storage,item)).toThrow();expect(storage.getItem(key(item))).toBe(raw);
 });

 it.each([
  {version:2},{scope:'bad'},{documentId:'bad'},{documentRevision:-1},{documentRevision:0.5},
  {documentSha256:'bad'},{textSha256:'A'.repeat(64)},{quoteSha256:'bad'},{rangeSha256:'bad'},
  {start:-1},{end:start},{start:NaN},{end:Number.MAX_SAFE_INTEGER+1},
  {createdAt:-1},{updatedAt:now-1},{createdAt:Infinity},{operationId:'not-an-id',requestSha256:digest('x')},
 ] as unknown as Partial<CitationDraftRecord>[])('rejects malformed metadata without storage mutation: %j',async(patch)=>{
  const storage=memoryStorage(),item={...await makeDraft(),...patch};
  expect(()=>persistCitationDraft(storage,item,now)).toThrow();expect(storage.length).toBe(0);
 });

 it('validates scope/document IDs on reads and validates caller timestamps',async()=>{
  const storage=memoryStorage();expect(()=>listCitationDrafts(storage,'bad',now)).toThrow();
  expect(()=>readCitationDraft(storage,scope,'bad',now)).toThrow();
  expect(()=>listCitationDrafts(storage,scope,NaN)).toThrow();
  await expect(createCitationDraft('bad',source,text,{start,end},'',now)).rejects.toThrow();
 });
});

describe('source integrity, UTF-16 range and exact byte limits',()=>{
 it('supports both TXT and MD and rejects PDF without making a pending operation',async()=>{
  await expect(createCitationDraft(scope,{...source,format:'md'},text,{start,end},'',now)).resolves.toMatchObject({start,end});
  await expect(createCitationDraft(scope,{...source,format:'pdf'},text,{start,end},'',now)).rejects.toThrow(/TXT \/ MD/);
  const item=await makeDraft();await expect(beginCitationSave(item,{...source,format:'pdf'},text,now)).rejects.toThrow();
 });

 it('accepts whole surrogate pairs and preserves combining characters without normalization',async()=>{
  const value='A😀 cafe\u0301 Z',s={...source,textSha256:digest(value)};
  const emoji=await createCitationDraft(scope,s,value,{start:1,end:3},'',now);
  expect(emoji.quoteSha256).toBe(digest('😀'));
  const accent=await createCitationDraft(scope,s,value,{start:4,end:9},'',now);
  expect(accent.quoteSha256).toBe(digest('cafe\u0301'));expect(accent.quoteSha256).not.toBe(digest('café'));
 });

 it.each([[2,3],[1,2],[0,2],[2,4],[-1,2],[0,0],[0,5],[0.5,3]])('rejects invalid or surrogate-splitting half-open range %j',async(start,end)=>{
  const value='A😀Z';await expect(createCitationDraft(scope,{...source,textSha256:digest(value)},value,{start,end},'',now)).rejects.toThrow(/范围/);
 });

 it.each(['\ud800','A\udfffB'])('rejects malformed source Unicode before hashing: %j',async(value)=>{
  await expect(createCitationDraft(scope,{...source,textSha256:digest(value)},value,{start:0,end:value.length},'',now)).rejects.toThrow();
 });

 it('enforces note limits in UTF-8 bytes, not JavaScript length, and allows normal multiline notes',async()=>{
  expect((await makeDraft('😀'.repeat(1024))).note).toHaveLength(2048);
  await expect(makeDraft('😀'.repeat(1024)+'a')).rejects.toThrow(/4096/);
  await expect(makeDraft('汉'.repeat(1366))).rejects.toThrow(/4096/);
  await expect(makeDraft('line one\nline two\tindented\r\n')).resolves.toBeDefined();
  for(const note of ['\ud800','\u0000','\u007f','\u000b'])await expect(makeDraft(note)).rejects.toThrow();
 });

 it('enforces serialized 8 KiB separately from the note byte limit',async()=>{
  // Tabs are valid human input, but JSON escaping plus metadata exceeds 8 KiB.
  await expect(makeDraft('\t'.repeat(4096))).rejects.toThrow(/8 KiB/);
  const storage=memoryStorage(),item=await makeDraft();
  expect(()=>persistCitationDraft(storage,{...item,note:'\t'.repeat(4096)},now)).toThrow(/8 KiB/);expect(storage.length).toBe(0);
 });

 it('enforces the quote 16 KiB bound in UTF-8 bytes while never persisting the quote',async()=>{
  const value='😀'.repeat(4096),s={...source,textSha256:digest(value)};
  const item=await createCitationDraft(scope,s,value,{start:0,end:value.length},'',now);
  expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThan(1000);
  const longer=value+'a';await expect(createCitationDraft(scope,{...s,textSha256:digest(longer)},longer,{start:0,end:longer.length},'',now)).rejects.toThrow(/16384/);
 });

 it('validates the complete extracted text, even if the selected quote is unchanged',async()=>{
  await expect(createCitationDraft(scope,source,text+'tampered',{start,end},'',now)).rejects.toThrow(/哈希/);
  const item=await makeDraft();
  await expect(validateCitationDraft(item,source,text+'tampered')).rejects.toThrow(/哈希/);
  await expect(validateCitationDraft(item,{...source,textSha256:digest(text+'tampered')},text+'tampered')).rejects.toThrow();
 });

 it.each([
  {id:otherDocumentId},{sha256:digest('different original')},{textSha256:digest('different extraction')},{revision:5},
 ] as Partial<CitationDraftSource>[])('rejects a changed draft source binding before recovery or save: %j',async(patch)=>{
  const item=await makeDraft();await expect(validateCitationDraft(item,{...source,...patch},text)).rejects.toThrow();
  await expect(beginCitationSave(item,{...source,...patch},text,now)).rejects.toThrow();
 });

 it('rejects a shifted range or quote digest rather than searching for another matching passage',async()=>{
  const item=await makeDraft();
  await expect(validateCitationDraft({...item,start:start+1,end:end+1},source,text)).rejects.toThrow();
  await expect(validateCitationDraft({...item,quoteSha256:digest('bad')},source,text)).rejects.toThrow();
  expect(item.start).toBe(text.lastIndexOf(quote));expect(item.start).not.toBe(text.indexOf(quote));
 });

 it('rejects ordinary-draft offsets moved to identical repeated text even though text and quote hashes still match',async()=>{
  const item=await makeDraft(),storage=memoryStorage(),otherStart=text.indexOf(quote);
  persistCitationDraft(storage,item,now);
  const corrupted={...item,start:otherStart,end:otherStart+quote.length};
  expect(text.slice(corrupted.start,corrupted.end)).toBe(text.slice(item.start,item.end));
  expect(digest(text.slice(corrupted.start,corrupted.end))).toBe(item.quoteSha256);
  expect(corrupted.textSha256).toBe(digest(text));expect(corrupted.operationId).toBeNull();
  storage.setItem(key(item),JSON.stringify(corrupted));
  const loaded=readCitationDraft(storage,scope,documentId,now)!,random=vi.spyOn(crypto,'randomUUID');
  await expect(validateCitationDraft(loaded,source,text)).rejects.toThrow(/范围的哈希/);
  await expect(beginCitationSave(loaded,source,text,now+100)).rejects.toThrow(/范围的哈希/);
  await expect(rebuildCitationPayload(loaded,source,text)).rejects.toThrow(/范围的哈希/);
  expect(random).not.toHaveBeenCalled();expect(storage.getItem(key(item))).toBe(JSON.stringify(corrupted));
 });

 it('keeps selection identity checksum unchanged by note edits, timestamp changes and pending freeze',async()=>{
  const item=await makeDraft(),updated=updateCitationDraftNote(item,'A different user note',now+100);
  expect(updated.rangeSha256).toBe(item.rangeSha256);
  await expect(validateCitationDraft(updated,source,text)).resolves.toBeUndefined();
  const pending=await beginCitationSave(updated,source,text,now+200);
  expect(pending.rangeSha256).toBe(item.rangeSha256);
  expect(await beginCitationSave(pending,{...source,revision:99},text,now+300)).toEqual(pending);
  await expect(validateCitationDraft({...item,rangeSha256:digest('corrupted selection')},source,text)).rejects.toThrow(/范围的哈希/);
 });
});

describe('frozen original request and verified committed receipt',()=>{
 it('validates a recovered draft without allocating an operation or changing the record',async()=>{
  const item=await makeDraft(),random=vi.spyOn(crypto,'randomUUID');
  await expect(validateCitationDraft(item,source,text)).resolves.toBeUndefined();expect(random).not.toHaveBeenCalled();
  expect(item.operationId).toBeNull();await expect(rebuildCitationPayload(item,source,text)).rejects.toThrow(/冻结/);
 });

 it('generates one UUID and the exact backend hash, then reuses all original request fields',async()=>{
  const item=await makeDraft(),random=vi.spyOn(crypto,'randomUUID');
  const pending=await beginCitationSave(item,source,text,now+100),request=await rebuildCitationPayload(pending,source,text);
  expect(random).toHaveBeenCalledTimes(1);expect(Object.keys(request).sort()).toEqual([...requestFields]);
  expect(request).toEqual({documentRevision:source.revision,documentSha256:source.sha256,end,note:item.note,operationId:pending.operationId,quote,quoteSha256:digest(quote),rangeUnit:'utf16-code-unit',start,textSha256:source.textSha256});
  expect(pending.requestSha256).toBe(digest(JSON.stringify(requestFields.map(field=>[field,request[field]]))));
  expect(await beginCitationSave(pending,source,text,now+200)).toEqual(pending);expect(random).toHaveBeenCalledTimes(1);
  expect(await rebuildCitationPayload(pending,{...source,revision:30},text)).toEqual(request);
 });

 it.each([
  {note:'tampered note'},{documentRevision:99},{operationId:otherOperationId},{requestSha256:digest('wrong request')},
  {start:text.indexOf(quote),end:text.indexOf(quote)+quote.length},
 ] as Partial<CitationDraftRecord>[])('rejects pending request mutation even with an unchanged quote: %j',async(patch)=>{
  const pending={...await makePending(),...patch};
  await expect(rebuildCitationPayload(pending,source,text)).rejects.toThrow(/哈希/);
  await expect(beginCitationSave(pending,source,text,now+200)).rejects.toThrow();
 });

 it('accepts a verified committed receipt after only document metadata revision changed',async()=>{
  const pending=await makePending(),proof=await receipt(pending);
  expect(await verifyCitationReceipt(pending,proof,{...source,revision:50},text)).toEqual(proof.citation);
  // Older compatible citations can omit the two optional range descriptors.
  const {rangeUnit,rangeConvention,...olderCitation}=proof.citation;
  expect(await verifyCitationReceipt(pending,{...proof,citation:olderCitation},source,text)).toEqual(olderCitation);
 });

 it.each([
  {storeScope:otherScope},{operationId:otherOperationId},{requestSha256:digest('wrong')},
  {outcome:'absent'},{outcome:'pending'},
 ])('rejects a mismatched or noncommitted receipt envelope and retains pending metadata: %j',async(patch)=>{
  const pending=await makePending(),storage=memoryStorage();persistCitationDraft(storage,pending,now+100);
  await expect(verifyCitationReceipt(pending,{...await receipt(pending),...patch},source,text)).rejects.toThrow();
  expect(readCitationDraft(storage,scope,documentId,now+100)).toEqual(pending);
 });

 it.each([
  {id:'not-a-citation'},{documentId:otherDocumentId},{documentSha256:digest('different')},{textSha256:digest('different')},
  {start:text.indexOf(quote),end:text.indexOf(quote)+quote.length},{start:start+1},{end:end+1},
  {quote:'same looking different quote'},{quoteSha256:digest('different')},{note:'different note'},
  {page:1},{level:'page'},{rangeUnit:'codepoint'},{rangeConvention:'closed'},
  {labelAtCreation:''},{labelAtCreation:'\u0000'},{createdAt:'not-a-date'},{extraSourceContent:'not part of receipt'},
 ])('rejects every mismatched citation binding or malformed receipt field: %j',async(patch)=>{
  const pending=await makePending(),proof=await receipt(pending);
  await expect(verifyCitationReceipt(pending,{...proof,citation:{...proof.citation,...patch}},source,text)).rejects.toThrow();
 });

 it('rejects absent, incomplete and missing outcome receipts as well as changed source originals',async()=>{
  const pending=await makePending(),proof=await receipt(pending),{outcome,...withoutOutcome}=proof;
  for(const invalid of [null,[],{},withoutOutcome,{storeScope:scope,operationId:pending.operationId,outcome:'absent'},{...proof,citation:null}])await expect(verifyCitationReceipt(pending,invalid,source,text)).rejects.toThrow();
  await expect(verifyCitationReceipt(pending,proof,{...source,sha256:digest('changed')},text)).rejects.toThrow();
  await expect(verifyCitationReceipt(pending,proof,source,text+'changed elsewhere')).rejects.toThrow();
  const draft=await makeDraft();await expect(verifyCitationReceipt(draft,proof,source,text)).rejects.toThrow();
 });

 it('does not let a fake receipt conceal a damaged retained original request hash',async()=>{
  const pending=await makePending(),proof=await receipt(pending),damaged={...pending,requestSha256:digest('forged')};
  await expect(verifyCitationReceipt(damaged,{...proof,requestSha256:damaged.requestSha256},source,text)).rejects.toThrow(/哈希/);
 });
});
