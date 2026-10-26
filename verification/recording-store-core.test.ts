// @vitest-environment node
import { describe,it,expect,vi,beforeEach } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { DATABASE,POLICY,RecordingDraftStore,prepareCompletedDraft,createRecordingClockGuard } from '../candidate/src/recording/recording-draft-store';
let guard=createRecordingClockGuard();
beforeEach(()=>{guard=createRecordingClockGuard();});
const isolatedOpen=(factory:IDBFactory,now:()=>number=Date.now)=>RecordingDraftStore.open(factory,now,{clockGuard:guard});
const start=1_800_000_000_000;
const blob=()=>new Blob(['synthetic bytes only'],{type:'application/x-synthetic'});
const prepare=(now=start)=>prepareCompletedDraft({preserve:true,blob:blob(),durationSeconds:10},now);
async function stored(d:any) {const {blob,...metadata}=d;return {...metadata,bytes:await blob.arrayBuffer()};}
async function raw(factory:IDBFactory, fn:(s:IDBObjectStore)=>void) {
  const db=await new Promise<IDBDatabase>((res,rej)=>{const r=factory.open(DATABASE,2);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
  try { await new Promise<void>((res,rej)=>{const tx=db.transaction('completed-drafts','readwrite');tx.oncomplete=()=>res();tx.onabort=()=>rej(tx.error);fn(tx.objectStore('completed-drafts'));}); } finally {db.close();}
}
describe('isolated completed-Blob draft foundation',()=>{
  it('reports blocked open once and closes a late successful connection',async()=>{
    const req:any={};const close=vi.fn();
    const f={open:()=>req} as unknown as IDBFactory;
    const result=isolatedOpen(f);
    req.onblocked();await expect(result).rejects.toMatchObject({code:'blocked'});
    req.result={close};req.onsuccess();expect(close).toHaveBeenCalledOnce();
  });
  it('rejects an unknown dedicated database schema without modifying it',async()=>{
    const f=new IDBFactory();await new Promise<void>((resolve)=>{const r=f.open(DATABASE,1);r.onupgradeneeded=()=>r.result.createObjectStore('foreign');r.onsuccess=()=>{r.result.close();resolve();};});
    await expect(isolatedOpen(f)).rejects.toMatchObject({code:'invalid'});
  });
  it('hash-corrupt records cannot be reconciled or explicitly removed',async()=>{
    const f=new IDBFactory(),s=await isolatedOpen(f,()=>start),p=await prepare();await s.preserve(p);
    const r=await stored((await s.restore()).drafts[0]);
    await raw(f,store=>store.put({...r,bytes:new TextEncoder().encode('SYNTHETIC BYTES ONLY').buffer}));
    await expect(s.preserve(p)).rejects.toMatchObject({code:'conflict'});
    await expect(s.remove(p.id,p.revision)).rejects.toMatchObject({code:'conflict'});
    expect((await s.restore()).unrestorableCount).toBe(1);s.close();
  });
  it('takes policy time again inside queued transaction and never restores future metadata after clock rollback',async()=>{
    let now=start;const s=await isolatedOpen(new IDBFactory(),()=>now),p=await prepare();await s.preserve(p);now--;
    await expect(s.restore()).rejects.toMatchObject({code:'clock-rollback'});await expect(s.preserve(p)).rejects.toMatchObject({code:'clock-rollback'});s.close();
  });

  it('never exposes mutable stored bytes through preparation or restore',async()=>{
    const source=new Uint8Array([1,2,3]);const b=new Blob([source]);const s=await isolatedOpen(new IDBFactory(),()=>start);
    const token=await prepareCompletedDraft({preserve:true,blob:b,durationSeconds:1},start);source.fill(9);await s.preserve(token);
    const first=(await s.restore()).drafts[0];expect(Object.keys(first)).not.toContain('bytes');expect(Object.keys(token).sort()).toEqual(['id','revision']);
    new Uint8Array(await first.blob.arrayBuffer()).fill(8);
    expect(Array.from(new Uint8Array(await (await s.restore()).drafts[0].blob.arrayBuffer()))).toEqual([1,2,3]);await s.preserve(token);s.close();
  });
  it('requires explicit opt-in and validates actual Blob plus limits before touching IDB',async()=>{
    await expect(prepareCompletedDraft({preserve:false,blob:blob(),durationSeconds:1} as any,start)).rejects.toMatchObject({code:'invalid'});
    for(const b of [new Blob([]),new Blob([new Uint8Array(POLICY.maxBytes+1)]),{size:1,type:'audio/webm'}]) await expect(prepareCompletedDraft({preserve:true,blob:b as Blob,durationSeconds:1},start)).rejects.toMatchObject({code:'invalid'});
    for(const d of [0,-1,301,NaN,Infinity]) await expect(prepareCompletedDraft({preserve:true,blob:blob(),durationSeconds:d},start)).rejects.toMatchObject({code:'invalid'});
    await expect(prepareCompletedDraft({preserve:true,blob:new Blob([new Uint8Array(POLICY.maxBytes)]),durationSeconds:300},start)).resolves.toHaveProperty('id');
  });
  it('restores non-consumingly and preserves exact bytes without format claims',async()=>{
    const s=await isolatedOpen(new IDBFactory(),()=>start);const p=await prepare();
    await s.preserve(p);const first=await s.restore();const second=await s.restore();
    expect(await first.drafts[0].blob.text()).toBe('synthetic bytes only');expect(second.drafts[0].expiresAt).toBe(start+POLICY.ttlMs);expect(first.drafts[0].mimeType).toBe('application/x-synthetic');s.close();
  });
  it('enforces capacity atomically across three connections, never evicts',async()=>{
    const f=new IDBFactory();const stores=await Promise.all([0,1,2].map(()=>isolatedOpen(f,()=>start)));
    const tokens=await Promise.all([prepare(),prepare(),prepare()]);
    const results=await Promise.allSettled(stores.map((s,i)=>s.preserve(tokens[i])));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    expect((await stores[0].restore()).drafts).toHaveLength(2);stores.forEach(s=>s.close());
  });
  it('reconciles same immutable identity after discarded acknowledgment, including another connection',async()=>{
    const f=new IDBFactory(),a=await isolatedOpen(f,()=>start),b=await isolatedOpen(f,()=>start);const p=await prepare();
    expect(Object.isFrozen(p)).toBe(true);await a.preserve(p);await b.preserve(p);await a.preserve(p);
    expect((await b.restore()).drafts).toHaveLength(1);await expect(a.preserve({...p})).rejects.toMatchObject({code:'invalid'});a.close();b.close();
  });
  it('requires revision-targeted deletion and leaves other draft intact',async()=>{
    const s=await isolatedOpen(new IDBFactory(),()=>start);const p=await prepare(),q=await prepare();await s.preserve(p);await s.preserve(q);
    await expect(s.remove(p.id,q.revision)).rejects.toMatchObject({code:'conflict'});expect(await s.remove(p.id,p.revision)).toBe(true);expect(await s.remove(p.id,p.revision)).toBe(false);expect((await s.restore()).drafts[0].id).toBe(q.id);s.close();
  });
  it('expires from first preservation request, does not refresh restore/retry, cleans only on access',async()=>{
    let now=start;const f=new IDBFactory(),s=await isolatedOpen(f,()=>now);const p=await prepare();await s.preserve(p);
    now+=POLICY.ttlMs-1;await s.restore();await s.preserve(p);expect((await s.restore()).drafts[0].expiresAt).toBe(start+POLICY.ttlMs);
    now++;expect((await s.restore()).drafts).toHaveLength(0);await expect(s.preserve(p)).rejects.toMatchObject({code:'expired'});s.close();
  });
  it('does not restore or silently delete unknown, corrupt, future or hash-mismatched rows',async()=>{
    const f=new IDBFactory();let now=start;const s=await isolatedOpen(f,()=>now);const p=await prepare();await s.preserve(p);const r=await stored((await s.restore()).drafts[0]);
    const invalids=[{...r,schema:2},{...r,size:r.size+1},{...r,mimeType:'WRONG'},{...r,createdAt:start+1,expiresAt:start+1+POLICY.ttlMs},{...r,sha256:'0'.repeat(64)},{...r,extra:true},{...r,revision:new String(r.revision)},{...r,sha256:new String(r.sha256)},{...r,revision:[r.revision]},{...r,revision:{}},{...r,sha256:[r.sha256]},{...r,sha256:{}},{...r,mimeType:new String(r.mimeType)},{...r,mimeType:[r.mimeType]},{...r,mimeType:{}},{...r,createdAt:new Number(r.createdAt)},{...r,expiresAt:[r.expiresAt]},{...r,durationSeconds:new Number(r.durationSeconds)},{...r,size:new Number(r.size)},{...r,schema:new Number(1)}];
    for(const bad of invalids){await raw(f,store=>store.put(bad));const out=await s.restore();expect(out.drafts).toHaveLength(0);expect(out.unrestorableCount).toBe(1);}
    now=start+POLICY.ttlMs+1;expect((await s.restore()).unrestorableCount).toBe(1);
    await raw(f,store=>store.put({...r,sha256:'0'.repeat(64)}));expect((await s.restore()).unrestorableCount).toBe(1);s.close();
  });
  it('unknown rows conservatively occupy capacity',async()=>{
    const f=new IDBFactory(),s=await isolatedOpen(f,()=>start);await raw(f,store=>{store.add({id:'unknown-a'});store.add({id:'unknown-b'});});
    await expect(s.preserve(await prepare())).rejects.toMatchObject({code:'capacity'});expect((await s.restore()).unrestorableCount).toBe(2);s.close();
  });
  it('request success followed by abort does not report save success or lose previous data',async()=>{
    const f=new IDBFactory(),s=await isolatedOpen(f,()=>start),p=await prepare(),q=await prepare();await s.preserve(p);
    const original=IDBObjectStore.prototype.add;
    const spy=vi.spyOn(IDBObjectStore.prototype,'add').mockImplementation(function(this:IDBObjectStore,...args:any[]){const req=original.apply(this,args as any);req.addEventListener('success',()=>this.transaction.abort());return req;});
    try {await expect(s.preserve(q)).rejects.toMatchObject({code:'aborted'});}finally{spy.mockRestore();}
    expect((await s.restore()).drafts.map(d=>d.id)).toEqual([p.id]);await s.preserve(q);expect((await s.restore()).drafts).toHaveLength(2);s.close();
  });
  it('quota-like add failure rolls back expiry cleanup and retains caller Blob',async()=>{
    const f=new IDBFactory();let now=start;const s=await isolatedOpen(f,()=>now),p=await prepare();await s.preserve(p);now+=POLICY.ttlMs;const b=blob(),q=await prepareCompletedDraft({preserve:true,blob:b,durationSeconds:1},now);
    const spy=vi.spyOn(IDBObjectStore.prototype,'add').mockImplementation(()=>{throw new DOMException('synthetic quota','QuotaExceededError');});
    try {await expect(s.preserve(q)).rejects.toHaveProperty('name','QuotaExceededError');}finally{spy.mockRestore();}
    let count=0;await raw(f,store=>{const req=store.count();req.onsuccess=()=>{count=req.result;};});expect(count).toBe(1);expect(await b.text()).toBe('synthetic bytes only');await s.preserve(q);expect((await s.restore()).drafts[0].id).toBe(q.id);s.close();
  });
  it('rejects storage denial without mutating caller data',async()=>{
    const f={open(){throw new DOMException('denied','SecurityError');}} as unknown as IDBFactory;
    await expect(isolatedOpen(f)).rejects.toMatchObject({code:'unavailable'});
  });
  it('closes on version change, never keeps blocking upgrades',async()=>{
    const f=new IDBFactory(),s=await isolatedOpen(f,()=>start);await s.preserve(await prepare());
    await new Promise<void>((res,rej)=>{const req=f.open(DATABASE,3);req.onsuccess=()=>{req.result.close();res();};req.onerror=()=>rej(req.error);});
    await expect(s.restore()).rejects.toMatchObject({code:'closed'});
  });
});
