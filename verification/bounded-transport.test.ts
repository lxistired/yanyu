import {it,expect,vi} from 'vitest';
import {boundedTransport,durableOperations} from '../visual-harness/bounded-transport';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
it.each(Object.entries(durableOperations).flatMap(([module,ops])=>ops.map(op=>`/api/${module}/${op}`)))('admits only explicit durable operation %s',async(path)=>{const native=vi.fn(async()=>new Response('{}'));const fetch=boundedTransport(new OrdinaryRequestLifetime(),native);await fetch(path,{method:'POST',body:'{}'});expect(native).toHaveBeenCalledOnce();expect(native.mock.calls[0][1]).toMatchObject({credentials:'same-origin',redirect:'error',cache:'no-store'});});
it.each(['https://evil.test/api/workspace/create','//evil.test/api/workspace/create','/api/workspace/create?extra=1','/api/workspace/constructor','/api/service-reports/exportReport?extra=1','/api/service-reports/openReportSource/extra','/api/service-reports/recoverCommand?extra=1','/api/service-reports/cancelCommand/','/api/service-reports/recoverAll','/api/service-report-mail/send','/api/files','/api/feedback/create','/api/login'])('blocks unadmitted transport %s',async(path)=>{const native=vi.fn();const fetch=boundedTransport(new OrdinaryRequestLifetime(),native);expect((await fetch(path,{method:'POST'})).status).toBe(503);expect(native).not.toHaveBeenCalled();});
it('blocks wrong methods and supports explicit synthetic identity',async()=>{const native=vi.fn(async()=>new Response('{}'));const fetch=boundedTransport(new OrdinaryRequestLifetime(),native);expect((await fetch('/api/workspace/create')).status).toBe(503);expect((await fetch('/api/demo/identity',{method:'POST'})).status).toBe(503);expect(native).not.toHaveBeenCalled();await fetch('/api/demo/identity');expect(native).toHaveBeenCalledOnce();});
it('keeps simulation and unavailable capabilities away from native network',async()=>{const native=vi.fn();const fetch=boundedTransport(new OrdinaryRequestLifetime(),native);expect((await fetch('/api/integrations')).status).toBe(200);expect((await fetch('/api/automation/list',{method:'POST',body:'{}'})).status).toBe(503);expect(native).not.toHaveBeenCalled();});
it('client and server durable operation lists stay identical',async()=>{const {readFileSync}=await import('node:fs');const source=readFileSync(process.cwd()+'/backend/server.mjs','utf8');for(const [module,ops] of Object.entries(durableOperations)){const label=module.includes('-')?"'"+module+"'":module;const start=source.indexOf(label+':new Set([');expect(start).toBeGreaterThan(-1);const values=source.slice(start+label.length+10).split('])')[0].replace(/'/g,'"');expect(JSON.parse('['+values+']').sort()).toEqual([...ops].sort());}});

it('admits only exact local ASR jobs GET and transcribe POST',async()=>{const native=vi.fn().mockResolvedValue(new Response('{}'));const transport=boundedTransport(new OrdinaryRequestLifetime(),native);for(const [path,method] of [['/api/local-asr/jobs','GET'],['/api/local-asr/transcribe','POST']]){await transport(path,{method});}expect(native).toHaveBeenCalledTimes(2);for(const [path,method] of [['/api/local-asr/jobs','POST'],['/api/local-asr/transcribe','GET'],['/api/local-asr/jobs?x=1','GET'],['/api/local-asr/delete','POST']]){expect((await transport(path,{method})).status).toBe(503)}expect(native).toHaveBeenCalledTimes(2)});

it('admits exact local ASR UUID cancel POST and rejects route variants',async()=>{
 const native=vi.fn().mockResolvedValue(new Response('{}'));
 const transport=boundedTransport(new OrdinaryRequestLifetime(),native);
 const path='/api/local-asr/jobs/12345678-abcd-4abc-8abc-123456789abc/cancel';
 await transport(path,{method:'POST'});
 expect(native).toHaveBeenCalledOnce();
 expect(native.mock.calls[0][1]).toMatchObject({credentials:'same-origin',redirect:'error',cache:'no-store'});
 for(const [url,method] of [[path,'GET'],[path,'DELETE'],[path+'?x=1','POST'],[path+'/','POST'],['https://evil.test'+path,'POST'],['//evil.test'+path,'POST'],[path.replace('12345678-abcd-4abc-8abc-123456789abc','not-a-uuid'),'POST'],[path.replace('12345678-abcd-4abc-8abc-123456789abc','------------------------------------'),'POST'],[path.replace('/cancel','/delete'),'POST']]){
  expect((await transport(url,{method})).status).toBe(503);
 }
 expect(native).toHaveBeenCalledOnce();
});

it('admits precise transcript correction and export routes only',async()=>{const native=vi.fn().mockResolvedValue(new Response('{}'));const t=boundedTransport(new OrdinaryRequestLifetime(),native);const base='/api/local-asr/jobs/12345678-abcd-4abc-8abc-123456789abc';for(const [route,method] of [['transcript','GET'],['transcript','POST'],['export','POST']])await t(base+'/'+route,{method});expect(native).toHaveBeenCalledTimes(3);for(const [path,method] of [[base+'/export','GET'],[base+'/transcript','DELETE'],[base+'/transcript?x=1','POST'],[base+'/raw','POST'],['https://evil.test'+base+'/transcript','POST']])expect((await t(path,{method})).status).toBe(503);expect(native).toHaveBeenCalledTimes(3)});
it('admits only library query keys and UUID metadata POST routes',async()=>{
 const native=vi.fn().mockImplementation(async()=>new Response('{}'));const transport=boundedTransport(new OrdinaryRequestLifetime(),native);
 await transport('/api/local-asr/jobs?q=%E4%B8%AD&scope=trash&offset=10&limit=10');
 const base='/api/local-asr/jobs/12345678-abcd-4abc-8abc-123456789abc/';
 for(const action of ['rename','trash','restore'])await transport(base+action,{method:'POST'});
 expect(native).toHaveBeenCalledTimes(4);
 for(const path of ['/api/local-asr/jobs?q=x&q=y','/api/local-asr/jobs?purge=true',base+'purge',base+'trash?x=1','https://evil.test/api/local-asr/jobs?q=x'])expect((await transport(path,{method:'POST'})).status).toBe(503);
 expect((await transport(base+'trash')).status).toBe(503);expect(native).toHaveBeenCalledTimes(4);
});
it('admits bounded transcript organization routes and filters without broadening other routes',async()=>{
 const native=vi.fn().mockImplementation(async()=>new Response('{}')),t=boundedTransport(new OrdinaryRequestLifetime(),native),base='/api/local-asr/jobs/12345678-abcd-4abc-8abc-123456789abc/relationship';
 for(const [path,method] of [['/api/local-asr/relationships','GET'],[base,'POST'],['/api/local-asr/jobs?workspaceId=a&sessionId=b&jobId=12345678-abcd-4abc-8abc-123456789abc','GET']])await t(path,{method});expect(native).toHaveBeenCalledTimes(3);
 for(const [path,method] of [['/api/local-asr/relationships','POST'],['/api/local-asr/relationships?x=1','GET'],[base,'GET'],[base+'?x=1','POST'],['/api/local-asr/jobs?workspaceId=a&workspaceId=b','GET'],['/api/local-asr/jobs?reportPin=x','GET']])expect((await t(path,{method})).status).toBe(503);expect(native).toHaveBeenCalledTimes(3);
});

it('admits exact history read and explicit restore routes without broadening other routes',async()=>{
 const native=vi.fn().mockImplementation(async()=>new Response('{}')),t=boundedTransport(new OrdinaryRequestLifetime(),native),base='/api/local-asr/jobs/12345678-abcd-4abc-8abc-123456789abc/';
 for(const [route,method] of [['history','GET'],['history/7','GET'],['transcript-restore','POST']])await t(base+route,{method});expect(native).toHaveBeenCalledTimes(3);
 for(const [route,method] of [['history','POST'],['history/7','POST'],['history/0','GET'],['history/-1','GET'],['history/01','GET'],['history?x=1','GET'],['transcript-restore','GET'],['transcript-restore/1','POST']])expect((await t(base+route,{method})).status).toBe(503);expect(native).toHaveBeenCalledTimes(3);
});

it('admits exact local ASR UUID resume POST and rejects route variants',async()=>{
 const native=vi.fn().mockResolvedValue(new Response('{}'));
 const transport=boundedTransport(new OrdinaryRequestLifetime(),native);
 const path='/api/local-asr/jobs/12345678-abcd-4abc-8abc-123456789abc/resume';
 await transport(path,{method:'POST'});
 expect(native).toHaveBeenCalledOnce();
 expect(native.mock.calls[0][1]).toMatchObject({credentials:'same-origin',redirect:'error',cache:'no-store'});
 for(const [url,method] of [[path,'GET'],[path,'DELETE'],[path+'?x=1','POST'],[path+'/','POST'],['https://evil.test'+path,'POST'],['//evil.test'+path,'POST'],[path.replace('12345678-abcd-4abc-8abc-123456789abc','not-a-uuid'),'POST'],[path.replace('12345678-abcd-4abc-8abc-123456789abc','------------------------------------'),'POST'],[path.replace('/resume','/delete'),'POST']]){
  expect((await transport(url,{method})).status).toBe(503);
 }
 expect(native).toHaveBeenCalledOnce();
});

it('matches all six mounted inventory route contracts and refuses execution/provider variants',async()=>{
 const native=vi.fn().mockResolvedValue(new Response('{}'));const t=boundedTransport(new OrdinaryRequestLifetime(),native);
 for(const [path,method] of [['capabilities','GET'],['schedules','GET'],['schedules','POST'],['state','POST'],['runs','GET'],['result?id=run_1','GET']])await t('/api/local-scheduler/'+path,{method});
 expect(native).toHaveBeenCalledTimes(6);
 for(const [path,method] of [['tick','POST'],['claim','POST'],['execute','POST'],['start','POST'],['providers','GET'],['research','POST'],['schedules?x=1','POST'],['state','GET'],['runs','POST'],['capabilities?x=1','GET'],['result','GET'],['result?id=a&id=b','GET'],['result?id=a&x=1','GET'],['result/?id=a','GET']])expect((await t('/api/local-scheduler/'+path,{method})).status).toBe(503);
 expect(native).toHaveBeenCalledTimes(6);
});
it('admits only exact queryless GET transcription identity discovery',async()=>{
 const native=vi.fn().mockResolvedValue(new Response('{}')),t=boundedTransport(new OrdinaryRequestLifetime(),native);
 expect((await t('/api/local-asr/identity',{method:'GET'})).status).toBe(200);
 for(const [path,method] of [['/api/local-asr/identity?','GET'],['/api/local-asr/identity?x=1','GET'],['/api/local-asr/identity/','GET'],['/api/local-asr/%69dentity','GET'],['/api/local-asr/identity','HEAD'],['/api/local-asr/identity','POST']])expect((await t(path,{method})).status).toBe(503);
 expect(native).toHaveBeenCalledOnce();
});

// Exact local report source admission; no wildcard or newline normalization.
it.each(['sourceChoices','openActivitySource','openReportSource'])('admits only exact POST local report source operation %s',async(op)=>{
 const native=vi.fn(async()=>new Response('{}'));const transport=boundedTransport(new OrdinaryRequestLifetime(),native);const path='/api/service-reports/'+op;
 await transport(path,{method:'POST',body:'{}'});expect(native).toHaveBeenCalledOnce();expect(native.mock.calls[0][1]).toMatchObject({credentials:'same-origin',redirect:'error',cache:'no-store'});
 for(const method of ['GET','PUT'])expect((await transport(path,{method})).status).toBe(503);
 for(const suffix of ['?extra=1','/','/extra','Suffix','\n','\r'])expect((await transport(path+suffix,{method:'POST'})).status).toBe(503);
 expect(native).toHaveBeenCalledOnce();
});
it.each(Object.entries(durableOperations).map(([module,ops])=>'/api/'+module+'/'+ops[0]))('rejects trailing line terminators for every durable module %s',async(path)=>{
 const native=vi.fn();const transport=boundedTransport(new OrdinaryRequestLifetime(),native);
 for(const suffix of ['\n','\r'])expect((await transport(path+suffix,{method:'POST'})).status).toBe(503);
 expect(native).not.toHaveBeenCalled();
});
