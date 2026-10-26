import {fixtureStoreHeaders, fixtureStoreUrl} from './transcription-store-fixture';
import {initialUploadAccepted} from './initial-upload-fixture';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {LocalTranscription} from '../candidate/src/components/LocalTranscription';

const model={maxSeconds:7200,maxBytes:268435456,chunkSeconds:30,overlapSeconds:1,deadlineSeconds:14400};
const ok=(data:unknown)=>({headers:fixtureStoreHeaders(),ok:true,json:async()=>data});
const processing={id:'x',filename:'synthetic.wav',status:'processing',created:'2026-10-15T00:00:00Z',error:null,result:null,progress:{completedChunks:1,totalChunks:3,durationSeconds:75}};
afterEach(()=>{cleanup();vi.unstubAllGlobals()});

it('shows dynamic configured limits, validation caveat and no playback controls',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(ok({jobs:[],model})));
 render(<LocalTranscription/>);
 await screen.findByText('还没有转写记录');
 expect(screen.getByText(/faster-whisper-small/)).toBeTruthy();
 expect(screen.getByText(/当前配置上限/).textContent).toContain('256 MiB');
 expect(screen.getByText(/当前配置上限/).textContent).toContain((7200).toLocaleString());
 expect(screen.getByText(/75 秒的合成英文音频验证/)).toBeTruthy();
 expect(document.querySelector('audio')).toBeNull();
 expect((screen.getByText('上传并本地转写') as HTMLButtonElement).disabled).toBe(true);
});

it('does not enable uploads without valid server limits',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(ok({jobs:[]})));
 render(<LocalTranscription/>);
 await screen.findByText(/未取得有效的服务端音频限制/);
 expect((screen.getByLabelText('选择音频文件') as HTMLInputElement).disabled).toBe(true);
});

it('shows filename then posts the selected file once and displays the persisted transcript',async()=>{
 const job={...processing,status:'completed',result:{text:'Actual recognizer result',duration_seconds:75,inference_seconds:15,language:'en'}};
 let submitted=false;
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{if(url==='/api/local-asr/transcribe'){submitted=true;return initialUploadAccepted(init!);}return ok({jobs:submitted?[job]:[],model});});
 vi.stubGlobal('fetch',fetcher);
 render(<LocalTranscription/>);
 await screen.findByText('还没有转写记录');
 const file=new File([new Uint8Array(80)],'synthetic.wav',{type:'audio/wav'});
 fireEvent.change(screen.getByLabelText('选择音频文件'),{target:{files:[file]}});
 expect(screen.getByText(/待上传：synthetic.wav/)).toBeTruthy();
 fireEvent.click(screen.getByText('上传并本地转写'));
 fireEvent.click(screen.getByText('正在上传…'));
 await screen.findByText('查看新提交任务');
 await screen.findByText('Actual recognizer result');
 const posts=fetcher.mock.calls.filter(call=>call[0]==='/api/local-asr/transcribe');
 expect(posts).toHaveLength(1);
 expect(posts[0][1].body).toBe(file);
 expect(new Headers(posts[0][1].headers).get('X-Upload-Operation-Id')).toMatch(/^[a-f0-9-]{36}$/);
 expect(screen.queryByLabelText('未确认上传核对')).toBeNull();
 expect(screen.getByText(/推理用时 15.00 秒/)).toBeTruthy();
 expect((screen.getByLabelText('选择音频文件') as HTMLInputElement).value).toBe('');
});

it('rejects input exceeding the server byte budget without posting',async()=>{
 const f=vi.fn().mockResolvedValue(ok({jobs:[],model:{...model,maxBytes:1048576}}));
 vi.stubGlobal('fetch',f);
 render(<LocalTranscription/>);
 await screen.findByText('还没有转写记录');
 fireEvent.change(screen.getByLabelText('选择音频文件'),{target:{files:[new File([new Uint8Array(1048577)],'large.wav')]}});
 fireEvent.click(screen.getByText('上传并本地转写'));
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('1 MiB'));
 expect(f.mock.calls.some(call=>call[1]?.method==='POST')).toBe(false);
});

it('shows chunk progress and cancels once, waiting for confirmed cancelled state',async()=>{
 let cancelled=false;
 const fetcher=vi.fn(async(url:string)=>{
  if(url.endsWith('/cancel')) {cancelled=true;return ok({});}
  return ok({jobs:[cancelled?{...processing,status:'cancelled'}:processing],model});
 });
 vi.stubGlobal('fetch',fetcher);
 render(<LocalTranscription/>);
 await screen.findByText(/已完成 1 \/ 3 段/);
 const progress=screen.getByRole('progressbar') as HTMLProgressElement;
 expect(progress.value).toBe(1);expect(progress.max).toBe(3);
 expect((screen.getByLabelText('选择音频文件') as HTMLInputElement).disabled).toBe(true);
 fireEvent.click(screen.getByText('取消转写'));
 const pending=screen.getByText('正在取消…') as HTMLButtonElement;
 expect(pending.disabled).toBe(true);fireEvent.click(pending);
 await screen.findByText(/任务已停止/,{}, {timeout:2500});
 expect(fetcher.mock.calls.filter(call=>call[0].endsWith('/cancel'))).toHaveLength(1);
 expect(fetcher.mock.calls.find(call=>call[0].endsWith('/cancel'))?.[0]).toBe('/api/local-asr/jobs/x/cancel');
 expect(screen.queryByText('取消转写')).toBeNull();
 expect(screen.queryByRole('progressbar')).toBeNull();
 expect((screen.getByLabelText('选择音频文件') as HTMLInputElement).disabled).toBe(false);
});

it('allows cancellation retry after server rejection without pretending the job stopped',async()=>{
 const fetcher=vi.fn(async(url:string)=>url.endsWith('/cancel')?{headers:fixtureStoreHeaders(),ok:false,json:async()=>({error:{message:'Cancellation unavailable'}})}:ok({jobs:[processing],model}));
 vi.stubGlobal('fetch',fetcher);
 render(<LocalTranscription/>);
 fireEvent.click(await screen.findByText('取消转写'));
 await screen.findByText('Cancellation unavailable');
 expect((screen.getByText('取消转写') as HTMLButtonElement).disabled).toBe(false);
 expect(screen.queryByText(/任务已停止/)).toBeNull();
});

it('renders durable failed and cancelled jobs without partial transcript output',async()=>{
 const partial={text:'Incomplete result',duration_seconds:75,inference_seconds:2,language:'en'};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(ok({jobs:[{...processing,id:'bad',status:'failed',error:'Invalid WAV'},{...processing,id:'cancelled',status:'cancelled',result:partial}],model})));
 render(<LocalTranscription/>);
 await screen.findByText('Invalid WAV');
 expect(screen.getByText(/转写失败/)).toBeTruthy();
 expect(screen.getByText(/已取消/)).toBeTruthy();
 expect(screen.queryByText('Incomplete result')).toBeNull();
});


it('warns about uncertain merge boundaries and recognition omissions or additions',async()=>{
 const job={...processing,status:'completed',result:{text:'Review this transcript',duration_seconds:75,inference_seconds:15,language:'en',boundaries:[{offset:29,method:'uncertain-midpoint'},{offset:58,method:'token-alignment'}]}};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(ok({jobs:[job],model})));
 render(<LocalTranscription/>);
 await screen.findByText('Review this transcript');
 expect(screen.getByText(/有 1 处分段边界未能可靠对齐/).textContent).toContain('29.00 秒');
 expect(screen.getByText(/添加原音频中没有的词/)).toBeTruthy();
});

it.each(['auto','zh','en'])('submits selected language %s with no forced English default',async(language)=>{
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>url==='/api/local-asr/transcribe'?initialUploadAccepted(init!):ok({jobs:[],model}));vi.stubGlobal('fetch',fetcher);
 render(<LocalTranscription/>);await screen.findByText('还没有转写记录');
 const selector=screen.getByLabelText('识别语言') as HTMLSelectElement;expect(selector.value).toBe('auto');
 fireEvent.change(selector,{target:{value:language}});
 fireEvent.change(screen.getByLabelText('选择音频文件'),{target:{files:[new File([new Uint8Array(80)],'test.wav')]}});
 fireEvent.click(screen.getByText('上传并本地转写'));
 await waitFor(()=>expect(fetcher.mock.calls.some(c=>c[0]==='/api/local-asr/transcribe')).toBe(true));
 expect(new Headers(fetcher.mock.calls.find(c=>c[0]==='/api/local-asr/transcribe')?.[1].headers).get('X-Audio-Language')).toBe(language);
 await screen.findByText('查看新提交任务');
 expect(selector.value).toBe(language);
});
it('locks language during a job and distinguishes persisted request from detection',async()=>{
 const job={...processing,requested_language:'auto'};vi.stubGlobal('fetch',vi.fn().mockResolvedValue(ok({jobs:[job],model})));
 render(<LocalTranscription/>);await screen.findByText('请求语言：自动检测');
 expect((screen.getByLabelText('识别语言') as HTMLSelectElement).disabled).toBe(true);
 expect(screen.getByText(/只检测首段并固定/)).toBeTruthy();
});
it('renders detected Chinese from saved result honestly',async()=>{
 const job={...processing,status:'completed',requested_language:'auto',result:{text:'甚至出现交易几乎停滞的情况',duration_seconds:4.204,inference_seconds:1.5,language:'zh',language_source:'first-chunk-detection',language_probability:0.99}};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(ok({jobs:[job],model})));render(<LocalTranscription/>);
 await screen.findByText('甚至出现交易几乎停滞的情况');expect(screen.getByText(/识别语言：中文（首段自动检测）/)).toBeTruthy();
});

it('requires explicit resume for interrupted jobs and shows retention without selecting a file',async()=>{
 const fetcher=vi.fn().mockImplementation(async(url:string,options?:RequestInit)=>options?.method==='POST'?ok({status:'processing'}):ok({jobs:[{...processing,status:'interrupted',pending_expires_at:Date.now()+60000}],model:{...model,retentionSeconds:86400},activeJobCount:0}));
 vi.stubGlobal('fetch',fetcher);render(<LocalTranscription/>);
 const resume=await screen.findByText('从已保存分段继续');
 expect(screen.getByText(/中断后不会自动继续/).textContent).toContain('86400');
 expect(screen.getByText(/临时音频到期/)).toBeTruthy();
 expect(fetcher.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(0);
 fireEvent.click(resume);
 await waitFor(()=>expect(fetcher.mock.calls.some(call=>call[0]==='/api/local-asr/jobs/x/resume'&&call[1]?.method==='POST')).toBe(true));
 expect(fetcher.mock.calls.some(call=>call[0]==='/api/local-asr/transcribe')).toBe(false);
});

it('interrupted cancellation uses the existing job without re-upload',async()=>{
 const fetcher=vi.fn().mockImplementation(async(url:string,options?:RequestInit)=>options?.method==='POST'?ok({status:'cancelled'}):ok({jobs:[{...processing,status:'interrupted'}],model,activeJobCount:0}));
 vi.stubGlobal('fetch',fetcher);render(<LocalTranscription/>);
 fireEvent.click(await screen.findByText('取消并删除临时音频'));
 await waitFor(()=>expect(fetcher.mock.calls.some(call=>call[0]==='/api/local-asr/jobs/x/cancel')).toBe(true));
});

beforeEach(() => { history.replaceState(null, '', fixtureStoreUrl()); });
