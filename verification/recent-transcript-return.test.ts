import {afterEach,expect,it,vi} from 'vitest';
import {recentTranscriptReturn,type RecentTranscriptReturn} from '../candidate/src/components/recent-transcript-return';
import {ExternalTranscriptionSource} from '../candidate/src/components/external-transcription-source';
import {subscribeUnsavedHistory,unsavedHistoryEntryKey,writeUnsavedHistory} from '../candidate/src/components/unsaved-work';
// SOURCE-ONLY: these tests have not been executed in this overlay.
const scope='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const context=():RecentTranscriptReturn=>({transcriptStoreId:scope,offset:10,statuses:['interrupted'],dates:{createdFrom:'2024-02-29',createdThrough:'2024-02-29'},origin:'recording-draft'});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();history.replaceState(null,'','/');});
it('copies only bounded committed preferences, not unrelated fields or mutable arrays',()=>{
 const original={...context(),rows:[{text:'synthetic excluded text'}],token:'synthetic excluded field'};const result=recentTranscriptReturn(original)!;
 expect(Object.keys(result).sort()).toEqual(['dates','offset','origin','statuses','transcriptStoreId']);original.statuses.push('failed');original.dates.createdFrom='2025-01-01';expect(result).toEqual(context());
});
it.each([-10,1,1001,Infinity,NaN])('rejects invalid paging %s',offset=>{expect(recentTranscriptReturn({...context(),offset})).toBeNull();});
it('rejects invalid ranges, sources, origin and status and accepts bounded endpoints',()=>{
 expect(recentTranscriptReturn({...context(),dates:{createdFrom:'2024-02-30',createdThrough:''}})).toBeNull();
 expect(recentTranscriptReturn({...context(),dates:{createdFrom:'2025-01-01',createdThrough:'2024-02-29'}})).toBeNull();
 expect(recentTranscriptReturn({...context(),transcriptStoreId:'invalid'})).toBeNull();
 expect(recentTranscriptReturn({...context(),origin:'invalid' as never})).toBeNull();
 expect(recentTranscriptReturn({...context(),statuses:['interrupted','interrupted']})).toBeNull();
 expect(recentTranscriptReturn({...context(),offset:1000})).not.toBeNull();
});
it.each([other,null])('expected source mismatch %s is blocked before jobs and remains blocked on retry',async store=>{
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({transcriptionStoreId:store}),{headers:store?{'X-Transcription-Store-Id':store}:{}}));vi.stubGlobal('fetch',fetch);
 const source=new ExternalTranscriptionSource(scope),request={signal:new AbortController().signal,current:()=>true};
 await expect(source.read('/api/local-asr/jobs?offset=10',request)).rejects.toThrow();expect(source.blocked).toBe(true);expect(fetch).toHaveBeenCalledTimes(1);
 await expect(source.read('/api/local-asr/jobs?offset=0',request)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
it('matching expected identity is freshly discovered and used for the jobs header',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({transcriptionStoreId:scope}),{headers:{'X-Transcription-Store-Id':scope}})).mockResolvedValueOnce(new Response(JSON.stringify({jobs:[]}),{headers:{'X-Transcription-Store-Id':scope}}));vi.stubGlobal('fetch',fetch);
 const result=await new ExternalTranscriptionSource(scope).read('/api/local-asr/jobs?offset=10',{signal:new AbortController().signal,current:()=>true});
 expect(result.transcriptStoreId).toBe(scope);expect(fetch.mock.calls[0][0]).toBe('/api/local-asr/identity');expect(fetch.mock.calls[1][1].headers).toEqual({'X-Transcription-Store-Id':scope});
});
it('read-only history accessor does not seed history and refuses foreign/transient positions',()=>{
 history.replaceState(null,'','/?page=tasks');const replace=vi.spyOn(history,'replaceState'),push=vi.spyOn(history,'pushState');
 expect(unsavedHistoryEntryKey()).toBeNull();expect(replace).not.toHaveBeenCalled();expect(push).not.toHaveBeenCalled();
 const release=subscribeUnsavedHistory(()=>{});
 try {const original=unsavedHistoryEntryKey();expect(original).not.toBeNull();writeUnsavedHistory('/?page=files');expect(unsavedHistoryEntryKey()).not.toBe(original);history.replaceState(null,'','/?page=tasks');expect(unsavedHistoryEntryKey()).toBeNull();}
 finally {release();}
});
