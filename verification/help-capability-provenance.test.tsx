import React from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {HelpContent} from '../candidate/src/components/HelpContent';
import type {AppCapabilities} from '../candidate/src/adapters/api';
const neutral = '此入口未读取实时服务状态；请以各功能页显示的当前可用状态为准。';
const capabilities: AppCapabilities = {persistence:'sqlite-local',mode:'local',auth:'trusted-server-adapter',model:'registered',asr:'local',uploads:'local-files',privateAssets:true,plans:true,organization:true,workspace:true,automation:true,scheduler:{mode:'running',lastCheckedAt:null,lastError:null}};
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
it.each([
 {value:null, error:undefined}, {value:null, error:'stale error'},
 {value:capabilities, error:undefined}, {value:capabilities, error:'stale error'},
])('not-read suppresses stale capability claims and never fetches (%j)', ({value,error})=>{
 const fetch = vi.fn();vi.stubGlobal('fetch',fetch);
 render(<HelpContent capabilities={value} capabilityState="not-read" capabilityError={error} onClose={()=>{}} onNavigate={()=>{}}/>);
 expect(screen.getByText(neutral)).toBeTruthy();
 expect(screen.queryByText('服务状态读取失败，当前能力未知。')).toBeNull();
 expect(screen.queryByText(/正在确认服务状态/)).toBeNull();
 for(const name of ['本地记录与重启','会话与资料导航','模型与计划','录音与转写','通知范围'])expect(screen.queryByRole('heading',{name})).toBeNull();
 expect(fetch).not.toHaveBeenCalled();
});
it('retains genuine error and pending defaults when not-read is absent',()=>{
 const props={capabilities:null,onClose:()=>{},onNavigate:()=>{}};
 const view=render(<HelpContent {...props} capabilityError="genuine read failure"/>);
 expect(screen.getByText('服务状态读取失败，当前能力未知。')).toBeTruthy();expect(screen.queryByText(neutral)).toBeNull();
 view.rerender(<HelpContent {...props}/>);
 expect(screen.getByText('正在确认服务状态，尚不能确认本地存储、模型或 ASR 是否可用。')).toBeTruthy();expect(screen.queryByText(neutral)).toBeNull();
});
it('retains capability-dependent sections and conditional gates for genuine data',()=>{
 const props={onClose:()=>{},onNavigate:()=>{}};
 const view=render(<HelpContent {...props} capabilities={capabilities}/>);
 for(const name of ['本地记录与重启','会话与资料导航','模型与计划','录音与转写','通知范围'])expect(screen.getByRole('heading',{name})).toBeTruthy();
 view.rerender(<HelpContent {...props} capabilities={{...capabilities,workspace:false,plans:false,automation:false}}/>);
 expect(screen.queryByRole('heading',{name:'通知范围'})).toBeNull();expect(screen.queryByRole('heading',{name:'会话与资料导航'})).toBeNull();expect(screen.queryByRole('button',{name:'查看研究计划'})).toBeNull();
});
it.each([['查看手动模型计划用量','usage'],['查看服务与显示偏好','settings']] as const)('not-read still closes then navigates via %s',(name,destination)=>{
 const order:string[]=[];render(<HelpContent capabilities={null} capabilityState="not-read" onClose={()=>order.push('close')} onNavigate={page=>order.push(page)}/>);
 fireEvent.click(screen.getByRole('button',{name}));expect(order).toEqual(['close',destination]);
});
