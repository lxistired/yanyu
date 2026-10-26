import type {ManualPlanSessionTarget} from '../../shared/manual-plans';
import {WorkspaceWriteSession,captureWorkspaceCommand,type WorkspaceCompletion,type WorkspaceWriteOperation} from './workspace-write-session';
import {useUnsavedWork,allowLeavingUnsavedWork,useUnsavedHistoryDismiss} from './unsaved-work';
import {RelatedTranscriptLinks} from './TranscriptRelationships';
import { parseWatchlistImport } from './workspace-watchlist-import';
export { parseWatchlistImport } from './workspace-watchlist-import';
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowRight,
  FolderOpen,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import type {
  ImportWatchlistRequest,
  ListWorkspaceRecordsRequest,
  WorkspaceDataByKind,
  WorkspaceKind,
  WorkspaceInputDataByKind,
  WorkspaceRecord,
  WorkspaceRecordIdentity,
  WorkspaceRecordPage,
} from '../../shared/workspace-records';
import { ApiError, errorMessage } from '../adapters/api';
import { workspaceApi } from '../adapters/workspace';
import { EmptyState, Modal, Notice, PageHeading, Spinner } from './common';

export type WorkspaceEntryMode = 'workspace' | 'manual-conversation';
export interface WorkspaceManagerProps {
  conversationTarget?: Readonly<ManualPlanSessionTarget>;
  onReturnToPlan?: () => void;
  sourcePlanTitle?: string;
  entryMode?: WorkspaceEntryMode;
  onOpenWorkspace?: () => void;
  initialWorkspaceId?: string;
  session?: WorkspaceWriteSession;
  onWorkspaceChange?: (workspaceId: string | null) => void;
}
const labels: Record<WorkspaceKind, string> = {
  workspace: '工作区',
  'session-group': '会话分组',
  session: '会话',
  message: '消息',
  watchlist: '自选分组',
  'watchlist-item': '自选证券',
};
const kinds = Object.keys(labels) as WorkspaceKind[];
const lookupKinds = ['workspace', 'session-group', 'session', 'watchlist'] as const;
type LookupKind = (typeof lookupKinds)[number];
type Lookups = Record<LookupKind, WorkspaceRecord[]>;
const emptyLookups = (): Lookups => ({ workspace: [], 'session-group': [], session: [], watchlist: [] });
type Draft = Record<string, string | boolean | null>;
type Editor = { kind: WorkspaceKind; record: WorkspaceRecord | null; draft: Draft; conflict: boolean };
type DeletePreview = {
  token:string;
  roots: WorkspaceRecord[];
  manifest: WorkspaceRecordIdentity[] | null;
  approved: boolean;
};
type View = {
  kind: WorkspaceKind;
  workspaceId: string;
  groupId: string;
  sessionId: string;
  watchlistId: string;
  query: string;
  includeDeleted: boolean;
  pinned: boolean;
  offset: number;
};
function field(record: WorkspaceRecord, name: string): string {
  const value = (record.data as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}
function title(record: WorkspaceRecord): string {
  return (
    field(record, 'title') ||
    field(record, 'name') ||
    field(record, 'symbol') ||
    field(record, 'content').slice(0, 72) ||
    record.id
  );
}
function recordKind(record: WorkspaceRecord): WorkspaceKind {
  return record.kind as WorkspaceKind;
}
function identity(record: WorkspaceRecord): WorkspaceRecordIdentity {
  return { kind: recordKind(record), id: record.id, expectedRevision: record.revision };
}
function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.detail.code === 'CONFLICT';
}
function newKey(): string {
  return `workspace-ui-${crypto.randomUUID()}`;
}
function draftFrom(record: WorkspaceRecord): Draft {
  // Only user-editable properties are round-tripped. Server metadata (e.g. message sequence) stays immutable.
  const writable: Record<WorkspaceKind, string[]> = {
    workspace: ['name', 'parentId', 'description'],
    'session-group': ['name', 'workspaceId', 'parentId'],
    session: ['title', 'workspaceId', 'groupId', 'pinned', 'mode', 'model'],
    message: ['sessionId', 'role', 'content'],
    watchlist: ['name', 'workspaceId', 'description'],
    'watchlist-item': ['watchlistId', 'symbol', 'market', 'name', 'notes'],
  };
  const data = record.data as Draft;
  return Object.fromEntries(writable[recordKind(record)].map((key) => [key, data[key]]));
}
function seed(kind: WorkspaceKind, view: View, lookups: Lookups): Draft {
  const workspaceId = view.workspaceId || lookups.workspace.find((row) => !row.deletedAt)?.id || '';
  switch (kind) {
    case 'workspace':
      return { name: '', description: '', parentId: null };
    case 'session-group':
      return { name: '', workspaceId, parentId: null };
    case 'session':
      return {
        title: '',
        workspaceId,
        groupId: view.groupId === '*' ? null : view.groupId || null,
        mode: 'quick',
        model: '',
        pinned: false,
      };
    case 'message':
      return { sessionId: view.sessionId, role: 'user', content: '' };
    case 'watchlist':
      return { name: '', workspaceId, description: '' };
    case 'watchlist-item':
      return { watchlistId: view.watchlistId, symbol: '', market: 'UNSPECIFIED', name: '', notes: '' };
  }
}
function requestFor(view: View): ListWorkspaceRecordsRequest {
  const request: ListWorkspaceRecordsRequest = {
    kind: view.kind,
    query: view.query,
    includeDeleted: view.includeDeleted,
    limit: 30,
    offset: view.offset,
    sortBy: view.kind === 'message' ? 'sequence' : 'updatedAt',
    direction: view.kind === 'message' ? 'asc' : 'desc',
  };
  if (view.workspaceId && ['session-group', 'session', 'watchlist'].includes(view.kind))
    request.workspaceId = view.workspaceId;
  if (view.kind === 'session' && view.groupId !== '*') request.groupId = view.groupId || null;
  if (view.kind === 'session' && view.pinned) request.pinned = true;
  if (view.kind === 'message' && view.sessionId) request.sessionId = view.sessionId;
  if (view.kind === 'watchlist-item' && view.watchlistId) request.watchlistId = view.watchlistId;
  return request;
}
async function loadLookups(signal: AbortSignal, conversationWorkspace?: string): Promise<Lookups> {
  const values = await Promise.all(
    lookupKinds.map(async (kind) => {
      // The conversation entry never reads an unselected cross-workspace session directory.
      if (conversationWorkspace !== undefined && kind !== 'workspace' &&
          (!conversationWorkspace || kind === 'watchlist')) return [kind, []] as const;
      const records: WorkspaceRecord[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (offset > 10_000) throw new Error('关系目录超过本地查询上限，请先在列表中分批整理');
        const page: WorkspaceRecordPage = await workspaceApi.list(
          { kind, includeDeleted: true, limit: 200, offset, sortBy: 'name', direction: 'asc',
            ...(conversationWorkspace && kind !== 'workspace' ? {workspaceId: conversationWorkspace} : {}) },
          signal,
        );
        records.push(...page.items);
        if (page.nextOffset !== null && page.nextOffset <= offset)
          throw new Error('关系目录分页无进展，请刷新重试');
        offset = page.nextOffset;
      }
      return [kind, records] as const;
    }),
  );
  return Object.fromEntries(values) as Lookups;
}


export function WorkspaceManager({ initialWorkspaceId = '', onWorkspaceChange, session:providedSession, entryMode = 'workspace', onOpenWorkspace,conversationTarget,onReturnToPlan,sourcePlanTitle }: WorkspaceManagerProps) {
  const manualConversation = entryMode === 'manual-conversation';
  const [localSession]=useState(()=>providedSession??new WorkspaceWriteSession());
  const session=providedSession??localSession;
  const [sessionEvent,renderSession]=useReducer(n=>n+1,0);
  useEffect(()=>session.subscribe(renderSession),[session]);
  const [retained]=useState(()=>session.draft);

  const savedView = retained?.view as View | undefined;
  const [view, setView] = useState<View>((!manualConversation || savedView?.kind === 'session' || savedView?.kind === 'message' ? savedView : undefined)??{
    kind: manualConversation || initialWorkspaceId ? 'session' : 'workspace',
    workspaceId: manualConversation ? savedView?.workspaceId ?? initialWorkspaceId : initialWorkspaceId,
    groupId: '*',
    sessionId: '',
    watchlistId: '',
    query: '',
    includeDeleted: false,
    pinned: false,
    offset: 0,
  });
  const [page, setPage] = useState<WorkspaceRecordPage | null>(null);
  const [lookups, setLookups] = useState<Lookups>(emptyLookups);
  const [lookupReady, setLookupReady] = useState(false);
  const exactTargetStale = !!conversationTarget&&view.workspaceId===conversationTarget.workspaceId&&view.sessionId===conversationTarget.sessionId&&lookupReady&&
    (!lookups.workspace.some(row=>row.id===conversationTarget.workspaceId&&!row.deletedAt&&row.revision===conversationTarget.workspaceRevision)||
     !lookups.session.some(row=>row.id===conversationTarget.sessionId&&!row.deletedAt&&row.revision===conversationTarget.sessionRevision&&field(row,'workspaceId')===conversationTarget.workspaceId));
  const conversationScopeMissing = exactTargetStale || manualConversation && (!lookupReady ||
    !lookups.workspace.some(row => row.id === view.workspaceId && (view.includeDeleted || !row.deletedAt)) ||
    (view.kind === 'message' && !lookups.session.some(row => row.id === view.sessionId &&
      field(row, 'workspaceId') === view.workspaceId && (view.includeDeleted || !row.deletedAt))));
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [lookupError, setLookupError] = useState('');
  const [success, setSuccess] = useState('');
  const [operation, setOperation] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [previousPages, setPreviousPages] = useState<number[]>([]);
  const [editor, setEditor] = useState<Editor | null>((retained?.editor as Editor|null)??null);
  const editorDirty = editor !== null && JSON.stringify(editor.draft) !== JSON.stringify(editor.record ? draftFrom(editor.record) : seed(editor.kind, view, lookups));
  const editorDirtyRef = useRef(editorDirty); editorDirtyRef.current = editorDirty;
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [importing, setImporting] = useState(Boolean(retained?.importing));
  const [importText, setImportText] = useState(typeof retained?.importText==='string'?retained.importText:'');
  const [importItems, setImportItems] = useState<ImportWatchlistRequest['items'] | null>((retained?.importItems as ImportWatchlistRequest['items']|null)??null);
  const [importResult, setImportResult] = useState<string[]>([]);
  useUnsavedWork(!providedSession&&(editorDirty||Boolean(session.pending)||Boolean(importText.trim())));
  useLayoutEffect(()=>{
    try{session.setDraft({view,editor,importing,importText,importItems,previewToken:preview?.token??null,selected,dirty:editorDirty||Boolean(importText.trim())});}
    catch{setError('草稿超出本地保留容量，请缩短内容；尚未发送。');}
  },[session,view,editor,editorDirty,importing,importText,importItems,preview?.token,selected]);
  const preserveSelectionOnReload=useRef(false);
  const mounted = useRef(false);
  const locked = useRef(false);
  const readEpoch = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const previewController = useRef<AbortController | null>(null);
  const previewEpoch = useRef(0);
  const reloadController = useRef<AbortController | null>(null);
  const navigationEpoch = useRef(0);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const editorForm = useRef<HTMLFormElement>(null);
  const pendingEditFocus = useRef<{
    key: string;
    navigation: number;
    previousPage: WorkspaceRecordPage | null;
    trigger: HTMLButtonElement | undefined;
  } | null>(null);
  const submit=(operation:WorkspaceWriteOperation,input:Record<string,unknown>)=>
    session.submit(captureWorkspaceCommand(operation,input,session.draftVersion));
  const completionNotice=(result:WorkspaceCompletion)=>{
    const deleted=result.current.filter(row=>row.deletedAt!==null).length;
    const checked=`已逐项核对 ${result.current.length} 项当前状态（${deleted} 项已删除）；这是逐项读取，非同一时刻快照。`;
    if(result.createdCount!==undefined)return `原导入回执：新增 ${result.createdCount} 项，跳过 ${result.skipped?.length??0} 项重复证券，既有备注未覆盖。${checked}`;
    return `原操作已确认。${checked}`;
  };

  const dismissTransient = useCallback(() => {
    navigationEpoch.current++;
    pendingEditFocus.current = null;
    previewController.current?.abort();
    previewEpoch.current++;
    if (reloadController.current) {
      reloadController.current.abort();
      reloadController.current = null;
      locked.current = false;
      setOperation('');
    }
    setPreview(null);
    setEditor(null);
    setImporting(false);
    setError('');
    setSuccess('');
    setSelected([]);
  }, []);
  const historyIssue = useUnsavedHistoryDismiss(dismissTransient);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readController.current?.abort();
      previewController.current?.abort();
      reloadController.current?.abort();

    };
  }, [dismissTransient]);
  useEffect(() => {
    const respectFocusChoice = (event: FocusEvent) => {
      const pending = pendingEditFocus.current;
      if (pending && event.target !== document.body && event.target !== pending.trigger)
        pendingEditFocus.current = null;
    };
    document.addEventListener('focusin', respectFocusChoice);
    return () => {
      pendingEditFocus.current = null;
      document.removeEventListener('focusin', respectFocusChoice);
    };
  }, []);
  useEffect(() => {
    const pending = pendingEditFocus.current;
    if (!pending || editor || loading || !lookupReady || page === pending.previousPage) return;
    pendingEditFocus.current = null;
    const active = document.activeElement;
    if (pending.navigation !== navigationEpoch.current ||
        (active !== document.body && active !== pending.trigger)) return;
    const button = editButtons.current.get(pending.key);
    if (button?.isConnected && !button.disabled) button.focus();
  }, [editor, loading, lookupReady, page]);
  useEffect(() => {
    const controller = new AbortController();
    setLookupReady(false);
    setLookupError('');
    void loadLookups(controller.signal, manualConversation ? view.workspaceId : undefined)
      .then((rows) => {
        if (!controller.signal.aborted) {
          setLookups(rows);
          setLookupReady(true);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setLookupError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [reload, manualConversation ? view.workspaceId : undefined]);
  useEffect(() => {
    const epoch = ++readEpoch.current;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && readEpoch.current === epoch;
    setLoading(true);
    setPage(null);
    if(!preserveSelectionOnReload.current)setSelected([]);
    preserveSelectionOnReload.current=false;
    if (conversationScopeMissing) { setLoading(false); return () => controller.abort(); }
    void workspaceApi
      .list(requestFor(view), controller.signal)
      .then((result) => {
        if (!current()) return;
        if (!result.items.length && view.offset > 0) {
          setView((old) => ({ ...old, offset: 0 }));
          return;
        }
        setPage(result);
      })
      .catch((cause) => {
        if (current()) setError(errorMessage(cause));
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
    return () => controller.abort();
  }, [view, reload, conversationScopeMissing]);

  const navigate = (patch: Partial<View>) => {
    if((editorDirty||importText.trim())&&!allowLeavingUnsavedWork())return;
    if (patch.offset === undefined) setPreviousPages([]);
    else if (patch.offset > view.offset) setPreviousPages((old) => [...old, view.offset]);
    else setPreviousPages((old) => old.slice(0, -1));
    dismissTransient();
    readEpoch.current++;
    readController.current?.abort();
    setView((current) => ({ ...current, ...patch, offset: patch.offset ?? 0 }));
    if ('workspaceId' in patch) onWorkspaceChange?.(patch.workspaceId || null);
  };
  const refresh = () => {
    if (!locked.current) {
      setError('');
      setSuccess('');
      setReload((value) => value + 1);
    }
  };
  const closeEditor = useCallback(() => {
    if (editorDirtyRef.current && !allowLeavingUnsavedWork()) return;
    if (!locked.current) {
      setEditor(null);
      setError('');
    }
  }, []);
  const closePreview = useCallback(() => {
    if (locked.current) return;
    previewEpoch.current++;
    previewController.current?.abort();
    setPreview(null);
    setError('');
  }, []);
  const closeImport = useCallback(() => {
    if(importText.trim()&&!allowLeavingUnsavedWork())return;
    if (!locked.current) {
      setImporting(false);setImportText('');setImportItems(null);
      setError('');
    }
  }, [importText]);

  const mutate = async (name: string, work: () => Promise<WorkspaceCompletion|null>, completed?: (result:WorkspaceCompletion) => void) => {
    if (locked.current) return;
    locked.current = true;
    const navigation = navigationEpoch.current;
    setOperation(name);setError('');setSuccess('');
    readEpoch.current++;readController.current?.abort();
    try {
      const result=await work();
      if (!mounted.current) return;
      if(!result){const rejected=session.takeRejection();if(navigation===navigationEpoch.current){setError(session.pending?.message??rejected?.message??'原操作未提交；草稿已保留，请核对内容。');if(rejected?.conflict&&rejected.command.draftVersion===session.draftVersion)setEditor(old=>old?{...old,conflict:true}:old);}return;}
      if(!session.takeCompletion(result.id))return;
      if(navigation===navigationEpoch.current){
        setSuccess(completionNotice(result));
        if(result.skipped)setImportResult(result.skipped.map(item=>`${item.market}:${item.symbol}`));
        if(result.command.draftVersion!==session.draftVersion)preserveSelectionOnReload.current=true;
        if(result.command.draftVersion===session.draftVersion){
          setEditor(null);setPreview(null);setImporting(false);setImportText('');setImportItems(null);completed?.(result);
        }
      }
      setReload(value=>value+1);
    } catch(cause){
      if(mounted.current&&navigation===navigationEpoch.current)setError(errorMessage(cause));
    }finally{locked.current=false;if(mounted.current)setOperation('');}
  };
  useEffect(()=>{
    // The originating mounted mutation owns its callback. A remounted view owns
    // late completions only when it has no active mutation waiting on that result.
    if(locked.current||!session.available)return;
    const rejected=session.takeRejection();
    if(rejected){setError(rejected.message);if(rejected.conflict&&rejected.command.draftVersion===session.draftVersion)setEditor(old=>old?{...old,conflict:true}:old);}
    const event=session.completionEvent;if(!event)return;
    const result=session.takeCompletion(event.id);if(!result)return;
    if(result.command.draftVersion!==session.draftVersion)preserveSelectionOnReload.current=true;
    setSuccess(completionNotice(result));setReload(n=>n+1);
    if(result.skipped)setImportResult(result.skipped.map(item=>`${item.market}:${item.symbol}`));
    if(result.command.draftVersion===session.draftVersion){setEditor(null);setImporting(false);setImportText('');setImportItems(null);}
  },[session,sessionEvent]);

  const openEditor = (kind: WorkspaceKind, record: WorkspaceRecord | null = null) => {
    if (locked.current || !lookupReady) return;
    setError('');
    setSuccess('');
    setEditor({
      kind,
      record,
      draft: record ? draftFrom(record) : seed(kind, view, lookups),
      conflict: false,
    });
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!editor || editor.conflict || !validDraft(editor)) return;
    const { kind, record, draft } = editor;
    const data = Object.fromEntries(
      Object.entries(draft).map(([name, value]) => [
        name,
        typeof value === 'string' && !['content', 'notes'].includes(name) ? value.trim() : value,
      ]),
    ) as Partial<WorkspaceInputDataByKind[WorkspaceKind]>;
    const input = record
      ? { kind, id: record.id, expectedRevision: record.revision, patch: data }
      : { kind, data };
    void mutate('保存', () => input.patch !== undefined ? submit('update',input) : submit('create',input)
    , () => {
      // Modal restores its original DOM node, but refresh replaces the row. Restore
      // the same record's new button only if focus still belongs to this editor.
      if (record && (document.activeElement === document.body ||
          editorForm.current?.contains(document.activeElement))) {
        const key = `${kind}:${record.id}`;
        pendingEditFocus.current = {
          key, navigation: navigationEpoch.current, previousPage: page,
          trigger: editButtons.current.get(key),
        };
      }
    });
  };
  const reloadEditor = async () => {
    if (!editor?.record || locked.current) return;
    if(session.pending){setError('请先核对原操作；载入版本不会替换尚未确认的提交或新草稿。');return;}
    const target = editor;
    const navigation = navigationEpoch.current;
    const controller = new AbortController();
    reloadController.current = controller;
    const current = () =>
      mounted.current && !controller.signal.aborted && navigation === navigationEpoch.current;
    locked.current = true;
    setOperation('载入版本');
    try {
      const record = await workspaceApi.get(
        { kind: target.kind, id: target.record!.id, includeDeleted: true },
        controller.signal,
      );
      if (!current()) return;
      if (record.deletedAt) {
        setEditor(null);
        setError('此记录已被删除，请在显示已删除记录后恢复。');
      } else {
        setEditor({ kind: target.kind, record, draft: draftFrom(record), conflict: false });
        setError('');
      }
    } catch (cause) {
      if (current()) setError(errorMessage(cause));
    } finally {
      if (reloadController.current === controller) {
        reloadController.current = null;
        locked.current = false;
        if (mounted.current) setOperation('');
      }
    }
  };
  const togglePin = (record: WorkspaceRecord) => {
    const input = {
      ...identity(record),
      kind: 'session' as const,
      patch: { pinned: !(record.data as WorkspaceDataByKind['session']).pinned },
    };
    void mutate('置顶',()=>submit('update',input));
  };
  const restore = (record: WorkspaceRecord) => {
    const input = identity(record);
    void mutate('恢复',()=>submit('restore',{...input}));
  };
  const prepareDelete = async (roots: WorkspaceRecord[]) => {
    if (locked.current || !roots.length) return;
    const epoch = ++previewEpoch.current;
    previewController.current?.abort();
    const controller = new AbortController();
    previewController.current = controller;
    setError('');
    const previewToken=newKey();
    setPreview({token:previewToken, roots, manifest: null, approved: false });
    try {
      const manifests = await Promise.all(
        roots.map((record) =>
          workspaceApi.previewDelete({ kind: recordKind(record), id: record.id }, controller.signal),
        ),
      );
      if (!mounted.current || controller.signal.aborted || previewEpoch.current !== epoch) return;
      const manifest = [
        ...new Map(manifests.flat().map((item) => [`${item.kind}:${item.id}`, item])).values(),
      ];
      if (manifest.length > 1000) throw new Error('删除范围超过 1000 项，请缩小选择范围');
      setPreview({token:previewToken, roots, manifest, approved: false });
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted && previewEpoch.current === epoch)
        setError(errorMessage(cause));
    }
  };
  const confirmDelete = () => {
    if (!preview?.manifest?.length || (preview.manifest.length > preview.roots.length && !preview.approved))
      return;
    const input = { items: preview.manifest };
    void mutate(
      '删除',
      () => submit('batchDelete',input),
      (result) => {
        if (view.includeDeleted) return;
        const deleted = (kind: WorkspaceKind, id: string) =>
          result.current.some((item) => item.kind === kind && item.id === id && item.deletedAt!==null);
        const removedWorkspace = deleted('workspace', view.workspaceId);
        setView((old) => ({
          ...old,
          offset: 0,
          workspaceId: removedWorkspace ? '' : old.workspaceId,
          groupId: deleted('session-group', old.groupId) ? '*' : old.groupId,
          sessionId: deleted('session', old.sessionId) ? '' : old.sessionId,
          watchlistId: deleted('watchlist', old.watchlistId) ? '' : old.watchlistId,
        }));
        setPreviousPages([]);
        if (removedWorkspace) onWorkspaceChange?.(null);
      },
    );
  };
  const reviewImport = () => {
    try {
      setImportItems(parseWatchlistImport(importText));
      setError('');
    } catch (cause) {
      setImportItems(null);
      setError(errorMessage(cause));
    }
  };
  const confirmImport = () => {
    if (!importItems || !view.watchlistId) return;
    const input = { watchlistId: view.watchlistId, items: importItems };
    void mutate('导入',()=>submit('importWatchlist',input));
  };

  const busy = Boolean(operation);
  const recoveryNotice=session.pending ? <Notice><p>{session.pending.message}</p><button type="button" className="secondary" disabled={busy} onClick={()=>void mutate('核对原操作',()=>session.recover())}>{session.pending.receipt?'重试读取当前状态':'重试原操作'}</button><p>原提交内容和范围保持不变；修改后的草稿不会自动另行提交。</p></Notice> : null;
  const visibleLookups = (kind: LookupKind) =>
    lookups[kind].filter((row) => view.includeDeleted || !row.deletedAt);
  const workspaceOptions = visibleLookups('workspace');
  const scoped = (kind: 'session' | 'session-group' | 'watchlist') =>
    visibleLookups(kind).filter((row) => !view.workspaceId || field(row, 'workspaceId') === view.workspaceId);
  const lookupTitle = (kind: LookupKind, id: string) =>
    lookups[kind].find((row) => row.id === id) ? title(lookups[kind].find((row) => row.id === id)!) : id;
  const selectedRows = (page?.items ?? []).filter((row) => selected.includes(row.id) && !row.deletedAt);
  const activePage = (page?.items ?? []).filter((row) => !row.deletedAt);
  const scopeMissing =
    view.kind === 'message' ? !view.sessionId : view.kind === 'watchlist-item' ? !view.watchlistId : false;
  const selectedParent =
    view.kind === 'message'
      ? lookups.session.find((row) => row.id === view.sessionId)
      : view.kind === 'watchlist-item'
        ? lookups.watchlist.find((row) => row.id === view.watchlistId)
        : null;
  const canCreate =
    !conversationScopeMissing &&
    (!manualConversation || lookups.workspace.some(row => row.id === view.workspaceId && !row.deletedAt)) &&
    !selectedParent?.deletedAt &&
    lookupReady &&
    !busy &&
    (view.kind === 'workspace' ||
      (!scopeMissing &&
        (['message', 'watchlist-item'].includes(view.kind) ||
          lookups.workspace.some((row) => !row.deletedAt))));
  const relationships = (record: WorkspaceRecord) => {
    const parts: string[] = [];
    if (field(record, 'workspaceId')) parts.push(lookupTitle('workspace', field(record, 'workspaceId')));
    if (field(record, 'parentId'))
      parts.push(
        `上级：${lookupTitle(record.kind === 'workspace' ? 'workspace' : 'session-group', field(record, 'parentId'))}`,
      );
    if (field(record, 'groupId')) parts.push(lookupTitle('session-group', field(record, 'groupId')));
    if (field(record, 'sessionId')) parts.push(lookupTitle('session', field(record, 'sessionId')));
    if (field(record, 'watchlistId')) parts.push(lookupTitle('watchlist', field(record, 'watchlistId')));
    if (record.kind === 'session')
      parts.push(
        `模式：${({ quick: '快速', deep: '深入', plan: '计划', daily: '日常' } as Record<string, string>)[field(record, 'mode')]}`,
        field(record, 'model') ? `模型偏好：${field(record, 'model')}` : '未设模型偏好',
      );
    if (record.kind === 'watchlist-item') parts.push(field(record, 'symbol'), field(record, 'market'));
    if (record.kind === 'message')
      parts.push(
        (({ user: '用户', assistant: '助手', system: '系统' } as Record<string, string>)[
          field(record, 'role')
        ] || field(record, 'role')) + (manualConversation ? '（手工标记，非生成回复）' : ''),
      );
    return parts.join(' · ');
  };

  return (
    <section className="workspace-manager">
      {!editor&&!preview&&!importing&&recoveryNotice}
      {historyIssue && <p role="alert">{historyIssue}</p>}
      <style>{workspaceStyles}</style>
      {!manualConversation && <RelatedTranscriptLinks workspaceId={view.workspaceId} sessionId={view.sessionId}/>}
      <PageHeading
        eyebrow={manualConversation ? "LOCAL MANUAL CONVERSATION" : "LOCAL RESEARCH WORKSPACE"}
        title={manualConversation ? "本地手工会话" : "会话与工作区"}
        description={manualConversation ? "选择工作区和会话，阅读已保存消息或手工追加记录" : "组织本地研究会话、消息和自选证券，保存后可刷新继续使用"}
        actions={
          <div className="company-toolbar-actions">
            {onReturnToPlan&&<button className="secondary" onClick={onReturnToPlan}>返回来源计划：{sourcePlanTitle}</button>}
            {manualConversation && onOpenWorkspace && <button className="secondary" onClick={onOpenWorkspace}>返回工作区管理</button>}
            <button className="secondary" disabled={busy} onClick={refresh}>
              <RefreshCw size={15} />
              刷新工作区
            </button>
            <button className="primary" disabled={!canCreate} onClick={() => openEditor(view.kind)}>
              <Plus size={16} />
              新建{labels[view.kind]}
            </button>
          </div>
        }
      />
      {manualConversation && <Notice>本地手工会话，未连接 AI；消息由用户录入。用户、助手、系统均为手工角色标记，不代表自动生成或真实系统指令。</Notice>}
      <Notice>
        这里保存本地记录。消息为手工记录；研究模式和模型名称仅保存偏好，不会自动调用
        AI。自选证券为人工录入，不含实时行情或证券身份核验。
      </Notice>
      {lookupError && (
        <Notice kind="error">
          关系目录读取失败：{lookupError}。请刷新；为避免错误关联，新增和编辑暂不可用。
        </Notice>
      )}
      {error && !editor && !preview && !importing && <Notice kind="error">{error}</Notice>}
      {page?.generatedSearchTruncated && (
        <Notice>
          生成研究正文搜索达到有界扫描或匹配上限；当前仅显示部分匹配，请缩小工作区或关键词。标题和手工消息搜索仍保留。
        </Notice>
      )}
      {success && (
        <div role="status">
          <Notice kind="success">{success}</Notice>
          {importResult.length > 0 && (
            <details>
              <summary>查看原导入回执跳过的证券（{importResult.length}）</summary>
              <p className="wm-wrap">{importResult.join('、')}</p>
            </details>
          )}
        </div>
      )}
      <nav className="wm-tabs company-tabs" aria-label="工作区管理视图">
        {(manualConversation ? ['session', 'message'] as const : kinds).map((kind) => (
          <button
            key={kind}
            className={view.kind === kind ? 'selected' : ''}
            aria-pressed={view.kind === kind}
            onClick={() => navigate({ kind, query: '', pinned: false })}
          >
            {labels[kind]}
          </button>
        ))}
      </nav>
      <div className="wm-controls panel">
        <label>
          当前工作区
          <select
            aria-label="当前工作区"
            value={view.workspaceId}
            onChange={(event) =>
              navigate({ workspaceId: event.target.value, groupId: '*', sessionId: '', watchlistId: '' })
            }
          >
<option value="">{manualConversation ? '请选择工作区' : '全部工作区'}</option>
            {workspaceOptions.map((row) => (
              <option key={row.id} value={row.id}>
                {title(row)}
                {row.deletedAt ? '（已删除）' : ''}
              </option>
            ))}
          </select>
        </label>
        {view.kind === 'session' && (
          <label>
            会话分组筛选
            <select
              aria-label="会话分组筛选"
              value={view.groupId}
              onChange={(event) => navigate({ groupId: event.target.value })}
            >
              <option value="*">全部分组</option>
              <option value="">未分组</option>
              {scoped('session-group').map((row) => (
                <option key={row.id} value={row.id}>
                  {title(row)}
                  {row.deletedAt ? '（已删除）' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {view.kind === 'message' && (
          <label>
            所属会话
            <select
              aria-label="所属会话筛选"
              value={view.sessionId}
              onChange={(event) => navigate({ sessionId: event.target.value })}
            >
<option value="">{manualConversation ? '请选择会话' : '全部会话消息'}</option>
              {scoped('session').map((row) => (
                <option key={row.id} value={row.id}>
                  {title(row)}
                  {row.deletedAt ? '（已删除）' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {view.kind === 'watchlist-item' && (
          <label>
            所属自选分组
            <select
              aria-label="所属自选分组筛选"
              value={view.watchlistId}
              onChange={(event) => navigate({ watchlistId: event.target.value })}
            >
              <option value="">全部自选证券</option>
              {scoped('watchlist').map((row) => (
                <option key={row.id} value={row.id}>
                  {title(row)}
                  {row.deletedAt ? '（已删除）' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="wm-search">
          <span>
            <Search size={13} /> 搜索{labels[view.kind]}
            {view.kind === 'session' ? '及已授权消息/研究正文' : ''}
          </span>
          <input
            aria-label={`搜索${labels[view.kind]}`}
            value={view.query}
            maxLength={150}
            onChange={(event) => navigate({ query: event.target.value })}
            placeholder={view.kind === 'session' ? '标题、手工消息或已授权研究内容' : '输入关键词'}
          />
        </label>
        <label className="wm-checkbox">
          <input
            type="checkbox"
            checked={view.includeDeleted}
            onChange={(event) =>
              navigate({
                includeDeleted: event.target.checked,
                ...(!event.target.checked
                  ? {
                      workspaceId: lookups.workspace.find((row) => row.id === view.workspaceId)?.deletedAt
                        ? ''
                        : view.workspaceId,
                      groupId: lookups['session-group'].find((row) => row.id === view.groupId)?.deletedAt
                        ? '*'
                        : view.groupId,
                      sessionId: lookups.session.find((row) => row.id === view.sessionId)?.deletedAt
                        ? ''
                        : view.sessionId,
                      watchlistId: lookups.watchlist.find((row) => row.id === view.watchlistId)?.deletedAt
                        ? ''
                        : view.watchlistId,
                    }
                  : {}),
              })
            }
          />
          显示已删除记录
        </label>
        {view.kind === 'session' && (
          <label className="wm-checkbox">
            <input
              type="checkbox"
              checked={view.pinned}
              onChange={(event) => navigate({ pinned: event.target.checked })}
            />
            仅置顶
          </label>
        )}
      </div>
      {manualConversation && <div className="wm-toolbar">
        {view.kind === 'message' && <button className="secondary" onClick={() => navigate({kind: 'session', sessionId: '', query: ''})}>返回会话列表</button>}
        {conversationScopeMissing && <p role="status">{exactTargetStale?'来源计划的会话版本已变化，请返回计划重新核对关联；不会改用其他会话。':!lookupReady ? '正在读取可选工作区与会话…' : !view.workspaceId ? '请先选择一个工作区，再选择会话；尚未读取任何会话消息。' : '请选择当前工作区内的有效会话；未找到、已删除或已移动的选择不会自动改用其他记录。'}</p>}
      </div>}
      {scopeMissing && !manualConversation && (
        <p className="wm-hint">
          选择{view.kind === 'message' ? '一个会话' : '一个自选分组'}后可新增{labels[view.kind]}
          ；当前跨全部工作区展示记录。
        </p>
      )}
      {view.kind === 'watchlist-item' && view.watchlistId && (
        <div className="wm-toolbar">
          <button
            className="secondary"
            disabled={
              busy ||
              !lookupReady ||
              Boolean(lookups.watchlist.find((row) => row.id === view.watchlistId)?.deletedAt)
            }
            onClick={() => {
              setImportText('');
              setImportItems(null);
              setImportResult([]);
              setError('');
              setImporting(true);
            }}
          >
            批量导入自选证券
          </button>
        </div>
      )}
      {loading ? (
        <div className="loading" role="status">
          <Spinner /> 正在读取{labels[view.kind]}…
        </div>
      ) : (
        page && (
          <>
            <div className="wm-toolbar">
              <span>
                共 {page.total} 项{view.includeDeleted ? '（含已删除）' : ''} · 当前 {page.items.length} 项
              </span>
              {activePage.length > 0 && (
                <label className="wm-checkbox">
                  <input
                    type="checkbox"
                    aria-label="选择本页有效记录"
                    checked={activePage.every((row) => selected.includes(row.id))}
                    onChange={(event) =>
                      setSelected(event.target.checked ? activePage.map((row) => row.id) : [])
                    }
                  />
                  选择本页
                </label>
              )}
              <button
                className="secondary company-danger"
                disabled={busy || !selectedRows.length}
                onClick={() => void prepareDelete(selectedRows)}
              >
                <Trash2 size={14} />
                预览批量删除（{selectedRows.length}）
              </button>
            </div>
            {!page.items.length ? (
              <EmptyState
                title={view.query ? '没有匹配的记录' : '这里还没有记录'}
                description={
                  view.query
                    ? '尝试更换关键词、分组或工作区。不会用其他记录代替无匹配结果。'
                    : `新建${labels[view.kind]}，或切换“显示已删除记录”查看可恢复内容。`
                }
              />
            ) : (
              <div className={`company-grid ${view.kind === 'message' ? 'wm-messages' : ''}`}>
                {page.items.map((record) => (
                  <article
                    key={record.id}
                    className={`panel company-card ${record.deletedAt ? 'company-deleted' : ''}`}
                  >
                    <div className="company-card-top">
                      {!record.deletedAt ? (
                        <label className="wm-checkbox">
                          <input
                            type="checkbox"
                            aria-label={`选择 ${title(record)}`}
                            checked={selected.includes(record.id)}
                            onChange={(event) =>
                              setSelected((old) =>
                                event.target.checked
                                  ? [...old, record.id]
                                  : old.filter((id) => id !== record.id),
                              )
                            }
                          />
                          {labels[recordKind(record)]}
                        </label>
                      ) : (
                        <span className="wm-deleted">已删除 · 可恢复</span>
                      )}
                      <span className="wm-meta">版本 {record.revision}</span>
                    </div>
                    <h2>
                      {record.kind === 'session' &&
                        (record.data as WorkspaceDataByKind['session']).pinned && (
                          <Pin size={14} aria-label="已置顶" />
                        )}{' '}
                      {title(record)}
                    </h2>
                    <p className="company-symbol">{relationships(record)}</p>
                    {(field(record, 'description') || field(record, 'content') || field(record, 'notes')) && (
                      <p className="company-description">
                        {field(record, 'content') || field(record, 'description') || field(record, 'notes')}
                      </p>
                    )}
                    <p className="wm-meta">
                      更新于 {new Date(record.updatedAt).toLocaleString()}
                      <span className="wm-id"> · {record.id}</span>
                    </p>
                    <div className="company-card-footer">
                      {record.deletedAt ? (
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => restore(record)}
                          aria-label={`恢复 ${title(record)}`}
                        >
                          <RotateCcw size={14} />
                          恢复
                        </button>
                      ) : (
                        <>
                          <button
                            className="secondary"
                            disabled={busy || !lookupReady}
                            ref={(button) => {
                              const key = `${record.kind}:${record.id}`;
                              if (button) editButtons.current.set(key, button);
                              else editButtons.current.delete(key);
                            }}
                            aria-label={`编辑 ${title(record)}`}
                            onClick={() => openEditor(recordKind(record), record)}
                          >
                            <Pencil size={14} />
                            编辑 / 移动
                          </button>
                          {record.kind === 'session' && (
                            <button
                              className="secondary"
                              disabled={busy}
                              aria-label={`${(record.data as WorkspaceDataByKind['session']).pinned ? '取消置顶' : '置顶'} ${title(record)}`}
                              onClick={() => togglePin(record)}
                            >
                              <Pin size={14} />
                              {(record.data as WorkspaceDataByKind['session']).pinned ? '取消置顶' : '置顶'}
                            </button>
                          )}
                          <button
                            className="icon-button company-danger"
                            disabled={busy}
                            aria-label={`删除 ${title(record)}`}
                            onClick={() => void prepareDelete([record])}
                          >
                            <Trash2 size={16} />
                          </button>
                        </>
                      )}
                      {record.kind === 'workspace' && (
                        <button
                          className="secondary"
                          onClick={() =>
                            navigate({
                              kind: 'session',
                              workspaceId: record.id,
                              groupId: '*',
                              sessionId: '',
                              watchlistId: '',
                              query: '',
                              includeDeleted: Boolean(record.deletedAt) || view.includeDeleted,
                            })
                          }
                        >
                          <FolderOpen size={14} />
                          进入工作区
                        </button>
                      )}
                      {record.kind === 'session-group' && (
                        <button
                          className="secondary"
                          onClick={() =>
                            navigate({
                              kind: 'session',
                              workspaceId: field(record, 'workspaceId'),
                              groupId: record.id,
                              query: '',
                              includeDeleted: Boolean(record.deletedAt) || view.includeDeleted,
                            })
                          }
                        >
                          查看组内会话
                          <ArrowRight size={14} />
                        </button>
                      )}
                      {record.kind === 'session' && (
                        <button
                          className="secondary"
                          onClick={() =>
                            navigate({
                              kind: 'message',
                              workspaceId: field(record, 'workspaceId'),
                              sessionId: record.id,
                              query: '',
                              includeDeleted: Boolean(record.deletedAt) || view.includeDeleted,
                            })
                          }
                        >
                          查看消息
                          <ArrowRight size={14} />
                        </button>
                      )}
                      {record.kind === 'watchlist' && (
                        <button
                          className="secondary"
                          onClick={() =>
                            navigate({
                              kind: 'watchlist-item',
                              workspaceId: field(record, 'workspaceId'),
                              watchlistId: record.id,
                              query: '',
                              includeDeleted: Boolean(record.deletedAt) || view.includeDeleted,
                            })
                          }
                        >
                          查看证券
                          <ArrowRight size={14} />
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
            <div className="wm-pagination" aria-label="记录分页">
              <button
                className="secondary"
                disabled={busy || view.offset === 0}
                onClick={() => navigate({ offset: previousPages.at(-1) ?? 0 })}
              >
                上一页
              </button>
              <span>
                第 {view.offset + (page.items.length ? 1 : 0)}–{view.offset + page.items.length} 项
              </span>
              <button
                className="secondary"
                disabled={busy || page.nextOffset === null}
                onClick={() => navigate({ offset: page.nextOffset ?? 0 })}
              >
                下一页
              </button>
            </div>
          </>
        )
      )}
      {!loading && !page && !conversationScopeMissing && (
        <div className="panel company-confirm">
          <p>未能读取记录。请确认本地工作区服务已经启动，再刷新重试。</p>
          <button className="secondary" onClick={refresh}>
            重新读取
          </button>
        </div>
      )}
      {editor && (
        <Modal
          title={`${editor.record ? '编辑' : '新建'}${labels[editor.kind]}`}
          onClose={closeEditor}
          wide={editor.kind === 'message'}
        >
          <form ref={editorForm} className="company-form wm-form" onSubmit={save}>
            {recoveryNotice}
            {error && <Notice kind="error">{error}</Notice>}
            {editor.record && (
              <p className="wm-meta">
                正在编辑版本 {editor.record.revision}。保存时会校验版本，避免覆盖其他窗口的修改。
              </p>
            )}
            {editor.conflict && (
              <button type="button" className="secondary" disabled={busy} onClick={() => void reloadEditor()}>
                丢弃草稿并载入最新版本
              </button>
            )}
            <fieldset disabled={busy || editor.conflict}>
              <EditorFields
                editor={editor}
                manualConversation={manualConversation}
                lookups={lookups}
                change={(name, value) =>
                  setEditor((old) =>
                    old
                      ? {
                          ...old,
                          draft: {
                            ...old.draft,
                            [name]: value,
                            ...(name === 'workspaceId'
                              ? old.kind === 'session'
                                ? { groupId: null }
                                : old.kind === 'session-group'
                                  ? { parentId: null }
                                  : {}
                              : {}),
                          },
                        }
                      : old,
                  )
                }
              />
            </fieldset>
            <div className="company-form-actions">
              <button type="button" className="secondary" disabled={busy} onClick={closeEditor}>
                取消
              </button>
              <button
                type="submit"
                className="primary"
                disabled={busy || editor.conflict || !validDraft(editor)}
              >
                {busy ? <Spinner /> : null}保存{labels[editor.kind]}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {preview && (
        <Modal title="确认删除范围" onClose={closePreview}>
          <div className="company-confirm">
            {recoveryNotice}
            {error && <Notice kind="error">{error}</Notice>}
            <p>选择：{preview.roots.map(title).join('、')}</p>
            {!preview.manifest ? (
              <>
                {!error ? (
                  <div role="status">
                    <Spinner /> 正在核对关联子项…
                  </div>
                ) : (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void prepareDelete(preview.roots)}
                  >
                    重新预览删除范围
                  </button>
                )}
              </>
            ) : (
              <>
                <Notice>
                  这会将 {preview.manifest.length}{' '}
                  项移到回收站，不会永久删除。请先移动需要保留的子项，再重新预览。
                </Notice>
                <ul>
                  {kinds
                    .filter((kind) => preview.manifest!.some((item) => item.kind === kind))
                    .map((kind) => (
                      <li key={kind}>
                        {labels[kind]}：{preview.manifest!.filter((item) => item.kind === kind).length} 项
                      </li>
                    ))}
                </ul>
                {preview.manifest.length > preview.roots.length && (
                  <label className="wm-checkbox">
                    <input
                      type="checkbox"
                      checked={preview.approved}
                      disabled={busy}
                      onChange={(event) =>
                        setPreview((old) => (old ? { ...old, approved: event.target.checked } : old))
                      }
                    />
                    同时删除上述关联子项
                  </label>
                )}
              </>
            )}
            <div className="company-form-actions">
              <button className="secondary" disabled={busy} onClick={closePreview}>
                取消
              </button>
              <button
                className="primary company-danger-button"
                disabled={
                  busy ||
                  !preview.manifest?.length ||
                  (preview.manifest.length > preview.roots.length && !preview.approved)
                }
                onClick={confirmDelete}
              >
                {busy ? <Spinner /> : <Trash2 size={14} />}确认移到回收站
              </button>
            </div>
          </div>
        </Modal>
      )}
      {importing && (
        <Modal title="批量导入自选证券" onClose={closeImport} wide>
          <div className="company-form wm-form">
            {recoveryNotice}
            {error && <Notice kind="error">{error}</Notice>}
            <p>
              导入到：{lookupTitle('watchlist', view.watchlistId)}
              。每行一条，按代码、市场、名称、备注排列，可使用 CSV 或制表符；同市场同代码不会覆盖既有记录。
            </p>
            <label>
              导入内容
              <textarea
                rows={9}
                aria-label="自选导入内容"
                disabled={busy}
                placeholder={'symbol,market,name,notes\nSYN-001,UNSPECIFIED,原创虚构证券,待核验'}
                value={importText}
                onChange={(event) => {
                  setImportText(event.target.value);
                  setImportItems(null);
                }}
              />
            </label>
            <button className="secondary" disabled={busy || !importText.trim()} onClick={reviewImport}>
              校验并预览
            </button>
            {importItems && (
              <div className="panel company-confirm">
                <p>已校验 {importItems.length} 项（最多 200 项）；以下预览前 10 项</p>
                <ul>
                  {importItems.slice(0, 10).map((item, index) => (
                    <li key={index}>
                      {item.symbol} · {item.market} · {item.name || '未填写名称'}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="company-form-actions">
              <button className="secondary" disabled={busy} onClick={closeImport}>
                取消
              </button>
              <button className="primary" disabled={busy || !importItems} onClick={confirmImport}>
                {busy ? <Spinner /> : null}确认导入
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function validDraft(editor: Editor): boolean {
  const required: Record<WorkspaceKind, string[]> = {
    workspace: ['name'],
    'session-group': ['name', 'workspaceId'],
    session: ['title', 'workspaceId'],
    message: ['sessionId', 'content'],
    watchlist: ['name', 'workspaceId'],
    'watchlist-item': ['watchlistId', 'symbol', 'market'],
  };
  return required[editor.kind].every(
    (name) => typeof editor.draft[name] === 'string' && String(editor.draft[name]).trim(),
  );
}
function EditorFields({
  editor,
  lookups,
  change,
  manualConversation = false,
}: {
  editor: Editor;
  manualConversation?: boolean;
  lookups: Lookups;
  change: (name: string, value: string | boolean | null) => void;
}) {
  const { kind, draft, record } = editor;
  const text = (
    name: string,
    label: string,
    required = false,
    maxLength = 120,
    multiline = false,
  ): ReactNode => (
    <label>
      {label}
      {multiline ? (
        <textarea
          aria-label={label}
          required={required}
          maxLength={maxLength}
          rows={kind === 'message' ? 10 : 4}
          value={String(draft[name] ?? '')}
          onChange={(event) => change(name, event.target.value)}
        />
      ) : (
        <input
          aria-label={label}
          required={required}
          maxLength={maxLength}
          value={String(draft[name] ?? '')}
          onChange={(event) => change(name, event.target.value)}
        />
      )}
    </label>
  );
  const select = (
    name: string,
    label: string,
    options: WorkspaceRecord[],
    empty: string,
    nullable = false,
  ): ReactNode => (
    <label>
      {label}
      <select
        aria-label={label}
        value={String(draft[name] ?? '')}
        required={!nullable}
        onChange={(event) => change(name, event.target.value || (nullable ? null : ''))}
      >
        <option value="">{empty}</option>
        {options
          .filter((row) => !row.deletedAt && (row.kind !== record?.kind || row.id !== record?.id))
          .map((row) => (
            <option key={row.id} value={row.id}>
              {title(row)}
            </option>
          ))}
      </select>
    </label>
  );
  const groups = lookups['session-group'].filter((row) => field(row, 'workspaceId') === draft.workspaceId);
  return (
    <>
      {(kind === 'workspace' ||
        kind === 'session-group' ||
        kind === 'watchlist' ||
        kind === 'watchlist-item') &&
        text(
          'name',
          kind === 'watchlist-item' ? '证券名称（可选）' : `${labels[kind]}名称`,
          kind !== 'watchlist-item',
        )}
      {kind === 'session' && text('title', '会话标题', true, 180)}
      {['session-group', 'session', 'watchlist'].includes(kind) &&
        select('workspaceId', '移动到工作区', lookups.workspace, '请选择工作区')}
      {kind === 'workspace' && select('parentId', '上级工作区', lookups.workspace, '根工作区', true)}
      {kind === 'session-group' && (
        <>
          {select('parentId', '上级会话分组', groups, '顶层分组', true)}
          <p className="wm-hint">
            层级由上级分组保存；不允许移入自身或后代。跨工作区移动前，请先移走子组及会话。
          </p>
        </>
      )}
      {kind === 'session' && (
        <>
          {select('groupId', '移动到会话分组', groups, '未分组', true)}
          <div className="company-form-pair">
            <label>
              研究模式
              <select
                aria-label="研究模式"
                value={String(draft.mode)}
                onChange={(event) => change('mode', event.target.value)}
              >
                <option value="quick">快速</option>
                <option value="deep">深入</option>
                <option value="plan">计划</option>
                <option value="daily">日常</option>
              </select>
            </label>
            {text('model', '模型偏好（可选）', false, 60)}
          </div>
          <label className="wm-checkbox">
            <input
              type="checkbox"
              checked={Boolean(draft.pinned)}
              onChange={(event) => change('pinned', event.target.checked)}
            />
            置顶会话
          </label>
          <Notice>模式与模型只保存为会话偏好；不会配置服务或发送研究请求。</Notice>
        </>
      )}
      {(kind === 'workspace' || kind === 'watchlist') && text('description', '说明', false, 3000, true)}
      {kind === 'message' && (
        <>
          {select('sessionId', '移动到会话', lookups.session, '请选择会话')}
          <label>
            消息角色
            <select
              aria-label="消息角色"
              value={String(draft.role)}
              onChange={(event) => change('role', event.target.value)}
            >
<option value="user">{manualConversation ? '用户（手工录入）' : '用户'}</option>
              <option value="assistant">{manualConversation ? '助手（手工录入，非 AI 回复）' : '助手'}</option>
              <option value="system">{manualConversation ? '系统（手工录入）' : '系统'}</option>
            </select>
          </label>
          {text('content', '消息正文', true, 16000, true)}
          <p className="wm-hint">以纯文本存储和显示，不执行 HTML、脚本或系统指令。</p>
        </>
      )}
      {kind === 'watchlist-item' && (
        <>
          {select('watchlistId', '移动到自选分组', lookups.watchlist, '请选择自选分组')}
          <div className="company-form-pair">
            {text('symbol', '证券代码', true, 40)}
            {text('market', '市场标识', true, 32)}
          </div>
          {text('notes', '备注', false, 4000, true)}
          <p className="wm-hint">市场未知可填 UNSPECIFIED；此记录不代表实时行情或已经核验的证券身份。</p>
        </>
      )}
    </>
  );
}

// Component-scoped layout keeps the six record flows usable in narrow mobile viewports.
const workspaceStyles = `
.workspace-manager{min-width:0}.wm-tabs{margin:22px 0 14px;flex-wrap:wrap}.wm-tabs button{min-height:38px}.wm-controls{padding:18px;display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;margin-bottom:16px}.wm-controls>label{display:flex;flex-direction:column;gap:7px;color:#617490;font-size:12px;min-width:0}.wm-controls select,.wm-controls input:not([type=checkbox]),.wm-form select{width:100%;min-width:0;max-width:100%;border:1px solid #dae3f0;border-radius:7px;padding:10px 12px;background:#fbfcff;color:#293c5c}.wm-controls>label:not(.wm-checkbox){flex:1 1 170px}.wm-search span{display:flex;align-items:center;gap:6px}.wm-checkbox,.company-form .wm-checkbox{display:flex!important;flex-direction:row!important;align-items:center;gap:8px!important;font-size:12px;cursor:pointer}.wm-checkbox input,.company-form .wm-checkbox input{width:16px!important;height:16px;flex:none}.wm-toolbar,.wm-pagination{display:flex;align-items:center;gap:15px;flex-wrap:wrap;margin:18px 0;color:#718099;font-size:12px}.wm-pagination{justify-content:center;margin-top:26px}.wm-meta,.wm-hint{font-size:12px;color:#718099;line-height:1.7}.wm-meta{overflow-wrap:anywhere;margin:8px 0}.wm-id{font-size:10px}.wm-deleted{color:#9c6363;font-size:12px}.wm-form fieldset{border:0;padding:0;margin:0;min-width:0;display:flex;flex-direction:column;gap:18px}.wm-messages{grid-template-columns:minmax(0,1fr)}.wm-messages .company-description{max-height:420px}.wm-wrap{overflow-wrap:anywhere}.wm-form .notice{margin:0}.workspace-manager details{margin:12px 0}.workspace-manager .company-card-footer .secondary{font-size:12px}.workspace-manager .company-card h2{line-height:1.5}.workspace-manager .company-card-top{margin-bottom:8px}.workspace-manager .company-card-footer{margin-top:12px}.workspace-manager .company-confirm ul{padding-left:20px;line-height:1.9}.workspace-manager button:focus-visible,.workspace-manager select:focus-visible,.workspace-manager input:focus-visible,.workspace-manager textarea:focus-visible{outline:2px solid #587bc7;outline-offset:3px}@media(max-width:640px){.wm-controls{padding:14px}.wm-controls>label:not(.wm-checkbox){flex-basis:100%}.wm-tabs{width:100%}.wm-tabs button{flex:1 0 27%;padding:8px}.wm-toolbar{gap:10px}.wm-pagination{gap:8px}.wm-form .company-form-pair{grid-template-columns:minmax(0,1fr)}.workspace-manager .company-card{padding:16px}.wm-form .company-form-actions{flex-wrap:wrap}}
`;
export default WorkspaceManager;
