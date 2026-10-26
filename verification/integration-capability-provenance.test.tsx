import React from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {IntegrationCapabilities} from '../candidate/src/components/IntegrationCapabilities';
import {api} from '../candidate/src/adapters/api';
import type {IntegrationCapability, IntegrationKind} from '../candidate/shared/integration-capabilities';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {boundedTransport} from '../visual-harness/bounded-transport';
import {syntheticTransport} from '../visual-harness/synthetic-transport';
const empty='当前没有此类能力条目；不代表本地文档或专用手动清单不可用，请以各功能页的当前状态为准。';
const scope='此页不是全部本地功能的可用性清单。';
const item:IntegrationCapability={id:'test',label:'controlled result',kind:'model.text',implemented:true,configured:false,available:false,reason:'unconfigured'};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('renders bounded synthetic provenance and refreshes only the synthetic GET',async()=>{
 const native=vi.fn();const fetch=vi.fn(boundedTransport(new OrdinaryRequestLifetime(),native));vi.stubGlobal('fetch',fetch);
 render(<IntegrationCapabilities source="synthetic"/>);
 expect(screen.getByRole('region',{name:'合成能力展示'})).toBeTruthy();
 expect(screen.getByRole('status').textContent).toContain('正在读取合成能力展示');expect(screen.queryByText(empty)).toBeNull();
 await screen.findByRole('heading',{name:'本地合成文本模型 · 未配置'});
 expect(screen.getByText(/此入口仅展示合成能力数据，不是实时服务注册或资格检查/)).toBeTruthy();
 expect(screen.getByText(scope)).toBeTruthy();expect(screen.getByText('未配置')).toBeTruthy();expect(screen.getByText('不可调用')).toBeTruthy();
 expect(screen.queryByText(/只表示服务端资格判断/)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'重新读取合成展示'}));
 await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));await screen.findByRole('heading',{name:'本地合成文本模型 · 未配置'});
 for(const [path,init] of fetch.mock.calls){expect(path).toBe('/api/integrations');expect(init?.method??'GET').toBe('GET');expect(init?.body).toBeUndefined();expect(init?.signal).toBeInstanceOf(AbortSignal);}
 expect(native).not.toHaveBeenCalled();
});
it.each(['server','synthetic'] as const)('keeps %s empty success distinct from pending and rejected reads',async source=>{
 const pending=deferred<IntegrationCapability[]>();const read=vi.spyOn(api,'integrations').mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('controlled failure'));
 render(<IntegrationCapabilities source={source}/>);expect(screen.queryByText(empty)).toBeNull();expect(screen.getByText(scope)).toBeTruthy();
 await act(async()=>pending.resolve([]));expect(screen.getByText(empty)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:source==='server'?'重新检查资格':'重新读取合成展示'}));
 await waitFor(()=>expect(screen.queryByRole('status')).toBeNull());expect(screen.queryByText(empty)).toBeNull();expect(document.querySelector('.notice.error')).not.toBeNull();expect(read).toHaveBeenCalledTimes(2);
});
it('defaults to server registration wording without synthetic claims',async()=>{
 vi.spyOn(api,'integrations').mockResolvedValue([]);render(<IntegrationCapabilities/>);
 expect(screen.getByRole('region',{name:'服务端注册能力'})).toBeTruthy();expect(screen.getByRole('button',{name:'重新检查资格'})).toBeTruthy();
 expect(screen.getByText(/只表示服务端资格判断/)).toBeTruthy();expect(screen.queryByText(/此入口仅展示合成能力数据/)).toBeNull();await screen.findByText(empty);
});
it('clears previous items on refresh, aborts unmount and ignores late resolution',async()=>{
 const late=deferred<IntegrationCapability[]>();const read=vi.spyOn(api,'integrations').mockResolvedValueOnce([item]).mockReturnValueOnce(late.promise);
 const view=render(<IntegrationCapabilities source="synthetic"/>);await screen.findByText(item.label);
 fireEvent.click(screen.getByRole('button',{name:'重新读取合成展示'}));expect(screen.queryByText(item.label)).toBeNull();expect(screen.queryByText(empty)).toBeNull();
 expect(read.mock.calls[0][0]?.aborted).toBe(true);const signal=read.mock.calls[1][0]!;view.unmount();expect(signal.aborted).toBe(true);
 await act(async()=>late.resolve([item]));expect(screen.queryByText(item.label)).toBeNull();
});
it('rejects delayed synthetic capability replies after route advance',async()=>{
 vi.useFakeTimers();const life=new OrdinaryRequestLifetime();const transport=syntheticTransport(life,20);
 const response=transport('/api/integrations');const rejected=expect(response).rejects.toMatchObject({name:'AbortError'});
 life.advance();await vi.advanceTimersByTimeAsync(20);await rejected;
});
it('returns a legal, typed synthetic integration contract, not a local inventory registry',async()=>{
 const native=vi.fn();const response=await boundedTransport(new OrdinaryRequestLifetime(),native)('/api/integrations');const values=await response.json();
 const kinds:IntegrationKind[]=['model.text','asr.transcribe','tts','live','im','hardware','payment'];
 expect(values).toHaveLength(1);
 for(const value of values){expect(kinds).toContain(value.kind);for(const key of ['implemented','configured','available'])expect(typeof value[key]).toBe('boolean');expect(['eligible','contract-only','unconfigured','disabled','unavailable']).toContain(value.reason);expect(value.label).toContain('合成');}
 expect(values[0]).toMatchObject({id:'demo-local',kind:'model.text',configured:false,available:false,reason:'unconfigured'});expect(native).not.toHaveBeenCalled();
});
