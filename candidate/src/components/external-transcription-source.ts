import {STORE_HEADER, StoreContinuityError, validStoreId} from './transcription-store-session';

type Request = {signal: AbortSignal; current: () => boolean};
/** Fresh read-only entry discovery, not proof of a historical reference or a snapshot.
 * One mounted consumer owns this instance; only explicit source reload replaces it. */
export class ExternalTranscriptionSource {
 private scope: string|null = null;
 private stopped = false;
 // Return context is an expected identity, not permission to skip fresh discovery.
 constructor(private readonly expectedScope: string|null = null) {
  if(expectedScope!==null&&!validStoreId(expectedScope))throw new StoreContinuityError();
 }
 get blocked() {return this.stopped;}
 assertActive(scope: string) {if(this.stopped || this.scope !== scope) throw new StoreContinuityError();}
 private stop(): never {this.stopped=true;throw new StoreContinuityError();}
 async read(url: string, request: Request): Promise<{data: unknown; transcriptStoreId: string}> {
  if(this.stopped) throw new StoreContinuityError();
  if(!/^\/api\/local-asr\/(?:jobs\?|relationships$)/.test(url)) throw Error('Unsupported external transcription route');
  const current=()=>{if(!request.current() || request.signal.aborted)throw new DOMException('Superseded request','AbortError');};
  current();
  if(this.scope === null) {
   const identity=await fetch('/api/local-asr/identity',{method:'GET',signal:request.signal,credentials:'same-origin',cache:'no-store',redirect:'error'});
   current();
   const captured=identity.headers.get(STORE_HEADER);
   if(!identity.ok || !validStoreId(captured) || (this.expectedScope!==null && captured!==this.expectedScope))this.stop();
   const data:unknown=await identity.json().catch(()=>{current();return this.stop();});
   current();
   if(this.stopped || !data || typeof data!=='object' || (data as Record<string,unknown>).transcriptionStoreId!==captured || (this.scope!==null && this.scope!==captured))this.stop();
   this.scope=captured;
  }
  const expected=this.scope;
  this.assertActive(expected);
  const response=await fetch(url,{method:'GET',signal:request.signal,headers:{[STORE_HEADER]:expected},credentials:'same-origin',cache:'no-store',redirect:'error'});
  current();
  const captured=response.headers.get(STORE_HEADER);
  if(!validStoreId(captured) || (this.scope !== null && captured !== this.scope) || response.status===409)this.stop();
  // Bind even a same-source HTTP error; retries may not silently discover another source.
  this.scope=captured;
  this.assertActive(captured);
  if(!response.ok)throw Error(`本地转写来源暂不可用 (${response.status})，请重试`);
  const data:unknown=await response.json();
  current();this.assertActive(captured);
  if(data && typeof data==='object')for(const key of ['transcriptionStoreId','transcriptStoreId','storeScope']) {
   if(key in data && (data as Record<string,unknown>)[key] !== captured)this.stop();
  }
  return {data,transcriptStoreId:captured};
 }
}
