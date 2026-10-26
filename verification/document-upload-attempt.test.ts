import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DOCUMENT_UPLOAD_ATTEMPT_TIMEOUT_MS,DocumentUploadAttemptTimeoutError,runDocumentUploadAttempt} from '../candidate/src/components/document-upload-attempt';

// Authored source-only regressions. No network, app launch or real document content.
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>vi.useRealTimers());
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j});return {promise,resolve,reject};}

it('expires an uncooperative wait and aborts only its own controller',async()=>{
 const own=new AbortController(),other=new AbortController(),pending=deferred<void>();
 const result=runDocumentUploadAttempt(own,()=>pending.promise).catch(error=>error);
 await vi.advanceTimersByTimeAsync(DOCUMENT_UPLOAD_ATTEMPT_TIMEOUT_MS-1);
 expect(own.signal.aborted).toBe(false);
 await vi.advanceTimersByTimeAsync(1);
 expect(await result).toBeInstanceOf(DocumentUploadAttemptTimeoutError);
 expect(own.signal.aborted).toBe(true);expect(other.signal.aborted).toBe(false);expect(vi.getTimerCount()).toBe(0);
 pending.resolve();await Promise.resolve();expect(await result).toBeInstanceOf(DocumentUploadAttemptTimeoutError);
});

it.each(['resolve','reject'] as const)('clears the deadline after ordinary %s',async outcome=>{
 const own=new AbortController(),pending=deferred<string>(),failure=new Error('synthetic failure');
 const result=runDocumentUploadAttempt(own,()=>pending.promise).catch(error=>error);
 if(outcome==='resolve')pending.resolve('synthetic value');else pending.reject(failure);
 expect(await result).toBe(outcome==='resolve'?'synthetic value':failure);expect(vi.getTimerCount()).toBe(0);
 await vi.advanceTimersByTimeAsync(DOCUMENT_UPLOAD_ATTEMPT_TIMEOUT_MS*2);expect(own.signal.aborted).toBe(false);
});

it('external abort settles without waiting for transport and does not become a timeout',async()=>{
 const own=new AbortController(),pending=deferred<void>();
 const result=runDocumentUploadAttempt(own,()=>pending.promise).catch(error=>error);own.abort();
 expect(await result).toMatchObject({name:'AbortError'});expect(vi.getTimerCount()).toBe(0);
 pending.reject(new Error('synthetic late rejection'));await Promise.resolve();
 expect(await result).not.toBeInstanceOf(DocumentUploadAttemptTimeoutError);
});

it('does not start work for an already stopped controller',async()=>{
 const own=new AbortController(),work=vi.fn(async()=>{});own.abort();
 await expect(runDocumentUploadAttempt(own,work)).rejects.toMatchObject({name:'AbortError'});
 expect(work).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});

it('cleans up when work throws synchronously',async()=>{
 const own=new AbortController(),failure=new Error('synthetic setup failure');
 await expect(runDocumentUploadAttempt(own,()=>{throw failure;})).rejects.toBe(failure);
 expect(vi.getTimerCount()).toBe(0);expect(own.signal.aborted).toBe(false);
});
