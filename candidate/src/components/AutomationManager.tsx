import {AutomationRunResult, runStates} from './AutomationRunResult';
import {AutomationExecutionPreview} from './AutomationExecutionPreview';
import {ManualInventoryPanel} from './ManualInventoryPanel';
import type {ManualInventorySession} from './manual-inventory-session';
import {createContext,useContext,useLayoutEffect,useReducer} from 'react';
import {captureAutomationDefinitionCommand,type AutomationDefinitionWriteSession,type AutomationDefinitionOperation,type AutomationDefinitionEditor} from './automation-definition-write-session';
import { allowLeavingUnsavedWork, useUnsavedDraft, useUnsavedHistoryDismiss } from './unsaved-work';
import type { MeetingNotificationTarget } from '../../shared/meeting-reminders';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Bell, CalendarClock, Check, Clock3, Plus, RefreshCw, X } from 'lucide-react';
import type {
  CreateDataSource,
  CreateSchedule,
  CreateSkill,
  DataSourceKind,
  DataSourceView,
  NotificationRecord,
  ScheduleCadence,
  ScheduleRecord,
  ScheduleRunRecord,
  SkillHandler,
  SkillView,
} from '../../shared/automation';
import { automationApi } from '../adapters/automation';
import { ApiError, errorMessage } from '../adapters/api';
import { EmptyState, Notice, PageHeading, Spinner } from './common';

const DefinitionEditorContext=createContext<{session:AutomationDefinitionWriteSession;editor:AutomationDefinitionEditor}|null>(null);
function useDefinitionDraft(value:Record<string,unknown>){
 const recovery=useContext(DefinitionEditorContext);const baseline=useRef(recovery?.session.editor?.baseline??JSON.stringify(value));
 useUnsavedDraft(recovery?null:value);
 useLayoutEffect(()=>{if(recovery&&recovery.session.available){try{recovery.session.setEditor({...recovery.editor,draft:value,baseline:baseline.current,dirty:JSON.stringify(value)!==baseline.current});}catch{/* Session records retention failure and UI warns below. */}}});
}
function useDefinitionState<T>(field:string,initial:T){const recovery=useContext(DefinitionEditorContext);return useState<T>(()=>{const draft=recovery?.session.editor?.draft;return draft&&Object.hasOwn(draft,field)?draft[field] as T:initial;});}
type Snapshot = {
  skills: SkillView[];
  sources: DataSourceView[];
  schedules: ScheduleRecord[];
  runs: ScheduleRunRecord[];
  notifications: NotificationRecord[];
};
type Section = keyof Snapshot;
type ConfigurationSection = 'skills' | 'sources' | 'schedules';
type ConfigurationRecord = SkillView | DataSourceView | ScheduleRecord;
type Editor = { section: ConfigurationSection; record?: ConfigurationRecord; token: string };
type Confirmation = {
  section: ConfigurationSection;
  record: ConfigurationRecord;
  action: 'delete' | 'cancel';
  token: string;
};
type Problem = { message: string; conflict: boolean };
const sections: { key: Section; label: string }[] = [
  { key: 'schedules', label: '定时任务' },
  { key: 'skills', label: '技能' },
  { key: 'sources', label: '数据源' },
  { key: 'runs', label: '运行记录' },
  { key: 'notifications', label: '应用内通知' },
];
const sectionNames = { schedules: '任务', skills: '技能', sources: '数据源' };
const handlers: Record<SkillHandler, string> = {
  'local-notification': '本地应用内通知',
  'local-checkpoint': '本地指令快照',
  'local-document-inventory': '本地文档清单（仅专用手动入口）',
  'local-evidence-report': '本地证据报告（需专用绑定）',
  'external-research': '外部研究（未配置）',
};
const sourceKinds: Record<DataSourceKind, string> = {
  'local-workspace': '本地工作区',
  'local-archive': '本地资料归档',
  'web-search': '网页搜索（未配置）',
  'private-drive': '私域云盘（未配置）',
  'vendor-feed': '采购数据（未配置）',
};
const scheduleStates = { active: '活动', paused: '已暂停', cancelled: '已终止', completed: '已结束' };
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const emptySnapshot: Snapshot = { skills: [], sources: [], schedules: [], runs: [], notifications: [] };
const key = () => crypto.randomUUID();
const slotFor = (section: Section, id: string) => `${section}:${id}`;
function dateLabel(instant: string | null, timezone = 'UTC') {
  if (!instant) return '无';
  try {
    return `${new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(instant))} · ${timezone}`;
  } catch {
    return instant;
  }
}
function cadenceLabel(cadence: ScheduleCadence) {
  if (cadence.kind === 'once') return `单次 · ${dateLabel(cadence.at, cadence.timezone)}`;
  return `${cadence.kind === 'daily' ? '每日' : cadence.weekdays.map((day) => weekdays[day]).join('、')} ${cadence.time} · ${cadence.timezone}`;
}
function mutationInput(record: { id: string; revision: number }, idempotencyKey: string) {
  return { id: record.id, expectedRevision: record.revision, idempotencyKey };
}
function eligible(schedule: ScheduleRecord, data: Snapshot) {
  const skill = data.skills.find((item) => item.id === schedule.data.skillId && !item.deletedAt);
  if (!skill) return '所选技能已删除或不可访问';
  if (!skill.data.enabled) return '所选技能未启用';
  if (skill.availability.status !== 'available') return '所选技能的执行器不可用';
  for (const id of schedule.data.sourceIds) {
    const source = data.sources.find((item) => item.id === id && !item.deletedAt);
    if (!source || !source.data.enabled || source.availability.status !== 'available')
      return '所选数据源已删除、未启用或尚不可用';
  }
  return '';
}

/** Local persisted controls. Provider availability always comes from the server, never the switch. */
export function AutomationManager({
  session, manualInventorySession, visible = true,
  schedulerActive = false,
  definitionsOnly = false,
  onNotify,
  onOpenMeetingNotification,
}: {
  session?: AutomationDefinitionWriteSession; manualInventorySession?: ManualInventorySession; visible?: boolean;
  schedulerActive?: boolean;
  definitionsOnly?: boolean;
  onOpenMeetingNotification?: (target: MeetingNotificationTarget) => void;
  onNotify?: (message: string) => void;
}) {
  const [,rerender]=useReducer(x=>x+1,0);
  useEffect(()=>session?.subscribe(rerender),[session]);
  const [data, setData] = useState<Snapshot>(emptySnapshot);
  const [section, setSection] = useState<Section>('schedules');
  const [loading, setLoading] = useState<Partial<Record<Section, boolean>>>({});
  const [readErrors, setReadErrors] = useState<Partial<Record<Section, string>>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [problems, setProblems] = useState<Record<string, Problem>>({});
  const [success, setSuccess] = useState('');
  const [submissionError, setSubmissionError] = useState('');
  const viewEpoch = useRef(0);
  const [query, setQuery] = useState('');
  const [trash, setTrash] = useState(false);
  const [runSchedule, setRunSchedule] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(()=>session?.editor??null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const mounted = useRef(false);
  const generations = useRef<Record<Section, number>>({
    skills: 0,
    sources: 0,
    schedules: 0,
    runs: 0,
    notifications: 0,
  });
  const controllers = useRef<Partial<Record<Section, AbortController>>>({});
  const locks = useRef(new Set<string>());
  // Retain keys after an ambiguous transport failure. Explicit retry of the same input is safe.
  const retries = useRef(new Map<string, { fingerprint: string; idempotencyKey: string }>());
  const notifyRef = useRef(onNotify);
  notifyRef.current = onNotify;

  const refresh = useCallback(async (target: Section) => {
    const generation = ++generations.current[target];
    controllers.current[target]?.abort();
    const controller = new AbortController();
    controllers.current[target] = controller;
    const current = () =>
      mounted.current && (!session||session.available) && !controller.signal.aborted && generations.current[target] === generation;
    setLoading((previous) => ({ ...previous, [target]: true }));
    setReadErrors((previous) => ({ ...previous, [target]: '' }));
    try {
      session?.assertCurrent();
      const result = await {
        skills: () => automationApi.listSkills({ includeDeleted: true }, controller.signal),
        sources: () => automationApi.listDataSources({ includeDeleted: true }, controller.signal),
        schedules: () => automationApi.listSchedules({ includeDeleted: true }, controller.signal),
        runs: () => automationApi.listRuns({}, controller.signal),
        notifications: () => automationApi.listNotifications({}, controller.signal),
      }[target]();
      if (current()) setData((previous) => ({ ...previous, [target]: result }));
    } catch (error) {
      if (current()) setReadErrors((previous) => ({ ...previous, [target]: errorMessage(error) }));
    } finally {
      if (current()) setLoading((previous) => ({ ...previous, [target]: false }));
    }
  }, [session]);
  const refreshAll = useCallback(() => {
    sections.forEach((item) => void refresh(item.key));
  }, [refresh]);
  useEffect(() => {
    mounted.current = true;
    refreshAll();
    const activeControllers = controllers.current;
    const lifecycleEpoch = viewEpoch;
    return () => {
      mounted.current = false;
      lifecycleEpoch.current++;
      Object.values(activeControllers).forEach((controller) => controller.abort());
    };
  }, [refreshAll]);
  useEffect(() => {
    if (!schedulerActive) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden' || locks.current.size > 0) return;
      (['schedules', 'runs', 'notifications'] as const).forEach((target) => void refresh(target));
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [schedulerActive, refresh]);
  const closeEditor = useCallback(() => {
    if (!allowLeavingUnsavedWork()) return;
    viewEpoch.current++;
    setEditor(null);
  }, []);
  const closeConfirmation = useCallback(() => setConfirmation(null), []);
  const closeRun = useCallback(() => {
    viewEpoch.current++;
    setRunId(null);
  }, []);
  const clearTransient = useCallback(() => {
    viewEpoch.current++;
    setEditor(null);
    setConfirmation(null);
    setRunId(null);
  }, []);
  const historyIssue = useUnsavedHistoryDismiss(()=>{if(visible&&!session)clearTransient();});

  function apply<K extends Section>(target: K, record: Snapshot[K][number]) {
    setData((previous) => ({
      ...previous,
      [target]: previous[target].some((item) => item.id === record.id)
        ? previous[target].map((item) =>
            item.id === record.id && item.revision <= record.revision ? record : item,
          )
        : [record, ...previous[target]],
    }));
  }
  const consumeDefinition=()=>{
    if(!session?.available)return;
    const completion=session.takeCompletion();const rejection=session.takeRejection();
    if(rejection)setSubmissionError(rejection.message);
    if(!completion)return;setSubmissionError('');
    const {record,command}=completion;const target=command.kind==='skill'?'skills':command.kind==='data-source'?'sources':'schedules';
    apply(target,record);setSuccess(command.message+(record.deletedAt?' 当前记录已删除，可在已删除列表查看。':''));
    if(command.token&&session.editor?.token===command.token&&session.editorVersion===command.draftVersion){session.setEditor(null);setEditor(old=>old?.token===command.token?null:old);}
    setConfirmation(old=>old?.token===command.token?null:old);
    void refresh(target);if(target==='schedules')void refresh('runs');
  };
  useEffect(()=>{consumeDefinition();});
  async function recoverDefinition(){try{await session?.recover();if(mounted.current)consumeDefinition();}catch(error){if(mounted.current)setSubmissionError(errorMessage(error));}}
  async function mutate<T>(options: {
    definition?: {operation:AutomationDefinitionOperation;input:Record<string,unknown>};
    slot: string;
    fingerprint: string;
    affected: Section[];
    work: (idempotencyKey: string) => Promise<T>;
    accept: (result: T) => void;
    message: string;
    token?: string;
  }) {
    if(options.definition&&session){
      try{const command=captureAutomationDefinitionCommand(options.definition.operation,options.definition.input,{message:options.message,token:options.token,draftVersion:session.editorVersion});await session.submit(command);if(mounted.current)consumeDefinition();}
      catch(error){if(mounted.current)setSubmissionError(errorMessage(error));}return;
    }
    if (locks.current.has(options.slot)) return;
    locks.current.add(options.slot);
    setPending(new Set(locks.current));
    setProblems((previous) => {
      const copy = { ...previous };
      delete copy[options.slot];
      return copy;
    });
    setSuccess('');
    setSubmissionError('');
    const previous = retries.current.get(options.slot);
    const request =
      previous?.fingerprint === options.fingerprint
        ? previous
        : { fingerprint: options.fingerprint, idempotencyKey: key() };
    retries.current.set(options.slot, request);
    options.affected.forEach((target) => {
      generations.current[target]++;
      controllers.current[target]?.abort();
      setLoading((old) => ({ ...old, [target]: false }));
    });
    try {
      const result = await options.work(request.idempotencyKey);
      retries.current.delete(options.slot);
      if (!mounted.current) return;
      options.accept(result);
      setSuccess(options.message);
      notifyRef.current?.(options.message);
      if (options.token) {
        setEditor((old) => (old?.token === options.token ? null : old));
        setConfirmation((old) => (old?.token === options.token ? null : old));
      }
      options.affected.forEach((target) => void refresh(target));
    } catch (error) {
      if (!mounted.current) return;
      // Typed transport failures still require reconciliation and the original key.
      const known = error instanceof ApiError && error.outcome !== 'unknown';
      const conflict = known && error.detail.code === 'CONFLICT';
      setSubmissionError(
        conflict
          ? '操作遇到版本冲突，请刷新并核对最新记录后重试。'
          : known
            ? errorMessage(error)
            : '请求结果尚未确认，请刷新核对；不要创建重复任务。',
      );
      if (known) retries.current.delete(options.slot);
      setProblems((old) => ({
        ...old,
        [options.slot]: {
          conflict,
          message: conflict
            ? '记录已被其他操作修改，未覆盖新版本。已请求最新记录；关闭编辑窗口后重新打开，再核对修改。'
            : known
              ? errorMessage(error)
              : `请求结果尚未确认：${errorMessage(error)}。先刷新核对；本页以相同内容重试会复用幂等键。`,
        },
      }));
      if (conflict) options.affected.forEach((target) => void refresh(target));
    } finally {
      locks.current.delete(options.slot);
      if (mounted.current) setPending(new Set(locks.current));
    }
  }
  function recordAction(
    target: ConfigurationSection,
    record: ConfigurationRecord,
    action: 'toggle' | 'restore' | 'delete' | 'pause' | 'resume' | 'cancel',
    token?: string,
  ) {
    const slot = slotFor(target, record.id);
    const base={id:record.id,expectedRevision:record.revision};
    const suffix=target==='skills'?'Skill':target==='sources'?'DataSource':'Schedule';
    const operation:AutomationDefinitionOperation=(action==='restore'?`restore${suffix}`:action==='delete'?`delete${suffix}`:target==='schedules'&&action!=='toggle'?'setScheduleState':`update${suffix}`) as AutomationDefinitionOperation;
    const input=action==='restore'||action==='delete'?base:operation==='setScheduleState'?{...base,state:action==='pause'?'paused':action==='resume'?'active':'cancelled'}:{...base,patch:{enabled:!record.data.enabled}};
    void mutate({
      definition:{operation,input},slot,
      fingerprint: JSON.stringify({ action, id: record.id, revision: record.revision }),
      affected: target === 'schedules' ? ['schedules', 'runs'] : [target],
      token,
      message:
        definitionsOnly ? (action === 'delete' ? '定义已移入已删除列表，可恢复；通用任务与定时执行未接通。' : action === 'pause' ? '定义已暂停并保存；通用任务与定时执行未接通。' : action === 'resume' ? '定义已恢复并保存；通用任务与定时执行未接通。' : action === 'cancel' ? '定义已终止并保存；通用任务与定时执行未接通。' : '定义已保存；通用任务与定时执行未接通。') : action === 'restore'
          ? '已恢复；技能和数据源恢复为未启用，日程恢复为暂停。'
          : action === 'delete'
            ? '已移入已删除列表，可恢复。日程删除会原子取消尚未完成的运行。'
            : action === 'cancel'
              ? '日程已终止，尚未完成的运行已一并取消。'
              : action === 'pause'
                ? '日程已暂停，已经创建的运行保持原状态。'
                : action === 'resume'
                  ? '日程已恢复；是否产生定时运行仍取决于启用开关。'
                  : '已保存启用偏好；可用性由服务端独立检查。',
      work: async (idempotencyKey) => {
        const input = mutationInput(record, idempotencyKey);
        if (target === 'skills') {
          if (action === 'restore') return automationApi.restoreSkill(input);
          if (action === 'delete') return automationApi.deleteSkill(input);
          return automationApi.updateSkill({ ...input, patch: { enabled: !record.data.enabled } });
        }
        if (target === 'sources') {
          if (action === 'restore') return automationApi.restoreDataSource(input);
          if (action === 'delete') return automationApi.deleteDataSource(input);
          return automationApi.updateDataSource({ ...input, patch: { enabled: !record.data.enabled } });
        }
        if (action === 'restore') return automationApi.restoreSchedule(input);
        if (action === 'delete') return automationApi.deleteSchedule(input);
        if (action === 'toggle')
          return automationApi.updateSchedule({ ...input, patch: { enabled: !record.data.enabled } });
        return automationApi.setScheduleState({
          ...input,
          state: action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'cancelled',
        });
      },
      accept: (result) => {
        // Delete responses intentionally omit availability. Retain the last server capability view.
        apply(target, { ...record, ...result } as ConfigurationRecord);
      },
    });
  }
  function saveSkill(input: Omit<CreateSkill, 'idempotencyKey'>) {
    if (!editor) return;
    const { record, token } = editor;
    void mutate({
      definition:{operation:record?'updateSkill':'createSkill',input:record?{id:record.id,expectedRevision:record.revision,patch:input}:{...input}},
      slot: slotFor('skills', record?.id ?? token),
      token,
      fingerprint: JSON.stringify({ input, revision: record?.revision }),
      affected: ['skills'],
      work: (idempotencyKey) =>
        record
          ? automationApi.updateSkill({ ...mutationInput(record, idempotencyKey), patch: input })
          : automationApi.createSkill({ ...input, idempotencyKey }),
      accept: (result) => apply('skills', result),
      message: '技能定义已保存到本地。',
    });
  }
  function saveSource(input: Omit<CreateDataSource, 'idempotencyKey'>) {
    if (!editor) return;
    const { record, token } = editor;
    void mutate({
      definition:{operation:record?'updateDataSource':'createDataSource',input:record?{id:record.id,expectedRevision:record.revision,patch:{name:input.name,enabled:input.enabled,collectionIds:input.collectionIds}}:{...input}},
      slot: slotFor('sources', record?.id ?? token),
      token,
      fingerprint: JSON.stringify({ input, revision: record?.revision }),
      affected: ['sources'],
      work: (idempotencyKey) =>
        record
          ? automationApi.updateDataSource({
              ...mutationInput(record, idempotencyKey),
              patch: { name: input.name, enabled: input.enabled, collectionIds: input.collectionIds },
            })
          : automationApi.createDataSource({ ...input, idempotencyKey }),
      accept: (result) => apply('sources', result),
      message: '数据源偏好已保存；不会自动连接外部服务或扩大资料权限。',
    });
  }
  function saveSchedule(input: Omit<CreateSchedule, 'idempotencyKey'>) {
    if (!editor) return;
    const { record, token } = editor;
    const patch: Parameters<typeof automationApi.updateSchedule>[0]['patch'] = { ...input };
    // A rename of an expired single occurrence must not accidentally reschedule it.
    if (
      record &&
      'cadence' in record.data &&
      JSON.stringify(record.data.cadence) === JSON.stringify(input.cadence)
    )
      delete patch.cadence;
    void mutate({
      definition:{operation:record?'updateSchedule':'createSchedule',input:record?{id:record.id,expectedRevision:record.revision,patch:patch}:{...input}},
      slot: slotFor('schedules', record?.id ?? token),
      token,
      fingerprint: JSON.stringify({ input, revision: record?.revision }),
      affected: ['schedules'],
      work: (idempotencyKey) =>
        record
          ? automationApi.updateSchedule({ ...mutationInput(record, idempotencyKey), patch })
          : automationApi.createSchedule({ ...input, idempotencyKey }),
      accept: (result) => apply('schedules', result),
      message: definitionsOnly ? '定义已保存，通用任务与定时执行未接通。' : '日程已保存，下一次时间以服务端记录为准。',
    });
  }
  function runAction(
    record: ScheduleRecord | ScheduleRunRecord,
    action: 'runNow' | 'retryRun' | 'cancelRun' | 'executeLocalRun',
  ) {
    if (definitionsOnly) return;
    const target = action === 'runNow' ? 'schedules' : 'runs';
    const navigation = viewEpoch.current;
    void mutate({
      slot: slotFor(target, record.id),
      fingerprint: JSON.stringify({ action, id: record.id, revision: record.revision }),
      affected: ['runs', 'notifications'],
      work: (idempotencyKey) => automationApi[action](mutationInput(record, idempotencyKey)),
      accept: (result) => {
        apply('runs', result);
        if (viewEpoch.current === navigation) setRunId(result.id);
      },
      message:
        action === 'runNow' || action === 'retryRun'
          ? '已创建独立运行，执行状态请查看运行记录。'
          : action === 'cancelRun'
            ? '已取得运行状态回执；未来日程不受此次取消影响。'
            : '已取得本地执行回执；结果以运行记录为准。',
    });
  }
  function markRead(record: NotificationRecord) {
    if(definitionsOnly)return;
    void mutate({
      slot: slotFor('notifications', record.id),
      fingerprint: JSON.stringify({ id: record.id, revision: record.revision }),
      affected: ['notifications'],
      work: (idempotencyKey) => automationApi.markNotificationRead(mutationInput(record, idempotencyKey)),
      accept: (result) => apply('notifications', result),
      message: '通知已标为已读。',
    });
  }
  const openEditor = (target: ConfigurationSection, record?: ConfigurationRecord) => {
    if(session?.editor?.dirty){setSubmissionError('已有未保存草稿，请先恢复并处理；不会覆盖原草稿。');return;}
    if (!allowLeavingUnsavedWork()) return;
    clearTransient();
    if (record)
      setProblems((previous) => {
        const copy = { ...previous };
        delete copy[slotFor(target, record.id)];
        return copy;
      });
    setSubmissionError('');
    const next={section:target,...(record?{record}:{}),token:key()};try{session?.setEditor(next);setEditor(next);}catch(error){setSubmissionError(errorMessage(error));}
  };
  function openConfirmation(next: Confirmation) {
    if (!allowLeavingUnsavedWork()) return;
    clearTransient();
    setProblems((previous) => {
      const copy = { ...previous };
      delete copy[slotFor(next.section, next.record.id)];
      return copy;
    });
    setSubmissionError('');
    setConfirmation(next);
  }
  function openRun(id: string) {
    viewEpoch.current++;
    setRunId(id);
  }
  function changeSection(target: Section) {
    if (!allowLeavingUnsavedWork()) return;
    viewEpoch.current++;
    setSection(target);
    setQuery('');
    setTrash(false);
    setEditor(null);
    setConfirmation(null);
    setRunId(null);
  }
  const normalized = query.trim().toLocaleLowerCase();
  const visibleConfigurations = (target: ConfigurationSection) =>
    data[target].filter(
      (record) =>
        Boolean(record.deletedAt) === trash && record.data.name.toLocaleLowerCase().includes(normalized),
    );
  const selectedRun = data.runs.find((record) => record.id === runId);
  const editorSlot = editor ? slotFor(editor.section, editor.record?.id ?? editor.token) : '';
  const editorProblem = problems[editorSlot];
  const confirmationSlot = confirmation ? slotFor(confirmation.section, confirmation.record.id) : '';
  const problemNotice = (slot: string) =>
    problems[slot] && <Notice kind="error">{problems[slot].message}</Notice>;
  const configActions = (target: ConfigurationSection, record: ConfigurationRecord) => (
    <div className="company-row-actions">
      {record.deletedAt ? (
        <button
          className="text-button"
          disabled={pending.has(slotFor(target, record.id))}
          onClick={() => recordAction(target, record, 'restore')}
        >
          恢复 {record.data.name}
        </button>
      ) : (
        <>
          <button
            className="text-button"
            disabled={pending.has(slotFor(target, record.id))}
            onClick={() => recordAction(target, record, 'toggle')}
            aria-label={`${record.data.enabled ? '停用' : '启用'} ${record.data.name}`}
          >
            {record.data.enabled ? '停用' : '启用'}
          </button>
          <button
            className="text-button"
            disabled={pending.has(slotFor(target, record.id))}
            onClick={() => openEditor(target, record)}
            aria-label={`编辑 ${record.data.name}`}
          >
            编辑
          </button>
          <button
            className="text-button company-danger"
            disabled={pending.has(slotFor(target, record.id))}
            onClick={() => openConfirmation({ section: target, record, action: 'delete', token: key() })}
            aria-label={`删除 ${record.data.name}`}
          >
            删除
          </button>
        </>
      )}
    </div>
  );
  return (
    <div className="automation-manager" hidden={!visible}>
      {session?.pending&&<Notice kind="error">{session.pending.message}<button type="button" disabled={session.pending.phase==='sending'||session.pending.phase==='reading'} onClick={()=>void recoverDefinition()}>{session.pending.ackId?'重新读取当前定义':'继续确认原操作'}</button></Notice>}
      {session?.draftRetentionIncomplete&&<Notice kind="error">草稿超过当前恢复容量，尚未完整保留。请勿离开页面。</Notice>}
      {session?.editor&&!editor&&<button onClick={()=>setEditor(session.editor)}>恢复未保存的定义草稿</button>}
      {session?.editor?.dirty&&<button onClick={()=>{if(window.confirm('放弃当前未保存草稿？原待确认操作仍会保留。')){session.setEditor(null);setEditor(null);}}}>放弃当前定义草稿</button>}
      {historyIssue && <p role="alert">{historyIssue}</p>}
      <PageHeading
        eyebrow="LOCAL AUTOMATION"
        title="定时任务与技能"
        description={definitionsOnly ? "任务、技能与数据源定义可保存在本地；通用任务与定时执行未接通" : "本地持久化日程、执行记录和应用内通知"}
        actions={
          <button className="secondary" onClick={refreshAll}>
            <RefreshCw size={15} /> 刷新全部
          </button>
        }
      />
      <Notice>
        {definitionsOnly ? '定义可保存在本地；通用任务与定时执行未接通。下一次时间仅为定义计算，不代表已排队或会自动执行。' : schedulerActive
          ? '本地服务运行期间，调度器每分钟检查到期日程并执行受限本地任务；服务关闭时不运行。此页每 15 秒刷新运行状态。'
          : '当前为手动调度：保存日程不会自动执行。点击“检查到期任务”创建运行，再在运行记录执行本地任务。'}{' '}
        {definitionsOnly ? (manualInventorySession ? '通知投递未接通。下方专用手动清单须核验当前来源；来源未知或不可用时不能新建。可用时须先预览范围，再明确确认保存一次文档元数据；不会启用调度器。' : '通知投递未接通；此入口未提供专用手动清单。') : '仅支持应用内通知和指令快照，不生成研究结论。外部研究、网页搜索、云盘和采购服务尚未配置；不会发送邮件或第三方消息。'}
      </Notice>
      {definitionsOnly&&<div hidden={section!=='runs'}><AutomationExecutionPreview schedules={data.schedules} ready={!loading.schedules&&!readErrors.schedules&&(!session||session.available)} visible={visible&&section==='runs'}/></div>}
      {manualInventorySession&&<ManualInventoryPanel session={manualInventorySession} schedules={data.schedules} skills={data.skills} definitionsReady={!loading.schedules&&!loading.skills&&!readErrors.schedules&&!readErrors.skills}/>}
      {submissionError && <Notice kind="error">{submissionError}</Notice>}
      {success && (
        <div role="status">
          <Notice kind="success">{success}</Notice>
        </div>
      )}
      <div className="company-controls automation-controls">
        <div className="company-tabs automation-tabs" aria-label="自动化功能">
          {sections.map((item) => (
            <button
              key={item.key}
              className={section === item.key ? 'selected' : ''}
              aria-pressed={section === item.key}
              onClick={() => changeSection(item.key)}
            >
              {item.label}
              {item.key === 'notifications' &&
                ` (${data.notifications.filter((record) => !record.data.readAt).length})`}
            </button>
          ))}
        </div>
      </div>
      {readErrors[section] && (
        <Notice kind="error">
          读取失败：{readErrors[section]}。保留上次成功读取的记录；这不表示连接未配置。
          <button className="text-button" onClick={() => void refresh(section)}>
            重新读取
          </button>
        </Notice>
      )}
      {loading[section] && (
        <p className="company-loading" role="status">
          <Spinner /> 正在读取记录…
        </p>
      )}
      {(section === 'schedules' || section === 'skills' || section === 'sources') && (
        <>
          <div className="company-controls">
            <div className="company-toolbar-actions">
              <button
                className="primary"
                disabled={Boolean(readErrors[section]) || loading[section]}
                onClick={() => openEditor(section)}
              >
                <Plus size={15} /> 新建{sectionNames[section]}
              </button>
              <label className="automation-check">
                <input type="checkbox" checked={trash} onChange={(event) => setTrash(event.target.checked)} />{' '}
                查看已删除
              </label>
            </div>
            <label className="company-search">
              搜索名称
              <input
                aria-label="搜索自动化名称"
                maxLength={100}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          {section === 'schedules' && (
            <section className="panel company-dataset" aria-label="调度控制">
              <div className="company-toolbar-actions">
                <CalendarClock size={23} />{' '}
                <strong>{definitionsOnly ? '仅保存定义 · 通用任务与定时执行未接通' : schedulerActive ? '本地进程调度已开启' : '手动检查到期日程'}</strong>
                <button
                  className="secondary"
                  disabled={definitionsOnly || pending.has('dispatch') || loading.schedules || Boolean(readErrors.schedules)}
                  onClick={() =>
                    void mutate({
                      slot: 'dispatch',
                      fingerprint: 'dispatchDue',
                      affected: ['schedules', 'runs'],
                      work: (idempotencyKey) => automationApi.dispatchDue({ idempotencyKey, limit: 20 }),
                      accept: (result) => {
                        result.runs.forEach((record) => apply('runs', record));
                        if (result.hasMore)
                          setProblems((old) => ({
                            ...old,
                            dispatch: {
                              conflict: false,
                              message: '仍有到期日程，可再次检查。每批最多处理 20 条，不会无限补跑。',
                            },
                          }));
                      },
                      message: '到期检查已完成；请在运行记录核对排队、跳过或不可用的结果。',
                    })
                  }
                >
                  {pending.has('dispatch') && <Spinner />} 检查到期任务
                </button>
              </div>
              <p className="company-boundary">
                {definitionsOnly ? '不会启动新的任务；终止或删除日程仍会将该日程已有未结束运行标为取消。检查到期任务与创建运行已禁用。所有时间明确显示时区。' : '暂停仅停止未来调度；终止或删除日程会同时取消尚未完成的运行。单次“立即创建运行”不会改动未来日程。所有时间明确显示时区。'}
              </p>
              {problemNotice('dispatch')}
            </section>
          )}
          {section === 'sources' && (
            <Notice>
              “已启用”是使用偏好；“连接可用”是服务端能力状态。集合 ID
              只缩小逻辑选择范围，不授予读取权限；本地指令快照不会读取这些集合。
            </Notice>
          )}
          <section
            className="company-grid"
            aria-label={`${trash ? '已删除' : '有效'}${sectionNames[section]}`}
          >
            {visibleConfigurations(section).map((record) => {
              const slot = slotFor(section, record.id);
              return (
                <article
                  key={record.id}
                  className={`panel company-card ${record.deletedAt ? 'company-deleted' : ''}`}
                  aria-label={record.data.name}
                  aria-busy={pending.has(slot)}
                >
                  <div className="company-card-top">
                    <span className="mock-label">
                      {record.data.enabled ? '偏好：已启用' : '偏好：未启用'}
                      {record.deletedAt ? ' · 已删除' : ''}
                    </span>
                    {pending.has(slot) && <Spinner />}
                  </div>
                  <h2>{record.data.name}</h2>
                  {'handler' in record.data && (
                    <>
                      <p className="company-symbol">{handlers[record.data.handler]}</p>
                      <p className="company-description">{record.data.description || '暂无描述'}</p>
                    </>
                  )}
                  {'collectionIds' in record.data && (
                    <>
                      <p className="company-symbol">{sourceKinds[record.data.kind]}</p>
                      <p className="company-description">
                        逻辑集合：
                        {record.data.collectionIds.join('、') || '未限定集合 ID；仍受服务端权限限制'}
                      </p>
                    </>
                  )}
                  {'availability' in record && <Availability record={record as SkillView | DataSourceView} />}
                  {'cadence' in record.data &&
                    (() => {
                      const schedule = record as ScheduleRecord;
                      const runs = data.runs.filter((item) => item.data.scheduleId === record.id);
                      const last = runs[0];
                      const lastSuccess = runs.find((run) => run.data.state === 'completed');
                      const lastFailure = runs.find((run) =>
                        ['failed', 'unavailable'].includes(run.data.state),
                      );
                      const historyKnown = !loading.runs && !readErrors.runs;
                      const blocked =
                        readErrors.skills || readErrors.sources
                          ? '技能或数据源状态读取失败，请刷新后核对'
                          : eligible(schedule, data);
                      return (
                        <>
                          <p className="company-symbol">
                            {scheduleStates[schedule.data.state]} · {cadenceLabel(schedule.data.cadence)}
                          </p>
                          <p className="company-description">{schedule.data.instructions || '未填写指令'}</p>
                          <dl className="automation-facts">
                            <dt>{definitionsOnly ? '下次定义时间（不会执行）' : '下一次'}</dt>
                            <dd>{dateLabel(schedule.data.nextRunAt, schedule.data.cadence.timezone)}</dd>
                            <dt>漏跑策略</dt>
                            <dd>
                              {schedule.data.misfirePolicy === 'coalesce'
                                ? '合并为最近一次'
                                : `超出 ${schedule.data.graceSeconds} 秒宽限则跳过`}
                            </dd>
                            <dt>最近成功</dt>
                            <dd>
                              {!historyKnown
                                ? '尚未核实'
                                : lastSuccess
                                  ? dateLabel(
                                      lastSuccess.data.finishedAt ?? lastSuccess.data.scheduledAt,
                                      schedule.data.cadence.timezone,
                                    )
                                  : '暂无'}
                            </dd>
                            <dt>最近失败 / 不可用</dt>
                            <dd>
                              {!historyKnown
                                ? '尚未核实'
                                : lastFailure
                                  ? `${runStates[lastFailure.data.state]} · ${dateLabel(lastFailure.data.finishedAt ?? lastFailure.data.scheduledAt, schedule.data.cadence.timezone)}`
                                  : '暂无'}
                            </dd>
                            <dt>运行累计</dt>
                            <dd>
                              {historyKnown
                                ? `${runs.length} 次${last ? ` · 最近${runStates[last.data.state]}` : ''}`
                                : '运行记录尚未核实'}
                            </dd>
                          </dl>
                          {blocked && <p className="automation-warning">执行不可用：{blocked}</p>}
                          {!record.deletedAt && (
                            <div className="company-row-actions automation-actions">
                              <button
                                className="secondary"
                                disabled={
                                  definitionsOnly || pending.has(slot) ||
                                  Boolean(blocked) ||
                                  schedule.data.state === 'cancelled' ||
                                  data.skills.find((skill) => skill.id === schedule.data.skillId)?.data
                                    .handler === 'local-evidence-report'
                                }
                                onClick={() => runAction(schedule, 'runNow')}
                              >
                                立即创建运行
                              </button>
                              <button
                                className="text-button"
                                disabled={pending.has(slot) || schedule.data.state === 'completed'}
                                onClick={() =>
                                  recordAction(
                                    'schedules',
                                    schedule,
                                    schedule.data.state === 'active' ? 'pause' : 'resume',
                                  )
                                }
                              >
                                {schedule.data.state === 'active' ? '暂停日程' : '恢复日程'}
                              </button>
                              {schedule.data.state !== 'cancelled' && (
                                <button
                                  className="text-button company-danger"
                                  disabled={pending.has(slot)}
                                  onClick={() =>
                                    openConfirmation({
                                      section: 'schedules',
                                      record,
                                      action: 'cancel',
                                      token: key(),
                                    })
                                  }
                                >
                                  终止日程
                                </button>
                              )}
                            </div>
                          )}
                          <button
                            className="text-button automation-history-link"
                            onClick={() => {
                              changeSection('runs');
                              setRunSchedule(record.id);
                            }}
                          >
                            查看该日程运行记录
                          </button>
                        </>
                      );
                    })()}
                  {problemNotice(slot)}
                  <div className="company-card-footer">
                    <span className="muted">版本 {record.revision}</span>
                    {configActions(section, record)}
                  </div>
                </article>
              );
            })}
          </section>
          {!loading[section] && !readErrors[section] && visibleConfigurations(section).length === 0 && (
            <EmptyState
              title={query ? '没有匹配的记录' : trash ? '没有已删除的记录' : '还没有记录'}
              description={
                trash ? '软删除记录可以在这里恢复' : '先创建本地技能，再配置日程；所有启用开关默认关闭'
              }
            />
          )}
        </>
      )}
      {section === 'runs' && (
        <>
          <label className="local-asr-field">
            筛选日程
            <select value={runSchedule} onChange={(event) => setRunSchedule(event.target.value)}>
              <option value="">全部日程</option>
              {data.schedules.map((record) => (
                <option key={record.id} value={record.id}>
                  {record.data.name}
                  {record.deletedAt ? '（已删除）' : ''}
                </option>
              ))}
            </select>
          </label>
          <Notice>
            {definitionsOnly ? '此处只读展示通用任务历史，不创建或执行通用任务。专用手动文档清单请在其独立历史中查看。' : '“待执行”不等于完成。只有“执行本地任务”或运行中的本地调度器才会写入通知/快照。取消单次运行不会停止未来日程。'}
          </Notice>
          <section className="company-grid" aria-label="运行列表">
            {data.runs
              .filter((record) => !runSchedule || record.data.scheduleId === runSchedule)
              .map((record) => (
                <article className="panel company-card" key={record.id} aria-label={`运行 ${record.id}`}>
                  <div className="company-card-top">
                    <span className="mock-label">{runStates[record.data.state]}</span>
                    <span>{record.data.trigger === 'manual' ? '手动' : '定时'}</span>
                  </div>
                  <h2>
                    {data.schedules.find((item) => item.id === record.data.scheduleId)?.data.name ??
                      '关联日程不可用'}
                  </h2>
                  <p className="company-symbol">{dateLabel(record.data.scheduledAt)}</p>
                  <p className="company-description">{record.data.detail || '等待本地执行器处理'}</p>
                  <div className="company-row-actions">
                    <button className="secondary" onClick={() => openRun(record.id)}>
                      查看运行详情
                    </button>
                    <RunActions
                      readonly={definitionsOnly}
                      record={record}
                      busy={pending.has(slotFor('runs', record.id))}
                      onAction={runAction}
                    />
                  </div>
                  {problemNotice(slotFor('runs', record.id))}
                </article>
              ))}
          </section>
          {!loading.runs &&
            !readErrors.runs &&
            !data.runs.some((record) => !runSchedule || record.data.scheduleId === runSchedule) && (
              <EmptyState
                title="暂无运行记录"
                description={definitionsOnly ? "当前筛选下没有通用任务运行记录；专用手动清单记录不在此列表。" : "检查到期日程或手动创建一次运行后，记录会保存在这里"}
              />
            )}
        </>
      )}
      {section === 'notifications' && (
        <>
          <Notice>这些消息只保存到本地应用内收件箱；没有系统推送、微信、飞书或邮件发送。</Notice>
          <label className="automation-check">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(event) => setUnreadOnly(event.target.checked)}
            />{' '}
            只看未读
          </label>
          <section className="company-grid" aria-label="通知列表">
            {data.notifications
              .filter((record) => !unreadOnly || !record.data.readAt)
              .map((record) => (
                <article
                  className="panel company-card"
                  key={record.id}
                  aria-label={`通知 ${record.data.title}`}
                >
                  <div className="company-card-top">
                    <Bell size={18} />
                    <span>{record.data.readAt ? '已读' : '未读'} · 应用内</span>
                  </div>
                  <h2>{record.data.title}</h2>
                  <p className="company-description">{record.data.body || '无正文'}</p>
                  <p className="company-symbol">{dateLabel(record.createdAt)}</p>
                  <div className="company-row-actions automation-actions">
                    {!record.data.readAt && (
                      <button
                        className="text-button"
                        title={definitionsOnly?'定义模式通知仅供只读查看，不会发送已读请求':undefined}
                        onClick={() => markRead(record)}
                        disabled={definitionsOnly || pending.has(slotFor('notifications', record.id))}
                      >
                        <Check size={14} /> {definitionsOnly?'只读通知':'标为已读'}
                      </button>
                    )}
                    <button
                      className="secondary"
                      onClick={() => {
                        if (record.data.target.kind === 'meeting-reminder') {
                          if (onOpenMeetingNotification) onOpenMeetingNotification(record.data.target);
                          else
                            location.hash = `calendar?occurrenceId=${encodeURIComponent(record.data.target.id)}`;
                        } else {
                          changeSection('runs');
                          setRunSchedule('');
                          openRun(record.data.target.id);
                        }
                      }}
                    >
                      {record.data.target.kind === 'meeting-reminder' ? '打开准确会议' : '打开关联运行'}
                    </button>
                  </div>
                  {problemNotice(slotFor('notifications', record.id))}
                </article>
              ))}
          </section>
          {!loading.notifications &&
            !readErrors.notifications &&
            !data.notifications.some((record) => !unreadOnly || !record.data.readAt) && (
              <EmptyState
                title={unreadOnly ? '没有未读通知' : '暂无应用内通知'}
                description={definitionsOnly ? "通知执行未接通，没有产生任何通知" : "本地通知技能执行成功后，消息会出现在这里"}
              />
            )}
        </>
      )}
      {visible && editor && (
        <AutomationModal
          title={`${editor.record ? '编辑' : '新建'}${sectionNames[editor.section]}`}
          onClose={closeEditor}
        >
          <DefinitionEditorContext.Provider value={session?{session,editor}:null}>
          {editor.section === 'skills' ? (
            <SkillEditor
              definitionsOnly={definitionsOnly}
              key={editor.token}
              record={editor.record as SkillView | undefined}
              busy={pending.has(editorSlot)||session?.pending?.phase==='sending'||session?.pending?.phase==='reading'}
              problem={editorProblem}
              onClose={closeEditor}
              onSave={saveSkill}
            />
          ) : editor.section === 'sources' ? (
            <SourceEditor
              key={editor.token}
              record={editor.record as DataSourceView | undefined}
              busy={pending.has(editorSlot)||session?.pending?.phase==='sending'||session?.pending?.phase==='reading'}
              problem={editorProblem}
              onClose={closeEditor}
              onSave={saveSource}
            />
          ) : (
            <ScheduleEditor
              definitionsOnly={definitionsOnly}
              key={editor.token}
              record={editor.record as ScheduleRecord | undefined}
              data={data}
              busy={pending.has(editorSlot)||session?.pending?.phase==='sending'||session?.pending?.phase==='reading'}
              problem={editorProblem}
              onClose={closeEditor}
              onSave={saveSchedule}
            />
          )}
          </DefinitionEditorContext.Provider>
        </AutomationModal>
      )}
      {visible && confirmation && (
        <AutomationModal
          title={confirmation.action === 'cancel' ? '确认终止日程' : '确认软删除'}
          onClose={closeConfirmation}
        >
          <div className="company-confirm">
            <p>
              {confirmation.action === 'cancel' ? '终止' : '删除'}「{confirmation.record.data.name}」？
            </p>
            <p className="muted">
              {definitionsOnly ? (confirmation.section === 'schedules' ? '不会启动新的任务；终止或删除日程仍会将该日程已有未结束运行标为取消。已删除日程可以恢复，恢复后未启用并处于暂停。' : '此操作只修改技能或数据源定义，不启动任务。已删除定义可以恢复，恢复后默认未启用。通用任务与定时执行未接通。') : confirmation.section === 'schedules'
                ? '此操作会在同一次提交中取消该日程所有待执行和执行中的本地运行，并停止未来调度。已有终态记录保留。删除的日程可恢复为暂停。'
                : '记录可从已删除列表恢复，但会恢复为未启用。引用此配置的日程将无法执行；不会自动改用其他技能或数据源。'}
            </p>
            {problemNotice(confirmationSlot)}
            <PendingNote busy={pending.has(confirmationSlot)} />
            <div className="company-form-actions">
              <button className="secondary" onClick={closeConfirmation}>
                返回
              </button>
              <button
                className="primary company-danger-button"
                disabled={pending.has(confirmationSlot) || problems[confirmationSlot]?.conflict}
                onClick={() =>
                  recordAction(
                    confirmation.section,
                    confirmation.record,
                    confirmation.action,
                    confirmation.token,
                  )
                }
              >
                {pending.has(confirmationSlot) && <Spinner />}
                {confirmation.action === 'cancel' ? '确认终止并取消当前运行' : '确认软删除'}
              </button>
            </div>
          </div>
        </AutomationModal>
      )}
      {visible && runId && (
        <AutomationModal title="运行详情" onClose={closeRun}>
          <div className="company-confirm">
            {selectedRun ? (
              <>
                <h3>{runStates[selectedRun.data.state]}</h3>
                <dl className="automation-facts">
                  <dt>运行 ID</dt>
                  <dd>{selectedRun.id}</dd>
                  <dt>版本</dt>
                  <dd>{selectedRun.revision}</dd>
                  <dt>日程</dt>
                  <dd>
                    {data.schedules.find((record) => record.id === selectedRun.data.scheduleId)?.data.name ??
                      '关联日程不可用'}
                  </dd>
                  <dt>发生时间</dt>
                  <dd>{dateLabel(selectedRun.data.scheduledAt)}</dd>
                  <dt>创建时间</dt>
                  <dd>{dateLabel(selectedRun.createdAt)}</dd>
                  <dt>开始时间</dt>
                  <dd>{dateLabel(selectedRun.data.startedAt)}</dd>
                  <dt>结束时间</dt>
                  <dd>{dateLabel(selectedRun.data.finishedAt)}</dd>
                  <dt>执行次数</dt>
                  <dd>{selectedRun.data.attempt}</dd>
                  {selectedRun.data.coalescedFrom && (
                    <>
                      <dt>合并起点</dt>
                      <dd>{dateLabel(selectedRun.data.coalescedFrom)}</dd>
                    </>
                  )}
                  {selectedRun.data.retryOf && (
                    <>
                      <dt>重试来源</dt>
                      <dd>{selectedRun.data.retryOf}</dd>
                    </>
                  )}
                  <dt>状态代码</dt>
                  <dd>{selectedRun.data.code || '无'}</dd>
                </dl>
                <p className="automation-prewrap">{selectedRun.data.detail || '尚无完成回执'}</p>
                {selectedRun.data.intent && (
                  <>
                    <h3>本次绑定的指令快照</h3>
                    <p className="automation-prewrap">{selectedRun.data.intent.instructions || '空指令'}</p>
                    <p className="muted">
                      技能版本 {selectedRun.data.intent.skillRevision} · 数据源版本绑定{' '}
                      {selectedRun.data.intent.sources.length} 项
                    </p>
                  </>
                )}
                <AutomationRunResult result={selectedRun.data.result}/>
                <div className="company-row-actions">
                  <RunActions
                      readonly={definitionsOnly}
                    record={selectedRun}
                    busy={pending.has(slotFor('runs', selectedRun.id))}
                    onAction={runAction}
                  />
                  <button className="secondary" onClick={() => void refresh('runs')}>
                    <RefreshCw size={14} /> 刷新运行
                  </button>
                </div>
                {problemNotice(slotFor('runs', selectedRun.id))}
              </>
            ) : (
              <Notice kind="error">关联运行尚未读到，可能已不可访问。请刷新运行记录核对。</Notice>
            )}
          </div>
        </AutomationModal>
      )}
    </div>
  );
}

function Availability({ record }: { record: SkillView | DataSourceView }) {
  return (
    <div className="automation-availability">
      <strong>
        {record.availability.status === 'available' ? '执行能力 / 连接可用' : '执行能力 / 连接不可用'}
      </strong>
      <p>{record.availability.detail}</p>
      <small>{record.availability.code}</small>
    </div>
  );
}
function RunActions({
  readonly = false,
  record,
  busy,
  onAction,
}: {
  record: ScheduleRunRecord;
  readonly?: boolean;
  busy: boolean;
  onAction: (record: ScheduleRunRecord, action: 'retryRun' | 'cancelRun' | 'executeLocalRun') => void;
}) {
  return (
    <>
      {readonly&&<span>此处运行记录仅供只读查看，不能执行、取消或重试；专用手动清单的原操作核对在独立入口进行。</span>}
      {!readonly && record.data.intent?.handler === 'local-evidence-report' && (
        <a className="secondary" href="#scheduled">
          前往定时报告核对同意与结果
        </a>
      )}
      {record.data.state === 'queued' && record.data.intent?.handler !== 'local-evidence-report' && (
        <button className="primary" disabled={busy||readonly} onClick={() => onAction(record, 'executeLocalRun')}>
          执行本地任务
        </button>
      )}
      {(record.data.state === 'queued' || record.data.state === 'running') && (
        <button
          className="text-button company-danger"
          disabled={busy||readonly}
          onClick={() => onAction(record, 'cancelRun')}
        >
          取消本次运行
        </button>
      )}
      {['cancelled', 'unavailable', 'skipped', 'failed'].includes(record.data.state) &&
        record.data.intent?.handler !== 'local-evidence-report' && (
          <button className="secondary" disabled={busy||readonly} onClick={() => onAction(record, 'retryRun')}>
            创建重试运行
          </button>
        )}
    </>
  );
}
function PendingNote({ busy }: { busy: boolean }) {
  return busy ? <p role="status">正在提交。关闭窗口不会撤销已提交的操作，稍后请刷新核对回执。</p> : null;
}
function FormFooter({ busy, problem, onClose }: { busy: boolean; problem?: Problem; onClose: () => void }) {
  return (
    <>
      {problem && <Notice kind="error">{problem.message}</Notice>}
      <PendingNote busy={busy} />
      <div className="company-form-actions">
        <button type="button" className="secondary" onClick={onClose}>
          {busy ? '关闭窗口' : '取消'}
        </button>
        <button type="submit" aria-label="保存" className="primary" disabled={busy || problem?.conflict}>
          {busy && <Spinner />} 保存
        </button>
      </div>
    </>
  );
}
type EditorProps<T> = { definitionsOnly?: boolean; record?: T; busy: boolean; problem?: Problem; onClose: () => void };
function SkillEditor({
  definitionsOnly = false,
  record,
  busy,
  problem,
  onClose,
  onSave,
}: EditorProps<SkillView> & { onSave: (input: Omit<CreateSkill, 'idempotencyKey'>) => void }) {
  const [name, setName] = useDefinitionState('name', record?.data.name ?? '');
  const [description, setDescription] = useDefinitionState('description', record?.data.description ?? '');
  const [handler, setHandler] = useDefinitionState<SkillHandler>('handler', record?.data.handler ?? 'local-notification');
  const [enabled, setEnabled] = useDefinitionState('enabled', record?.data.enabled ?? false);
  useDefinitionDraft({ name, description, handler, enabled });
  return (
    <form
      className="company-form automation-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && !problem?.conflict && name.trim())
          onSave({ name: name.trim(), description, handler, enabled });
      }}
    >
      <Notice>
        {definitionsOnly ? '此处仅保存技能定义；通用执行入口未接通。文档清单须另走专用手动入口，不会产生通知。请勿填写凭据、密码或可执行代码。' : '本地通知只写入应用收件箱；本地指令快照只保存原文。外部研究执行器不可用。请勿填写凭据、密码或可执行代码。'}
      </Notice>
      <label>
        技能名称
        <input
          required
          maxLength={100}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        描述
        <textarea
          maxLength={2000}
          rows={3}
          value={description}
          disabled={busy}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label>
        执行入口
        <select
          value={handler}
          disabled={busy}
          onChange={(event) => setHandler(event.target.value as SkillHandler)}
        >
          {Object.entries(handlers).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="automation-check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(event) => setEnabled(event.target.checked)}
        />{' '}
        启用技能偏好（不会连接提供方）
      </label>
      <FormFooter busy={busy} problem={problem} onClose={onClose} />
    </form>
  );
}
function SourceEditor({
  record,
  busy,
  problem,
  onClose,
  onSave,
}: EditorProps<DataSourceView> & { onSave: (input: Omit<CreateDataSource, 'idempotencyKey'>) => void }) {
  const [name, setName] = useDefinitionState('name', record?.data.name ?? '');
  const [kind, setKind] = useDefinitionState<DataSourceKind>('kind', record?.data.kind ?? 'local-workspace');
  const [collections, setCollections] = useDefinitionState('collections', record?.data.collectionIds.join('\n') ?? '');
  const [enabled, setEnabled] = useDefinitionState('enabled', record?.data.enabled ?? false);
  const [validation, setValidation] = useDefinitionState('validation', '');
  useDefinitionDraft({ name, kind, collections, enabled });
  const local = kind === 'local-workspace' || kind === 'local-archive';
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || problem?.conflict || !name.trim()) return;
    const collectionIds = local ? collections.split(/[\s,，]+/).filter(Boolean) : [];
    if (
      collectionIds.length > 50 ||
      collectionIds.some((id) => !/^[A-Za-z0-9_-]{1,100}$/.test(id)) ||
      new Set(collectionIds).size !== collectionIds.length
    ) {
      setValidation(
        '集合 ID 需唯一，只能包含英文字母、数字、下划线和连字符；每个最多 100 字符，最多 50 个。',
      );
      return;
    }
    setValidation('');
    onSave({ name: name.trim(), kind, enabled, collectionIds });
  }
  return (
    <form className="company-form automation-form" onSubmit={submit}>
      <Notice>
        这里仅保存逻辑偏好，不输入服务地址、密钥或密码，也不会授予新资料权限。外部连接器尚未配置。
      </Notice>
      <label>
        数据源名称
        <input
          required
          maxLength={100}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        来源类型
        <select
          disabled={busy || Boolean(record)}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as DataSourceKind);
            setValidation('');
          }}
        >
          {Object.entries(sourceKinds).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {record && <p className="muted">已有来源类型不可修改；如需其他类型，请新建数据源。</p>}
      {local && (
        <label>
          逻辑集合 ID（选填，每行一个）
          <textarea
            rows={3}
            maxLength={5049}
            value={collections}
            disabled={busy}
            onChange={(event) => setCollections(event.target.value)}
          />
        </label>
      )}
      <label className="automation-check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(event) => setEnabled(event.target.checked)}
        />{' '}
        启用数据源偏好（不代表连接可用）
      </label>
      {validation && <Notice kind="error">{validation}</Notice>}
      <FormFooter busy={busy} problem={problem} onClose={onClose} />
    </form>
  );
}
function ScheduleEditor({
  definitionsOnly = false,
  record,
  data,
  busy,
  problem,
  onClose,
  onSave,
}: EditorProps<ScheduleRecord> & {
  data: Snapshot;
  onSave: (input: Omit<CreateSchedule, 'idempotencyKey'>) => void;
}) {
  const [name, setName] = useDefinitionState('name', record?.data.name ?? '');
  const [skillId, setSkillId] = useDefinitionState('skillId', record?.data.skillId ?? '');
  const [sourceIds, setSourceIds] = useDefinitionState('sourceIds', record?.data.sourceIds ?? []);
  const [instructions, setInstructions] = useDefinitionState('instructions', record?.data.instructions ?? '');
  const [kind, setKind] = useDefinitionState<ScheduleCadence['kind']>('kind', record?.data.cadence.kind ?? 'daily');
  const [timezone, setTimezone] = useDefinitionState('timezone', record?.data.cadence.timezone ?? 'Asia/Shanghai');
  const [at, setAt] = useDefinitionState('at', record?.data.cadence.kind === 'once' ? record.data.cadence.at : '');
  const [time, setTime] = useDefinitionState('time', 
    record && record.data.cadence.kind !== 'once' ? record.data.cadence.time : '09:00',
  );
  const [days, setDays] = useDefinitionState('days', 
    record?.data.cadence.kind === 'weekly' ? record.data.cadence.weekdays : [1],
  );
  const [enabled, setEnabled] = useDefinitionState('enabled', record?.data.enabled ?? false);
  const [policy, setPolicy] = useDefinitionState<'coalesce' | 'skip'>('policy', record?.data.misfirePolicy ?? 'coalesce');
  const [grace, setGrace] = useDefinitionState('grace', String(record?.data.graceSeconds ?? 60));
  const [validation, setValidation] = useDefinitionState('validation', '');
  useDefinitionDraft({ name, skillId, sourceIds, instructions, kind, timezone, at, time, days, enabled, policy, grace });
  const skills = data.skills.filter((item) => !item.deletedAt);
  const sources = data.sources.filter((item) => !item.deletedAt);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || problem?.conflict || !name.trim()) return;
    let zone: string;
    try {
      if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(timezone)) throw new Error();
      zone = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
    } catch {
      setValidation('请输入有效的 IANA 时区，例如 Asia/Shanghai 或 America/New_York。');
      return;
    }
    if (
      !skills.some((item) => item.id === skillId) ||
      sourceIds.some((id) => !sources.some((item) => item.id === id))
    ) {
      setValidation('所选技能或数据源已不可用，请重新选择；不会自动替换。');
      return;
    }
    if (sourceIds.length > 20) {
      setValidation('每个日程最多选择 20 个数据源。');
      return;
    }
    const graceSeconds = Number(grace);
    if (!/^\d+$/.test(grace) || !Number.isInteger(graceSeconds) || graceSeconds < 0 || graceSeconds > 3600) {
      setValidation('宽限期必须是 0 到 3600 之间的整数秒。');
      return;
    }
    let cadence: ScheduleCadence;
    if (kind === 'once') {
      const parsed = new Date(at);
      const parts = at.slice(0, 10).split('-').map(Number);
      if (
        !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(
          at,
        ) ||
        !Number.isFinite(parsed.getTime()) ||
        parsed.getUTCFullYear() < 1970 ||
        parsed.getUTCFullYear() > 2099 ||
        new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDate() !== parts[2]
      ) {
        setValidation(
          '单次时间必须是有效 ISO 时间，并包含 Z 或明确 UTC 偏移，例如 2026-12-01T09:00:00+08:00（1970–2099 年）。',
        );
        return;
      }
      cadence = { kind, at, timezone: zone };
    } else {
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
        setValidation('请选择有效的小时和分钟。');
        return;
      }
      if (kind === 'weekly' && days.length === 0) {
        setValidation('每周日程至少选择一天。');
        return;
      }
      cadence =
        kind === 'daily'
          ? { kind, time, timezone: zone }
          : { kind, time, timezone: zone, weekdays: [...days].sort() };
    }
    setValidation('');
    onSave({
      name: name.trim(),
      skillId,
      sourceIds,
      instructions,
      cadence,
      enabled,
      misfirePolicy: policy,
      graceSeconds,
    });
  }
  return (
    <form className="company-form automation-form" onSubmit={submit}>
      <label>
        任务名称
        <input
          required
          maxLength={100}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        执行技能
        <select required disabled={busy} value={skillId} onChange={(event) => setSkillId(event.target.value)}>
          <option value="">请选择技能</option>
          {skillId && !skills.some((item) => item.id === skillId) && (
            <option value={skillId}>已删除或不可访问的技能</option>
          )}
          {skills.map((item) => (
            <option key={item.id} value={item.id}>
              {item.data.name} · {item.data.enabled ? '已启用' : '未启用'} ·{' '}
              {item.availability.status === 'available' ? '可用' : '不可用'}
            </option>
          ))}
        </select>
      </label>
      <fieldset disabled={busy} className="automation-fieldset">
        <legend>数据源（选填，最多 20 项）</legend>
        {sources.length === 0 && <p className="muted">暂无数据源；本地通知和指令快照可不选择数据源。</p>}
        {sources.map((item) => (
          <label className="automation-check" key={item.id}>
            <input
              type="checkbox"
              checked={sourceIds.includes(item.id)}
              disabled={busy || (!sourceIds.includes(item.id) && sourceIds.length >= 20)}
              onChange={(event) =>
                setSourceIds((previous) =>
                  event.target.checked ? [...previous, item.id] : previous.filter((id) => id !== item.id),
                )
              }
            />
            {item.data.name} · {item.data.enabled ? '已启用' : '未启用'} ·{' '}
            {item.availability.status === 'available' ? '可用' : '不可用'}
          </label>
        ))}
        {sourceIds
          .filter((id) => !sources.some((item) => item.id === id))
          .map((id) => (
            <label className="automation-check" key={id}>
              <input
                type="checkbox"
                checked
                disabled={busy}
                onChange={() => setSourceIds((previous) => previous.filter((value) => value !== id))}
              />{' '}
              已失效的选择：{id}（取消勾选后重新选择）
            </label>
          ))}
      </fieldset>
      <label>
        指令 / 通知正文
        <textarea
          rows={3}
          maxLength={4000}
          value={instructions}
          disabled={busy}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <div className="company-form-pair">
        <label>
          重复方式
          <select
            disabled={busy}
            value={kind}
            onChange={(event) => setKind(event.target.value as ScheduleCadence['kind'])}
          >
            <option value="once">单次</option>
            <option value="daily">每日</option>
            <option value="weekly">每周</option>
          </select>
        </label>
        <label>
          IANA 时区
          <input
            required
            maxLength={100}
            disabled={busy}
            list="automation-timezones"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
          />
          <datalist id="automation-timezones">
            {['Asia/Shanghai', 'Asia/Tokyo', 'UTC', 'America/New_York', 'Europe/London'].map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </label>
      </div>
      {kind === 'once' ? (
        <label>
          单次时间（ISO，含 UTC 偏移）
          <input
            required
            maxLength={35}
            aria-label="单次时间（ISO，含 UTC 偏移）"
            aria-describedby="automation-once-offset-hint"
            disabled={busy}
            placeholder="2026-12-01T09:00:00+08:00"
            value={at}
            onChange={(event) => setAt(event.target.value)}
          />
          <span id="automation-once-offset-hint">
            偏移决定唯一时刻；上方时区用于显示，不会重新解释此时刻。
          </span>
        </label>
      ) : (
        <label>
          当地时间
          <input
            required
            type="time"
            value={time}
            disabled={busy}
            onChange={(event) => setTime(event.target.value)}
          />
        </label>
      )}
      {kind === 'weekly' && (
        <fieldset className="automation-fieldset" disabled={busy}>
          <legend>每周日期</legend>
          <div className="automation-weekdays">
            {weekdays.map((day, index) => (
              <label className="automation-check" key={day}>
                <input
                  type="checkbox"
                  checked={days.includes(index)}
                  onChange={(event) =>
                    setDays((previous) =>
                      event.target.checked
                        ? [...previous, index]
                        : previous.filter((value) => value !== index),
                    )
                  }
                />
                {day}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <Notice>
        <Clock3 size={15} />{' '}
        {definitionsOnly ? '每日/每周按所选时区计算定义时间，不会执行。夏令时跳过不存在的时间；重复的当地时间只取第一次。单次日程需有未来发生点。' : '每日/每周按所选时区的当地时间执行。夏令时跳过不存在的时间；重复的当地时间只取第一次。单次日程需有未来发生点。'}
      </Notice>
      <div className="company-form-pair">
        <label>
          漏跑政策
          <select
            value={policy}
            disabled={busy}
            onChange={(event) => setPolicy(event.target.value as 'coalesce' | 'skip')}
          >
            <option value="coalesce">合并为最近一次</option>
            <option value="skip">超过宽限期则跳过</option>
          </select>
        </label>
        <label>
          宽限期（秒）
          <input
            required
            type="number"
            min={0}
            max={3600}
            step={1}
            value={grace}
            disabled={busy}
            onChange={(event) => setGrace(event.target.value)}
          />
        </label>
      </div>
      <label className="automation-check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(event) => setEnabled(event.target.checked)}
        />{' '}
        {definitionsOnly ? '启用定义偏好（通用任务与定时执行未接通）' : '启用未来调度（还需日程处于活动状态）'}
      </label>
      <p className="muted">
        {definitionsOnly ? '只保存任务配置。技能、数据源与日程的启用偏好均不会连接执行器或外部服务。' : '本地技能仅生成应用内通知或原文快照。选择外部/未启用技能或数据源会阻止执行；启用日程不会自动连接它们。'}
      </p>
      {validation && <Notice kind="error">{validation}</Notice>}
      <FormFooter busy={busy} problem={problem} onClose={onClose} />
    </form>
  );
}

/** Scoped focus trap includes selects and excludes disabled controls; Escape never submits a form. */
function AutomationModal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(
        dialog?.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex="0"]') ??
          [],
      ).filter((node) => !node.matches(':disabled') && node.getAttribute('aria-hidden') !== 'true');
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first) {
        event.preventDefault();
        dialog?.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      if (previous?.isConnected) previous.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal wide automation-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
