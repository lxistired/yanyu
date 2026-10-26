import {fixtureStoreHeaders, fixtureStoreUrl} from './transcription-store-fixture';
import {initialUploadAccepted} from './initial-upload-fixture';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {LocalTranscription} from '../candidate/src/components/LocalTranscription';
vi.mock('../candidate/src/components/RecordingDrafts',()=>({RecordingDrafts:({onSelect}:any)=><button onClick={()=>onSelect({file:new File([new Uint8Array(100)],'recording.wav',{type:'audio/wav'}),expiresAt:2000})}>Synthetic recording selection</button>}));
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name,exact:true}));
const ordinary=()=>fireEvent.change(screen.getByLabelText('选择音频文件'),{target:{files:[new File([new Uint8Array(100)],'ordinary.wav',{type:'audio/wav'})]}});
const model={maxSeconds:300,maxBytes:1024,chunkSeconds:30,overlapSeconds:1,deadlineSeconds:500};
async function setup(){
 const f=vi.fn(async(url:string,options?:RequestInit)=>options?.method==='POST'?initialUploadAccepted(options):({headers:fixtureStoreHeaders(),ok:true,status:200,json:async()=>({jobs:[],model,total:0,activeJobCount:0})}));vi.stubGlobal('fetch',f);render(<LocalTranscription/>);await waitFor(()=>expect((screen.getByLabelText('选择音频文件') as HTMLInputElement).disabled).toBe(false));return f;
}
const posts=(f:any)=>f.mock.calls.filter(([,o]:any)=>o?.method==='POST');
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('replacing ordinary File needs owned-selection confirmation; cancellation keeps exact File',async()=>{
 vi.spyOn(Date,'now').mockReturnValue(1000);const f=await setup();ordinary();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);click('Synthetic recording selection');expect(confirm).toHaveBeenCalledOnce();expect(screen.getByText(/待上传：ordinary.wav/)).toBeTruthy();expect(posts(f)).toHaveLength(0);click('上传并本地转写');await waitFor(()=>expect(posts(f)).toHaveLength(1));expect(posts(f)[0][1].body.name).toBe('ordinary.wav');await screen.findByText('查看新提交任务');expect(screen.queryByLabelText('未确认上传核对')).toBeNull();
});
it('loaded draft expiry is checked again before POST; native picker clears provenance',async()=>{
 const now=vi.spyOn(Date,'now').mockReturnValue(1000);const f=await setup();click('Synthetic recording selection');expect(posts(f)).toHaveLength(0);now.mockReturnValue(2000);click('上传并本地转写');await screen.findByText('录音草稿已过期，不能上传。请清除待上传文件。');expect(posts(f)).toHaveLength(0);ordinary();click('上传并本地转写');await waitFor(()=>expect(posts(f)).toHaveLength(1));expect(posts(f)[0][1].body.name).toBe('ordinary.wav');await screen.findByText('查看新提交任务');expect(screen.queryByLabelText('未确认上传核对')).toBeNull();
});
it('expiry at use rejects before replacing an ordinary selection; accepted replacement does not submit',async()=>{
 const now=vi.spyOn(Date,'now').mockReturnValue(2000);const f=await setup();ordinary();const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);click('Synthetic recording selection');expect(confirm).not.toHaveBeenCalled();expect(screen.getByText(/待上传：ordinary.wav/)).toBeTruthy();now.mockReturnValue(1000);click('Synthetic recording selection');expect(confirm).toHaveBeenCalledOnce();expect(screen.getByText(/待上传：recording.wav/)).toBeTruthy();expect(posts(f)).toHaveLength(0);
});

beforeEach(() => { history.replaceState(null, '', fixtureStoreUrl()); });
