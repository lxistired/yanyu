import { MeetingReminderPreview } from './MeetingReminderPreview';
import React, { useEffect, useRef, useState } from 'react';
import { organizationApi } from '../adapters/organization';
import type { OrganizationRecordPage } from '../../shared/organization';
import { agendaReturnContext, type AgendaReturnContext, AGENDA_HISTORY_LIMIT, agendaDateRange, shiftAgendaDate, type AgendaPeriod, agendaRequest, validateAgendaPage, formatAgendaInstant, type AgendaFilters, type AgendaState } from './local-meeting-agenda';

import {selectMeetingRecord, type MeetingOpenSelection} from './meeting-open-selection';
import type {MeetingAgendaBinding} from './meeting-open-intent';

const states = { scheduled:'已安排', cancelled:'已取消', completed:'已完成' };
export function LocalMeetingAgenda({ onManageOrganizations, binding, onOpenMeeting, initialFilters, onRememberFilters, initialContext, onRememberContext }: { initialContext?:AgendaReturnContext; onRememberContext?:(context:AgendaReturnContext)=>void; initialFilters?:AgendaFilters; onRememberFilters?:(filters:AgendaFilters)=>void; onManageOrganizations: () => void; binding?:MeetingAgendaBinding|null; onOpenMeeting?:(selection:MeetingOpenSelection)=>void }) {
  const currentBinding=useRef(binding);currentBinding.current=binding;
  const accepted=useRef<{epoch:number;page:OrganizationRecordPage<'meeting'>;live:()=>boolean;pins:Map<string,MeetingOpenSelection>}|null>(null);
  const [restored] = useState(()=>agendaReturnContext(initialContext));
  const [pageNotice,setPageNotice] = useState('');
  const [filters,setFilters] = useState<AgendaFilters>(()=>restored ? restored.filters : initialFilters ? {...initialFilters} : {from:'',to:'',state:''});
  const [date,setDate] = useState(()=>restored?.date ?? (initialFilters?.from.slice(0,10) || new Date().toISOString().slice(0,10)));
  const [period,setPeriod] = useState<AgendaPeriod>(()=>restored?.period ?? (initialFilters?.from && initialFilters?.to && Date.parse(initialFilters.to)-Date.parse(initialFilters.from)===7*86400000 ? 'week' : 'day'));
  const [dateError,setDateError] = useState('');
  const [offsets,setOffsets] = useState(()=>restored?.offsets ?? [0]);
  const [refresh,setRefresh] = useState(0);
  const [result,setResult] = useState<{status:'loading'|'error'|'invalid'|'ready'; page?:OrganizationRecordPage<'meeting'>}>({status:'loading'});
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const offset = offsets[offsets.length-1];
  // Invalidate immediately in event handlers, as well as in effect cleanup/unmount.
  const invalidate = () => { accepted.current=null; generation.current++; active.current?.abort(); setResult({status:'loading'}); };
  const changeFilters = (next: AgendaFilters) => { invalidate(); setPageNotice(''); setOffsets([0]); setFilters(next); };
  const chooseDate = (nextDate: string, nextPeriod = period) => {
    setDate(nextDate); setPeriod(nextPeriod);
    try { const range=agendaDateRange(nextDate,nextPeriod); setDateError(''); changeFilters({...filters,...range}); }
    catch { setDateError('请选择 1970–2100 年内的完整日期；所选日或周须全部位于支持范围内。'); }
  };
  const moveDate = (direction: -1 | 1) => {
    try { chooseDate(shiftAgendaDate(date,period,direction)); }
    catch { setDateError('无法继续翻页：请选择支持范围内的完整日期。'); }
  };
  const appliedPeriod = (value:AgendaPeriod) => { try { const range=agendaDateRange(date,value);return filters.from===range.from&&filters.to===range.to; } catch { return false; } };
  const canMove = (direction: -1 | 1) => { try { shiftAgendaDate(date,period,direction); return true; } catch { return false; } };
  useEffect(() => {
    const epoch = ++generation.current;accepted.current=null;
    const captured=binding;
    const session=captured?.session, scope=captured?.identityScope, hostGeneration=captured?.hostGeneration;
    const live=()=>{try{const now=currentBinding.current;return !!captured&&!!session&&session.available&&captured.session===session&&captured.identityScope===scope&&captured.hostGeneration===hostGeneration&&now?.session===session&&now.identityScope===scope&&now.hostGeneration===hostGeneration&&captured.isCurrent()&&now.isCurrent();}catch{return false;}};
    const bound=live();
    const controller = new AbortController(); active.current = controller;
    setResult({status:'loading'});
    let request;
    try { request = agendaRequest(filters,offset); } catch { setResult({status:'invalid'}); return () => { generation.current++; controller.abort(); }; }
    const read=bound&&session?session.guard(signal=>organizationApi.list(request,signal),controller.signal):organizationApi.list(request,controller.signal);
    read.then(value => {
      if (epoch !== generation.current || controller.signal.aborted) return;
      if(bound&&!live())return;
      const page = validateAgendaPage(value,request);
      // A saved page may disappear after an edit or cancellation. Read a valid
      // earlier position instead of displaying old rows or selecting a replacement.
      if(page.offset>0 && !page.items.length){
        setPageNotice('原页已无符合筛选的会议，已返回前面的有效分页并重新读取。');
        setOffsets(values=>{const kept=values.filter(n=>n<page.total);return kept.length?kept:[0];});
        return;
      }
      const pins=new Map<string,MeetingOpenSelection>();
      if(bound&&captured)for(const row of page.items){const pin=selectMeetingRecord(row,captured.identityScope,captured.hostGeneration);if(pin)pins.set(row.id,pin);}
      accepted.current={epoch,page,live:()=>bound&&live(),pins};
      setResult({status:'ready',page});
    }).catch(() => {
      if (epoch === generation.current && !controller.signal.aborted && (!bound || live())) setResult({status:'error'});
    });
    return () => { accepted.current=null;generation.current++; controller.abort(); };
  },[filters,offset,refresh,binding]);
  const page = result.status === 'ready' ? result.page : undefined;
  const openMeeting=(id:string)=>{const snapshot=accepted.current;const pin=snapshot?.pins.get(id);if(!snapshot||!pin||snapshot.epoch!==generation.current||snapshot.page!==page||!snapshot.live()||!snapshot.page.items.some(row=>row.id===id))return;onRememberFilters?.({...filters});onRememberContext?.({filters:{...filters},offsets:[...offsets],date,period});onOpenMeeting?.(pin);};
  const canNext = page?.nextOffset != null && page.nextOffset <= 10000 && offsets.length < AGENDA_HISTORY_LIMIT;
  return <section aria-label="本地会议议程" className="p-6 space-y-4">
    <h1 className="text-xl font-semibold">本地会议议程</h1>
    <p>只读本地已保存会议，使用固定本地模拟所有者；不是外部日历接入，也不是完整日历快照。提醒、外部会议服务未接通，不支持外部日历同步或系统通知。</p>
    <p>打开会议记录仅供查看与编辑，修改后仍需手动保存。</p>
    <button type="button" onClick={()=>{onRememberFilters?.({...filters});onRememberContext?.({filters:{...filters},offsets:[...offsets],date,period});onManageOrganizations();}}>在机构管理中管理会议</button>
    <section aria-label="按日期浏览会议" className="border rounded p-3 space-y-3">
      <h2 className="font-semibold">按日 / 周浏览</h2>
      <p>日期导航采用 UTC；一周从周一开始。会议条目仍按各自保存的时区显示，筛选按开始时间归属，不是跨日重叠查询。</p>
      <div className="flex flex-wrap gap-3">
        <label>浏览日期（UTC）<input aria-label="浏览日期（UTC）" type="date" min="1970-01-01" max="2100-12-31" value={date} onChange={e=>chooseDate(e.target.value)}/></label>
        <button type="button" aria-pressed={appliedPeriod('day')} onClick={()=>chooseDate(date,'day')}>日视图</button>
        <button type="button" aria-pressed={appliedPeriod('week')} onClick={()=>chooseDate(date,'week')}>周视图</button>
        <button type="button" disabled={!canMove(-1)} onClick={()=>moveDate(-1)}>上一{period==='day'?'天':'周'}</button>
        <button type="button" onClick={()=>chooseDate(new Date().toISOString().slice(0,10))}>今天（UTC）</button>
        <button type="button" disabled={!canMove(1)} onClick={()=>moveDate(1)}>下一{period==='day'?'天':'周'}</button>
        <button type="button" onClick={()=>{setDateError('');changeFilters({from:'',to:'',state:''});}}>清空全部筛选</button>
      </div>
      {dateError && <p role="alert">{dateError} 当前列表仍使用下方已应用范围。</p>}
      <p>已应用范围（UTC）：{filters.from || '不限开始'} 至 {filters.to || '不限结束'}（不含上限）。</p>
      <p>日 / 周按钮用于应用日期范围；初次进入和清空后显示全部日期。下方可手工调整精确 UTC 范围。</p>
    </section>
    <fieldset className="flex flex-wrap gap-3"><legend>按会议开始时间筛选（不是重叠区间查询）</legend>
      <label>开始时间 ≥ UTC 下限（可选）<input aria-label="UTC 下限" type="text" maxLength={40} placeholder="2026-10-21T00:00:00Z" value={filters.from} onChange={e=>changeFilters({...filters,from:e.target.value})}/></label>
      <label>开始时间 &lt; UTC 上限（可选）<input aria-label="UTC 上限" type="text" maxLength={40} placeholder="2026-10-22T00:00:00Z" value={filters.to} onChange={e=>changeFilters({...filters,to:e.target.value})}/></label>
      <label>会议状态<select aria-label="会议状态" value={filters.state} onChange={e=>changeFilters({...filters,state:e.target.value as AgendaState})}><option value="">全部状态</option>{Object.entries(states).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
    </fieldset>
    <p>筛选值须包含日期、秒和 Z，明确使用 UTC。每条会议按已保存的命名时区显示；机构编辑器中的 UTC 输入仍是 UTC，不按浏览器时区重解释。</p>
    <button type="button" onClick={()=>{invalidate();setOffsets([0]);setRefresh(n=>n+1);}}>刷新 / 重试</button>
    {pageNotice && <p role="status">{pageNotice}</p>}
    {result.status === 'loading' && <p role="status">正在读取本地会议…</p>}
    {result.status === 'invalid' && <p role="alert">筛选无效：请使用有效的 UTC ISO 时间（含秒和 Z，1970–2100 年），且上限晚于下限。</p>}
    {result.status === 'error' && <p role="alert">无法读取或校验本地会议。本次结果未显示；请刷新重试，或在机构管理中检查记录。</p>}
    {page && <>
      <p role="status">本页 {page.items.length} 条；读取时符合筛选共 {page.total} 条，偏移 {page.offset}。分页不是一致性快照，其他页面修改记录后请刷新。</p>
      {!page.items.length && <p>{page.offset ? '本页已无记录，数据可能已变更。请返回上一页或刷新。' : '没有符合筛选的已保存本地会议。可清空筛选或到机构管理中添加会议。'}</p>}
      <ol>{page.items.map(meeting=><li key={meeting.id} className="border rounded p-3 my-2" data-meeting-state={meeting.data.state}>
        <h2 className="font-semibold">{meeting.data.title}</h2>
        <p><strong>{states[meeting.data.state]}</strong></p>
        <p>开始：<time dateTime={meeting.data.startsAt}>{formatAgendaInstant(meeting.data.startsAt,meeting.data.timezone)}</time></p>
        <p>结束：<time dateTime={meeting.data.endsAt}>{formatAgendaInstant(meeting.data.endsAt,meeting.data.timezone)}</time></p>
        <p>显示时区：{meeting.data.timezone}</p>
        <p>地点：{meeting.data.location || '未填写'}</p>
        <MeetingReminderPreview key={`${meeting.id}:${meeting.revision}`} meeting={meeting}/>
        {onOpenMeeting&&accepted.current?.live()&&accepted.current.pins.has(meeting.id)&&<button type="button" aria-label={`打开此会议记录：${meeting.data.title}`} onClick={()=>openMeeting(meeting.id)}>打开此会议记录</button>}
      </li>)}</ol>
      {page.nextOffset != null && !canNext && <p>已达到本地分页浏览上限；请缩小开始时间范围后重试，当前列表并非全部结果。</p>}
    </>}
    <nav aria-label="会议分页"><button type="button" disabled={offsets.length === 1 || result.status === 'loading'} onClick={()=>{invalidate();setOffsets(values=>values.slice(0,-1));}}>上一页</button><button type="button" disabled={!canNext} onClick={()=>{if(page?.nextOffset != null && canNext){invalidate();setOffsets(values=>[...values,page.nextOffset!]);}}}>下一页</button></nav>
  </section>;
}
