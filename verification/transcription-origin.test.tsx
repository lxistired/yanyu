import {initialUploadAccepted, initialUploadUnconfirmed} from './initial-upload-fixture';
import {fixtureStoreHeaders, fixtureStoreUrl} from './transcription-store-fixture';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup,act} from '@testing-library/react';
import {LocalTranscription} from '../candidate/src/components/LocalTranscription';
// Both real panel paths share this callback; no microphone, IndexedDB or media runtime.
vi.mock('../candidate/src/components/RecordingDrafts',()=>({RecordingDrafts:({onSelect}:{onSelect:(selection:{file:File;expiresAt?:number})=>boolean})=><>{['current','saved'].map(kind=><button key={kind} onClick={()=>onSelect({file:new File([new Uint8Array(80)],`${kind}.wav`),expiresAt:Date.now()+60000})}>{kind} recording fixture</button>)}</>}));
const id='11111111-1111-4111-8111-111111111111',model={maxSeconds:7200,maxBytes:1024,chunkSeconds:30,overlapSeconds:1,deadlineSeconds:14400};
const ok=(data:unknown,status=200)=>({headers:fixtureStoreHeaders(),ok:true,status,json:async()=>data});
const accepted=(options:RequestInit)=>initialUploadAccepted(options,{id});
const file=()=>new File([new Uint8Array(80)],'recording.wav');
const choose=()=>fireEvent.change(screen.getByLabelText('选择音频文件'),{target:{files:[file()]}});
const post=(f:ReturnType<typeof vi.fn>)=>f.mock.calls.filter(([url])=>url==='/api/local-asr/transcribe');
async function setup(write:(options:RequestInit)=>unknown=accepted,rows:unknown[]=[]){const f=vi.fn(async(url:string,options?:RequestInit)=>url.startsWith('/api/local-asr/transcribe?operationId=')?initialUploadUnconfirmed(url):options?.method==='POST'?write(options):ok({jobs:rows,model,total:rows.length,activeJobCount:0}));vi.stubGlobal('fetch',f);render(<LocalTranscription/>);await waitFor(()=>expect((screen.getByLabelText('选择音频文件') as HTMLInputElement).disabled).toBe(false));return f;}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();history.replaceState(null,'','/')});
it.each(['current','saved'])('explicit %s recording callback declares recording panel, not MIME or name',async(kind)=>{const f=await setup();fireEvent.click(screen.getByText(`${kind} recording fixture`));fireEvent.click(screen.getByText('上传并本地转写'));await screen.findByText('查看新提交任务');expect(new Headers(post(f)[0][1]?.headers).get('X-Audio-Origin')).toBe('recording-draft');expect((post(f)[0][1]?.body as File).name).toBe(`${kind}.wav`)});
it('file picker declares file-selection despite recording filename; same-operation retry preserves declaration',async()=>{
 const f=await setup(()=>({headers:fixtureStoreHeaders(),ok:false,status:500,json:async()=>({})}));
 choose();fireEvent.click(screen.getByText('上传并本地转写'));
 await screen.findByText(/上传未获确认。原文件和操作标识仍保留/);
 const first=post(f)[0][1]!;
 expect((screen.getByText('上传并本地转写') as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByText('上传并本地转写'));expect(post(f)).toHaveLength(1);
 fireEvent.click(screen.getByText('用原操作重试上传'));await waitFor(()=>expect(post(f)).toHaveLength(2));
 for(const call of post(f)) {
  expect(new Headers(call[1]?.headers).get('X-Audio-Origin')).toBe('file-selection');
  expect(call[1]?.body).toBe(first.body);
  expect(new Headers(call[1]?.headers).get('X-Upload-Operation-Id')).toBe(new Headers(first.headers).get('X-Upload-Operation-Id'));
 }
 expect(f.mock.calls.filter(([url])=>url.startsWith('/api/local-asr/transcribe?operationId='))).toHaveLength(1);
});
it('rejected recording replacement preserves file; accepted clear and reselect updates origin',async()=>{const f=await setup();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);choose();fireEvent.click(screen.getByText('saved recording fixture'));expect(confirm).toHaveBeenCalled();fireEvent.click(screen.getByText('上传并本地转写'));await screen.findByText('查看新提交任务');expect(new Headers(post(f)[0][1]?.headers).get('X-Audio-Origin')).toBe('file-selection');fireEvent.click(screen.getByText('current recording fixture'));fireEvent.click(screen.getByText('清除待上传文件'));choose();fireEvent.click(screen.getByText('上传并本地转写'));await waitFor(()=>expect(post(f)).toHaveLength(2));expect(new Headers(post(f)[1][1]?.headers).get('X-Audio-Origin')).toBe('file-selection')});
it('in-flight body and declaration snapshot ignore newer selection; only its exact receipt clears pending identity',async()=>{
 let resolve!:(value:unknown)=>void;
 const f=await setup(()=>new Promise(r=>resolve=r));fireEvent.click(screen.getByText('current recording fixture'));
 fireEvent.click(screen.getByText('上传并本地转写'));await waitFor(()=>expect(post(f)).toHaveLength(1));
 const first=post(f)[0][1]!;choose();
 expect(new Headers(first.headers).get('X-Audio-Origin')).toBe('recording-draft');
 expect((first.body as File).name).toBe('current.wav');
 expect(screen.getByText(/待上传：current.wav/)).toBeTruthy();expect(screen.queryByText('查看新提交任务')).toBeNull();
 await act(async()=>resolve(await accepted(first)));await screen.findByText('查看新提交任务');
 expect(screen.queryByText(/待上传：/)).toBeNull();expect(post(f)).toHaveLength(1);
 choose();expect(screen.getByText(/待上传：recording.wav/)).toBeTruthy();expect(post(f)).toHaveLength(1);
});
it('only explicit known client-declared DTO labels a route, old or malformed metadata stays unknown',async()=>{await setup(accepted,[{id,filename:'recording.wav',status:'failed',created:'2026-10-21',error:null,result:null},{id:'2',filename:'x.wav',status:'failed',created:'2026-10-21',error:null,result:null,uploadOrigin:'recording-draft',uploadOriginAssurance:'client-declared'},{id:'3',filename:'z.wav',status:'cancelled',created:'2026-10-21',error:null,result:null,uploadOrigin:'file-selection'}]);expect(screen.getAllByText('首次提交来源：来源未知')).toHaveLength(2);expect(screen.getByText(/首次提交来源：录音面板（当前录音或已保存草稿）（客户端声明，非来源证明）/)).toBeTruthy()});

beforeEach(() => { history.replaceState(null, '', fixtureStoreUrl()); });
