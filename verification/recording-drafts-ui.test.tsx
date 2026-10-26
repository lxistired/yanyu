import {StrictMode} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {RecordingDrafts,type RecordingServices} from '../candidate/src/components/RecordingDrafts';
import type {CaptureSnapshot} from '../candidate/src/recording/controller.mjs';
import {allowLeavingUnsavedWork} from '../candidate/src/components/unsaved-work';
vi.mock('../candidate/src/recording/validate-wav',()=>({isOwnedPcmWav:async()=>true}));
const deferred=()=>{let resolve!:(value?:any)=>void,reject!:(value?:any)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const limits={maxDurationSeconds:300,maxWavBytes:16777216};
function fixture(){
 let state:CaptureSnapshot={state:'idle',artifact:null,error:null,reason:null},listener:(s:CaptureSnapshot)=>void=()=>{};
 const emit=(patch:Partial<CaptureSnapshot>)=>{state={...state,...patch};listener(state);};
 const controller={getSnapshot:()=>state,subscribe:vi.fn(fn=>{listener=fn;return()=>{listener=()=>{};};}),start:vi.fn(async()=>emit({state:'requesting'})),stop:vi.fn(()=>emit({state:'stopping'})),cancel:vi.fn(),dispose:vi.fn()};
 const token={id:'a',revision:'r'};
 const store={restoreCheckpoints:vi.fn(async()=>({checkpoints:[],unrestorableCount:0,emptyReservationCount:0,emptyReservations:[],integrityBlocked:false})),restore:vi.fn(async()=>({drafts:[],unrestorableCount:0})),preserve:vi.fn(async()=>({id:'a',revision:'r',expiresAt:2000})),remove:vi.fn(async()=>true),close:vi.fn()};
 const runtime={createController:vi.fn(()=>controller),openStore:vi.fn(async()=>store),prepare:vi.fn(async()=>token),now:()=>1000} as unknown as RecordingServices;
 const onSelect=vi.fn(()=>true);
 const ui=()=> <RecordingDrafts limits={limits} disabled={false} runtime={runtime} onSelect={onSelect}/>;
 return {controller,emit,store,runtime,onSelect,ui,ready:()=>act(()=>emit({state:'ready',artifact:new Uint8Array(300),frames:128,interrupted:true,reachedLimit:true}))};
}
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name,exact:true}));
const blocked=()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;};
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('mount does not initialize media/store; double Start is synchronous fenced; all active and ready states are guarded',()=>{
 const f=fixture();render(f.ui());expect(f.runtime.createController).not.toHaveBeenCalled();expect(f.runtime.openStore).not.toHaveBeenCalled();expect(blocked()).toBe(false);
 click('开始录音');click('开始录音');expect(f.controller.start).toHaveBeenCalledOnce();expect(f.controller.start).toHaveBeenCalledWith(limits);expect(blocked()).toBe(true);
 for(const state of ['preparing','recording','stopping'] as const){act(()=>f.emit({state}));expect(blocked()).toBe(true);}
 f.ready();expect(screen.getByText(/录音因页面或设备中断/)).toBeTruthy();expect(blocked()).toBe(true);expect(f.onSelect).not.toHaveBeenCalled();
 click('选用当前录音作为待上传文件');expect(f.onSelect.mock.calls[0][0].file.type).toBe('audio/wav');expect(f.store.preserve).not.toHaveBeenCalled();expect(blocked()).toBe(true);
});
it('save A waits for transaction acknowledgment, prevents duplicate saves/start B, then requires a separate Start click',async()=>{
 const f=fixture(),pending=deferred();f.store.preserve.mockReturnValue(pending.promise);render(f.ui());click('开始录音');f.ready();click('保留到本机草稿架并清空当前录音');click('保留到本机草稿架并清空当前录音');
 await waitFor(()=>expect(f.store.preserve).toHaveBeenCalledOnce());click('开始录音');expect(f.controller.start).toHaveBeenCalledOnce();expect(screen.getByText('录音状态：录音已完成')).toBeTruthy();expect(blocked()).toBe(true);
 await act(async()=>pending.resolve());await screen.findByText(/已确认保存到本机草稿架/);expect(f.onSelect).not.toHaveBeenCalled();expect(f.controller.dispose).toHaveBeenCalledOnce();expect(f.controller.start).toHaveBeenCalledOnce();expect(blocked()).toBe(false);
});
it.each(['quota','blocked','closed','capacity'])('failed %s save retains A and retries exact prepared token without overwriting or upload',async(reason)=>{
 const f=fixture();f.store.preserve.mockRejectedValueOnce(Error(reason));render(f.ui());click('开始录音');f.ready();click('保留到本机草稿架并清空当前录音');await screen.findByRole('alert');expect(blocked()).toBe(true);expect(f.controller.dispose).not.toHaveBeenCalled();
 const token=f.store.preserve.mock.calls[0][0];click('保留到本机草稿架并清空当前录音');await screen.findByText(/已确认保存到本机草稿架/);expect(f.runtime.prepare).toHaveBeenCalledOnce();expect(f.store.preserve.mock.calls[1][0]).toBe(token);expect(f.onSelect).not.toHaveBeenCalled();
});
it('late save after unmount cannot clear a newer mounted ready recording or select any file',async()=>{
 const a=fixture(),pending=deferred();a.store.preserve.mockReturnValue(pending.promise);const mounted=render(a.ui());click('开始录音');a.ready();click('保留到本机草稿架并清空当前录音');await waitFor(()=>expect(a.store.preserve).toHaveBeenCalledOnce());mounted.unmount();
 const b=fixture();render(b.ui());click('开始录音');b.ready();await act(async()=>pending.resolve());expect(screen.getByText('录音状态：录音已完成')).toBeTruthy();expect(b.controller.dispose).not.toHaveBeenCalled();expect(a.store.restore).not.toHaveBeenCalled();expect(a.onSelect).not.toHaveBeenCalled();expect(blocked()).toBe(true);
});
it('late storage open is closed after unmount and never starts save',async()=>{
 const f=fixture(),pending=deferred();vi.mocked(f.runtime.openStore).mockReturnValue(pending.promise);const view=render(f.ui());click('读取或刷新本机草稿架');view.unmount();await act(async()=>pending.resolve(f.store));expect(f.store.close).toHaveBeenCalledOnce();expect(f.store.restore).not.toHaveBeenCalled();
});
it('restores non-consumingly; explicit select carries expiry; delete uses only exact selected revision',async()=>{
 const f=fixture();const draft={id:'a',revision:'r',blob:new Blob([new Uint8Array(300)],{type:'audio/wav'}),expiresAt:2000,durationSeconds:.008};f.store.restore.mockResolvedValue({drafts:[draft],unrestorableCount:0} as any);
 render(f.ui());click('读取或刷新本机草稿架');await screen.findByText('选用此草稿作为待上传文件');expect(f.runtime.createController).not.toHaveBeenCalled();expect(f.onSelect).not.toHaveBeenCalled();expect(f.store.remove).not.toHaveBeenCalled();expect(blocked()).toBe(false);
 click('选用此草稿作为待上传文件');expect(f.onSelect.mock.calls[0][0].expiresAt).toBe(2000);expect(f.store.remove).not.toHaveBeenCalled();vi.spyOn(window,'confirm').mockReturnValue(true);click('删除此草稿');await waitFor(()=>expect(f.store.remove).toHaveBeenCalledWith('a','r'));
});
it('loaded draft that expires before select is rejected; denied discard keeps A and owned guard',async()=>{
 const f=fixture();f.store.restore.mockResolvedValue({drafts:[{id:'a',revision:'r',blob:new Blob(['synthetic']),expiresAt:999,durationSeconds:1}],unrestorableCount:0} as any);render(f.ui());click('读取或刷新本机草稿架');await screen.findByText('选用此草稿作为待上传文件');click('选用此草稿作为待上传文件');expect(f.onSelect).not.toHaveBeenCalled();expect(screen.getByRole('alert').textContent).toContain('过期');click('开始录音');f.ready();vi.spyOn(window,'confirm').mockReturnValue(false);click('放弃已完成录音');expect(f.controller.dispose).not.toHaveBeenCalled();expect(allowLeavingUnsavedWork()).toBe(false);cleanup();expect(blocked()).toBe(false);
});
it('sticky closed store is discarded on failure; explicit retry reopens and reuses the same prepared identity',async()=>{
 const f=fixture();f.store.preserve.mockRejectedValue(Error('closed'));
 const replacement={...f.store,preserve:vi.fn(async()=>({id:'a',revision:'r',expiresAt:2000})),close:vi.fn()};
 vi.mocked(f.runtime.openStore).mockResolvedValueOnce(f.store as any).mockResolvedValueOnce(replacement as any);
 render(f.ui());click('开始录音');f.ready();click('保留到本机草稿架并清空当前录音');await screen.findByRole('alert');expect(f.store.close).toHaveBeenCalledOnce();expect(blocked()).toBe(true);
 const identity=f.store.preserve.mock.calls[0][0];click('保留到本机草稿架并清空当前录音');await screen.findByText(/已确认保存到本机草稿架/);expect(f.runtime.openStore).toHaveBeenCalledTimes(2);expect(f.runtime.prepare).toHaveBeenCalledOnce();expect(replacement.preserve).toHaveBeenCalledWith(identity);
});
it('late confirmed delete does not read the shelf or alter a newly mounted recording',async()=>{
 const a=fixture(),pending=deferred();a.store.restore.mockResolvedValue({drafts:[{id:'a',revision:'r',blob:new Blob(['synthetic']),expiresAt:2000,durationSeconds:1}],unrestorableCount:0} as any);a.store.remove.mockReturnValue(pending.promise);const view=render(a.ui());click('读取或刷新本机草稿架');await screen.findByText('删除此草稿');vi.spyOn(window,'confirm').mockReturnValue(true);click('删除此草稿');await waitFor(()=>expect(a.store.remove).toHaveBeenCalledOnce());view.unmount();
 const b=fixture();render(b.ui());click('开始录音');b.ready();await act(async()=>pending.resolve(true));expect(a.store.restore).toHaveBeenCalledOnce();expect(b.controller.dispose).not.toHaveBeenCalled();expect(screen.getByText('录音状态：录音已完成')).toBeTruthy();
});
it('StrictMode remount rehearsal is inert, then explicit capture/save and disposal remain correctly owned',async()=>{
 const f=fixture(),shelf=deferred();f.store.restore.mockReturnValue(shelf.promise);
 const view=render(<StrictMode>{f.ui()}</StrictMode>);expect(f.runtime.createController).not.toHaveBeenCalled();expect(f.runtime.openStore).not.toHaveBeenCalled();click('开始录音');expect(f.controller.start).toHaveBeenCalledOnce();f.ready();click('保留到本机草稿架并清空当前录音');await screen.findByText(/已确认保存到本机草稿架/);expect(f.store.preserve).toHaveBeenCalledOnce();
 // A confirmed preserve is not the end of the subsequent shelf-refresh operation.
 expect(f.store.restore).toHaveBeenCalledOnce();expect((screen.getByRole('button',{name:'开始录音',exact:true}) as HTMLButtonElement).disabled).toBe(true);expect(blocked()).toBe(true);
 await act(async()=>shelf.resolve({drafts:[],unrestorableCount:0}));
 expect((screen.getByRole('button',{name:'开始录音',exact:true}) as HTMLButtonElement).disabled).toBe(false);expect(blocked()).toBe(false);view.unmount();expect(f.store.close).toHaveBeenCalledOnce();
});
it('confirmed save followed by shelf refresh failure is not reported as unconfirmed save',async()=>{
 const f=fixture();f.store.restore.mockRejectedValue(Error('closed'));render(f.ui());click('开始录音');f.ready();click('保留到本机草稿架并清空当前录音');await screen.findByText(/录音已确认保存，但草稿架刷新失败/);expect(screen.getByText('录音状态：未开始')).toBeTruthy();expect(f.store.preserve).toHaveBeenCalledOnce();expect(f.store.close).toHaveBeenCalledOnce();expect(screen.queryByText(/本机草稿操作未获确认/)).toBeNull();expect(blocked()).toBe(false);
});
it('late restore completion after unmount cannot populate a new shelf or activate any recording',async()=>{
 const a=fixture(),pending=deferred();a.store.restore.mockReturnValue(pending.promise);const view=render(a.ui());click('读取或刷新本机草稿架');await waitFor(()=>expect(a.store.restore).toHaveBeenCalledOnce());view.unmount();const b=fixture();render(b.ui());
 await act(async()=>pending.resolve({drafts:[{id:'a',revision:'r',blob:new Blob(['synthetic']),expiresAt:2000,durationSeconds:1}],unrestorableCount:0}));expect(screen.queryByText('选用此草稿作为待上传文件')).toBeNull();expect(b.runtime.createController).not.toHaveBeenCalled();expect(b.runtime.openStore).not.toHaveBeenCalled();expect(a.onSelect).not.toHaveBeenCalled();expect(blocked()).toBe(false);
});
