import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { MeetingReminderPreview } from '../candidate/src/components/MeetingReminderPreview';
import { LocalMeetingAgenda } from '../candidate/src/components/LocalMeetingAgenda';
import { organizationApi } from '../candidate/src/adapters/organization';
import type { OrganizationRecord } from '../candidate/shared/organization';
const row=(id='a',state:'scheduled'|'cancelled'|'completed'='scheduled'):OrganizationRecord<'meeting'>=>({id,kind:'meeting',revision:1,createdAt:'2026-10-21T00:00:00.000Z',updatedAt:'2026-10-21T00:00:00.000Z',deletedAt:null,data:{title:'Meeting '+id,organizationId:null,series:'',category:'research',startsAt:'2099-10-21T00:00:00.000Z',endsAt:'2099-10-21T01:00:00.000Z',timezone:'Asia/Shanghai',location:'Room A',description:'',attendeeIds:[],state,providerAvailability:'unconfigured'}});
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name}));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('applies only a memory preview; close discards draft but preserves applied choice; cancel is repeat-safe',()=>{
 const fetch=vi.fn(()=>{throw Error('No network allowed')});vi.stubGlobal('fetch',fetch);
 const storage=vi.spyOn(Storage.prototype,'setItem');const notification=vi.fn();vi.stubGlobal('Notification',notification);
 render(<MeetingReminderPreview meeting={row()}/>);click('设置 / 查看提醒预览');
 fireEvent.change(screen.getByLabelText('预览提前量'),{target:{value:'3600'}});click('应用当前页预览');click('应用当前页预览');
 expect(screen.getByText(/本地模拟，未调度.*提前 1 小时.*2099-10-20T23:00:00.000Z/)).toBeTruthy();
 fireEvent.change(screen.getByLabelText('预览提前量'),{target:{value:'300'}});click('关闭预览设置');click('设置 / 查看提醒预览');
 expect((screen.getByLabelText('预览提前量') as HTMLSelectElement).value).toBe('3600');
 click('取消当前页预览');expect(screen.getByText(/已取消当前页预览/)).toBeTruthy();expect((screen.getByRole('button',{name:'取消当前页预览'}) as HTMLButtonElement).disabled).toBe(true);
 click('应用当前页预览');expect(screen.queryByText(/已取消当前页预览/)).toBeNull();expect(fetch).not.toHaveBeenCalled();expect(storage).not.toHaveBeenCalled();expect(notification).not.toHaveBeenCalled();
});
it('blocks cancelled/completed meetings and elapsed reminders, revalidating time at apply',()=>{
 for(const state of ['cancelled','completed'] as const){render(<MeetingReminderPreview meeting={row('a',state)}/>);click('设置 / 查看提醒预览');expect((screen.getByRole('button',{name:'应用当前页预览'}) as HTMLButtonElement).disabled).toBe(true);cleanup();}
 vi.spyOn(Date,'now').mockReturnValue(Date.parse('2099-10-20T23:50:00Z'));
 render(<MeetingReminderPreview meeting={row()}/>);click('设置 / 查看提醒预览');click('应用当前页预览');expect(screen.getByRole('alert').textContent).toContain('必须晚于当前时间');
 fireEvent.change(screen.getByLabelText('预览提前量'),{target:{value:'0'}});click('应用当前页预览');expect(screen.queryByRole('alert')).toBeNull();
 vi.spyOn(Date,'now').mockReturnValue(Date.parse('2099-10-21T00:00:00Z'));click('应用当前页预览');expect(screen.getByRole('alert')).toBeTruthy();
});
it('agenda keeps meetings isolated and refresh destroys previews without reminder writes',async()=>{
 const list=vi.spyOn(organizationApi,'list').mockResolvedValue({items:[row('a'),row('b')],offset:0,total:2,nextOffset:null});
 render(<LocalMeetingAgenda onManageOrganizations={()=>{}}/>);await screen.findByText('Meeting a');
 let a=within(screen.getByRole('region',{name:'提醒预览：Meeting a'}));const b=within(screen.getByRole('region',{name:'提醒预览：Meeting b'}));
 fireEvent.click(a.getByRole('button',{name:'设置 / 查看提醒预览'}));fireEvent.click(a.getByRole('button',{name:'应用当前页预览'}));expect(a.getByText(/本地模拟，未调度.*提前 15 分钟/)).toBeTruthy();expect(b.getByText(/尚未设置当前页预览/)).toBeTruthy();
 click('刷新 / 重试');await screen.findByText('Meeting a');a=within(screen.getByRole('region',{name:'提醒预览：Meeting a'}));expect(a.getByText(/尚未设置当前页预览/)).toBeTruthy();expect(list).toHaveBeenCalledTimes(2);
});
it('leaving and returning starts without a prior preview',()=>{
 const view=render(<MeetingReminderPreview meeting={row()}/>);click('设置 / 查看提醒预览');click('应用当前页预览');view.unmount();render(<MeetingReminderPreview meeting={row()}/>);expect(screen.getByText(/尚未设置当前页预览/)).toBeTruthy();
});
it('paging and filter changes discard applied preview when returning to the same meeting',async()=>{
 vi.spyOn(organizationApi,'list').mockImplementation(async request=>request.offset ? {items:[row('b')],offset:1,total:2,nextOffset:null} : {items:[row('a')],offset:0,total:2,nextOffset:1});
 render(<LocalMeetingAgenda onManageOrganizations={()=>{}}/>);await screen.findByText('Meeting a');click('设置 / 查看提醒预览');click('应用当前页预览');
 click('下一页');await screen.findByText('Meeting b');expect(screen.getByText(/尚未设置当前页预览/)).toBeTruthy();click('上一页');await screen.findByText('Meeting a');expect(screen.getByText(/尚未设置当前页预览/)).toBeTruthy();
 click('设置 / 查看提醒预览');click('应用当前页预览');fireEvent.change(screen.getByLabelText('会议状态'),{target:{value:'scheduled'}});await screen.findByText('Meeting a');expect(screen.getByText(/尚未设置当前页预览/)).toBeTruthy();
});
it('loads a saved zero preference only on request and clears preview when the saved revision/time changes',()=>{
 const meeting={...row(),data:{...row().data,reminderLeadSeconds:0 as const}};
 const view=render(<MeetingReminderPreview meeting={meeting}/>);
 expect(screen.getByText(/已保存提醒偏好：会议开始时/)).toBeTruthy();
 click('设置 / 查看提醒预览');
 expect((screen.getByLabelText('预览提前量') as HTMLSelectElement).value).toBe('900');
 click('载入已保存偏好到预览');
 expect((screen.getByLabelText('预览提前量') as HTMLSelectElement).value).toBe('0');
 expect(screen.getByText(/尚未设置当前页预览/)).toBeTruthy();
 click('应用当前页预览');
 expect(screen.getByText(/本地模拟，未调度.*2099-10-21T00:00:00.000Z/)).toBeTruthy();
 view.rerender(<MeetingReminderPreview meeting={{...meeting,revision:2,data:{...meeting.data,startsAt:'2099-10-22T10:00:00.000Z',endsAt:'2099-10-22T11:00:00.000Z'}}}/>);
 expect(screen.getByText(/尚未设置当前页预览/)).toBeTruthy();
 click('设置 / 查看提醒预览');click('载入已保存偏好到预览');click('应用当前页预览');
 expect(screen.getByText(/本地模拟，未调度.*2099-10-22T10:00:00.000Z/)).toBeTruthy();
});
it('legacy absence and explicit null are not zero and cannot load a saved preference',()=>{
 for(const preference of [{},{reminderLeadSeconds:null}]){
  render(<MeetingReminderPreview meeting={{...row(),data:{...row().data,...preference}}}/>);
  click('设置 / 查看提醒预览');
  expect((screen.getByRole('button',{name:'载入已保存偏好到预览'}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('预览提前量') as HTMLSelectElement).value).toBe('900');cleanup();
 }
});
