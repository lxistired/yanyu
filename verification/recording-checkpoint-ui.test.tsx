import {StrictMode} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {RecordingDrafts,type RecordingServices} from '../candidate/src/components/RecordingDrafts';
import type {CaptureSnapshot} from '../candidate/src/recording/controller.mjs';
import {createRecordingClockGuard} from '../candidate/src/recording/recording-draft-store';
vi.mock('../candidate/src/recording/validate-wav',()=>({isOwnedPcmWav:async()=>true}));
const deferred=()=>{let resolve!:(value?:any)=>void,reject!:(value?:any)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const limits={maxDurationSeconds:300,maxWavBytes:16777216};
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name,exact:true}));
function fixture(){
 let now=1000;
 let state:CaptureSnapshot={state:'idle',artifact:null,error:null,reason:null};
 let listener:(s:CaptureSnapshot)=>void=()=>{};
 const emit=(patch:Partial<CaptureSnapshot>)=>{state={...state,...patch};listener(state);};
 const controller={getSnapshot:()=>state,subscribe:vi.fn(fn=>{listener=fn;return()=>{listener=()=>{};};}),start:vi.fn(async()=>emit({state:'requesting',persistenceStatus:'active'})),stop:vi.fn(()=>emit({state:'stopping'})),cancel:vi.fn(),dispose:vi.fn()};
 const identity={schema:2 as const,id:'11111111-1111-4111-8111-111111111111',writerEpoch:'22222222-2222-4222-8222-222222222222'};
 const receipt={...identity,revision:2,result:'committed' as const,status:'sealed' as const,committedFrames:16000,committedSegmentCount:1,committedPcmBytes:32000,createdAt:1000,expiresAt:86401000,lastCommittedAt:1000,limits:{maxFrames:4800000,maxWavBytes:16777216,maxDurationSeconds:300}};
 const item={...receipt,completion:'partial-unconfirmed' as const,status:'capturing' as const,terminal:null,durationSeconds:1,size:32044,mimeType:'audio/wav' as const,sha256:'0'.repeat(64),blob:new Blob([new Uint8Array(32044)],{type:'audio/wav'})};
 const store={reserveRecording:vi.fn(async()=>({writer:identity,receipt})),restore:vi.fn(async()=>({drafts:[],unrestorableCount:0})),restoreCheckpoints:vi.fn(async()=>({checkpoints:[item],unrestorableCount:0,emptyReservationCount:0,emptyReservations:[],integrityBlocked:false})),removeCheckpoint:vi.fn(async()=>({removed:true,absent:false})),inspectCheckpoint:vi.fn(async()=>receipt),preserve:vi.fn(),close:vi.fn()};
 const session={sink:{identity,expiresAt:receipt.expiresAt,limits:receipt.limits,append:vi.fn(),finish:vi.fn()},getReceipt:()=>receipt,reconcile:vi.fn(async()=>receipt)};
 const token={id:identity.id,writerEpoch:identity.writerEpoch};
 const runtime={createController:vi.fn(()=>controller),openStore:vi.fn(async()=>store),prepare:vi.fn(),prepareReservation:vi.fn(()=>token),createSession:vi.fn(()=>session),now:()=>now,clockGuard:createRecordingClockGuard()} as unknown as RecordingServices;
 const onSelect=vi.fn(()=>true);
 const ui=(policy=limits)=><RecordingDrafts limits={policy} disabled={false} runtime={runtime} onSelect={onSelect}/>;
 const opt=()=>fireEvent.click(screen.getByRole('checkbox'));
 const start=async()=>{opt();click('开始录音');await waitFor(()=>expect(controller.start).toHaveBeenCalledOnce());};
 const ready=()=>act(()=>emit({state:'ready',artifact:new Uint8Array(32044),frames:16000,receivedFrames:16000,persistedFrames:16000,persistenceStatus:'sealed'}));
 return {controller,emit,store,session,runtime,onSelect,ui,opt,start,ready,item,receipt,token,setNow:(value:number)=>{now=value;}};
}
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('StrictMode mount is inert, opt-in starts unchecked and reserves before any controller/media start',async()=>{
 const f=fixture(),reservation=deferred();f.store.reserveRecording.mockReturnValue(reservation.promise);
 render(<StrictMode>{f.ui()}</StrictMode>);expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);expect(f.runtime.openStore).not.toHaveBeenCalled();expect(f.runtime.createController).not.toHaveBeenCalled();
 f.opt();click('开始录音');click('开始录音');await waitFor(()=>expect(f.store.reserveRecording).toHaveBeenCalledOnce());expect(f.runtime.createController).not.toHaveBeenCalled();
 await act(async()=>reservation.resolve({writer:f.receipt,receipt:f.receipt}));expect(f.runtime.createController).toHaveBeenCalledWith({checkpointSink:f.session.sink});expect(f.controller.start).toHaveBeenCalledWith(limits);expect(f.onSelect).not.toHaveBeenCalled();
});
it('failed reservation does not fallback and explicit retry keeps exact prepared token and frozen limits',async()=>{
 const f=fixture();f.store.reserveRecording.mockRejectedValueOnce({code:'uncertain',outcome:'unknown'});render(f.ui());f.opt();click('开始录音');await screen.findByRole('alert');expect(f.controller.start).not.toHaveBeenCalled();
 click('开始录音');await waitFor(()=>expect(f.controller.start).toHaveBeenCalledOnce());expect(f.runtime.prepareReservation).toHaveBeenCalledOnce();expect(f.store.reserveRecording.mock.calls[1][0]).toBe(f.store.reserveRecording.mock.calls[0][0]);
});
it('unmount during reservation never starts late media or changes a newly mounted component',async()=>{
 const f=fixture(),pending=deferred();f.store.reserveRecording.mockReturnValue(pending.promise);const view=render(f.ui());f.opt();click('开始录音');await waitFor(()=>expect(f.store.reserveRecording).toHaveBeenCalledOnce());view.unmount();const b=fixture();render(b.ui());
 await act(async()=>pending.resolve({writer:f.receipt,receipt:f.receipt}));expect(f.controller.start).not.toHaveBeenCalled();expect(b.controller.start).not.toHaveBeenCalled();expect(f.onSelect).not.toHaveBeenCalled();
});
it('received progress is not persisted progress; Stop never removes or duplicates a completed Blob',async()=>{
 const f=fixture();render(f.ui());await f.start();act(()=>f.emit({state:'recording',receivedFrames:32000,persistedFrames:16000}));expect(screen.getByText(/已接收 2.00 秒；已确认保存 1.00 秒/)).toBeTruthy();
 click('停止录音');expect(f.store.removeCheckpoint).not.toHaveBeenCalled();f.ready();expect(screen.queryByText('保留到本机草稿架并清空当前录音')).toBeNull();expect(f.store.preserve).not.toHaveBeenCalled();
 click('清空当前录音并保留本机分段');expect(f.store.removeCheckpoint).not.toHaveBeenCalled();expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
});
it('explicit shelf recovery is read-only and selected partial file retains expiry/provenance without media/upload',async()=>{
 const f=fixture();render(f.ui());click('读取或刷新本机草稿架');await screen.findByText('选用此分段快照作为待上传文件');expect(f.runtime.createController).not.toHaveBeenCalled();expect(f.onSelect).not.toHaveBeenCalled();
 click('选用此分段快照作为待上传文件');const selection=f.onSelect.mock.calls[0][0];expect(selection.file.name).toBe('recording-recovered-partial.wav');expect(selection.expiresAt).toBe(f.item.expiresAt);expect(selection.checkpoint).toBe(true);expect(f.store.removeCheckpoint).not.toHaveBeenCalled();
});
it.each(['expired','rollback'])('checkpoint selection rejects %s before passing a file',async reason=>{
 const f=fixture();render(f.ui());click('读取或刷新本机草稿架');await screen.findByText('选用此分段快照作为待上传文件');f.runtime.clockGuard!.observe(1000);f.setNow(reason==='expired'?f.item.expiresAt:999);click('选用此分段快照作为待上传文件');expect(f.onSelect).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toBeTruthy();
});
it('discard stops first and clears memory only after acknowledged exact-revision delete',async()=>{
 const f=fixture(),pending=deferred();render(f.ui());await f.start();vi.spyOn(window,'confirm').mockReturnValue(true);click('放弃当前录音');expect(f.controller.stop).toHaveBeenCalledOnce();expect(f.store.removeCheckpoint).not.toHaveBeenCalled();f.ready();f.store.removeCheckpoint.mockReturnValue(pending.promise);
 click('核对并删除本次分段草稿');await waitFor(()=>expect(f.store.removeCheckpoint).toHaveBeenCalledWith({schema:2,id:f.receipt.id,writerEpoch:f.receipt.writerEpoch,revision:f.receipt.revision}));expect(f.controller.dispose).not.toHaveBeenCalled();await act(async()=>pending.resolve({removed:true,absent:false}));expect(f.controller.dispose).toHaveBeenCalledOnce();expect(f.onSelect).not.toHaveBeenCalled();
});
it('stale revision conflicts retain current recording and never retry using refreshed shelf revision',async()=>{
 const f=fixture();render(f.ui());await f.start();f.ready();vi.spyOn(window,'confirm').mockReturnValue(true);click('放弃已完成录音');act(()=>f.emit({state:'ready'}));f.store.removeCheckpoint.mockRejectedValue({code:'conflict',outcome:'not-started'});
 click('核对并删除本次分段草稿');await screen.findByRole('alert');expect(f.controller.dispose).not.toHaveBeenCalled();expect(f.store.removeCheckpoint).toHaveBeenCalledOnce();expect(f.store.inspectCheckpoint).not.toHaveBeenCalled();
});
it.each([true,false])('unknown delete only reports absence when exact inspection proves it: absent=%s',async absent=>{
 const f=fixture();f.store.removeCheckpoint.mockRejectedValue({code:'uncertain',outcome:'unknown'});f.store.inspectCheckpoint.mockResolvedValue(absent?null:f.receipt as any);render(f.ui());click('读取或刷新本机草稿架');await screen.findByText('删除此分段草稿');vi.spyOn(window,'confirm').mockReturnValue(true);click('删除此分段草稿');await waitFor(()=>expect(f.store.inspectCheckpoint).toHaveBeenCalledWith({schema:2,id:f.item.id,writerEpoch:f.item.writerEpoch}));
 if(absent)await screen.findByText('已核对该分段草稿不再存在。');else await screen.findByRole('alert');expect(f.store.removeCheckpoint).toHaveBeenCalledOnce();expect(f.runtime.createController).not.toHaveBeenCalled();
});
it('unresolved permission promise does not lock stopped checkpoint controls',async()=>{
 const f=fixture(),pending=deferred();f.controller.start.mockImplementation(()=>{f.emit({state:'requesting'});return pending.promise;});render(f.ui());await f.start();act(()=>f.emit({state:'cancelled'}));expect((screen.getByRole('button',{name:'结束本次录音并保留本机分段'}) as HTMLButtonElement).disabled).toBe(false);click('结束本次录音并保留本机分段');expect(f.controller.dispose).toHaveBeenCalledOnce();expect(f.store.removeCheckpoint).not.toHaveBeenCalled();
});
it('tighter limits arriving during reservation cannot start using obsolete higher limits',async()=>{
 const f=fixture(),pending=deferred();f.store.reserveRecording.mockReturnValue(pending.promise);const view=render(f.ui());f.opt();click('开始录音');await waitFor(()=>expect(f.store.reserveRecording).toHaveBeenCalledOnce());view.rerender(f.ui({...limits,maxDurationSeconds:1}));await act(async()=>pending.resolve({writer:f.receipt,receipt:f.receipt}));expect(f.controller.start).not.toHaveBeenCalled();expect(screen.getByRole('alert').textContent).toContain('限制已收紧');
});
it('explicitly ending a failed checkpoint releases closed connection and fences old capture callbacks',async()=>{
 const f=fixture();render(f.ui());await f.start();const oldListener=f.controller.subscribe.mock.calls[0][0];act(()=>f.emit({state:'error',persistenceStatus:'failed',error:'persistence-failed'}));click('结束本次录音并保留本机分段');expect(f.store.close).toHaveBeenCalledOnce();
 act(()=>oldListener({state:'ready',artifact:new Uint8Array(32044),frames:16000,error:null,reason:null,persistedFrames:16000,persistenceStatus:'sealed'}));expect(screen.getByText('录音状态：未开始')).toBeTruthy();click('读取或刷新本机草稿架');await waitFor(()=>expect(f.runtime.openStore).toHaveBeenCalledTimes(2));expect(f.onSelect).not.toHaveBeenCalled();
});
it('late unknown-delete failure after unmount cannot initiate inspection or refresh',async()=>{
 const f=fixture(),pending=deferred();f.store.removeCheckpoint.mockReturnValue(pending.promise);const view=render(f.ui());click('读取或刷新本机草稿架');await screen.findByText('删除此分段草稿');vi.spyOn(window,'confirm').mockReturnValue(true);click('删除此分段草稿');await waitFor(()=>expect(f.store.removeCheckpoint).toHaveBeenCalledOnce());view.unmount();await act(async()=>pending.reject({code:'uncertain',outcome:'unknown'}));expect(f.store.inspectCheckpoint).not.toHaveBeenCalled();expect(f.store.restoreCheckpoints).toHaveBeenCalledOnce();
});
function emptyShelf(f:ReturnType<typeof fixture>){
 const item={schema:2 as const,id:f.receipt.id,writerEpoch:f.receipt.writerEpoch,revision:0,createdAt:1000,expiresAt:86401000,status:'capturing' as const};
 f.store.restoreCheckpoints.mockResolvedValue({checkpoints:[],unrestorableCount:0,emptyReservationCount:1,emptyReservations:[item],integrityBlocked:false} as any);
 return item;
}
it('reload-style empty reservation cleanup has no writer/media and requires exact snapshot consent',async()=>{
 const f=fixture(),item=emptyShelf(f);render(f.ui());click('读取或刷新本机草稿架');await screen.findByText('删除此分段预留');expect(f.runtime.createController).not.toHaveBeenCalled();expect(f.runtime.createSession).not.toHaveBeenCalled();expect(f.onSelect).not.toHaveBeenCalled();
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);click('删除此分段预留');expect(f.store.removeCheckpoint).not.toHaveBeenCalled();confirm.mockReturnValue(true);click('删除此分段预留');await waitFor(()=>expect(f.store.removeCheckpoint).toHaveBeenCalledWith({schema:2,id:item.id,writerEpoch:item.writerEpoch,revision:0}));expect(confirm.mock.calls[1][0]).toContain('内容可能已变化');expect(confirm.mock.calls[1][0]).toContain('中断该页面的分段保存');expect(f.session.reconcile).not.toHaveBeenCalled();
});
it('own empty reservation requires stopped capture, then cleanup bypasses hung preparation without declaring append absent',async()=>{
 const f=fixture(),item=emptyShelf(f),hung=deferred();f.session.reconcile.mockReturnValue(hung.promise);render(f.ui());await f.start();click('读取或刷新本机草稿架');await screen.findByText('删除此分段预留');expect((screen.getByRole('button',{name:'删除此分段预留'}) as HTMLButtonElement).disabled).toBe(true);
 act(()=>f.emit({state:'error',error:'persistence-failed',persistenceStatus:'uncertain'}));vi.spyOn(window,'confirm').mockReturnValue(true);click('删除此分段预留');await waitFor(()=>expect(f.store.removeCheckpoint).toHaveBeenCalledWith({schema:2,id:item.id,writerEpoch:item.writerEpoch,revision:0}));expect(f.session.reconcile).not.toHaveBeenCalled();await screen.findByText('已核对该分段预留不再存在。');expect(screen.getByText('录音状态：未开始')).toBeTruthy();expect(f.onSelect).not.toHaveBeenCalled();
});
it('empty reservation changed revision conflict never adopts refreshed target or reports deletion',async()=>{
 const f=fixture();emptyShelf(f);f.store.removeCheckpoint.mockRejectedValue({code:'conflict',outcome:'not-started'});render(f.ui());click('读取或刷新本机草稿架');await screen.findByText('删除此分段预留');vi.spyOn(window,'confirm').mockReturnValue(true);click('删除此分段预留');await screen.findByRole('alert');expect(f.store.removeCheckpoint).toHaveBeenCalledOnce();expect(f.store.restoreCheckpoints).toHaveBeenCalledOnce();expect(f.store.inspectCheckpoint).not.toHaveBeenCalled();expect(screen.queryByText('已核对该分段预留不再存在。')).toBeNull();
});
it('confirmed empty deletion retires a timed-out local reservation without replaying its token',async()=>{
 const f=fixture();emptyShelf(f);f.store.reserveRecording.mockRejectedValueOnce({code:'uncertain',outcome:'unknown'});render(f.ui());f.opt();click('开始录音');await screen.findByRole('alert');click('读取或刷新本机草稿架');await screen.findByText('删除此分段预留');vi.spyOn(window,'confirm').mockReturnValue(true);click('删除此分段预留');await screen.findByText('已核对该分段预留不再存在。');expect(screen.queryByText('结束本次准备并保留可能的预留')).toBeNull();expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);expect(f.store.reserveRecording).toHaveBeenCalledOnce();expect(f.controller.start).not.toHaveBeenCalled();
});
it('uncertain empty deletion does not claim removal until exact no-orphan inspection confirms absence',async()=>{
 const f=fixture(),item=emptyShelf(f);f.store.removeCheckpoint.mockRejectedValue({code:'uncertain',outcome:'unknown'});f.store.inspectCheckpoint.mockResolvedValue(f.receipt);render(f.ui());click('读取或刷新本机草稿架');await screen.findByText('删除此分段预留');vi.spyOn(window,'confirm').mockReturnValue(true);click('删除此分段预留');await screen.findByRole('alert');expect(f.store.inspectCheckpoint).toHaveBeenCalledWith({schema:2,id:item.id,writerEpoch:item.writerEpoch});expect(f.store.removeCheckpoint).toHaveBeenCalledOnce();expect(screen.queryByText('已核对该分段预留不再存在。')).toBeNull();
});
it('own empty cleanup discloses clearing an unpersisted ready WAV, and declined consent keeps it',async()=>{
 const f=fixture();emptyShelf(f);render(f.ui());await f.start();f.ready();act(()=>f.emit({persistedFrames:0,persistenceStatus:'uncertain'}));click('读取或刷新本机草稿架');await screen.findByText('删除此分段预留');const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);click('删除此分段预留');expect(confirm.mock.calls[0][0]).toContain('删除确认后也会清空本次内存中的录音');expect(confirm.mock.calls[0][0]).toContain('删除未确认时保留当前内存录音');expect(f.store.removeCheckpoint).not.toHaveBeenCalled();expect(f.controller.dispose).not.toHaveBeenCalled();expect(screen.getByText('录音状态：录音已完成')).toBeTruthy();
});
it('failed own empty cleanup retains ready WAV despite retiring capture callbacks',async()=>{
 const f=fixture();emptyShelf(f);f.store.removeCheckpoint.mockRejectedValue({code:'conflict',outcome:'not-started'});render(f.ui());await f.start();f.ready();click('读取或刷新本机草稿架');await screen.findByText('删除此分段预留');vi.spyOn(window,'confirm').mockReturnValue(true);click('删除此分段预留');await screen.findByRole('alert');expect(screen.getByText('录音状态：录音已完成')).toBeTruthy();click('选用当前录音作为待上传文件');expect(f.onSelect).toHaveBeenCalledOnce();expect(f.onSelect.mock.calls[0][0].file.size).toBe(32044);expect(screen.queryByText('已核对该分段预留不再存在。')).toBeNull();
});
