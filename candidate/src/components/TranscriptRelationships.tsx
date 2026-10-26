import {nextRelationshipRevision, validRelationshipReceipt} from './transcript-relationship-receipt';
import {ExternalTranscriptionSource} from './external-transcription-source';
import {ResearchRequestOwner} from './local-research-search';
import {useTranscriptionStore} from './TranscriptionStoreBoundary';
import type {StoreFetch} from './transcription-store-session';
import {allowLeavingUnsavedWork, useUnsavedWork} from './unsaved-work';
import {useEffect, useRef, useState} from 'react';
export type TranscriptRelationship = {workspaceId: string | null; sessionId: string | null; revision: number; workspaceName?: string | null; sessionTitle?: string | null; stale: boolean};
type Choices = {workspaces: {id: string; name: string; count: number}[]; sessions: {id: string; title: string; workspaceId: string; count: number}[]};
export function transcriptUrl(filters: {transcriptStoreId?: string; jobId?: string; workspaceId?: string; sessionId?: string}) {
  const url = new URL(location.href); url.search = ''; url.searchParams.set('page', 'files');
  for (const [key, value] of Object.entries(filters)) if (value) url.searchParams.set(key === 'jobId' ? 'transcriptJob' : key, value);
  return `${url.pathname}${url.search}`;
}
async function choices(signal: AbortSignal | undefined, request: StoreFetch): Promise<Choices> {
  const response = await request('/api/local-asr/relationships', {signal});
  if (!response.ok) throw Error('无法读取工作区和会话，请重试');
  const data = await response.json();
  if (!Array.isArray(data.workspaces) || !Array.isArray(data.sessions)) throw Error('无法读取工作区和会话，请重试');
  return data;
}
export function TranscriptRelationshipEditor({id, relationship, onChanged}: {id: string; relationship?: TranscriptRelationship | null; onChanged: () => void}) {
  const store=useTranscriptionStore(), scopedFetch=store.fetch;
  const [draft, setDraft] = useState<{workspaceId: string; sessionId: string; revision: number; initialWorkspaceId: string; initialSessionId: string} | null>(null);
  const [catalog, setCatalog] = useState<Choices | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  // A pending or unverified write needs retention even for Clear without selector edits.
  const [unverifiedWrite, setUnverifiedWrite] = useState(false);
  const lock = useRef(false);
  // Baseline belongs to this opening and must not follow background prop refreshes.
  const dirty = draft !== null && (draft.workspaceId !== draft.initialWorkspaceId || draft.sessionId !== draft.initialSessionId);
  const protectedDraft = dirty || unverifiedWrite;
  useUnsavedWork(protectedDraft);
  const open = async () => {
    setBusy(true); setError('');
    try {
      const next = await choices(undefined, scopedFetch); store.assertActive(); setCatalog(next);
      let current = relationship;
      if (conflict) {
        const response = await scopedFetch(`/api/local-asr/jobs?${new URLSearchParams({jobId: id, scope: 'active', limit: '1'})}`);
        if (!response.ok) throw Error('无法载入最新关联，请重试');
        const data = await response.json(); store.assertActive();
        const job = data.jobs?.find((item: {id: string}) => item.id === id);
        if (!job || job.deleted_at || job.status !== 'completed') throw Error('此转写已不可关联，请刷新资料库');
        current = job.relationship;
      }
      // Fetch first: failed reloads retain the draft, and Stay refuses replacement.
      if (protectedDraft && !allowLeavingUnsavedWork()) return;
      setDraft({workspaceId: current?.workspaceId ?? '', sessionId: current?.sessionId ?? '', revision: current?.revision ?? 0, initialWorkspaceId: current?.workspaceId ?? '', initialSessionId: current?.sessionId ?? ''}); setConflict(false); setUnverifiedWrite(false);
    } catch (e) {setError(e instanceof Error ? e.message : '读取失败');}
    finally {setBusy(false);}
  };
  const save = async (clear = false) => {
    if (!draft || lock.current || conflict) return;
    lock.current = true; setBusy(true); setError('');
    try {
      // Capture intent before awaiting; refreshed props must not acknowledge a different draft.
      const intended = {workspaceId: clear ? null : draft.workspaceId || null, sessionId: clear ? null : draft.sessionId || null, expectedRevision: draft.revision};
      if (nextRelationshipRevision(intended.expectedRevision) === null) throw Error('关联版本无效，尚未发送保存请求；请重新载入后确认');
      setUnverifiedWrite(true);
      const response = await scopedFetch(`/api/local-asr/jobs/${encodeURIComponent(id)}/relationship`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...intended, idempotencyKey: crypto.randomUUID()})});
      const data = await response.json(); store.assertActive();
      if (!response.ok) {
        setConflict(true); onChanged();
        try {const next = await choices(undefined, scopedFetch); store.assertActive(); setCatalog(next);} catch {setCatalog(null);}
        throw Error(data.error?.message || '关联保存失败，请重新载入后确认');
      }
      // A same-store JSON response is not a receipt for this intent. Do not auto-retry.
      if (response.status !== 200 || !validRelationshipReceipt(data, intended)) throw Error('无法核验关联保存回执，保存可能已经发生。已保留当前选择；请明确重新载入并核对后再操作');
      setUnverifiedWrite(false); setDraft(null); onChanged();
    } catch (e) {setConflict(true); onChanged(); setError(e instanceof Error ? e.message : '保存失败，请重新载入后确认');}
    finally {lock.current = false; setBusy(false);}
  };
  const validWorkspace = !!draft && !!catalog?.workspaces.some(item => item.id === draft.workspaceId);
  const validSession = !!draft && (!draft.sessionId || !!catalog?.sessions.some(item => item.id === draft.sessionId && item.workspaceId === draft.workspaceId));
  return <section aria-label="转写关联">
    <p>关联：{relationship?.workspaceId ? <>{relationship.workspaceName || relationship.workspaceId}{relationship.sessionId ? ` / ${relationship.sessionTitle || relationship.sessionId}` : ''}</> : '未关联工作区'}</p>
    {relationship?.stale && <p role="status">关联已失效：工作区或会话已删除、移动或不可用。请明确重新关联或清除。</p>}
    {!relationship?.stale && relationship?.workspaceId && <p><a href={transcriptUrl({transcriptStoreId: store.scope!, workspaceId: relationship.workspaceId})}>查看此工作区的转写</a>{relationship.sessionId && <> · <a href={transcriptUrl({transcriptStoreId: store.scope!, workspaceId: relationship.workspaceId, sessionId: relationship.sessionId})}>查看此会话的转写</a></>}</p>}
    {!draft ? <button disabled={store.blocked || busy} onClick={() => void open()}>关联工作区 / 会话</button> : <div>
      <label>关联工作区<select aria-label="关联工作区" disabled={busy || conflict} value={draft.workspaceId} onChange={event => setDraft({...draft, workspaceId: event.target.value, sessionId: ''})}><option value="">请选择工作区</option>{!validWorkspace && draft.workspaceId && <option value={draft.workspaceId}>原工作区已不可用</option>}{catalog?.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>关联会话<select aria-label="关联会话" disabled={busy || conflict || !validWorkspace} value={draft.sessionId} onChange={event => setDraft({...draft, sessionId: event.target.value})}><option value="">仅关联工作区</option>{!validSession && draft.sessionId && <option value={draft.sessionId}>原会话已不可用</option>}{catalog?.sessions.filter(item => item.workspaceId === draft.workspaceId).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <button disabled={store.blocked || busy || conflict || !validWorkspace || !validSession} onClick={() => void save()}>保存关联</button>
      <button disabled={store.blocked || busy || conflict} onClick={() => void save(true)}>清除关联</button>
      <button disabled={busy} onClick={() => {if (protectedDraft && !allowLeavingUnsavedWork()) return; setDraft(null); setError(''); setConflict(false); setUnverifiedWrite(false);}}>取消关联修改</button>
      {conflict && <p>记录或可选目标可能已变化。重新载入后，请核对并重新选择，不会自动覆盖。<button disabled={store.blocked || busy} onClick={() => void open()}>重新载入关联</button></p>}
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
function externalChoices(value: unknown): Choices {
 const fail=()=>{throw Error('关联转写计数响应无效');};
 if(!value || typeof value!=='object')return fail();
 const data=value as Choices;
 if(!Array.isArray(data.workspaces)||!Array.isArray(data.sessions))return fail();
 const text=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=1024;
 const count=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>=0;
 if(data.workspaces.some(v=>!v||!text(v.id)||!text(v.name)||!count(v.count)) || data.sessions.some(v=>!v||!text(v.id)||!text(v.title)||!text(v.workspaceId)||!count(v.count)))return fail();
 if(new Set(data.workspaces.map(v=>v.id)).size!==data.workspaces.length || new Set(data.sessions.map(v=>v.id)).size!==data.sessions.length || data.sessions.some(v=>!data.workspaces.some(w=>w.id===v.workspaceId)))return fail();
 return {workspaces:data.workspaces.map(({id,name,count})=>({id,name,count})),sessions:data.sessions.map(({id,title,workspaceId,count})=>({id,title,workspaceId,count}))};
}
export function RelatedTranscriptLinks({workspaceId, sessionId}: {workspaceId?: string; sessionId?: string}) {
 const source=useRef(new ExternalTranscriptionSource()),owner=useRef(new ResearchRequestOwner());
 const [catalog,setCatalog]=useState<(Choices & {transcriptStoreId:string})|null>(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
 function reload(reset=false) {owner.current.cancel();setCatalog(null);setError('');if(reset)source.current=new ExternalTranscriptionSource();setRefresh(v=>v+1);}
 useEffect(()=>{
  const ticket=owner.current.begin(), captured=source.current;setCatalog(null);setError('');
  void captured.read('/api/local-asr/relationships',ticket).then(({data,transcriptStoreId})=>{
   if(!ticket.current())return;const next=externalChoices(data);captured.assertActive(transcriptStoreId);setCatalog({...next,transcriptStoreId});
  }).catch(failure=>{if(ticket.current()){setCatalog(null);setError(failure instanceof Error?failure.message:'关联转写计数暂不可用');}});
  return ()=>owner.current.cancel();
 },[workspaceId,sessionId,refresh]);
 function follow(event: React.MouseEvent<HTMLAnchorElement>,scope:string) {
  try {source.current.assertActive(scope);if(!allowLeavingUnsavedWork())event.preventDefault();}catch {event.preventDefault();setCatalog(null);setError('关联转写来源已变化，请明确重新载入来源');}
 }
 return <section aria-label="关联转写资料"><h3>关联转写资料</h3><p>打开资料库中的原转写和已保存校对文本；关联不会复制到会话消息或服务报告。计数与链接绑定本次首次读取的转写来源，不代表工作区存储身份或统一快照。</p><button disabled={source.current.blocked} onClick={()=>reload()}>刷新关联计数</button><button onClick={()=>reload(true)}>重新载入关联转写来源</button>{error&&<p role="status">{error}</p>}
 {catalog&&<ul>{catalog.workspaces.filter(item=>!workspaceId||item.id===workspaceId).map(item=><li key={item.id}><a onClick={event=>follow(event,catalog.transcriptStoreId)} href={transcriptUrl({transcriptStoreId:catalog.transcriptStoreId,workspaceId:item.id})}>{item.name} · {item.count} 条转写</a></li>)}{catalog.sessions.filter(item=>workspaceId&&item.workspaceId===workspaceId&&(!sessionId||item.id===sessionId)).map(item=><li key={item.id}><a onClick={event=>follow(event,catalog.transcriptStoreId)} href={transcriptUrl({transcriptStoreId:catalog.transcriptStoreId,workspaceId:item.workspaceId,sessionId:item.id})}>{item.title} · {item.count} 条转写</a></li>)}</ul>}
 </section>;
}
