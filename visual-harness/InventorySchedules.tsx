import React, {useEffect, useRef, useState} from 'react';
import {nextScheduleOccurrence, validateScheduleCadence, type ScheduleCadence} from '../scheduler/cadence.mjs';
import {useUnsavedWork} from '../candidate/src/components/unsaved-work';
import {InventoryRecovery, recoveryKey, type InventoryDraft, type InventoryPending} from './inventory-recovery.mjs';

type Scope = {workspaceId: string | null; folderId: string | null};
type Schedule = {id: string; state: string; nextDue: number | null; definition: {scope: Scope; cadence: ScheduleCadence}};
type Run = {id: string; schedule_id: string; state: string; due: number; attempt: number; error: string | null};
type ResultView = {runId: string; loading: true} | {runId: string; loading: false; value: unknown};
type Draft = {kind: ScheduleCadence['kind']; delay: string; time: string; timezone: string; weekdays: number[]};
type Pending = InventoryPending;
const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const states: Record<string, string> = {active: '运行中', paused: '已暂停', completed: '已完成', cancelled: '已取消'};
const commonZones = ['UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Hong_Kong', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];

class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {super(message);}
}
async function request(path: string, body?: unknown, recoveryScope?: string) {
  const response = await fetch('/api/local-scheduler/' + path, body === undefined ? (recoveryScope ? {headers: {'X-Yanyu-Recovery-Scope': recoveryScope}} : undefined) : {
    method: 'POST', headers: {'Content-Type': 'application/json', ...(recoveryScope ? {'X-Yanyu-Recovery-Scope': recoveryScope} : {})}, body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new RequestError(value.error?.message ?? '请求失败', response.status, value.error?.code);
  return value;
}
function defaultTimezone() {
  try {return validateScheduleCadence({kind: 'daily', time: '09:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone}).timezone;}
  catch {return 'UTC';}
}
export function inventoryCadence(draft: Draft, now: number): ScheduleCadence {
  let timezone: string;
  try {timezone = validateScheduleCadence({kind: 'daily', time: '09:00', timezone: draft.timezone.trim()}).timezone;}
  catch {throw Error('请输入有效的 IANA 时区，例如 Asia/Shanghai 或 UTC');}
  if (draft.kind === 'once') {
    const seconds = Number(draft.delay);
    if (!draft.delay.trim() || !Number.isInteger(seconds) || seconds < 5 || seconds > 86400) throw Error('延迟必须是 5–86400 秒');
    const at = new Date(now + seconds * 1000);
    if (!Number.isFinite(at.getTime()) || at.getUTCFullYear() > 2099 || at.getUTCFullYear() < 1970) throw Error('运行日期必须在 1970–2099 年之间');
    return validateScheduleCadence({kind: 'once', at: at.toISOString(), timezone});
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) throw Error('请选择有效的运行时间（00:00–23:59）');
  if (draft.kind === 'weekly' && draft.weekdays.length === 0) throw Error('每周计划至少选择一天');
  return validateScheduleCadence(draft.kind === 'weekly'
    ? {kind: 'weekly', time: draft.time, timezone, weekdays: draft.weekdays}
    : {kind: 'daily', time: draft.time, timezone});
}
export function inventoryTime(value: number | string | null, timezone: string) {
  if (value === null) return '无';
  try {
    return new Intl.DateTimeFormat('zh-CN', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset'}).format(new Date(value)) + '（' + timezone + '）';
  } catch {return '时间或时区不可用';}
}
function cadenceLabel(cadence: ScheduleCadence) {
  if (cadence.kind === 'once') return '一次';
  return (cadence.kind === 'daily' ? '每天' : '每周 ' + cadence.weekdays.map(day => days[day]).join('、')) + ' ' + cadence.time;
}

function initialDraft(): InventoryDraft {return {kind: 'once', delay: '15', time: '09:00', timezone: defaultTimezone(), weekdays: [1], workspace: '', folder: ''};}
export function InventorySchedules() {
  const [loaded, setLoaded] = useState<{scope: string; journal: InventoryRecovery} | null>(null);
  const [error, setError] = useState(''), [scope, setScope] = useState(''), [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setLoaded(null); setError(''); setScope('');
    void request('capabilities').then(value => {
      if (!active) return;
      recoveryKey(value.recoveryScope);
      setScope(value.recoveryScope);
      const journal = new InventoryRecovery(window.sessionStorage, value.recoveryScope, initialDraft());
      setLoaded({scope: value.recoveryScope, journal});
    }).catch(cause => {if (active) setError(cause instanceof Error ? cause.message : '清单恢复初始化失败');});
    return () => {active = false;};
  }, [version]);
  if (!loaded) return <section aria-label="清单恢复准备"><h1>本地文档清单快照</h1>{error ? <><p role="alert">{error}。未发送创建请求；现有恢复记录未自动清除。</p><button onClick={() => setVersion(v => v + 1)}>重试读取恢复记录</button>{scope && <button onClick={() => {
    if (!window.confirm('清除本页恢复记录可能丢失未确认请求标识；此前请求可能已经创建计划。请先核对已保存计划，避免重复创建。仍要清除吗？')) return;
    try {const key = recoveryKey(scope); window.sessionStorage.removeItem(key); if (window.sessionStorage.getItem(key) !== null) throw Error('记录未能清除'); setVersion(v => v + 1);} catch (cause) {setError(cause instanceof Error ? cause.message : '无法清除记录');}
  }}>清除本页恢复记录并重新打开</button>}</> : <p role="status">正在读取清单数据范围和本页恢复记录…</p>}</section>;
  return <InventorySchedulesSession key={loaded.scope + ':' + version} recoveryScope={loaded.scope} journal={loaded.journal} onReopen={() => setVersion(v => v + 1)}/>;
}
function InventorySchedulesSession({recoveryScope, journal, onReopen}: {recoveryScope: string; journal: InventoryRecovery; onReopen: () => void}) {
  const [schedules, setSchedules] = useState<Schedule[]>([]), [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState(''), [readError, setReadError] = useState(''), [notice, setNotice] = useState(journal.restored ? '已恢复本页清单草稿；未自动创建或重试计划。' : '');
  const [storageError, setStorageError] = useState(''), [revoked, setRevoked] = useState(false);
  const [busy, setBusy] = useState(false), busyRef = useRef(false), mounted = useRef(true), refreshVersion = useRef(0);
  const [draft, setDraft] = useState<InventoryDraft>(() => journal.snapshot().draft);
  const workspace = draft.workspace, folder = draft.folder;
  const [result, setResult] = useState<ResultView | null>(null), resultVersion = useRef(0);
  const [pending, setPending] = useState<Pending | null>(() => journal.snapshot().pending), pendingRef = useRef<Pending | null>(journal.snapshot().pending);
  const [choices, setChoices] = useState<{workspaces: {id: string; name: string}[]; folders: {id: string; name: string; workspaceId: string | null}[]}>({workspaces: [], folders: []});
  const [status, setStatus] = useState('正在读取运行状态'), [now, setNow] = useState(Date.now);
  useUnsavedWork(pending !== null || !!storageError);
  function editDraft(value: InventoryDraft) {
    if (busyRef.current || pendingRef.current || revoked) return;
    setDraft(value);
    try {journal.edit(value); setStorageError('');} catch (cause) {setStorageError('本页草稿恢复保存失败：' + (cause instanceof Error ? cause.message : '浏览器存储不可用'));}
  }
  const keepPending = (value: Pending | null) => {pendingRef.current = value; if (mounted.current) setPending(value);};
  const refresh = async () => {
    const version = ++refreshVersion.current;
    let values;
    try {values = await Promise.all([request('schedules', undefined, recoveryScope), request('runs', undefined, recoveryScope), request('capabilities')]);}
    catch (cause) {
      if (mounted.current && version === refreshVersion.current && cause instanceof RequestError && cause.code === 'RECOVERY_SCOPE_CONFLICT') {setRevoked(true); return;}
      throw cause;
    }
    const [s, r, c] = values;
    if (!mounted.current || version !== refreshVersion.current) return;
    if (c.recoveryScope !== recoveryScope) {setRevoked(true); return;}
    setSchedules(s); setRuns(r); setNow(Date.now()); setReadError('');
    setStatus(c.lastError ?? (c.admission?.blocked ? '保留运行记录已达上限；暂停接收新运行' : '本进程正在运行，每秒检查一次'));
  };
  useEffect(() => {
    mounted.current = true;
    const update = () => {void refresh().catch(e => {if (mounted.current) setReadError('列表读取失败：' + e.message);});};
    update();
    const controller = new AbortController();
    void fetch('/api/documents/choices', {signal: controller.signal}).then(async response => {
      if (!response.ok) throw Error('范围选项读取失败');
      const value = await response.json();
      if (mounted.current && !controller.signal.aborted) setChoices(value);
    }).catch(() => {if (mounted.current && !controller.signal.aborted) setReadError('工作区或文件夹选项读取失败；可刷新页面重试');});
    const timer = setInterval(update, 2000);
    return () => {mounted.current = false; refreshVersion.current++; resultVersion.current++; controller.abort(); clearInterval(timer);};
  }, []);
  async function action(fn: () => Promise<unknown>) {
    if (busyRef.current || revoked) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await fn();
      if (mounted.current) await refresh().catch(e => {if (mounted.current) setReadError('操作已确认，但列表刷新失败：' + e.message);});
    } catch (e) {if (mounted.current) {if (e instanceof RequestError && e.code === 'RECOVERY_SCOPE_CONFLICT') setRevoked(true); else setError(e instanceof Error ? e.message : '请求失败');}}
    finally {busyRef.current = false; if (mounted.current) setBusy(false);}
  }
  async function openResult(runId: string) {
    const version = ++resultVersion.current;
    setResult({runId, loading: true});
    try {
      const value = await request('result?id=' + encodeURIComponent(runId), undefined, recoveryScope);
      if (mounted.current && version === resultVersion.current) setResult({runId, loading: false, value});
    } catch (cause) {
      if (mounted.current && version === resultVersion.current) {setResult(null); throw cause;}
      // Dismissal suppresses stale view errors, not database-scope revocation.
      if (cause instanceof RequestError && cause.code === 'RECOVERY_SCOPE_CONFLICT') throw cause;
    }
  }
  function closeResult() {resultVersion.current++; setResult(null);}
  async function create() {
    let operation = pendingRef.current;
    if (!operation) {
      if (workspace && !choices.workspaces.some(value => value.id === workspace)) throw Error('恢复的工作区已不在当前列表，请重新选择范围');
      if (folder && !choices.folders.some(value => value.id === folder && (!workspace || value.workspaceId === workspace))) throw Error('恢复的文件夹已不在当前范围，请重新选择');
      const cadence = inventoryCadence(draft, Date.now());
      const id = crypto.randomUUID();
      journal.edit(draft);
      operation = journal.begin({id, idempotencyKey: id, handler: 'document-inventory-snapshot', scope: {workspaceId: workspace || null, folderId: folder || null}, cadence}).pending!;
      keepPending(operation); setStorageError('');
    }
    try {
      const saved = await request('schedules', operation.command, recoveryScope);
      if (!mounted.current) return;
      journal.confirm(saved);
      keepPending(null); setStorageError('');
      setNotice('计划已保存：' + operation.command.id);
    } catch (e) {
      if (!mounted.current) return;
      const rejected = !operation.uncertain && e instanceof RequestError && [400, 403, 404, 413, 429].includes(e.status);
      const next = rejected ? journal.rejectFirst() : journal.markUncertain();
      keepPending(next.pending);
      throw e;
    }
  }
  async function checkPending() {
    const operation = pendingRef.current;
    if (!operation) return;
    const saved = await request('schedules', undefined, recoveryScope);
    if (!mounted.current) return;
    if (!Array.isArray(saved)) throw Error('清单列表响应格式无效');
    const match = saved.find(value => value.id === operation.command.id);
    if (!match) {setNotice('当前列表尚未找到原请求；这不证明创建失败，可重试原创建请求。'); return;}
    journal.confirm(match); keepPending(null); setStorageError('');
    setNotice('已核对原计划：' + operation.command.id);
  }
  function discardDraft() {
    if (busyRef.current || pendingRef.current || !window.confirm('清除本页未提交的清单草稿？已保存的计划不受影响。')) return;
    try {const next = journal.discard(initialDraft()); setDraft(next.draft); setStorageError(''); setNotice('本页清单草稿已清除');}
    catch (cause) {setStorageError(cause instanceof Error ? cause.message : '草稿清除失败');}
  }
  let preview = '', previewError = '';
  try {
    const cadence = pending?.command.cadence ?? inventoryCadence(draft, now);
    const next = cadence.kind === 'once' ? cadence.at : nextScheduleOccurrence(cadence, new Date(now).toISOString(), true);
    preview = inventoryTime(next, cadence.timezone);
  } catch (e) {previewError = e instanceof Error ? e.message : '请检查时间设置';}
  const locked = busy || pending !== null;
  if (revoked) return <section aria-label="清单数据范围变化"><p role="alert">本地清单数据库已变化。旧草稿已隐藏，未在新数据范围重放请求。</p><button onClick={onReopen}>重新打开当前清单</button></section>;
  return <section style={{maxWidth: 1100, margin: '72px auto 24px', padding: 24, color: '#172b3a', background: '#fff', borderRadius: 16}}>
    <h1>本地文档清单快照</h1>
    <p>这不是 AI 研究生成。只保存运行时的本地文档名称、哈希、大小、文件夹与工作区编号；不读取正文，不调用远程服务。</p>
    <p role="status">{status}。仅在此隔离应用进程运行时执行；关闭应用后不会运行，重新打开后按合并补跑规则恢复。</p>
    <p>仅包括未放入回收站的文档。已保存的快照不会随后续重命名、移动或放入回收站而改变。旧研究计划和提供方任务未连接。</p>
    <form aria-label="创建清单计划" noValidate onSubmit={e => {e.preventDefault(); if (!pendingRef.current) void action(create);}}>
      <h2>创建清单计划</h2>
      <fieldset disabled={locked} style={{border: 0, padding: 0, display: 'grid', gap: 12}}>
        <legend>运行时间与文档范围</legend>
        <label>运行周期 <select aria-label="运行周期" value={draft.kind} onChange={e => editDraft({...draft, kind: e.target.value as Draft['kind']})}><option value="once">一次</option><option value="daily">每天</option><option value="weekly">每周</option></select></label>
        {draft.kind === 'once' ? <label>延迟秒数 <input aria-label="延迟秒数" type="number" min="5" max="86400" value={draft.delay} onChange={e => editDraft({...draft, delay: e.target.value})}/></label>
          : <label>运行时间 <input aria-label="运行时间" type="time" required value={draft.time} onChange={e => editDraft({...draft, time: e.target.value})}/></label>}
        {draft.kind === 'weekly' && <fieldset><legend>每周运行日</legend>{[1, 2, 3, 4, 5, 6, 0].map(day => <label key={day} style={{display: 'inline-block', marginRight: 16}}><input type="checkbox" checked={draft.weekdays.includes(day)} onChange={e => editDraft({...draft, weekdays: e.target.checked ? [...draft.weekdays, day].sort() : draft.weekdays.filter(value => value !== day)})}/>{days[day]}</label>)}</fieldset>}
        <label>时区（IANA） <input aria-label="时区（IANA）" list="inventory-timezones" value={draft.timezone} maxLength={100} onChange={e => editDraft({...draft, timezone: e.target.value})}/></label>
        <datalist id="inventory-timezones">{commonZones.map(zone => <option key={zone} value={zone}/>)}</datalist>
        <label>工作区 <select aria-label="快照工作区" value={workspace} onChange={e => editDraft({...draft, workspace: e.target.value, folder: ''})}><option value="">全部工作区（含未分配）</option>{workspace && !choices.workspaces.some(value => value.id === workspace) && <option value={workspace}>已恢复工作区编号：{workspace}（当前列表未找到）</option>}{choices.workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        <label>文件夹 <select aria-label="快照文件夹" value={folder} onChange={e => editDraft({...draft, folder: e.target.value})}><option value="">全部文件夹</option>{folder && !choices.folders.some(value => value.id === folder && (!workspace || value.workspaceId === workspace)) && <option value={folder}>已恢复文件夹编号：{folder}（当前范围未找到）</option>}{choices.folders.filter(f => !workspace || f.workspaceId === workspace).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
      </fieldset>
      <p aria-live="polite">{previewError || '预计首次运行：' + preview}。最终时间以保存后的计划为准{draft.kind === 'once' ? '；延迟从提交时计算' : ''}</p>
      <p>每天和每周按所选时区的当地时间运行。夏令时跳过不存在的时刻；重复时刻只取较早的一次。停机或暂停错过多次时，恢复后合并为最近一次。</p>
      <button type="submit" disabled={locked}>创建本地清单计划</button>{' '}<button type="button" disabled={locked} onClick={discardDraft}>清除未提交草稿</button>
      <p>输入与待确认请求只保存在当前浏览器标签页的会话存储中，绑定当前本地数据库。刷新或返回此页可恢复；关闭标签页、清除浏览器存储、换浏览器或更换访问地址后不保证恢复。恢复不会自动提交。</p>
    </form>
    {pending && <section aria-label="待确认创建请求"><p role="status">{busy ? '正在确认创建请求' : '创建结果尚未确认'}：{pending.command.id}。原内容与标识已保留，重试不会另建计划。已保留到本页会话存储；刷新后可核对或重试原请求，不会重新计算一次性运行时间。</p><button disabled={busy} onClick={() => void action(checkPending)}>核对原创建结果</button>{' '}<button disabled={busy} onClick={() => void action(create)}>重试原创建请求</button></section>}
    {storageError && <p role="alert">{storageError}。最新输入仍在页面中，刷新前请修复浏览器存储。</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" style={{color: '#a12323'}}>{error}</p>}
    {readError && <p role="alert" style={{color: '#a12323'}}>{readError} <button disabled={busy} onClick={() => void action(async () => {})}>刷新列表</button></p>}
    <h2>持久化计划（{schedules.length}/100）</h2>
    <p>已创建计划的时间和范围不可修改。需要调整时，先暂停旧计划，再创建新计划。</p>
    {schedules.length === 0 && <p>尚无计划。不会导入或激活旧计划。</p>}
    {schedules.map(s => <article key={s.id} aria-label={'计划 ' + s.id} style={{borderTop: '1px solid #ddd', padding: '12px 0'}}>
      <strong>{cadenceLabel(s.definition.cadence)}</strong><p>编号：{s.id} · 状态：{states[s.state] ?? s.state}</p>
      <p>{s.state === 'cancelled' || s.state === 'completed' ? '下一次：无' : (s.state === 'paused' ? '已暂停；保留的应运行时间：' : '下一次：') + inventoryTime(s.nextDue, s.definition.cadence.timezone)}{s.state === 'active' && s.nextDue !== null && s.nextDue < now ? ' · 已到期，等待本进程检查；错过多次会合并补跑' : ''}</p>
      <p>时区：{s.definition.cadence.timezone} · 范围：{s.definition.scope.workspaceId ?? '全部工作区'} / {s.definition.scope.folderId ?? '全部文件夹'}</p>
      {['active', 'paused'].includes(s.state) && <><button disabled={busy} onClick={() => void action(() => request('state', {id: s.id, state: s.state === 'active' ? 'paused' : 'active'}, recoveryScope))}>{s.state === 'active' ? '暂停' : '恢复'}</button>{' '}<button disabled={busy} onClick={() => void action(() => request('state', {id: s.id, state: 'cancelled'}, recoveryScope))}>取消计划（不可恢复）</button></>}
    </article>)}
    <h2>运行与结果（{runs.length}/10000）</h2>
    {runs.slice().reverse().map(r => <article key={r.id} style={{borderTop: '1px solid #ddd', padding: '12px 0'}}><p>{r.schedule_id} · {r.state} · 尝试 {r.attempt} · {inventoryTime(r.due, schedules.find(s => s.id === r.schedule_id)?.definition.cadence.timezone ?? 'UTC')}{r.error ? ' · ' + r.error : ''}</p>{r.state === 'completed' && <button disabled={busy} onClick={() => void action(() => openResult(r.id))}>查看快照结果</button>}</article>)}
    {result !== null && <section aria-label="快照结果"><h2>已保存的清单结果</h2><p>运行：{result.runId}</p>{result.loading ? <p role="status">正在读取快照结果…</p> : <pre style={{whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: '#f3f7fa', padding: 16}}>{JSON.stringify(result.value, null, 2)}</pre>}<button onClick={closeResult}>关闭结果</button></section>}
    <p>每次最多 250 个文档；最多保留 100 个计划、10000 个运行。没有自动清理、系统服务或通知。结果与完成状态在同一 SQLite 事务中保存；这不代表任意外部任务“恰好执行一次”。</p>
  </section>;
}
