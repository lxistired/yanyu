// RECOVERY: retained 13:52 wrapper plus newly reapplied documented R1/R2 corrections; fresh verification required.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ResearchDocument } from '../../shared/contracts';
import type { ReaderSourcePin } from '../../shared/reader-reference';
import { readerCanonical } from '../../shared/reader-reference';
import type {
  ServiceActivity,
  ServiceActivityPage,
  ServiceReport,
  ServiceReportPage,
} from '../../shared/service-reports';
import {
  ServiceReportsClientError,
  type ServiceCustomersPage,
  type ServiceReportExport,
  type ServiceReportsActor,
  type ServiceReportsAuthority,
  type ServiceReportsClient,
  type ServiceReportsCommands,
  type ServiceReportsIntent,
} from '../adapters/service-reports';
import { MonthlyServiceReportsView } from './MonthlyServiceReportsView';
import type {
  ServiceActivityDraft,
  ServiceCustomerIdentity,
  ServicePageRequest,
  ServicePageView,
  ServiceReadState,
  ServiceReportAuthority,
  ServiceReportSelection,
  ServiceSourceOpenRequest,
} from './service-report-view-types';

export interface ServiceReportsWorkspaceProps {
  /** Client and journal controller must outlive route dismissal. getActor is supplied by the outer app. */
  client: ServiceReportsClient;
  commands: ServiceReportsCommands;
  actor: ServiceReportsActor | null;
  status: 'available' | 'unknown' | 'unavailable';
  /** Increment on navigation replacement, including Back/Forward within the same visible route. */
  routeEpoch: number;
  initialSelection: ServiceReportSelection;
  /** One current, bounded uploaded-file library page. Display names never establish source authority. */
  librarySourceChoices?: ServiceReadState<readonly ServiceReportsLibrarySourceChoice[]>;
  /** Ready library choices remain hidden unless bound to this exact actor, service scope and route. */
  librarySourceBinding?: ServiceReportsAuthority & { routeEpoch: number };
  onRefreshLibrarySources?: () => void;
  onNextLibrarySources?: () => void;
  /** Both publication callbacks are synchronous; source withdrawal closes the outer reader. */
  onOpenSource: (
    value: { scope: string; document: ResearchDocument; pin: ReaderSourcePin },
    opener: HTMLButtonElement,
  ) => void;
  onWithdrawSource: () => void;
  /** Create/download a fresh Blob synchronously; revoke any temporary URL after browser handoff. */
  onDownload: (value: ServiceReportExport) => void;
  /** Controlled sibling workflow; values come only from this currently authorized keyed session. */
  renderMail?: (value: {
    customer: ServiceReadState<ServiceCustomerIdentity>;
    report: ServiceReadState<ServiceReport>;
    available: boolean;
  }) => ReactNode;
}
export type ServiceReportsLibrarySourceChoice = Readonly<{
  documentId: string;
  revisionId: string;
  name: string;
}>;
const unknown = <T,>(message = '请先确认当前访问范围'): ServiceReadState<T> => ({
  state: 'unknown',
  message,
});
const loading = <T,>(): ServiceReadState<T> => ({ state: 'loading', message: '正在进行当前授权读取' });
const firstPage = { after: null, censusSha256: null } as const;
const same = (a: unknown, b: unknown) => readerCanonical(a) === readerCanonical(b);
const errorMessage = (error: unknown) =>
  error instanceof ServiceReportsClientError ? error.message : '服务月报暂时不可用，请重新读取';
const failure = <T,>(error: unknown): ServiceReadState<T> => ({
  state:
    error instanceof ServiceReportsClientError && ['FORBIDDEN', 'NOT_FOUND'].includes(error.code)
      ? 'unavailable'
      : 'error',
  message: errorMessage(error),
});
const pageInput = (page: ServicePageRequest) => ({
  after: page.after,
  ...(page.censusSha256 === null ? {} : { censusSha256: page.censusSha256 }),
});
const resetNotice = (error: unknown) =>
  error instanceof ServiceReportsClientError && error.code === 'CONFLICT'
    ? '分页依据已改变；请点击从第一页重新读取'
    : null;
const libraryChoiceKey = (value: ServiceReportsLibrarySourceChoice) =>
  readerCanonical([value.documentId, value.revisionId]);
function libraryPage(
  read: ServiceReportsWorkspaceProps['librarySourceChoices'],
): readonly ServiceReportsLibrarySourceChoice[] | null {
  if (read?.state !== 'ready' || !Array.isArray(read.value) || read.value.length > 25) return null;
  const choices: ServiceReportsLibrarySourceChoice[] = [];
  for (const value of read.value) {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value),
      keys = ['documentId', 'revisionId', 'name'];
    if (
      Reflect.ownKeys(value).length !== keys.length ||
      keys.some(
        (key) =>
          !Object.hasOwn(descriptors, key) || !('value' in descriptors[key]) || !descriptors[key].enumerable,
      )
    )
      return null;
    const documentId: unknown = descriptors.documentId.value,
      revisionId: unknown = descriptors.revisionId.value,
      name: unknown = descriptors.name.value;
    if (
      typeof documentId !== 'string' ||
      !documentId ||
      documentId.length > 500 ||
      typeof revisionId !== 'string' ||
      !revisionId ||
      revisionId.length > 500 ||
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 1000
    )
      return null;
    choices.push({ documentId, revisionId, name });
  }
  if (new Set(choices.map(libraryChoiceKey)).size !== choices.length) return null;
  return choices;
}

/** The keyed shell withdraws ready data during render when actor/status/navigation changes. */
export function ServiceReportsWorkspace(props: ServiceReportsWorkspaceProps) {
  const key = JSON.stringify([
    props.actor?.binding ?? null,
    props.actor?.epoch ?? null,
    props.status,
    props.routeEpoch,
  ]);
  return <ServiceReportsSession key={key} {...props} />;
}

function ServiceReportsSession(props: ServiceReportsWorkspaceProps) {
  const { client, commands } = props;
  const latest = useRef(props);
  latest.current = props;
  const alive = useRef(false),
    epoch = useRef(0);
  const reads = useRef({
    customers: 0,
    activities: 0,
    reports: 0,
    report: 0,
    sources: 0,
    open: 0,
    export: 0,
  });
  const [authority, setAuthority] = useState<ServiceReportAuthority>({
    state: props.status === 'unavailable' ? 'unavailable' : 'unknown',
    message: '当前权限尚未确认',
  });
  const [selection, setSelection] = useState<ServiceReportSelection>(() => ({
    ...props.initialSelection,
    customer: props.initialSelection.customer ? { ...props.initialSelection.customer } : null,
  }));
  const selectionRef = useRef(selection);
  const [customers, setCustomers] = useState<ServiceReadState<ServiceCustomersPage>>(unknown());
  const [activities, setActivities] = useState<ServicePageView<ServiceActivityPage>>({
    read: unknown(),
    resetNotice: null,
  });
  const [reports, setReports] = useState<ServicePageView<ServiceReportPage>>({
    read: unknown(),
    resetNotice: null,
  });
  const [selectedReport, setSelectedReport] = useState<ServiceReadState<ServiceReport>>(
    unknown('请选择月报'),
  );
  const activityRef = useRef<ServiceActivityPage | null>(null),
    reportRef = useRef<ServiceReport | null>(null);
  const [draft, setDraft] = useState<ServiceActivityDraft | null>(null),
    draftRef = useRef<ServiceActivityDraft | null>(null);
  const [sourceChoices, setSourceChoices] = useState<ServiceReadState<readonly ReaderSourcePin[]>>({
    state: 'unavailable',
    message: '请在下方选择当前本地资料并核验，或输入精确文档与修订标识；不会自动选择来源',
  });
  const pins = useRef<readonly ReaderSourcePin[]>([]);
  const [commandView, setCommandView] = useState<ReturnType<ServiceReportsCommands['view']>>({
    pending: null,
    error: null,
  });
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [openingSource, setOpeningSource] = useState(false),
    opening = useRef(false);
  const [exporting, setExporting] = useState<{ reportId: string; format: 'json' | 'csv' | 'html' } | null>(
      null,
    ),
    exportBusy = useRef(false);
  const [documentId, setDocumentId] = useState(''),
    [revisionId, setRevisionId] = useState('');
  const [librarySelection, setLibrarySelection] = useState('');
  const [inspecting, setInspecting] = useState(false),
    inspectBusy = useRef(false);

  const authorized = () => {
    const current = client.authority();
    return (
      alive.current &&
      latest.current.status === 'available' &&
      latest.current.actor !== null &&
      current !== null &&
      same(current.actor, latest.current.actor)
    );
  };
  const fresh = (generation: number, slot: keyof typeof reads.current, serial: number) =>
    authorized() && epoch.current === generation && reads.current[slot] === serial;
  const unlocked = () => authorized() && commands.view().pending === null;
  const updateDraft = (value: ServiceActivityDraft | null) => {
    draftRef.current = value;
    setDraft(value);
  };
  const withdrawSource = () => {
    reads.current.open++;
    opening.current = false;
    setOpeningSource(false);
    latest.current.onWithdrawSource();
  };

  function loadCustomers(page: ServicePageRequest = firstPage) {
    if (!authorized()) return;
    const generation = epoch.current,
      serial = ++reads.current.customers;
    setCustomers(loading());
    void client.customers(pageInput(page)).then(
      (value) => {
        if (fresh(generation, 'customers', serial)) setCustomers({ state: 'ready', value });
      },
      (error: unknown) => {
        if (fresh(generation, 'customers', serial)) setCustomers(failure(error));
      },
    );
  }
  function loadActivities(page: ServicePageRequest = firstPage) {
    if (!authorized()) return;
    // Replacing the page immediately withdraws pending and already published old source ownership.
    withdrawSource();
    const selected = selectionRef.current,
      generation = epoch.current,
      serial = ++reads.current.activities;
    activityRef.current = null;
    if (!selected.customer) {
      setActivities({ read: unknown('请选择当前客户'), resetNotice: null });
      return;
    }
    setActivities({ read: loading(), resetNotice: null });
    void client
      .listActivities({
        customer: selected.customer,
        month: selected.month,
        timeZone: selected.timeZone,
        includeArchived: selected.includeArchived,
        ...pageInput(page),
      })
      .then(
        (value) => {
          if (!fresh(generation, 'activities', serial) || !same(selected, selectionRef.current)) return;
          activityRef.current = value;
          setActivities({ read: { state: 'ready', value }, resetNotice: null });
        },
        (error: unknown) => {
          if (fresh(generation, 'activities', serial))
            setActivities({ read: failure(error), resetNotice: resetNotice(error) });
        },
      );
  }
  function loadReports(page: ServicePageRequest = firstPage) {
    if (!authorized()) return;
    const generation = epoch.current,
      serial = ++reads.current.reports,
      includeArchived = selectionRef.current.includeArchived;
    setReports({ read: loading(), resetNotice: null });
    void client.listReports({ includeArchived, ...pageInput(page) }).then(
      (value) => {
        if (fresh(generation, 'reports', serial))
          setReports({ read: { state: 'ready', value }, resetNotice: null });
      },
      (error: unknown) => {
        if (fresh(generation, 'reports', serial))
          setReports({ read: failure(error), resetNotice: resetNotice(error) });
      },
    );
  }
  function chooseReport(id: string) {
    if (!unlocked()) return;
    // A returned export belongs to exactly the selected report, including while its replacement loads.
    reads.current.export++;
    exportBusy.current = false;
    setExporting(null);
    setExportError(null);
    withdrawSource();
    const generation = epoch.current,
      serial = ++reads.current.report;
    reportRef.current = null;
    setSelectedReport(loading());
    void client.getReport({ id }).then(
      (value) => {
        if (fresh(generation, 'report', serial)) {
          reportRef.current = value.report;
          setSelectedReport({ state: 'ready', value: value.report });
        }
      },
      (error: unknown) => {
        if (fresh(generation, 'report', serial)) setSelectedReport(failure(error));
      },
    );
  }
  function withdrawReads() {
    ++epoch.current;
    client.invalidateReads();
    activityRef.current = null;
    reportRef.current = null;
    setActivities({ read: unknown('当前条件已改变，请重新读取'), resetNotice: null });
    setReports({ read: unknown('正在更新当前列表'), resetNotice: null });
    setSelectedReport(unknown('请选择月报'));
    updateDraft(null);
    pins.current = [];
    setSourceChoices({ state: 'unavailable', message: '条件已改变，请重新核验精确来源' });
    inspectBusy.current = false;
    setInspecting(false);
    exportBusy.current = false;
    setExporting(null);
    setSourceError(null);
    setExportError(null);
    withdrawSource();
  }
  function changeSelection(value: ServiceReportSelection) {
    if (!unlocked() || draftRef.current !== null) return;
    setRecoveryNotice(null);
    withdrawReads();
    selectionRef.current = { ...value, customer: value.customer ? { ...value.customer } : null };
    setSelection(selectionRef.current);
    loadActivities();
    loadReports();
  }
  function refreshAfterMutation(reportId?: string) {
    const keepReport = reportId ?? reportRef.current?.id;
    withdrawReads();
    loadActivities();
    loadReports();
    loadCustomers();
    if (keepReport) chooseReport(keepReport);
  }
  function refreshAfterCancellation() {
    // Cancellation does not apply the draft or preserve a stale selected snapshot as a successful write.
    withdrawReads();
    loadActivities();
    loadReports();
    loadCustomers();
    setRecoveryNotice(
      '已确认原操作未提交并已取消。旧草稿已关闭，当前记录已重新请求；如需修改，请从重新读取的记录开始。',
    );
  }
  function runMutation(intent: ServiceReportsIntent) {
    if (!unlocked()) return;
    const generation = epoch.current;
    setMutationError(null);
    setRecoveryNotice(null);
    // submit claims its lock and writes the original command synchronously before returning a Promise.
    const result = commands.submit(intent);
    setCommandView(commands.view());
    void result.then(
      (value) => {
        if (!authorized() || epoch.current !== generation) return;
        refreshAfterMutation('report' in value ? value.report.id : undefined);
      },
      (error: unknown) => {
        if (alive.current && epoch.current === generation) setMutationError(errorMessage(error));
      },
    );
  }
  function recover(token: string, mode: 'retry' | 'check' | 'cancel') {
    if (!authorized()) return;
    setMutationError(null);
    setRecoveryNotice(null);
    const generation = epoch.current,
      result =
        mode === 'retry'
          ? commands.retry(token)
          : mode === 'cancel'
            ? commands.cancel(token)
            : commands.check(token);
    setCommandView(commands.view());
    void result.then(
      (value) => {
        if (!authorized() || epoch.current !== generation) return;
        if ('outcome' in value && value.outcome === 'cancelled') refreshAfterCancellation();
        else if (!('outcome' in value) || value.outcome === 'committed') {
          refreshAfterMutation();
          if (mode === 'cancel')
            setRecoveryNotice('原操作已经提交，未取消，也未撤销已提交的更改。当前记录已重新请求。');
        }
      },
      (error: unknown) => {
        if (alive.current && epoch.current === generation) setMutationError(errorMessage(error));
      },
    );
  }
  function correctActivity(value: ServiceActivity) {
    if (!unlocked() || !activityRef.current?.items.some((a) => same(a, value))) return;
    updateDraft({
      mode: 'correct',
      id: value.id,
      expectedRevision: value.revision,
      previousVersionId: value.versionId,
      activity: value.version.value,
      reason: '',
    });
    setMutationError(null);
    setRecoveryNotice(null);
  }
  function inspectSource(
    exact: { documentId: string; revisionId: string } = { documentId, revisionId },
    stillCurrent: () => boolean = () => true,
  ) {
    if (!unlocked() || inspectBusy.current || pins.current.length >= 64) return;
    const generation = epoch.current,
      serial = ++reads.current.sources;
    inspectBusy.current = true;
    setInspecting(true);
    setSourceError(null);
    setSourceChoices(loading());
    void client
      .inspectSource(exact)
      .then(
        (value) => {
          if (!fresh(generation, 'sources', serial)) return;
          if (!stillCurrent()) {
            pins.current = [];
            setSourceChoices({ state: 'unavailable', message: '资料页已改变，请重新选择并核验精确来源' });
            return;
          }
          const previous = pins.current.find(
            (p) => p.documentId === value.pin.documentId && p.revisionId === value.pin.revisionId,
          );
          if (previous && !same(previous, value.pin)) {
            pins.current = [];
            setSourceChoices({ state: 'unavailable', message: '原精确来源身份已改变，请逐条重新核验' });
            return;
          }
          pins.current = previous ? pins.current : [...pins.current, value.pin];
          setSourceChoices({ state: 'ready', value: pins.current });
        },
        (error: unknown) => {
          if (!fresh(generation, 'sources', serial)) return;
          pins.current = [];
          setSourceChoices(failure(error));
          setSourceError(errorMessage(error));
        },
      )
      .finally(() => {
        if (fresh(generation, 'sources', serial)) {
          inspectBusy.current = false;
          setInspecting(false);
        }
      });
  }
  function inspectLibraryChoice() {
    if (!unlocked()) return;
    const current = client.authority(),
      page = latest.current.librarySourceChoices,
      binding = latest.current.librarySourceBinding;
    if (
      !current ||
      !binding ||
      !same(binding.actor, current.actor) ||
      binding.scope !== current.scope ||
      binding.routeEpoch !== latest.current.routeEpoch
    )
      return;
    const parsedPage = libraryPage(page),
      pageSnapshot = readerCanonical(parsedPage);
    const bindingSnapshot = {
      actor: { ...binding.actor },
      scope: binding.scope,
      routeEpoch: binding.routeEpoch,
    };
    const selected = parsedPage?.find((choice) => libraryChoiceKey(choice) === librarySelection);
    if (!selected) return;
    const exact = { documentId: selected.documentId, revisionId: selected.revisionId };
    inspectSource(
      exact,
      () =>
        latest.current.librarySourceChoices === page &&
        same(latest.current.librarySourceBinding, bindingSnapshot) &&
        readerCanonical(libraryPage(latest.current.librarySourceChoices)) === pageSnapshot,
    );
  }
  function refreshSources() {
    if (!unlocked() || inspectBusy.current) return;
    if (pins.current.length === 0) {
      setSourceChoices({ state: 'unavailable', message: '请先输入文档与修订标识核验精确来源' });
      return;
    }
    const original = pins.current,
      generation = epoch.current,
      serial = ++reads.current.sources;
    inspectBusy.current = true;
    setInspecting(true);
    setSourceChoices(loading());
    setSourceError(null);
    // Serial bounded checks avoid an unbounded native enumeration or fan-out.
    void (async () => {
      const next: ReaderSourcePin[] = [];
      for (const pin of original) {
        if (!fresh(generation, 'sources', serial)) return;
        const value = await client.inspectSource({ documentId: pin.documentId, revisionId: pin.revisionId });
        if (!same(value.pin, pin)) throw new ServiceReportsClientError('CONFLICT');
        next.push(value.pin);
      }
      if (fresh(generation, 'sources', serial)) {
        pins.current = next;
        setSourceChoices({ state: 'ready', value: next });
      }
    })()
      .catch((error: unknown) => {
        if (fresh(generation, 'sources', serial)) {
          pins.current = [];
          setSourceChoices(failure(error));
          setSourceError(errorMessage(error));
        }
      })
      .finally(() => {
        if (fresh(generation, 'sources', serial)) {
          inspectBusy.current = false;
          setInspecting(false);
        }
      });
  }
  function openSource(value: ServiceSourceOpenRequest, opener: HTMLButtonElement) {
    if (!unlocked() || opening.current) return;
    const loaded =
      value.from === 'report'
        ? reportRef.current?.snapshot.activities.find((a) => a.id === value.activityId)
        : activityRef.current?.items.find((a) => a.id === value.activityId);
    if (
      !loaded ||
      loaded.versionId !== value.versionId ||
      !same(loaded.version.value.references[value.referenceIndex]?.pin ?? null, value.pin) ||
      (value.from === 'report'
        ? reportRef.current?.id !== value.reportId || reportRef.current.revision !== value.expectedRevision
        : loaded.revision !== value.expectedRevision)
    ) {
      setSourceError('来源入口已改变，请重新读取记录');
      return;
    }
    const generation = epoch.current,
      serial = ++reads.current.open;
    opening.current = true;
    setOpeningSource(true);
    setSourceError(null);
    void client
      .openSource(value)
      .then((result) => {
        if (fresh(generation, 'open', serial))
          client.consumeSource(result, (source) => latest.current.onOpenSource(source, opener));
      })
      .catch((error: unknown) => {
        if (fresh(generation, 'open', serial)) setSourceError(errorMessage(error));
      })
      .finally(() => {
        if (fresh(generation, 'open', serial)) {
          opening.current = false;
          setOpeningSource(false);
        }
      });
  }
  function exportReport(value: {
    reportId: string;
    expectedRevision: number;
    format: 'json' | 'csv' | 'html';
  }) {
    if (!unlocked() || exportBusy.current) return;
    if (reportRef.current?.id !== value.reportId || reportRef.current.revision !== value.expectedRevision) {
      setExportError('月报已改变，请重新读取');
      return;
    }
    const generation = epoch.current,
      serial = ++reads.current.export;
    exportBusy.current = true;
    setExporting({ reportId: value.reportId, format: value.format });
    setExportError(null);
    void client
      .exportReport(value)
      .then((result) => {
        if (fresh(generation, 'export', serial)) client.consumeDownload(result, latest.current.onDownload);
        else result.bytes.fill(0);
      })
      .catch((error: unknown) => {
        if (fresh(generation, 'export', serial)) setExportError(errorMessage(error));
      })
      .finally(() => {
        if (fresh(generation, 'export', serial)) {
          exportBusy.current = false;
          setExporting(null);
        }
      });
  }
  function connect() {
    if (!alive.current || latest.current.status !== 'available' || latest.current.actor === null) return;
    const generation = ++epoch.current;
    setAuthority({ state: 'unknown', message: '正在重新核验当前访问范围' });
    void client.scope().then(
      (value) => {
        if (!alive.current || generation !== epoch.current || !authorized()) return;
        setAuthority({ state: 'available', scope: value.scope, message: '已核验当前本地访问范围' });
        setCommandView(commands.view());
        loadCustomers();
        loadActivities();
        loadReports();
      },
      (error: unknown) => {
        if (alive.current && generation === epoch.current)
          setAuthority({ state: 'unavailable', message: errorMessage(error) });
      },
    );
  }

  useLayoutEffect(() => {
    alive.current = true;
    const unsubscribe = commands.subscribe(() => {
      if (alive.current) setCommandView(commands.view());
    });
    const unsubscribeAuthority = client.subscribe(() => {
      if (!alive.current || client.authority() !== null) return;
      // 401/403, scope mismatch, explicit withdrawal and actor transitions remove all ready data immediately.
      setAuthority({ state: 'unknown', message: '访问范围已撤回，请重新核验' });
      activityRef.current = null;
      reportRef.current = null;
      setCustomers(unknown());
      setActivities({ read: unknown(), resetNotice: null });
      setReports({ read: unknown(), resetNotice: null });
      setSelectedReport(unknown('请选择月报'));
      updateDraft(null);
      setRecoveryNotice(null);
      pins.current = [];
      setSourceChoices({ state: 'unavailable', message: '需要重新核验当前来源' });
      inspectBusy.current = false;
      setInspecting(false);
      exportBusy.current = false;
      setExporting(null);
      withdrawSource();
    });
    if (props.status !== 'available' || props.actor === null) {
      client.withdraw();
      setAuthority({
        state: props.status === 'unknown' ? 'unknown' : 'unavailable',
        message: '外层应用尚未提供可用身份',
      });
    } else connect();
    return () => {
      alive.current = false;
      unsubscribe();
      unsubscribeAuthority();
      client.withdraw();
      latest.current.onWithdrawSource();
    };
    // The keyed session remounts on actor/status/route changes; these services must have stable outer lifetimes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, commands]);

  const choices: ServiceReadState<readonly ServiceCustomerIdentity[]> =
    customers.state === 'ready' ? { state: 'ready', value: customers.value.items } : customers;
  const disabled = authority.state !== 'available' || commandView.pending !== null;
  const libraryBound =
    authority.state === 'available' &&
    props.librarySourceBinding !== undefined &&
    props.librarySourceBinding.scope === authority.scope &&
    props.librarySourceBinding.routeEpoch === props.routeEpoch &&
    same(props.librarySourceBinding.actor, props.actor);
  const libraryChoices = libraryBound ? libraryPage(props.librarySourceChoices) : null;
  const selectedCustomer =
    customers.state === 'ready'
      ? customers.value.items.find((item) =>
          same(
            { organizationId: item.pin.organizationId, contactId: item.pin.contactId },
            selection.customer,
          ),
        )
      : undefined;
  const mailCustomer: ServiceReadState<ServiceCustomerIdentity> =
    authority.state !== 'available'
      ? unknown('当前客户访问范围尚未确认')
      : selectedCustomer
        ? { state: 'ready', value: selectedCustomer }
        : unknown('请选择当前页中的客户');
  return (
    <>
      <MonthlyServiceReportsView
        authority={authority}
        customerChoices={choices}
        selection={selection}
        activities={activities}
        reportCards={reports}
        selectedReport={selectedReport}
        draft={draft}
        sourceChoices={sourceChoices}
        pending={commandView.pending}
        mutationError={mutationError ?? commandView.error}
        sourceError={sourceError}
        exportError={exportError}
        exporting={exporting}
        openingSource={openingSource}
        onSelectionChange={changeSelection}
        onRefreshCustomers={() => {
          if (unlocked() && draftRef.current === null) loadCustomers();
        }}
        onActivitiesPage={(page) => {
          if (unlocked() && draftRef.current === null) loadActivities(page);
        }}
        onReportsPage={(page) => {
          if (unlocked() && draftRef.current === null) loadReports(page);
        }}
        onChooseReport={chooseReport}
        onCloseReport={() => {
          reads.current.report++;
          reads.current.export++;
          exportBusy.current = false;
          setExporting(null);
          reportRef.current = null;
          setSelectedReport(unknown('请选择月报'));
          withdrawSource();
        }}
        onBeginActivity={() => {
          const selected = selectionRef.current;
          if (!unlocked() || !selected.customer) return;
          updateDraft({
            mode: 'add',
            activity: {
              customer: { ...selected.customer },
              kind: 'other',
              status: 'planned',
              occurredAt: new Date().toISOString(),
              summary: '',
              references: [],
            },
          });
          setMutationError(null);
          setRecoveryNotice(null);
        }}
        onCorrectActivity={correctActivity}
        onArchiveActivity={(value) => runMutation({ action: 'archiveActivity', input: value })}
        onDraftChange={(value) => {
          if (unlocked()) updateDraft(value);
        }}
        onSubmitActivity={(value) => {
          if (!same(value, draftRef.current)) return;
          if (value.mode === 'add')
            runMutation({ action: 'createActivity', input: { activity: value.activity } });
          else
            runMutation({
              action: 'correctActivity',
              input: {
                id: value.id,
                expectedRevision: value.expectedRevision,
                activity: value.activity,
                reason: value.reason,
              },
            });
        }}
        onCancelDraft={() => {
          if (unlocked()) updateDraft(null);
        }}
        onRefreshSources={refreshSources}
        onCreateReport={(value) => runMutation({ action: 'createReport', input: value })}
        onArchiveReport={(value) => runMutation({ action: 'archiveReport', input: value })}
        onExportReport={exportReport}
        onOpenSource={openSource}
        onRetryPending={(token) => recover(token, 'retry')}
        onCheckPending={(token) => recover(token, 'check')}
        onCancelPending={(token) => recover(token, 'cancel')}
      />
      {props.renderMail?.({
        customer: mailCustomer,
        report: authority.state === 'available' ? selectedReport : unknown('当前月报访问范围尚未确认'),
        available: authority.state === 'available' && commandView.pending === null,
      })}
      {recoveryNotice && (
        <p className="sr-notice" role="status" aria-label="原操作处理结果">
          {recoveryNotice}
        </p>
      )}
      <section className="sr-workspace" aria-label="当前客户与精确来源读取控制">
        <div className="sr-panel">
          <h2>当前客户页</h2>
          <p>客户选项来自一页当前 CRM 记录，不代表完整客户清单。</p>
          <div className="sr-actions">
            <button
              type="button"
              className="sr-button"
              disabled={
                props.status !== 'available' ||
                props.actor === null ||
                commandView.pending?.phase === 'sending'
              }
              onClick={connect}
            >
              重新核验当前访问范围
            </button>
            <button
              type="button"
              className="sr-button"
              disabled={disabled || draft !== null}
              onClick={() => {
                if (unlocked()) loadCustomers();
              }}
            >
              从第一页读取客户
            </button>
            <button
              type="button"
              className="sr-button"
              disabled={
                disabled ||
                draft !== null ||
                customers.state !== 'ready' ||
                customers.value.nextAfter === null
              }
              onClick={() => {
                if (unlocked() && customers.state === 'ready' && customers.value.nextAfter !== null)
                  loadCustomers({
                    after: customers.value.nextAfter,
                    censusSha256: customers.value.censusSha256,
                  });
              }}
            >
              下一页客户
            </button>
            <button
              type="button"
              className="sr-button"
              disabled={disabled || draft !== null}
              onClick={() => {
                if (unlocked()) {
                  loadActivities();
                  loadReports();
                }
              }}
            >
              从第一页重新读取活动与月报
            </button>
          </div>
        </div>
        {props.librarySourceChoices !== undefined && (
          <section className="sr-panel" aria-label="已上传资料来源选择">
            <h2>从已上传资料选择</h2>
            <p>这里显示一页当前资料库选项。名称仅供识别；选中后仍须核验精确文档与修订。</p>
            {libraryChoices === null && (
              <p role="status">当前资料页不可用，请由资料库重新载入当前身份的选项。</p>
            )}
            <label className="sr-field">
              已上传资料
              <select
                value={
                  libraryChoices?.some((choice) => libraryChoiceKey(choice) === librarySelection)
                    ? librarySelection
                    : ''
                }
                disabled={disabled || inspecting || libraryChoices === null}
                onChange={(event) => setLibrarySelection(event.target.value)}
              >
                <option value="">请选择已上传资料</option>
                {libraryChoices?.map((choice) => (
                  <option key={libraryChoiceKey(choice)} value={libraryChoiceKey(choice)}>
                    {choice.name} · 修订 {choice.revisionId}
                  </option>
                ))}
              </select>
            </label>
            <div className="sr-actions">
              <button
                type="button"
                className="sr-button"
                disabled={
                  disabled ||
                  inspecting ||
                  !libraryChoices?.some((choice) => libraryChoiceKey(choice) === librarySelection) ||
                  pins.current.length >= 64
                }
                onClick={inspectLibraryChoice}
              >
                核验所选资料
              </button>
              {props.onNextLibrarySources && (
                <button type="button" className="sr-button" disabled={disabled || inspecting || libraryChoices === null}
                  onClick={() => { if (unlocked()) latest.current.onNextLibrarySources?.(); }}>
                  下一页本地资料
                </button>
              )}
              {props.onRefreshLibrarySources && (
                <button
                  type="button"
                  className="sr-button"
                  disabled={disabled || inspecting}
                  onClick={() => {
                    if (unlocked()) latest.current.onRefreshLibrarySources?.();
                  }}
                >
                  从第一页刷新资料库选项
                </button>
              )}
            </div>
          </section>
        )}
        <form
          className="sr-panel"
          onSubmit={(event) => {
            event.preventDefault();
            inspectSource();
          }}
        >
          <h2>核验精确来源</h2>
          <div aria-label="精确来源核验状态">
            {sourceChoices.state === 'ready'
              ? <p role="status">已核验 {sourceChoices.value.length} 个精确来源；记录活动时仍需明确勾选。</p>
              : <p role={sourceChoices.state === 'error' ? 'alert' : 'status'}>{sourceChoices.message}</p>}
          </div>
          <p>本地资料请从上方明确选择并核验；也可输入精确文档与修订。synthetic-doc / v1 是独立的固定合成演示来源，不是已上传原件。</p>
          <label className="sr-field">
            文档标识
            <input
              value={documentId}
              maxLength={500}
              disabled={disabled || inspecting}
              onChange={(event) => setDocumentId(event.target.value)}
            />
          </label>
          <label className="sr-field">
            修订标识
            <input
              value={revisionId}
              maxLength={500}
              disabled={disabled || inspecting}
              onChange={(event) => setRevisionId(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="sr-button"
            disabled={disabled || inspecting || !documentId || !revisionId || pins.current.length >= 64}
          >
            核验并加入来源选项
          </button>
        </form>
      </section>
    </>
  );
}
