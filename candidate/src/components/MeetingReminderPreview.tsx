import React, { useId, useState } from 'react';
import { MEETING_REMINDER_LEADS, isMeetingReminderLeadSeconds } from '../../shared/organization';
import type { OrganizationRecord } from '../../shared/organization';

const leads = MEETING_REMINDER_LEADS;
/** A changed saved record resets preview state; this does not schedule any reminder. */
export function MeetingReminderPreview({ meeting }: { meeting: OrganizationRecord<'meeting'> }) {
  return <MeetingReminderPreviewState key={`${meeting.id}:${meeting.revision}:${meeting.data.startsAt}:${meeting.data.state}:${meeting.data.reminderLeadSeconds}`} meeting={meeting}/>;
}
/** UI-only preview; reads an optional saved preference, never writes or dispatches. */
function MeetingReminderPreviewState({ meeting }: { meeting: OrganizationRecord<'meeting'> }) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(900);
  const [preview, setPreview] = useState<{leadSeconds:number; dueAt:string} | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState('');
  const due = Date.parse(meeting.data.startsAt) - draft * 1000;
  const eligible = meeting.data.state === 'scheduled';
  const savedLead = meeting.data.reminderLeadSeconds;
  const hasSavedLead = isMeetingReminderLeadSeconds(savedLead);
  const close = () => { setDraft(preview?.leadSeconds ?? 900); setError(''); setOpen(false); };
  const apply = () => {
    if (!eligible || !leads.some(([seconds]) => seconds === draft) || !Number.isFinite(due) || due <= Date.now()) {
      setError('仅可预览已安排会议且预览提醒时刻必须晚于当前时间；请调整提前量或先修改并保存会议。');
      return;
    }
    setPreview({leadSeconds:draft, dueAt:new Date(due).toISOString()});
    setCancelled(false); setError('');
  };
  return <section aria-label={`提醒预览：${meeting.data.title}`} className="border rounded p-3 mt-3 space-y-2">
    <p>提醒预览（本地模拟，未调度）：{preview ? `${leads.find(([seconds])=>seconds===preview.leadSeconds)?.[1]} · ${preview.dueAt}（UTC）` : cancelled ? '已取消当前页预览' : '尚未设置当前页预览'}</p>
    <p>预览仅在当前列表页内存，不保存到会议或后端。刷新、筛选、翻页或离开日程后清除；不会发送任何通知。</p>
    <p>已保存提醒偏好：{hasSavedLead ? leads.find(([seconds])=>seconds===savedLead)?.[1] : savedLead === null ? '已清除' : '未设置'}。仅保存设置，不代表已启用提醒。</p>
    {!open ? <button type="button" onClick={()=>{setDraft(preview?.leadSeconds ?? 900);setOpen(true);}}>设置 / 查看提醒预览</button> : <>
      <p>依据已保存会议版本 {meeting.revision}。未连接真实提醒服务；不是原版提醒能力的复原。</p>
      {!eligible && <p>已取消或已完成的会议不能应用提醒预览。</p>}
      <button type="button" disabled={!hasSavedLead} onClick={()=>{if(hasSavedLead){setDraft(savedLead);setError('');}}}>载入已保存偏好到预览</button>
      <p>载入只修改待应用提前量；仍需点击“应用当前页预览”，按本页已加载会议时间重新计算。会议在其他页面修改后请先刷新。</p>
      <label htmlFor={inputId}>预览提前量</label>
      <select id={inputId} value={draft} onChange={event=>{setDraft(Number(event.target.value));setError('');}}>{leads.map(([seconds,label])=><option key={seconds} value={seconds}>{label}</option>)}</select>
      <p>待应用时刻（UTC）：{Number.isFinite(due) ? new Date(due).toISOString() : '无效会议时间'}</p>
      <p>到达时刻不会自动执行，也不会产生“已通知”状态。</p>
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={!eligible} onClick={apply}>应用当前页预览</button>
      <button type="button" disabled={!preview} onClick={()=>{setPreview(null);setCancelled(true);setDraft(900);setError('');}}>取消当前页预览</button>
      <button type="button" onClick={close}>关闭预览设置</button>
    </>}
  </section>;
}
