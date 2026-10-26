import { MEETING_REMINDER_LEADS, isMeetingReminderLeadSeconds } from '../../shared/organization';
import {meetingEditorApprovalCurrent,type MeetingOpenIntent} from './meeting-open-intent';
import {acceptedMeetingRecord} from './meeting-open-receiver';
import {ServiceRecordProjectionV2Panel, type ProjectionMode} from './ServiceRecordProjectionV2Panel';
import { allowLeavingUnsavedWork, useUnsavedDraft, useUnsavedHistoryDismiss, useUnsavedWork } from './unsaved-work';
import { createContext, useContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {OrganizationWriteSession,captureOrganizationCommand,validateOrganizationRecord,type OrganizationCommand,type OrganizationEditorRecovery} from './organization-write-session';
import { Download, Plus, RefreshCw, Search } from 'lucide-react';
import type {
  LocalTarget,
  OrganizationInputDataByKind,
  OrganizationKind,
  OrganizationRecord,
  ServiceActivity,
  ServiceStatistics,
} from '../../shared/organization';
import type { JsonValue } from '../../shared/workspace';
import { organizationApi, serviceRecordBridgeApi, type ServiceRecordProjection } from '../adapters/organization';
import { ApiError, errorMessage } from '../adapters/api';
import { EmptyState, Modal, Notice, PageHeading, Spinner } from './common';

type Snapshot = Record<OrganizationKind, OrganizationRecord[]>;
type Draft = Record<string, JsonValue>;
type Editor = OrganizationEditorRecovery;
const ProjectionAuthority=createContext<ProjectionMode>({mode:'v2',session:null});
const OrganizationAuthority=createContext<OrganizationWriteSession|null>(null);
type Problem = { message: string; conflict: boolean; token?: string };
type Confirmation = { record: OrganizationRecord; action: 'remove' | 'cancel'; token: string };
const labels: Record<OrganizationKind, string> = {
  organization: '机构',
  person: '人员',
  meeting: '会议',
  'meeting-registration': '参会意向',
  'crm-contact': '客户联系人',
  'service-record': '服务记录',
  bookmark: '收藏',
  'reading-record': '阅读记录',
  'access-request': '访问申请',
  'share-draft': '分享草稿',
};
const groups: { label: string; kinds: OrganizationKind[] }[] = [
  { label: '机构与人员', kinds: ['organization', 'person'] },
  { label: '会议与参会', kinds: ['meeting', 'meeting-registration'] },
  { label: '客户与服务', kinds: ['crm-contact', 'service-record'] },
  { label: '收藏与阅读', kinds: ['bookmark', 'reading-record'] },
  { label: '访问与分享', kinds: ['access-request', 'share-draft'] },
];
const kinds = Object.keys(labels) as OrganizationKind[];
const emptySnapshot = () =>
  Object.fromEntries(kinds.map((kind) => [kind, [] as OrganizationRecord[]])) as Snapshot;
const key = () => `org-ui-${crypto.randomUUID()}`;
const slotFor = (kind: OrganizationKind, id: string) => `${kind}:${id}`;
const kindOf = (record: OrganizationRecord) => record.kind as OrganizationKind;
const row = (record: OrganizationRecord): Draft => record.data;
const value = (record: OrganizationRecord, field: string) => String(row(record)[field] ?? '');
const activityNames: Record<ServiceActivity, string> = {
  'content-read': '资料阅读',
  meeting: '会议',
  call: '通话',
  email: '邮件',
  other: '其他',
};
const statusNames: Record<string, string> = {
  scheduled: '已排期',
  cancelled: '已取消',
  completed: '已结束',
  requested: '申请中',
  'approved-locally': '仅本地批准',
  declined: '已拒绝',
  pending: '待处理',
  draft: '草稿',
  revoked: '已撤回',
  prospect: '潜在客户',
  active: '服务中',
  inactive: '非活跃',
  'buy-side': '买方机构',
  'sell-side': '卖方机构',
  company: '企业',
  other: '其他',
  roadshow: '路演',
  strategy: '策略会',
  research: '研究交流',
  forum: '论坛',
};
const targetNames: Record<LocalTarget['kind'], string> = {
  organization: '机构',
  person: '人员',
  meeting: '会议',
  workspace: '工作区',
  session: '会话',
  watchlist: '自选分组',
  'ingestion-file': '入库文件',
  'ingestion-version': '文件版本',
  'research-artifact': '研究成果',
};
function displayDate(instant: string, timezone = 'UTC') {
  try {
    return `${new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(instant))} · ${timezone}`;
  } catch {
    return instant;
  }
}
function title(record: OrganizationRecord, data?: Snapshot): string {
  if (value(record, 'name') || value(record, 'title') || value(record, 'summary'))
    return value(record, 'name') || value(record, 'title') || value(record, 'summary');
  if (record.kind === 'meeting-registration')
    return `${refName(data, 'meeting', value(record, 'meetingId'))} · ${refName(data, 'person', value(record, 'personId'))}`;
  if (record.kind === 'access-request') return value(record, 'purpose').slice(0, 80);
  const target = row(record).target as LocalTarget | undefined;
  return target ? `${targetNames[target.kind]} · ${refName(data, target.kind, target.id)}` : record.id;
}
function refName(data: Snapshot | undefined, kind: string, id: string) {
  if (!id) return '未关联';
  const record = data?.[kind as OrganizationKind]?.find((item) => item.id === id);
  return record ? `${title(record)}${record.deletedAt ? '（已删除）' : ''}` : id;
}
function identity(record: OrganizationRecord, idempotencyKey: string) {
  return { kind: kindOf(record), id: record.id, expectedRevision: record.revision, idempotencyKey };
}
function targetOf(record: OrganizationRecord): LocalTarget {
  return { kind: record.kind as LocalTarget['kind'], id: record.id, revision: record.revision };
}
function organizationFor(record: OrganizationRecord, data: Snapshot): string[] {
  if (record.kind === 'organization') return [record.id];
  if (value(record, 'organizationId')) return [value(record, 'organizationId')];
  if (record.kind === 'meeting-registration') {
    const meeting = data.meeting.find((item) => item.id === value(record, 'meetingId'));
    return meeting ? organizationFor(meeting, data) : [];
  }
  if (record.kind === 'share-draft')
    return [
      ...(row(record).recipientOrganizationIds as string[]),
      ...(row(record).recipientPersonIds as string[]).flatMap((id) => {
        const person = data.person.find((item) => item.id === id);
        return person ? organizationFor(person, data) : [];
      }),
    ];
  const target = row(record).target as LocalTarget | undefined;
  const referenced = target && data[target.kind as OrganizationKind]?.find((item) => item.id === target.id);
  return referenced ? organizationFor(referenced, data) : [];
}

/** All records and decisions are local. This view never authenticates, sends invitations, or grants access. */
export function OrganizationManager({session:providedSession,projection={mode:'v2',session:null},visible=true,routeEpoch=0,meetingOpenIntent=null}:{meetingOpenIntent?:MeetingOpenIntent|null;session?:OrganizationWriteSession;projection?:ProjectionMode;visible?:boolean;routeEpoch?:number}={}) {
  const [ownedSession]=useState(()=>new OrganizationWriteSession());
  const session=providedSession??ownedSession;
  const [,renderSession]=useState(0);
  const visibleRef=useRef(visible);visibleRef.current=visible;
  const selectionRef=useRef(meetingOpenIntent);selectionRef.current=meetingOpenIntent;
  const routeRef=useRef(routeEpoch);routeRef.current=routeEpoch;
  const selectionController=useRef<AbortController|null>(null);
  const selectionActions=useRef(0);
  const invalidateSelectedOpen=useCallback(()=>{
    selectionActions.current++;
    selectionController.current?.abort();
    const intent=selectionRef.current;if(intent?.pending)intent.pending=false;
  },[]);
  // Capture events before RecordEditor's deferred snapshot effect can retain new input.
  // Even a subsequently vetoed local action withdraws the handoff, but keeps the draft.
  const [catalog,setCatalog]=useState<{generation:number;route:number;complete:boolean}|null>(null);
  const catalogRef=useRef(catalog);catalogRef.current=catalog;
  const guardedApi=useMemo(()=>({
    list:(input:Parameters<typeof organizationApi.list>[0],signal?:AbortSignal)=>session.guard(s=>organizationApi.list(input,s),signal),
    get:(input:Parameters<typeof organizationApi.get>[0],signal?:AbortSignal)=>session.guard(s=>organizationApi.get(input,s),signal),
    exportMeetingIcs:(input:Parameters<typeof organizationApi.exportMeetingIcs>[0],signal?:AbortSignal)=>session.guard(s=>organizationApi.exportMeetingIcs(input,s),signal),
  }),[session]);
  const [data, setData] = useState<Snapshot>(emptySnapshot);
  const dataRef = useRef(data); dataRef.current = data;
  const [projectionEpoch, setProjectionEpoch] = useState(0);
  const projectionSession=projection.mode==='v2'?projection.session:null;
  const discardProjection=useCallback(()=>{projectionSession?.discardUnsubmittedDraft();},[projectionSession]);
  const dirtyProjections = useRef(new Set<string>());
  const projectionDirtyChanged = useCallback((id: string, dirty: boolean) => {
    if (dirty) dirtyProjections.current.add(id);
    else dirtyProjections.current.delete(id);
  }, []);
  const [kind, setKind] = useState<OrganizationKind>('organization');
  const [query, setQuery] = useState('');
  const [organization, setOrganization] = useState('');
  const [trash, setTrash] = useState(false);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState('');
  const [writeError, setWriteError] = useState(()=>session.draftRetentionIncomplete?'上次超出容量的内容未保留；当前恢复的是上一次容量内的草稿。':'');
  const [editor, setEditorState] = useState<Editor | null>(()=>session.editor);
  const editorRef=useRef(editor);editorRef.current=editor;
  const setEditor:typeof setEditorState=useCallback((next)=>{setEditorState(old=>{const value=typeof next==='function'?next(old):next;try{session.setEditor(value);}catch{setWriteError('草稿超出恢复容量。超限内容仅在当前编辑框，离开页面会丢失；请先缩短内容。');}return value;});},[session]);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [pending, setPending] = useState(new Set<string>());
  const [problems, setProblems] = useState<Record<string, Problem>>({});
  const mounted = useRef(false);
  const readGeneration = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const reloadGeneration = useRef(0);
  const locks = useRef(new Set<string>());
  useEffect(()=>session.subscribe(()=>renderSession(v=>v+1)),[session]);
  useUnsavedWork(!providedSession&&Boolean(session.pending));

  const refresh = useCallback(async () => {
    const generation = ++readGeneration.current;
    const receivingRoute=routeRef.current;
    const selectedRefresh=Boolean(selectionRef.current?.pending);
    catalogRef.current=null;setCatalog(null);
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const current = () =>
      mounted.current && session.available && !controller.signal.aborted && generation === readGeneration.current;
    setLoading(true);
    setReadError('');
    try {
      const entries = await Promise.all(
        kinds.map(async (target) => {
          const records: OrganizationRecord[] = [];
          let offset = 0;
          let expectedTotal:number|null=null;
          let complete=true;
          const ids=new Set<string>();
          for (;;) {
            const result = await guardedApi.list(
              { kind: target, includeDeleted: true, limit: 200, offset },
              controller.signal,
            );
            if (!current()) return [target, []] as const;
            if(!Number.isSafeInteger(result.total)||result.total<0||result.total>10_000||result.offset!==offset||
              (expectedTotal!==null&&expectedTotal!==result.total)||result.items.length>200)complete=false;
            if(selectedRefresh&&!complete)throw new Error('目录读取不完整；不能打开所选会议');
            expectedTotal=result.total;
            for(const item of result.items){if(item.kind!==target||ids.has(item.id))complete=false;ids.add(item.id);}
            records.push(...result.items);
            if(result.nextOffset===null){if(records.length!==result.total)complete=false;}
            else if(result.nextOffset!==offset+result.items.length||result.nextOffset>=result.total)complete=false;
            if(selectedRefresh&&!complete)throw new Error('目录读取不完整；不能打开所选会议');
            if (result.nextOffset === null) break;
            if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset <= offset || result.nextOffset > 10_000)
              throw new Error('目录超出本页读取范围，请缩小本地数据规模后重试；未展示不完整统计');
            offset = result.nextOffset;
          }
          return [target, records, complete] as const;
        }),
      );
      if (current()) {
        const complete=entries.every(entry=>entry[2]===true);
        if(selectedRefresh&&!complete){
          const failed={generation,route:receivingRoute,complete:false};
          catalogRef.current=failed;setCatalog(failed);return;
        }
        const next = Object.fromEntries(entries.map(([target,records])=>[target,records])) as Snapshot;
        // A changed result can move/remove a row or remount its revision-bound
        // projection panel. Ask before applying that snapshot, not before the read.
        if (!selectedRefresh && JSON.stringify(next['service-record']) !== JSON.stringify(dataRef.current['service-record'])) {
          if (dirtyProjections.current.size > 0 && !allowLeavingUnsavedWork()) {
            setReadError('目录更新会替换未保存的月报投影选择；已保留草稿和上次目录，请保存或取消预览后刷新');
            return;
          }
          discardProjection();
          setProjectionEpoch((old) => old + 1);
        }
        setData(next);
        const accepted={generation,route:receivingRoute,complete};
        catalogRef.current=accepted;setCatalog(accepted);
        setLoaded(true);
      }
    } catch (error) {
      if (current()) {setReadError(errorMessage(error));const failed={generation,route:receivingRoute,complete:false};catalogRef.current=failed;setCatalog(failed);}
    } finally {
      if (current()) setLoading(false);
    }
  }, [guardedApi,discardProjection]);
  const clearTransient = useCallback(() => {
    discardProjection();
    epoch.current++;
    setEditor(null);
    setConfirmation(null);
    setProjectionEpoch((old) => old + 1);
  }, [discardProjection]);
  const dismiss = useCallback(() => {
    invalidateSelectedOpen();
    if (!allowLeavingUnsavedWork()) return false;
    clearTransient();
    return true;
  }, [clearTransient,invalidateSelectedOpen]);
  const historyIssue = useUnsavedHistoryDismiss(()=>{if(visibleRef.current&&!providedSession)clearTransient();});
  useEffect(() => {
    mounted.current = true;
    const lifecycle = epoch;
    if(visibleRef.current)void refresh();
    return () => {
      mounted.current = false;
      lifecycle.current++;
      readController.current?.abort();
    };
  }, [refresh]);
  useEffect(()=>{if(visible&&mounted.current)void refresh();else readController.current?.abort();},[visible,routeEpoch,refresh,meetingOpenIntent]);
  useEffect(()=>()=>{queueMicrotask(()=>{if(!mounted.current&&!providedSession)session.detach();});},[session,providedSession]);
  useLayoutEffect(()=>{
    catalogRef.current=null;
    selectionController.current?.abort();
    return()=>{selectionController.current?.abort();};
  },[visible,routeEpoch,session,meetingOpenIntent]);
  useEffect(()=>{
    const intent=meetingOpenIntent;
    if(!intent?.pending||!visible||intent.epoch!==routeEpoch||intent.session!==session)return;
    const active=()=>mounted.current&&visibleRef.current&&routeRef.current===routeEpoch&&selectionRef.current===intent&&intent.current();
    const blocked=()=>!meetingEditorApprovalCurrent(intent)||Boolean(projectionSession?.unsavedState().pending);
    if(!active())return;
    const reject=()=>{if(active()){intent.pending=false;setWriteError('无法打开所选会议：记录、目录或草稿状态已变化。请返回议程刷新后重新打开；现有草稿保持不变。');}};
    if(blocked()){reject();return;}
    const accepted=catalogRef.current;
    if(!accepted||accepted!==catalog||accepted.route!==routeEpoch||accepted.generation!==readGeneration.current||loading)return;
    if(!accepted.complete||readError){reject();return;}
    const action=selectionActions.current;
    const controller=new AbortController();selectionController.current=controller;
    const current=()=>!controller.signal.aborted&&active()&&selectionActions.current===action&&catalogRef.current===accepted&&accepted.generation===readGeneration.current;
    void (async()=>{
      try{
        const raw=await guardedApi.get({kind:'meeting',id:intent.selection.id,includeDeleted:false},controller.signal);
        if(!current())return;
        if(blocked()){reject();return;}
        const record=acceptedMeetingRecord(raw,intent.selection,dataRef.current);
        if(!record){reject();return;}
        if(!current()||blocked())return;
        // One synchronous commitment: consume before replacing the approved ordinary editor.
        // Never call dismiss/clearTransient or touch the unrelated projection session.
        intent.pending=false;
        epoch.current++;reloadGeneration.current++;
        const next:Editor={kind:'meeting',record,token:key()};
        session.setEditor(next);editorRef.current=next;setEditorState(next);
        setKind('meeting');setQuery('');setOrganization('');setTrash(false);setPage(0);
        setConfirmation(null);setNotice('');setWriteError('');
        setProblems(old=>({...old,[slotFor('meeting',record.id)]:{message:'',conflict:false}}));
      }catch(error){if(current())reject();}
    })();
    return()=>{controller.abort();if(selectionController.current===controller)selectionController.current=null;};
  },[meetingOpenIntent,visible,routeEpoch,session,projectionSession,catalog,loading,readError,guardedApi]);
  function navigate(next: OrganizationKind) {
    if (!dismiss()) return false;
    setKind(next);
    setQuery('');
    setPage(0);
    setNotice('');
    return true;
  }
  function openEditor(next: OrganizationKind, record?: OrganizationRecord, seed?: Draft) {
    if (!dismiss()) return false;
    setNotice('');
    if (record)
      setProblems((old) => ({ ...old, [slotFor(next, record.id)]: { message: '', conflict: false } }));
    setEditor({ kind: next, ...(record?{record}:{}), ...(seed?{seed}:{}), token: key() });
    return true;
  }
  function openConfirmation(record: OrganizationRecord, action: Confirmation['action']) {
    if (!dismiss()) return false;
    setNotice('');
    setProblems((old) => ({
      ...old,
      [slotFor(kindOf(record), record.id)]: { message: '', conflict: false },
    }));
    setConfirmation({ record, action, token: key() });
  }
  function changeScope() {
    if (!dismiss()) return false;
    setNotice('');
    return true;
  }
  const consumeCompletion=useCallback(()=>{
    if(!mounted.current||!session.available)return;
    const rejected=session.takeRejection();
    if(rejected){setWriteError(rejected.message);const {command}=rejected;if(rejected.conflict&&command.id)setProblems(old=>({...old,[slotFor(command.kind,command.id!)]:{conflict:true,token:command.token,message:rejected.message}}));}
    const failed=session.pending;
    if(failed?.conflict&&failed.command.id){const command=failed.command;setProblems(old=>({...old,[slotFor(command.kind,command.id!)]:{conflict:true,token:command.token,message:'记录版本可能已变化。可读取最新版本核对；原操作仍需确认，不能另发写入。'}}));}
    const completion=session.takeCompletion();if(!completion)return;
    const {record,command}=completion;
    setData(old=>({...old,[record.kind]:old[kindOf(record)].some(item=>item.id===record.id)?old[kindOf(record)].map(item=>item.id===record.id&&item.revision<=record.revision?record:item):[record,...old[kindOf(record)]]}));
    const currentNotice=`${command.message} 以上为原操作回执；当前记录${record.deletedAt?'已在回收站':'未删除'}，以本次读取结果为准。`;
    setNotice(currentNotice);setWriteError('');
    const latest=session.editor;
    if(command.token&&latest?.token===command.token){
      if(!session.draftRetentionIncomplete&&session.editorVersion===command.draftVersion){setEditor(null);}
      else {const incomplete=session.draftRetentionIncomplete;setEditor(old=>old&&old.token===command.token?{...(incomplete?old:latest),record}:old);setNotice(`${currentNotice} ${incomplete?'当前编辑框含未完整保留的超限内容，请先缩短。':'较新的草稿仍保留，请核对后再保存。'}`);}
    }
    setConfirmation(old=>old?.token===command.token?null:old);
    if(visibleRef.current)void refresh();
  },[session,refresh,setEditor]);
  useEffect(()=>{consumeCompletion();return session.subscribe(consumeCompletion);},[session,consumeCompletion]);
  async function recover(){
    invalidateSelectedOpen();
    try{await session.recover();if(mounted.current)consumeCompletion();}
    catch(error){if(mounted.current&&session.available)setWriteError(errorMessage(error));}
  }
  async function mutate(operation:'create'|'update'|'remove'|'restore',input:Record<string,unknown>,options:{token?:string;message:string}){
    setNotice('');setWriteError('');
    try{
      const command=captureOrganizationCommand(operation,input,{...options,draftVersion:session.editorVersion});
      readGeneration.current++;readController.current?.abort();setLoading(false);
      await session.submit(command);
      if(mounted.current)consumeCompletion();
    }catch(error){if(mounted.current&&session.available)setWriteError(errorMessage(error));}
  }
  function save(draft:Draft){
    if(!editor)return;
    const {kind:target,record,token}=editor;
    const input=record?{kind:target,id:record.id,expectedRevision:record.revision,patch:draft}:{kind:target,data:draft};
    void mutate(record?'update':'create',input,{token,message:`${labels[target]}已保存到本地${['meeting-registration','access-request','share-draft'].includes(target)?'；没有发送消息或授予访问权限':''}。`});
  }
  function action(record:OrganizationRecord,action:'remove'|'restore'|'cancel',token?:string){
    const input={kind:kindOf(record),id:record.id,expectedRevision:record.revision,...(action==='cancel'?{patch:{state:'cancelled'}}:{})};
    void mutate(action==='cancel'?'update':action,input,{token,message:action==='cancel'?'会议已在本地标为取消；未通知参会人，原有参会记录保留。':action==='remove'?'已移入回收站，可恢复。关联记录保持原样。':'已恢复本地记录；原有状态保持不变。'});
  }
  async function download(record: OrganizationRecord) {
    const slot = `ics:${record.id}`;
    if (locks.current.has(slot)) return;
    const generation = epoch.current;
    locks.current.add(slot);
    setPending(new Set(locks.current));
    setNotice('');
    setProblems((old) => ({
      ...old,
      [slotFor(kindOf(record), record.id)]: { conflict: false, message: '' },
    }));
    try {
      const result = await guardedApi.exportMeetingIcs({
        id: record.id,
        expectedRevision: record.revision,
      });
      if (!mounted.current || !session.available || epoch.current !== generation) return;
      const url = URL.createObjectURL(new Blob([result.content], { type: result.mediaType }));
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setNotice('已生成本地 ICS 下载；没有发送邀请或写入任何日历。');
    } catch (error) {
      if (mounted.current && session.available && epoch.current === generation)
        setProblems((old) => ({
          ...old,
          [slotFor(kindOf(record), record.id)]: {
            conflict: false,
            message: `下载失败：${errorMessage(error)}`,
          },
        }));
    } finally {
      locks.current.delete(slot);
      if (mounted.current) setPending(new Set(locks.current));
    }
  }
  async function reloadEditor() {
    invalidateSelectedOpen();
    if (!editor?.record) return;
    const captured = editor;
    const navigation = epoch.current;
    const generation = ++reloadGeneration.current;
    const current = () =>
      mounted.current && session.available && epoch.current === navigation && reloadGeneration.current === generation;
    try {
      const record = validateOrganizationRecord(await guardedApi.get({ kind: captured.kind, id: captured.record!.id,includeDeleted:true }),captured.kind,captured.record!.id);
      if (!current() || !allowLeavingUnsavedWork()) return;
      setEditor((old) =>
        old?.token === captured.token ? { kind: captured.kind, record, token: key() } : old,
      );
      setProblems((old) => ({
        ...old,
        [slotFor(captured.kind, record.id)]: { conflict: false, message: '' },
      }));
    } catch (error) {
      if (current())
        setProblems((old) => ({
          ...old,
          [slotFor(captured.kind, captured.record!.id)]: {
            conflict: true,
            token: captured.token,
            message: `无法重新载入：${errorMessage(error)}。草稿仍保留。`,
          },
        }));
    }
  }
  const group = groups.find((item) => item.kinds.includes(kind))!;
  const filtered = data[kind].filter(
    (record) =>
      Boolean(record.deletedAt) === trash &&
      (!organization || organizationFor(record, data).includes(organization)) &&
      (!query.trim() ||
        `${title(record, data)} ${JSON.stringify(record.data)}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())),
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / 24));
  const currentPage = Math.min(page, pageCount - 1);
  const editorSlot = editor ? slotFor(editor.kind, editor.record?.id ?? editor.token) : '';
  const confirmSlot = confirmation ? slotFor(kindOf(confirmation.record), confirmation.record.id) : '';
  const confirmProblem =
    confirmation && problems[confirmSlot]?.token === confirmation.token
      ? problems[confirmSlot]
      : undefined;
  const boundary = '机构身份均未核验。会议接入、短信、身份认证与外部分享均未配置；本地批准不授予资料权限。';
  return (
    <OrganizationAuthority.Provider value={session}><ProjectionAuthority.Provider value={projection}><div className="automation-manager" hidden={!visible} onClickCapture={invalidateSelectedOpen} onInputCapture={invalidateSelectedOpen} onChangeCapture={invalidateSelectedOpen} onSubmitCapture={invalidateSelectedOpen}>
      {historyIssue && <p role="alert">{historyIssue}</p>}
      <PageHeading
        eyebrow="LOCAL RELATIONSHIPS"
        title="机构与协作"
        description="把机构、人员、会议与服务事实连接起来，所有变更仅保存到当前本地工作区。"
        actions={
          <button className="secondary" onClick={() => void refresh()} disabled={pending.size > 0}>
            <RefreshCw size={16} /> 刷新目录
          </button>
        }
      />
      <Notice>{boundary}</Notice>
      <nav className="automation-tabs" aria-label="协作工作区">
        {groups.map((item) => (
          <button
            key={item.label}
            className={`filter-chip ${group === item ? 'selected' : ''}`}
            aria-pressed={group === item}
            onClick={() => navigate(item.kinds[0])}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="automation-controls">
        <div className="company-tabs" aria-label="记录类型">
          {group.kinds.map((item) => (
            <button
              key={item}
              aria-pressed={item === kind}
              className={item === kind ? 'selected' : ''}
              onClick={() => navigate(item)}
            >
              {labels[item]} <span>{data[item].filter((r) => !r.deletedAt).length}</span>
            </button>
          ))}
        </div>
        <button
          className="primary"
          disabled={!loaded || loading || Boolean(readError)}
          onClick={() =>
            openEditor(kind, undefined, organization ? { organizationId: organization } : undefined)
          }
        >
          <Plus size={16} /> 新建{labels[kind]}
        </button>
      </div>
      <div className="automation-controls automation-form">
        <label className="company-search">
          <Search size={16} />
          <input
            aria-label="搜索本地记录"
            maxLength={200}
            value={query}
            placeholder="搜索名称、标签或备注"
            onChange={(event) => {
              if (!changeScope()) return;
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </label>
        <label>
          机构范围{' '}
          <select
            aria-label="机构范围"
            value={organization}
            onChange={(event) => {
              if (!changeScope()) return;
              setOrganization(event.target.value);
              setPage(0);
            }}
          >
            <option value="">全部机构</option>
            {data.organization
              .filter((item) => !item.deletedAt)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {title(item)}
                </option>
              ))}
          </select>
        </label>
        <label className="automation-check">
          <input
            type="checkbox"
            checked={trash}
            onChange={(event) => {
              if (!changeScope()) return;
              setTrash(event.target.checked);
              setPage(0);
            }}
          />{' '}
          回收站
        </label>
        <span className="muted">
          {filtered.length} 条{trash ? '已删除' : '本地'}记录
        </span>
      </div>
      {loading && (
        <p role="status">
          <Spinner /> 正在读取本地目录…
        </p>
      )}
      {readError && (
        <Notice kind="error">
          读取失败：{readError}。{loaded ? '目前显示的是上次读取的数据。' : '尚未取得记录。'}{' '}
          <button className="text-button" onClick={() => void refresh()}>
            重试读取
          </button>
        </Notice>
      )}
      {notice && <Notice kind="success">{notice}</Notice>}
      {writeError && <Notice kind="error">{writeError}</Notice>}
      {session.pending&&<section aria-label="机构待确认操作"><p role="alert">{session.pending.message} 当前草稿与原操作分开处理；确认原操作前不会发送另一项写入。</p><button disabled={['sending','reading'].includes(session.pending.phase)} onClick={()=>void recover()}>{session.pending.ackId?'重试读取当前记录':'重试原操作'}</button></section>}
      <p className="muted">草稿与待确认操作仅保留在本次页面访问的内存中；刷新、关闭应用或身份失效后无法恢复。离开页面不会撤销已经提交的操作。</p>
      {group.kinds.includes('service-record') && (
        <ServiceSummary
          organizationId={organization}
          data={data}
          revision={data['service-record']}
          onOpen={(record) => {
            // Open once so a dirty editor asks only once before replacement.
            if (!openEditor('service-record', record)) return;
            setKind('service-record');
            setQuery('');
            setPage(0);
          }}
        />
      )}
      {!loading && !readError && !filtered.length && (
        <EmptyState
          title={trash ? '回收站为空' : query || organization ? '没有匹配记录' : `暂无${labels[kind]}`}
          description={
            trash
              ? '软删除的记录会出现在这里，可按原状态恢复'
              : '新增记录或调整搜索和机构范围；这里没有预设的真实机构或服务数据'
          }
        />
      )}
      <section className="company-grid" aria-label={`${labels[kind]}列表`} aria-busy={loading}>
        {filtered.slice(currentPage * 24, (currentPage + 1) * 24).map((record) => {
          const slot = slotFor(kind, record.id),
            busy = pending.has(slot),
            target = row(record).target as LocalTarget | undefined;
          return (
            <article
              key={record.id}
              className={`company-card ${record.deletedAt ? 'company-deleted' : ''}`}
              aria-label={title(record, data)}
            >
              <div className="company-card-top">
                <h2>{title(record, data)}</h2>
                <span className="source-pill">
                  {record.deletedAt
                    ? '已删除'
                    : record.kind === 'organization'
                      ? '未核验'
                      : statusNames[value(record, 'state')] ||
                        statusNames[value(record, 'stage')] ||
                        '本地记录'}
                </span>
              </div>
              <RecordDetails record={record} data={data} projectionEpoch={projectionEpoch} onProjectionDirtyChange={projectionDirtyChanged} />
              {target && <TargetStatus target={target} />}
              <p className="muted automation-prewrap">
                ID {record.id} · 版本 {record.revision}
                <br />
                更新于 {displayDate(record.updatedAt)}
              </p>
              <div className="company-row-actions automation-actions">
                {record.deletedAt ? (
                  <button className="secondary" disabled={busy} onClick={() => action(record, 'restore')}>
                    恢复{labels[kind]}
                  </button>
                ) : (
                  <>
                    <button className="secondary" disabled={busy} onClick={() => openEditor(kind, record)}>
                      编辑{labels[kind]}
                    </button>
                    {kind === 'organization' && (
                      <>
                        <button
                          className="text-button"
                          onClick={() => openEditor('person', undefined, { organizationId: record.id })}
                        >
                          添加人员
                        </button>
                        <button
                          className="text-button"
                          onClick={() => openEditor('crm-contact', undefined, { organizationId: record.id })}
                        >
                          建立客户
                        </button>
                      </>
                    )}
                    {kind === 'person' && (
                      <button
                        className="text-button"
                        onClick={() => openEditor('meeting-registration', undefined, { personId: record.id })}
                      >
                        登记参会
                      </button>
                    )}
                    {kind === 'meeting' && (
                      <>
                        <button
                          className="secondary"
                          disabled={pending.has(`ics:${record.id}`)}
                          onClick={() => void download(record)}
                        >
                          <Download size={14} /> 下载 ICS
                        </button>
                        {value(record, 'state') === 'scheduled' && (
                          <>
                            <button
                              className="text-button"
                              onClick={() =>
                                openEditor('meeting-registration', undefined, { meetingId: record.id })
                              }
                            >
                              登记参会
                            </button>
                            <button
                              className="text-button company-danger"
                              disabled={busy}
                              onClick={() => openConfirmation(record, 'cancel')}
                            >
                              取消会议
                            </button>
                          </>
                        )}
                      </>
                    )}
                    {kind === 'crm-contact' && (
                      <button
                        className="text-button"
                        onClick={() =>
                          openEditor('service-record', undefined, {
                            organizationId: value(record, 'organizationId'),
                            contactId: record.id,
                          })
                        }
                      >
                        登记服务
                      </button>
                    )}
                    {['organization', 'person', 'meeting'].includes(kind) && (
                      <button
                        className="text-button"
                        onClick={() =>
                          openEditor('bookmark', undefined, {
                            title: title(record),
                            target: targetOf(record),
                          })
                        }
                      >
                        收藏此记录
                      </button>
                    )}
                    {target && (
                      <button
                        className="text-button"
                        onClick={() => openEditor('reading-record', undefined, { target })}
                      >
                        登记阅读
                      </button>
                    )}
                    <button
                      className="text-button company-danger"
                      disabled={busy}
                      onClick={() => openConfirmation(record, 'remove')}
                    >
                      移入回收站
                    </button>
                  </>
                )}
              </div>
              {problems[slot]?.message && <Notice kind="error">{problems[slot].message}</Notice>}
            </article>
          );
        })}
      </section>
      {pageCount > 1 && (
        <nav className="automation-actions" aria-label="目录分页">
          <button
            className="secondary"
            disabled={currentPage === 0}
            onClick={() => {
              if (!changeScope()) return;
              setPage(currentPage - 1);
            }}
          >
            上一页
          </button>
          <span>
            第 {currentPage + 1} / {pageCount} 页
          </span>
          <button
            className="secondary"
            disabled={currentPage + 1 >= pageCount}
            onClick={() => {
              if (!changeScope()) return;
              setPage(currentPage + 1);
            }}
          >
            下一页
          </button>
        </nav>
      )}
      {visible && editor && (
        <Modal title={`${editor.record ? '编辑' : '新建'}${labels[editor.kind]}`} onClose={dismiss} wide>
          <RecordEditor
            key={editor.token}
            editor={session.editor?.token===editor.token?session.editor:editor}
            data={data}
            busy={Boolean(session.pending&&['sending','reading'].includes(session.pending.phase))}
            problem={
              !problems[editorSlot]?.token || problems[editorSlot]?.token === editor.token
                ? problems[editorSlot]
                : undefined
            }
            onSnapshot={(draft,tagText,dirty,baseline)=>{try{session.setEditor({...editor,draft,tagText,dirty,baseline});}catch{setWriteError('草稿超出恢复容量。超限内容仅在当前编辑框，离开页面会丢失；请先缩短内容。');}}}
            onSave={save}
            onClose={dismiss}
            onReload={() => void reloadEditor()}
          />
        </Modal>
      )}
      {visible && confirmation && (
        <Modal title={confirmation.action === 'cancel' ? '确认取消会议' : '确认软删除'} onClose={dismiss}>
          <div className="company-confirm">
            <p>「{title(confirmation.record, data)}」</p>
            <p>
              {confirmation.action === 'cancel'
                ? '将会议标为已取消，保留议程与参会记录，不能重新激活。不会通知参会人或撤回他们的日历。'
                : '记录将进入回收站，可恢复。不会级联删除关联记录；关联操作可能暂停，恢复时会重新校验引用。'}
            </p>
            {confirmProblem?.message && <Notice kind="error">{confirmProblem.message}</Notice>}
            {pending.has(confirmSlot) && (
              <Notice>请求已提交。关闭窗口不会撤销已提交的操作，请刷新核对结果。</Notice>
            )}
            <div className="company-form-actions">
              <button className="secondary" onClick={dismiss}>
                返回
              </button>
              <button
                className="primary company-danger-button"
                disabled={pending.has(confirmSlot) || confirmProblem?.conflict}
                onClick={() => action(confirmation.record, confirmation.action, confirmation.token)}
              >
                {pending.has(confirmSlot) && <Spinner />}
                {confirmation.action === 'cancel' ? '确认取消会议' : '确认移入回收站'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div></ProjectionAuthority.Provider></OrganizationAuthority.Provider>
  );
}

function RecordDetails({ record, data, projectionEpoch, onProjectionDirtyChange }: {
  record: OrganizationRecord;
  data: Snapshot;
  projectionEpoch: number;
  onProjectionDirtyChange: (id: string, dirty: boolean) => void;
}) {
  const facts: [string, string][] = [];
  const add = (label: string, field: string) => {
    if (value(record, field)) facts.push([label, value(record, field)]);
  };
  if (value(record, 'organizationId'))
    facts.push(['所属机构', refName(data, 'organization', value(record, 'organizationId'))]);
  if (value(record, 'parentId'))
    facts.push(['上级机构', refName(data, 'organization', value(record, 'parentId'))]);
  if (record.kind === 'person') {
    add('职位', 'role');
    add('部门', 'department');
    add('邮箱', 'email');
    facts.push(['关注', row(record).followed ? '已关注' : '未关注']);
  }
  if (record.kind === 'meeting') {
    facts.push(
      ['开始', displayDate(value(record, 'startsAt'), value(record, 'timezone'))],
      ['结束', displayDate(value(record, 'endsAt'), value(record, 'timezone'))],
    );
    add('系列', 'series');
    add('地点', 'location');
    facts.push([
      '拟参会人员',
      (row(record).attendeeIds as string[]).map((id) => refName(data, 'person', id)).join('、') || '无',
    ]);
    facts.push(['会议接入', '未配置，未创建直播或会议链接']);
  }
  if (record.kind === 'crm-contact' && value(record, 'personId'))
    facts.push(['关联人员', refName(data, 'person', value(record, 'personId'))]);
  if (record.kind === 'service-record') {
    facts.push(
      ['活动', activityNames[value(record, 'activity') as ServiceActivity]],
      ['时间', displayDate(value(record, 'occurredAt'))],
    );
    if (value(record, 'contactId'))
      facts.push(['客户联系人', refName(data, 'crm-contact', value(record, 'contactId'))]);
    facts.push(['事实来源', '用户手动登记；未验证实际服务或外部送达']);
  }
  if (record.kind === 'reading-record')
    facts.push(
      ['阅读时间', displayDate(value(record, 'readAt'))],
      ['手动进度', `${value(record, 'progress')}%`],
    );
  if (record.kind === 'access-request')
    facts.push(['申请人', refName(data, 'person', value(record, 'requesterPersonId'))]);
  if (record.kind === 'share-draft')
    facts.push([
      '拟接收范围',
      [
        ...(row(record).recipientPersonIds as string[]).map((id) => refName(data, 'person', id)),
        ...(row(record).recipientOrganizationIds as string[]).map((id) => refName(data, 'organization', id)),
      ].join('、'),
    ]);
  add('备注', 'notes');
  add('简介', record.kind === 'person' ? 'biography' : 'description');
  add('决定说明', 'decisionNote');
  if (Array.isArray(row(record).tags) && (row(record).tags as string[]).length)
    facts.push(['标签', (row(record).tags as string[]).join(' · ')]);
  return (
    <>
      <dl className="automation-facts">
        {facts.map(([label, text]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt>{label}</dt>
            <dd className="automation-prewrap">{text}</dd>
          </div>
        ))}
      </dl>
      {['meeting-registration', 'access-request', 'share-draft'].includes(record.kind) && (
        <p className="automation-warning">仅本地意向或审批记录，不授予资料权限，不发送邀请或分享链接。</p>
      )}
      {record.kind === 'service-record' && !record.deletedAt && <ServiceRecordProjectionPanel key={`${record.id}:${record.revision}:${projectionEpoch}`} sourceId={record.id} onDirtyChange={onProjectionDirtyChange} />}
      {record.kind === 'service-record' && row(record).source && (
        <TargetStatus target={row(record).source as LocalTarget} />
      )}
    </>
  );
}

function TargetStatus({ target }: { target: LocalTarget }) {
  const authority=useContext(OrganizationAuthority);
  const controller=useRef<AbortController|null>(null);
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const lifecycle = generation;
    lifecycle.current++;
    setResult('');
    setBusy(false);
    return () => {
      lifecycle.current++;controller.current?.abort();
    };
  }, [target.kind, target.id, target.revision]);
  async function inspect() {
    if (busy) return;
    const token = ++generation.current;
    controller.current?.abort();const request=new AbortController();controller.current=request;
    const current=()=>generation.current===token&&!request.signal.aborted&&(!authority||authority.available);
    setBusy(true);
    setResult('');
    try {
      const response = await (authority?authority.guard(signal=>organizationApi.inspectTarget({target},signal),request.signal):organizationApi.inspectTarget({target},request.signal));
      if (current())
        setResult(
          response.state === 'current'
            ? `引用版本 ${target.revision} 仍为当前版本；不代表内容访问许可`
            : `引用已变化：保存版本 ${target.revision}，当前版本 ${response.currentRevision}。请编辑并重新选择目标后保存`,
        );
    } catch (error) {
      if (current()) setResult(`引用不可用：${errorMessage(error)}`);
    } finally {
      if (current()) setBusy(false);
    }
  }
  return (
    <div className="automation-availability">
      <p className="automation-prewrap">
        {targetNames[target.kind]} · {target.id} · 绑定版本 {target.revision}
      </p>
      <button type="button" className="text-button" disabled={busy} onClick={() => void inspect()}>
        {busy && <Spinner />}核对引用状态
      </button>
      {result && <p role="status">{result}</p>}
    </div>
  );
}

type Field = {
  name: string;
  label: string;
  type?: 'textarea' | 'select' | 'reference' | 'many' | 'tags' | 'boolean' | 'instant' | 'number' | 'target' | 'reminder-preference';
  required?: boolean;
  reference?: OrganizationKind;
  choices?: string[];
  max?: number;
};
const fieldsets: Record<OrganizationKind, Field[]> = {
  organization: [
    { name: 'name', label: '机构名称', required: true },
    { name: 'parentId', label: '上级机构', type: 'reference', reference: 'organization' },
    {
      name: 'category',
      label: '机构类型',
      type: 'select',
      choices: ['buy-side', 'sell-side', 'company', 'other'],
    },
    { name: 'website', label: '网站地址', max: 2048 },
    { name: 'description', label: '机构简介', type: 'textarea' },
    { name: 'tags', label: '标签', type: 'tags' },
  ],
  person: [
    { name: 'name', label: '人员姓名', required: true },
    { name: 'organizationId', label: '所属机构', type: 'reference', reference: 'organization' },
    { name: 'role', label: '职位' },
    { name: 'department', label: '部门' },
    { name: 'email', label: '邮箱', max: 254 },
    { name: 'biography', label: '人员简介', type: 'textarea' },
    { name: 'followed', label: '关注此人员', type: 'boolean' },
    { name: 'tags', label: '标签', type: 'tags' },
  ],
  meeting: [
    { name: 'title', label: '会议标题', required: true },
    { name: 'organizationId', label: '主办机构', type: 'reference', reference: 'organization' },
    { name: 'series', label: '会议系列' },
    {
      name: 'category',
      label: '会议类型',
      type: 'select',
      choices: ['roadshow', 'strategy', 'research', 'forum', 'other'],
    },
    { name: 'startsAt', label: '开始时间（UTC）', type: 'instant', required: true },
    { name: 'endsAt', label: '结束时间（UTC）', type: 'instant', required: true },
    { name: 'timezone', label: '显示时区（IANA）', required: true },
    { name: 'reminderLeadSeconds', label: '提醒提前量偏好（仅保存设置）', type: 'reminder-preference' },
    { name: 'location', label: '会议地点' },
    { name: 'description', label: '议程说明', type: 'textarea' },
    { name: 'attendeeIds', label: '拟参会人员', type: 'many', reference: 'person' },
    { name: 'state', label: '会议状态', type: 'select', choices: ['scheduled', 'cancelled', 'completed'] },
  ],
  'meeting-registration': [
    { name: 'meetingId', label: '关联会议', type: 'reference', reference: 'meeting', required: true },
    { name: 'personId', label: '参会人员', type: 'reference', reference: 'person', required: true },
    {
      name: 'state',
      label: '参会意向状态',
      type: 'select',
      choices: ['requested', 'approved-locally', 'declined', 'cancelled'],
    },
    { name: 'notes', label: '参会备注', type: 'textarea' },
  ],
  'crm-contact': [
    { name: 'name', label: '客户联系人名称', required: true },
    {
      name: 'organizationId',
      label: '客户机构',
      type: 'reference',
      reference: 'organization',
      required: true,
    },
    { name: 'personId', label: '关联人员', type: 'reference', reference: 'person' },
    { name: 'stage', label: '客户阶段', type: 'select', choices: ['prospect', 'active', 'inactive'] },
    { name: 'notes', label: '客户备注', type: 'textarea' },
    { name: 'tags', label: '标签', type: 'tags' },
  ],
  'service-record': [
    {
      name: 'organizationId',
      label: '服务机构',
      type: 'reference',
      reference: 'organization',
      required: true,
    },
    { name: 'contactId', label: '服务联系人', type: 'reference', reference: 'crm-contact' },
    { name: 'activity', label: '服务类型', type: 'select', choices: Object.keys(activityNames) },
    { name: 'occurredAt', label: '发生时间（UTC）', type: 'instant', required: true },
    { name: 'summary', label: '服务摘要', required: true },
    { name: 'notes', label: '服务备注', type: 'textarea' },
    { name: 'source', label: '本地来源（可选）', type: 'target' },
  ],
  bookmark: [
    { name: 'title', label: '收藏标题', required: true },
    { name: 'target', label: '收藏目标', type: 'target', required: true },
    { name: 'notes', label: '收藏备注', type: 'textarea' },
    { name: 'tags', label: '标签', type: 'tags' },
  ],
  'reading-record': [
    { name: 'target', label: '阅读目标', type: 'target', required: true },
    { name: 'readAt', label: '阅读时间（UTC）', type: 'instant', required: true },
    { name: 'progress', label: '手动阅读进度（%）', type: 'number' },
    { name: 'notes', label: '阅读备注', type: 'textarea' },
  ],
  'access-request': [
    {
      name: 'organizationId',
      label: '申请机构',
      type: 'reference',
      reference: 'organization',
      required: true,
    },
    { name: 'requesterPersonId', label: '申请人员', type: 'reference', reference: 'person' },
    { name: 'target', label: '申请访问目标', type: 'target', required: true },
    { name: 'purpose', label: '申请目的', type: 'textarea', required: true },
    {
      name: 'state',
      label: '申请状态',
      type: 'select',
      choices: ['pending', 'approved-locally', 'declined', 'cancelled'],
    },
    { name: 'decisionNote', label: '决定说明', type: 'textarea' },
  ],
  'share-draft': [
    { name: 'title', label: '分享草稿标题', required: true },
    { name: 'target', label: '拟分享目标', type: 'target', required: true },
    { name: 'recipientPersonIds', label: '拟接收人员', type: 'many', reference: 'person' },
    { name: 'recipientOrganizationIds', label: '拟接收机构', type: 'many', reference: 'organization' },
    { name: 'state', label: '草稿状态', type: 'select', choices: ['draft', 'approved-locally', 'revoked'] },
    { name: 'notes', label: '分享说明', type: 'textarea' },
  ],
};
const immutable: Partial<Record<OrganizationKind, string[]>> = {
  'meeting-registration': ['meetingId', 'personId'],
  'service-record': ['organizationId', 'contactId', 'activity', 'occurredAt', 'source'],
  'reading-record': ['target', 'readAt'],
};
function initialDraft(editor: Editor): Draft {
  const defaults: Draft = {
    category: 'other',
    stage: 'prospect',
    timezone: 'Asia/Shanghai',
    activity: 'other',
    progress: 0,
    followed: false,
    startsAt: new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000).toISOString(),
    endsAt: new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 3_600_000).toISOString(),
    occurredAt: new Date().toISOString(),
    readAt: new Date().toISOString(),
    state:
      (
        {
          meeting: 'scheduled',
          'meeting-registration': 'requested',
          'access-request': 'pending',
          'share-draft': 'draft',
        } as Partial<Record<OrganizationKind, string>>
      )[editor.kind] ?? '',
  };
  return Object.fromEntries(
    fieldsets[editor.kind].filter(field => field.type !== 'reminder-preference' || Object.hasOwn(editor.record ? row(editor.record) : editor.seed ?? {}, field.name)).map((field) => [
      field.name,
      field.type === 'reminder-preference'
        ? (editor.record ? row(editor.record) : editor.seed!)[field.name]
        : editor.record
        ? row(editor.record)[field.name]
        : (editor.seed?.[field.name] ??
          defaults[field.name] ??
          (field.type === 'reference' || field.type === 'target'
            ? null
            : field.type === 'many' || field.type === 'tags'
              ? []
              : '')),
    ]),
  );
}
function validInstant(input: JsonValue | undefined) {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(input))
    return false;
  const instant = new Date(input);
  if (!Number.isFinite(instant.getTime())) return false;
  const expected = input.slice(0, -1).padEnd(19, ':00');
  return (
    instant.getUTCFullYear() >= 1970 &&
    instant.getUTCFullYear() <= 2100 &&
    instant.toISOString().slice(0, 19) === expected.slice(0, 19)
  );
}
function RecordEditor({
  editor,
  data,
  busy,
  problem,
  onSave,
  onClose,
  onReload,
  onSnapshot,
}: {
  editor: Editor;
  data: Snapshot;
  busy: boolean;
  problem?: Problem;
  onSave: (draft: Draft) => void;
  onClose: () => void;
  onReload: () => void;
  onSnapshot:(draft:Draft,tags:string,dirty:boolean,baseline:string)=>void;
}) {
  const [draft, setDraft] = useState<Draft>(() => editor.draft??initialDraft(editor));
  const [tagText, setTagText] = useState(() => editor.tagText??((draft.tags ?? []) as string[]).join(', '));
  const [baseline]=useState(()=>editor.baseline??JSON.stringify({draft,tagText}));
  const dirty=JSON.stringify({draft,tagText})!==baseline;
  useUnsavedWork(dirty);
  const snapshot=useRef(onSnapshot);snapshot.current=onSnapshot;
  useLayoutEffect(()=>{snapshot.current(draft,tagText,dirty,baseline);},[draft,tagText,dirty,baseline,editor.record]);
  const [validation, setValidation] = useState('');
  const set = (field: string, input: JsonValue) => {
    setValidation('');
    setDraft((old) => {
      const next = { ...old, [field]: input };
      if (field === 'organizationId' && old.organizationId !== input)
        for (const dependency of ['personId', 'contactId', 'requesterPersonId'])
          if (dependency in next) next[dependency] = null;
      return next;
    });
  };
  function references(field: Field) {
    const options = data[field.reference!].filter(
      (record) =>
        !record.deletedAt && record.id !== (field.name === 'parentId' ? editor.record?.id : undefined),
    );
    return options.filter((record) => {
      if (
        ['personId', 'contactId', 'requesterPersonId'].includes(field.name) &&
        ['crm-contact', 'service-record', 'access-request'].includes(editor.kind)
      )
        return value(record, 'organizationId') === draft.organizationId;
      if (field.name === 'meetingId')
        return value(record, 'state') === 'scheduled' || record.id === draft.meetingId;
      if (field.name === 'parentId' && editor.record) {
        const seen = new Set<string>();
        let current: OrganizationRecord | undefined = record;
        while (current && !seen.has(current.id)) {
          if (current.id === editor.record.id) return false;
          seen.add(current.id);
          current = data.organization.find((item) => item.id === value(current!, 'parentId'));
        }
      }
      return true;
    });
  }
  function choices(field: Field) {
    if (field.name !== 'state') return field.choices!;
    const current = String(draft.state);
    if (!editor.record && ['meeting-registration', 'access-request', 'share-draft'].includes(editor.kind))
      return [current];
    if (editor.kind === 'meeting' && editor.record && value(editor.record, 'state') !== 'scheduled')
      return [value(editor.record, 'state')];
    if (editor.record && ['revoked', 'declined', 'cancelled'].includes(value(editor.record, 'state')))
      return field.choices!.filter((state) => state !== 'approved-locally');
    return field.choices!;
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || problem?.conflict) return;
    const input = structuredClone(draft);
    if ('tags' in input)
      input.tags = tagText
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean);
    for (const field of fieldsets[editor.kind]) {
      if (
        field.required &&
        (input[field.name] === null ||
          input[field.name] === '' ||
          (typeof input[field.name] === 'string' && !String(input[field.name]).trim()))
      ) {
        setValidation(`请填写${field.label}`);
        return;
      }
      if (field.type === 'instant' && !validInstant(input[field.name])) {
        setValidation(`${field.label}需要有效的 1970–2100 年 UTC 日期和时间`);
        return;
      }
      if (field.type === 'instant') input[field.name] = new Date(String(input[field.name])).toISOString();
    }
    if (editor.kind === 'meeting') {
      if (Object.hasOwn(input, 'reminderLeadSeconds') && input.reminderLeadSeconds !== null && !isMeetingReminderLeadSeconds(input.reminderLeadSeconds)) {
        setValidation('请选择有效的提醒提前量偏好，或清除偏好');
        return;
      }
      const duration = Date.parse(String(input.endsAt)) - Date.parse(String(input.startsAt));
      if (duration <= 0 || duration > 31 * 86_400_000) {
        setValidation('结束时间必须晚于开始时间，会议不能超过 31 天');
        return;
      }
      try {
        if (!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(String(input.timezone))) throw new Error();
        new Intl.DateTimeFormat('en', { timeZone: String(input.timezone) }).format();
      } catch {
        setValidation('请填写有效的 IANA 时区，例如 Asia/Shanghai 或 UTC');
        return;
      }
    }
    if (
      Array.isArray(input.tags) &&
      (input.tags.length > 20 ||
        input.tags.some((tag) => String(tag).length > 20) ||
        new Set(input.tags.map((tag) => String(tag).toLowerCase())).size !== input.tags.length)
    ) {
      setValidation('最多 20 个标签，每个最多 20 字，不能重复');
      return;
    }
    if (
      editor.kind === 'share-draft' &&
      !(input.recipientPersonIds as string[]).length &&
      !(input.recipientOrganizationIds as string[]).length
    ) {
      setValidation('请选择至少一个拟接收人员或机构');
      return;
    }
    onSave(input);
  }
  return (
    <form className="company-form automation-form" onSubmit={submit}>
      {['meeting-registration', 'access-request', 'share-draft'].includes(editor.kind) && (
        <Notice>
          所有状态仅作为本地记录。批准不会创建账号、授予资料访问权限、发送消息或生成外部分享链接。
        </Notice>
      )}
      {editor.kind === 'organization' && (
        <Notice>新建及编辑机构都保持“未核验”，本页不提供机构身份认证。</Notice>
      )}
      {editor.kind === 'meeting' && (
        <Notice>
          日期字段按 UTC 输入，显示时区只控制议程展示，不会改动时间点。Asia/Shanghai 为 UTC+8，例如北京时间
          09:00 请填 UTC 01:00。会议接入未配置。提醒偏好随会议保存；保存设置不等于发送提醒，不会调度或发送通知。清除偏好不会取消其他系统中的提醒。
        </Notice>
      )}
      {['service-record', 'reading-record'].includes(editor.kind) && (
        <Notice>
          手动登记的本地事实，不代表系统检测到阅读、通话、邮件送达或实际参会。已有事实的时间和关联身份不能改写；需要纠错时请新建更正记录。
        </Notice>
      )}
      {editor.record &&
        ['share-draft', 'access-request'].includes(editor.kind) &&
        value(editor.record, 'state') === 'approved-locally' && (
          <Notice>如需变更目标或接收范围，请先单独保存为草稿或待处理，再修改内容。</Notice>
        )}
      <fieldset
        disabled={busy}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'grid', gap: 18 }}
      >
        {fieldsets[editor.kind].map((field) => {
          const locked = Boolean(editor.record && immutable[editor.kind]?.includes(field.name));
          const id = `${editor.token}-${field.name}`;
          if (field.type === 'target')
            return (
              <fieldset key={field.name} className="automation-fieldset" disabled={locked}>
                <legend>
                  {field.label}
                  {locked ? '（事实绑定，不可改写）' : ''}
                </legend>
                <TargetPicker
                  value={(draft[field.name] as LocalTarget | null) ?? null}
                  data={data}
                  required={field.required}
                  prefix={id}
                  onChange={(next) => set(field.name, next)}
                />
              </fieldset>
            );
          if (field.type === 'many') {
            const options = references(field),
              selected = (draft[field.name] ?? []) as string[];
            const missing = selected.filter((item) => !options.some((option) => option.id === item));
            return (
              <fieldset key={field.name} className="automation-fieldset">
                <legend>{field.label}（本地选择）</legend>
                {!options.length && (
                  <p className="muted">暂无可选{labels[field.reference!]}，请先在目录中添加</p>
                )}
                <div className="automation-weekdays">
                  {options.map((item) => (
                    <label key={item.id} className="automation-check">
                      <input
                        type="checkbox"
                        checked={selected.includes(item.id)}
                        onChange={(event) =>
                          set(
                            field.name,
                            event.target.checked
                              ? [...selected, item.id]
                              : selected.filter((entry) => entry !== item.id),
                          )
                        }
                      />
                      {title(item)}
                    </label>
                  ))}
                </div>
                {missing.map((item) => (
                  <label key={item} className="automation-check">
                    <input
                      type="checkbox"
                      checked
                      onChange={() =>
                        set(
                          field.name,
                          selected.filter((entry) => entry !== item),
                        )
                      }
                    />
                    {item}（已删除或不可用，取消勾选移除）
                  </label>
                ))}
              </fieldset>
            );
          }
          if (field.type === 'boolean')
            return (
              <label className="automation-check" key={field.name}>
                <input
                  type="checkbox"
                  checked={Boolean(draft[field.name])}
                  onChange={(event) => set(field.name, event.target.checked)}
                />
                {field.label}
              </label>
            );
          return (
            <label key={field.name} htmlFor={id}>
              {field.label}
              {field.required ? ' *' : ''}
              {locked ? '（不可改写）' : ''}
              {field.type === 'reference' ? (
                <select
                  id={id}
                  value={String(draft[field.name] ?? '')}
                  required={field.required}
                  disabled={locked}
                  onChange={(event) => set(field.name, event.target.value || null)}
                >
                  <option value="">{field.required ? '请选择' : '不关联'}</option>
                  {draft[field.name] && !references(field).some((item) => item.id === draft[field.name]) && (
                    <option value={String(draft[field.name])} disabled>
                      {refName(data, field.reference!, String(draft[field.name]))}（不可用）
                    </option>
                  )}
                  {references(field).map((item) => (
                    <option key={item.id} value={item.id}>
                      {title(item)}
                    </option>
                  ))}
                </select>
              ) : field.type === 'reminder-preference' ? (
                <select
                  id={id}
                  value={String(draft[field.name] ?? '')}
                  disabled={locked}
                  onChange={(event) => set(field.name, event.target.value === '' ? null : Number(event.target.value))}
                >
                  <option value="">不保存提醒提前量 / 清除偏好</option>
                  {MEETING_REMINDER_LEADS.map(([seconds, label]) => <option key={seconds} value={seconds}>{label}</option>)}
                </select>
              ) : field.type === 'select' ? (
                <select
                  id={id}
                  value={String(draft[field.name])}
                  disabled={locked}
                  onChange={(event) => set(field.name, event.target.value)}
                >
                  {choices(field).map((choice) => (
                    <option value={choice} key={choice}>
                      {field.name === 'activity'
                        ? activityNames[choice as ServiceActivity]
                        : (statusNames[choice] ?? choice)}
                    </option>
                  ))}
                </select>
              ) : field.type === 'textarea' ? (
                <textarea
                  id={id}
                  value={String(draft[field.name] ?? '')}
                  required={field.required}
                  maxLength={field.name === 'purpose' ? 2000 : 4000}
                  rows={3}
                  onChange={(event) => set(field.name, event.target.value)}
                />
              ) : field.type === 'tags' ? (
                <input
                  id={id}
                  value={tagText}
                  maxLength={500}
                  placeholder="逗号分隔，最多 20 个"
                  onChange={(event) => setTagText(event.target.value)}
                />
              ) : field.type === 'instant' ? (
                <input
                  id={id}
                  type="datetime-local"
                  step="0.001"
                  min="1970-01-01T00:00"
                  max="2100-12-31T23:59:59.999"
                  value={String(draft[field.name] ?? '').replace(/Z$/, '')}
                  required
                  disabled={locked}
                  onChange={(event) => set(field.name, event.target.value ? `${event.target.value}Z` : '')}
                />
              ) : field.type === 'number' ? (
                <input
                  id={id}
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={Number(draft[field.name])}
                  required
                  onChange={(event) =>
                    set(field.name, event.target.value === '' ? '' : Number(event.target.value))
                  }
                />
              ) : (
                <input
                  id={id}
                  type={field.name === 'email' ? 'email' : field.name === 'website' ? 'url' : 'text'}
                  value={String(draft[field.name] ?? '')}
                  required={field.required}
                  maxLength={field.max ?? 200}
                  list={field.name === 'timezone' ? `${editor.token}-timezones` : undefined}
                  onChange={(event) => set(field.name, event.target.value)}
                />
              )}
            </label>
          );
        })}
        <datalist id={`${editor.token}-timezones`}>
          {['UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/New_York'].map((zone) => (
            <option key={zone}>{zone}</option>
          ))}
        </datalist>
      </fieldset>
      {validation && <Notice kind="error">{validation}</Notice>}
      {problem?.message && <Notice kind="error">{problem.message}</Notice>}
      {busy && <Notice>保存已提交。关闭或切换页面不会撤销已提交的保存，请刷新核对。</Notice>}
      {problem?.conflict && editor.record && (
        <button className="secondary" type="button" onClick={onReload}>
          重新载入最新版本（放弃未保存修改）
        </button>
      )}
      <div className="company-form-actions">
        <button type="button" className="secondary" onClick={onClose}>
          取消编辑
        </button>
        <button type="submit" className="primary" disabled={busy || problem?.conflict}>
          {busy && <Spinner />}保存到本地
        </button>
      </div>
    </form>
  );
}

function TargetPicker({
  value,
  data,
  required,
  prefix,
  onChange,
}: {
  value: LocalTarget | null;
  data: Snapshot;
  required?: boolean;
  prefix: string;
  onChange: (value: LocalTarget | null) => void;
}) {
  const [selectedKind, setSelectedKind] = useState<LocalTarget['kind']>(value?.kind ?? 'organization');
  const [manual, setManual] = useState(
    Boolean(value && !['organization', 'person', 'meeting'].includes(value.kind)),
  );
  useUnsavedDraft({ selectedKind, manual });
  const options = (data[selectedKind as OrganizationKind] ?? []).filter((record) => !record.deletedAt);
  const selectKind = (next: LocalTarget['kind']) => {
    setSelectedKind(next);
    onChange(null);
  };
  return (
    <div className="automation-form">
      <label htmlFor={`${prefix}-kind`}>
        目标类型
        <select
          id={`${prefix}-kind`}
          value={selectedKind}
          onChange={(event) => selectKind(event.target.value as LocalTarget['kind'])}
        >
          {Object.entries(targetNames).map(([kind, label]) => (
            <option key={kind} value={kind}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {['organization', 'person', 'meeting'].includes(selectedKind) && (
        <label className="automation-check">
          <input
            type="checkbox"
            checked={manual}
            onChange={(event) => {
              setManual(event.target.checked);
              onChange(null);
            }}
          />
          手动输入本地 ID 与版本
        </label>
      )}
      {!manual && ['organization', 'person', 'meeting'].includes(selectedKind) ? (
        <label htmlFor={`${prefix}-record`}>
          本地目标记录
          <select
            id={`${prefix}-record`}
            required={required}
            value={value?.id ?? ''}
            onChange={(event) =>
              onChange(
                options.find((record) => record.id === event.target.value)
                  ? targetOf(options.find((record) => record.id === event.target.value)!)
                  : null,
              )
            }
          >
            <option value="">{required ? '请选择本地记录' : '不关联来源'}</option>
            {value && !options.some((record) => record.id === value.id) && (
              <option value={value.id} disabled>
                {value.id}（不可用）
              </option>
            )}
            {options.map((record) => (
              <option key={record.id} value={record.id}>
                {title(record)} · 当前版本 {record.revision}
              </option>
            ))}
          </select>
          {value &&
            options.some((record) => record.id === value.id && record.revision !== value.revision) && (
              <button
                type="button"
                className="text-button"
                onClick={() => onChange(targetOf(options.find((record) => record.id === value.id)!))}
              >
                改为目标当前版本
              </button>
            )}
        </label>
      ) : (
        <>
          <p className="muted">
            从对应本地页面复制记录 ID 和版本。此操作只绑定指针，不上传内容，不取得访问权限。
          </p>
          <label htmlFor={`${prefix}-id`}>
            本地目标 ID
            <input
              id={`${prefix}-id`}
              required={required}
              maxLength={100}
              pattern="[A-Za-z0-9_-]+"
              value={value?.id ?? ''}
              onChange={(event) =>
                onChange(
                  event.target.value
                    ? { kind: selectedKind, id: event.target.value, revision: value?.revision ?? 1 }
                    : null,
                )
              }
            />
          </label>
          <label htmlFor={`${prefix}-revision`}>
            目标版本
            <input
              id={`${prefix}-revision`}
              type="number"
              min={1}
              max={Number.MAX_SAFE_INTEGER}
              step={1}
              value={value?.revision ?? 1}
              onChange={(event) =>
                onChange({ kind: selectedKind, id: value?.id ?? '', revision: Number(event.target.value) })
              }
            />
          </label>
        </>
      )}
      {!required && value && (
        <button type="button" className="text-button" onClick={() => onChange(null)}>
          移除来源关联
        </button>
      )}
      {value && <TargetStatus target={value} />}
    </div>
  );
}

function ServiceSummary({
  organizationId,
  data,
  revision,
  onOpen,
}: {
  organizationId: string;
  data: Snapshot;
  revision: OrganizationRecord[];
  onOpen: (record: OrganizationRecord) => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [contact, setContact] = useState('');
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<ServiceStatistics | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const generation = useRef(0);
  const contacts = data['crm-contact'].filter(
    (record) => !record.deletedAt && (!organizationId || value(record, 'organizationId') === organizationId),
  );
  const selectedContact = contacts.some((record) => record.id === contact) ? contact : '';
  useEffect(() => {
    setContact('');
  }, [organizationId]);
  useEffect(() => {
    const token = ++generation.current,
      controller = new AbortController();
    setResult(null);
    setError('');
    setPage(0);
    if (
      (from && !validInstant(`${from}Z`)) ||
      (to && !validInstant(`${to}Z`)) ||
      (from && to && from >= to)
    ) {
      setLoading(false);
      setError('请选择有效 UTC 时间范围，开始应早于结束');
      return () => controller.abort();
    }
    setLoading(true);
    void organizationApi
      .serviceStatistics(
        {
          ...(organizationId ? { organizationId } : {}),
          ...(selectedContact ? { contactId: selectedContact } : {}),
          ...(from ? { from: new Date(`${from}Z`).toISOString() } : {}),
          ...(to ? { to: new Date(`${to}Z`).toISOString() } : {}),
        },
        controller.signal,
      )
      .then((response) => {
        if (!controller.signal.aborted && token === generation.current) setResult(response);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && token === generation.current) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted && token === generation.current) setLoading(false);
      });
    return () => controller.abort();
  }, [organizationId, selectedContact, from, to, reload, revision]);
  return (
    <section className="company-card" aria-label="本地服务事实统计">
      <h2>本地服务事实统计</h2>
      <p className="muted">
        来自未删除的手动服务记录，按机构、联系人及 UTC
        时间范围汇总。搜索词和回收站开关不影响统计；不代表外部送达、真实阅读量或平台用量。
      </p>
      <div className="company-form automation-form">
        <div className="company-form-pair">
          <label>
            统计起始（UTC，含）
            <input
              type="datetime-local"
              step="1"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label>
            统计结束（UTC，不含）
            <input
              type="datetime-local"
              step="1"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
        </div>
        <label>
          统计联系人
          <select value={selectedContact} onChange={(event) => setContact(event.target.value)}>
            <option value="">全部联系人</option>
            {contacts.map((record) => (
              <option key={record.id} value={record.id}>
                {title(record)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading && (
        <p role="status">
          <Spinner /> 正在汇总本地事实…
        </p>
      )}
      {error && (
        <Notice kind="error">
          统计不可用：{error}{' '}
          <button className="text-button" onClick={() => setReload((old) => old + 1)}>
            重试统计
          </button>
        </Notice>
      )}
      {result && (
        <>
          <p>
            <strong>本地服务事实：{result.total} 条</strong>
          </p>
          <div className="automation-actions">
            {Object.entries(result.byActivity).map(([activity, count]) => (
              <span className="source-pill" key={activity}>
                {activityNames[activity as ServiceActivity]} {count}
              </span>
            ))}
          </div>
          {result.byOrganization.map((item) => (
            <p key={item.organizationId}>
              {refName(data, 'organization', item.organizationId)}：{item.total} 条
            </p>
          ))}
          <details>
            <summary>核对统计来源（{result.events.length} 条记录）</summary>
            <ol>
              {result.events.slice(page * 20, (page + 1) * 20).map((event) => {
                const record = data['service-record'].find(
                  (item) => item.id === event.id && item.revision === event.revision && !item.deletedAt,
                );
                return (
                  <li key={event.id} className="automation-prewrap">
                    {displayDate(event.occurredAt)} · {activityNames[event.activity]} · {event.id} · 版本{' '}
                    {event.revision}
                    {record ? (
                      <button className="text-button" onClick={() => onOpen(record)}>
                        查看事实记录
                      </button>
                    ) : (
                      <span>（请刷新目录取得对应版本）</span>
                    )}
                  </li>
                );
              })}
            </ol>
            {result.events.length > 20 && (
              <div className="automation-actions">
                <button className="secondary" disabled={!page} onClick={() => setPage(page - 1)}>
                  前 20 条
                </button>
                <span>第 {page + 1} 页</span>
                <button
                  className="secondary"
                  disabled={(page + 1) * 20 >= result.events.length}
                  onClick={() => setPage(page + 1)}
                >
                  后 20 条
                </button>
              </div>
            )}
          </details>
        </>
      )}
    </section>
  );
}


/** Preview is read-only. Explicit discard clears inputs; submitted writes may have committed. */
function LegacyServiceRecordProjectionPanel({sourceId,onDirtyChange}:{sourceId:string;onDirtyChange?:(id:string,dirty:boolean)=>void}) {
  const authority=useContext(OrganizationAuthority);
  const [preview,setPreview]=useState<ServiceRecordProjection|null>(null);
  const [status,setStatus]=useState(''), [source,setSource]=useState(''), [reason,setReason]=useState('');
  const [busy,setBusy]=useState(false), [problem,setProblem]=useState(''), [result,setResult]=useState('');
  const dirty=Boolean(preview && (status || source || reason));
  useUnsavedWork(dirty);
  useEffect(()=>{onDirtyChange?.(sourceId,dirty);return()=>onDirtyChange?.(sourceId,false);},[sourceId,dirty,onDirtyChange]);
  const epoch=useRef(0), controller=useRef<AbortController|null>(null);
  useEffect(()=>()=>{epoch.current++;controller.current?.abort();},[]);
  const close=()=>{if(dirty&&!allowLeavingUnsavedWork())return;epoch.current++;controller.current?.abort();setPreview(null);setBusy(false);setProblem('');setStatus('');setSource('');setReason('');};
  async function load(){
    if(dirty&&!allowLeavingUnsavedWork())return;
    const current=++epoch.current;controller.current?.abort();controller.current=new AbortController();setBusy(true);setProblem('');setResult('');setPreview(null);setStatus('');setSource('');setReason('');
    try{const value=await (authority?authority.guard(signal=>serviceRecordBridgeApi.preview(sourceId,signal),controller.current.signal):serviceRecordBridgeApi.preview(sourceId,controller.current.signal));if(current===epoch.current&&(!authority||authority.available))setPreview(value);}
    catch(error){if(current===epoch.current&&(!authority||authority.available))setProblem(errorMessage(error));}
    finally{if(current===epoch.current&&(!authority||authority.available))setBusy(false);}
  }
  async function submit(){
    if(!preview||busy||!status||!source)return;
    const current=++epoch.current;controller.current=new AbortController();setBusy(true);setProblem('');
    try{const value=await (authority?authority.guard(signal=>serviceRecordBridgeApi.import({sourceId,token:preview.token,status,sourcePin:preview.syntheticSourcePin,reason},signal),controller.current.signal):serviceRecordBridgeApi.import({sourceId,token:preview.token,status,sourcePin:preview.syntheticSourcePin,reason},controller.current.signal));
      if(current===epoch.current&&(!authority||authority.available)){setResult(`${value.unchanged?'已存在，未重复计入':'已保存月报活动'} · ${value.activity.id} · 活动版本 ${value.activity.revision}。原记录和历史月报未修改；到服务报告选择同一客户、月份查看。`);setPreview(null);}}
    catch(error){if(current===epoch.current&&(!authority||authority.available))setProblem(`${errorMessage(error)}。请求可能已提交；重新预览并用相同选择重试可核对结果，不会重复计入。`);}
    finally{if(current===epoch.current&&(!authority||authority.available))setBusy(false);}
  }
  const correction=preview?.existing && preview.existing.sourceRevision!==preview.source.revision;
  return <section aria-label="机构服务记录投影" className="automation-form" style={{borderTop:'1px solid #cbd5e1',paddingTop:12,marginTop:12}}>
    <button className="secondary" disabled={busy} onClick={()=>void load()}>预览计入月报</button>
    <p className="muted">需逐条确认。手动事实本身没有完成状态或文档证据，不会自动计入月报。</p>
    {busy&&<p role="status">正在核对；离开页面不会撤销已提交的保存。</p>}
    {problem&&<p role="alert">{problem}</p>}{result&&<p role="status">{result}</p>}
    {preview&&<div>
      <h4>确认来源投影</h4><p>{preview.warning}</p>
      <p>源记录 {preview.source.id} · 修订 {preview.source.revision}</p>
      <p>摘要：{preview.projection.summary}</p><p>日期：{preview.projection.occurredAt} · 类型：{preview.projection.kind}</p>
      <p>客户：{preview.customerPin.organizationId} / {preview.customerPin.contactId??'机构级'} · 机构修订 {preview.customerPin.organizationRevision}</p>
      <p>原备注和本地目标保留在不可变来源快照；本地目标不转换为文档证据。</p>
      {preview.existing&&<p>已有活动 {preview.existing.id} · 源修订 {preview.existing.sourceRevision}。{correction?'此次将更正同一活动，不新增计数。':'相同选择再次确认只核对现有活动。'}</p>}
      {preview.existing?.archivedAt&&<p role="alert">已有活动已归档，请先在服务报告中明确恢复。</p>}
      <label>明确选择活动状态 <select aria-label="投影活动状态" value={status} disabled={busy} onChange={e=>setStatus(e.target.value)}><option value="">请选择，不推断状态</option><option value="planned">计划中</option><option value="reported-completed">自报已完成（未验证）</option><option value="cancelled">已取消</option></select></label>
      <label>明确选择文档来源 <select aria-label="投影文档来源" value={source} disabled={busy} onChange={e=>setSource(e.target.value)}><option value="">请选择，不转换本地目标</option><option value="synthetic">合成来源 synthetic-doc / v1（仅本地演示）</option></select></label>
      {correction&&<label>更正原因 <input aria-label="投影更正原因" maxLength={500} value={reason} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>}
      <p>日期按原 UTC 时间保留，月份由报告所选时区决定。保存不会重写已生成的月报。</p>
      <button className="primary" disabled={busy||!status||!source||Boolean(preview.existing?.archivedAt)||Boolean(correction&&!reason.trim())} onClick={()=>void submit()}>{correction?'确认更正原活动':'确认计入月报活动'}</button>
      <button className="secondary" onClick={close}>取消预览</button>
    </div>}
  </section>;
}

/** Standalone legacy callers are explicit; unavailable v2 authority never falls back. */
export function ServiceRecordProjectionPanel(props:{sourceId:string;onDirtyChange?:(id:string,dirty:boolean)=>void;mode?:ProjectionMode}) {
  const inherited=useContext(ProjectionAuthority),mode=props.mode??inherited;
  return mode.mode==='legacy-synthetic'?<LegacyServiceRecordProjectionPanel {...props}/>:<ServiceRecordProjectionV2Panel {...props} session={mode.session}/>;
}
