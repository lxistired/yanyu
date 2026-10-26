import {
  createServiceReportMailClient,
  createServiceReportMailCommands,
  type ServiceReportMailClient,
  type ServiceReportMailCommands,
} from '../adapters/service-report-mail';
import { ServiceReportMailWorkspace } from './ServiceReportMailWorkspace';
import type { ServiceMailReportPin } from '../../shared/service-report-mail';
import type { MailRead } from './service-report-mail-view-types';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { PreferenceValues } from '../../shared/preferences';
import {
  createServiceReportsClient,
  createServiceReportsCommands,
  ServiceReportsClientError,
  type ServiceReportExport,
  type ServiceReportsActor,
  type ServiceReportsAuthority,
  type ServiceReportsClient,
  type ServiceReportsCommands,
  type ServiceSourceChoicesPage,
} from '../adapters/service-reports';
import {
  ServiceReportsWorkspace,
  type ServiceReportsLibrarySourceChoice,
  type ServiceReportsWorkspaceProps,
} from './ServiceReportsWorkspace';
import type { ServiceReadState, ServiceReportSelection } from './service-report-view-types';
import './service-report-entry.css';

export interface ServiceReportsEntryProps {
  available: boolean;
  mailAvailable?: boolean;
  visible: boolean;
  /** A fresh server-verified preferences scopeKey. Display binding only; never selects a server owner. */
  identityScope: string | null;
  /** Main advances this on every route replacement and Back/Forward. Keep this entry mounted. */
  routeEpoch: number;
  displayPreferences?: Pick<PreferenceValues, 'dateDisplay'>;
}
type Runtime = {
  client: ServiceReportsClient;
  commands: ServiceReportsCommands;
  mailClient: ServiceReportMailClient;
  mailCommands: ServiceReportMailCommands;
};
type Source = Parameters<ServiceReportsWorkspaceProps['onOpenSource']>[0];
type SourceHandoff = { token: symbol; value: Source; opener: HTMLButtonElement };
type Choices = readonly ServiceReportsLibrarySourceChoice[];
const digest = /^[a-f0-9]{64}$/;
const unknownLibrary = (): ServiceReadState<Choices> => ({
  state: 'unknown', message: '请先核验当前服务报告访问范围，再读取本地资料来源',
});
const sameActor = (left: ServiceReportsActor | null, right: ServiceReportsActor | null) =>
  left !== null && right !== null && left.binding === right.binding && left.epoch === right.epoch;

function identity(available: boolean, identityScope: string | null, epoch: number) {
  const actor =
    available && identityScope !== null && digest.test(identityScope)
      ? Object.freeze({ binding: identityScope, epoch })
      : null;
  return { available, identityScope, epoch, actor };
}
function initialSelection(
  preferences?: ServiceReportsEntryProps['displayPreferences'],
): ServiceReportSelection {
  let timeZone = 'UTC';
  if (preferences?.dateDisplay !== 'utc') {
    try {
      timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      /* UTC fallback */
    }
  }
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const month = `${parts.find((part) => part.type === 'year')!.value}-${parts.find((part) => part.type === 'month')!.value}`;
  return { customer: null, month, timeZone, includeArchived: false };
}

/** Mount once above the route switch. Hiding the workspace never disposes its durable command owner. */
export function ServiceReportsEntry(props: ServiceReportsEntryProps) {
  const [binding, setBinding] = useState(() => identity(props.available, props.identityScope, 1));
  let current = binding;
  if (binding.available !== props.available || binding.identityScope !== props.identityScope) {
    current = identity(props.available, props.identityScope, binding.epoch + 1);
    setBinding(current);
  }
  const latest = useRef({ visible: props.visible, actor: current.actor });
  latest.current = { visible: props.visible, actor: current.actor };
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [startupError, setStartupError] = useState(false);
  useLayoutEffect(() => {
    const client = createServiceReportsClient({
      fetch: (...args) => globalThis.fetch(...args),
      getActor: () => (latest.current.visible ? latest.current.actor : null),
    });
    let commands: ServiceReportsCommands;
    try {
      // No memory/sessionStorage fallback. Getter denial prevents the workspace from mounting.
      commands = createServiceReportsCommands(client, { storage: window.localStorage });
    } catch {
      client.withdraw();
      setStartupError(true);
      return () => client.withdraw();
    }
    const mailClient = createServiceReportMailClient({
      fetch: (...args) => globalThis.fetch(...args),
      getActor: () => (latest.current.visible ? latest.current.actor : null),
      getScope: () => {
        const current = client.authority();
        return current && sameActor(current.actor, latest.current.actor) ? current.scope : null;
      },
    });
    let mailCommands: ServiceReportMailCommands;
    try {
      mailCommands = createServiceReportMailCommands(mailClient, { storage: window.localStorage });
    } catch {
      commands.dispose();
      client.withdraw();
      mailClient.withdraw();
      setStartupError(true);
      return () => mailClient.withdraw();
    }
    let mailScope: string | null = null;
    const unlink = client.subscribe(() => {
      const current = client.authority();
      const scope = current && sameActor(current.actor, latest.current.actor) ? current.scope : null;
      if (scope !== mailScope) {
        mailScope = scope;
        mailClient.withdraw();
      }
    });
    setRuntime({ client, commands, mailClient, mailCommands });
    setStartupError(false);
    return () => {
      unlink();
      mailCommands.dispose();
      mailClient.withdraw();
      commands.dispose();
      client.withdraw();
    };
  }, []);
  useLayoutEffect(() => {
    if (!props.visible) {
      runtime?.mailClient.withdraw();
      runtime?.client.withdraw();
    }
  }, [props.visible, runtime]);
  if (!props.visible) return null;
  if (startupError)
    return (
      <section className="sr-entry" aria-label="服务月报">
        <h1>服务月报</h1>
        <p role="alert">
          浏览器持久存储不可用，无法保存恢复记录；服务操作已阻止。请允许本地存储后重新打开应用。
        </p>
      </section>
    );
  if (!runtime)
    return (
      <section className="sr-entry" aria-label="服务月报">
        <p role="status">正在准备服务月报与操作恢复记录</p>
      </section>
    );
  return (
    <ServiceReportsEntrySession
      key={JSON.stringify([current.epoch, props.routeEpoch])}
      runtime={runtime}
      mailAvailable={props.mailAvailable === true}
      actor={current.actor}
      status={!props.available ? 'unavailable' : current.actor ? 'available' : 'unknown'}
      routeEpoch={props.routeEpoch}
      displayPreferences={props.displayPreferences}
    />
  );
}

function ServiceReportsEntrySession({
  runtime,
  mailAvailable,
  actor,
  status,
  routeEpoch,
  displayPreferences,
}: {
  runtime: Runtime;
  mailAvailable: boolean;
  actor: ServiceReportsActor | null;
  status: ServiceReportsWorkspaceProps['status'];
  routeEpoch: number;
  displayPreferences: ServiceReportsEntryProps['displayPreferences'];
}) {
  const { client, commands } = runtime;
  const [selection] = useState(() => initialSelection(displayPreferences));
  const [authority, setAuthority] = useState<ServiceReportsAuthority | null>(null);
  const [library, setLibrary] = useState<ServiceReadState<Choices>>(unknownLibrary);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<ServiceSourceChoicesPage | null>(null);
  const [pageRequest, setPageRequest] = useState<{ offset: number; storeScope: string | null }>({ offset: 0, storeScope: null });
  const [source, setSource] = useState<SourceHandoff | null>(null);
  const sourceRef = useRef<SourceHandoff | null>(null);
  const alive = useRef(false);
  const listController = useRef<AbortController | null>(null);
  const withdrawToken = (token: symbol) => {
    if (sourceRef.current?.token !== token) return;
    sourceRef.current = null;
    setSource((previous) => (previous?.token === token ? null : previous));
  };
  // Each render's callback pair owns its exact handoff token. Old cleanup cannot close a later handoff.
  const capturedToken = source?.token ?? null;
  let firstPublishedToken: symbol | null = null;
  const withdrawSource = () => {
    const token = capturedToken ?? firstPublishedToken;
    if (token !== null) withdrawToken(token);
  };
  useLayoutEffect(() => {
    alive.current = true;
    const synchronize = () => {
      const value = client.authority();
      if (value && sameActor(value.actor, actor)) {
        setAuthority((old) =>
          old?.scope === value.scope && sameActor(old.actor, value.actor) ? old : value,
        );
      } else {
        listController.current?.abort();
        sourceRef.current = null;
        setSource(null);
        setLibrary(unknownLibrary());
        setPage(null);
        setPageRequest({ offset: 0, storeScope: null });
        setAuthority(null);
      }
    };
    const unsubscribe = client.subscribe(() => {
      // A read-epoch invalidation also withdraws the selected source, even before React commits new props.
      sourceRef.current = null;
      setSource(null);
      synchronize();
    });
    synchronize();
    return () => {
      alive.current = false;
      unsubscribe();
      listController.current?.abort();
      sourceRef.current = null;
    };
  }, [client, actor]);
  useEffect(() => {
    if (!authority) return;
    const selected = authority;
    const controller = new AbortController();
    listController.current = controller;
    setLibrary({ state: 'loading', message: '正在核验本地资料来源选项' });
    setPage(null);
    const current = () => {
      const value = client.authority();
      return (
        alive.current &&
        !controller.signal.aborted &&
        value !== null &&
        value.scope === selected.scope &&
        sameActor(value.actor, selected.actor)
      );
    };
    void client.sourceChoices({ ...pageRequest, limit: 25 }, controller.signal).then(
      (result) => {
        if (!current()) return;
        setPage(result);
        setLibrary(result.capabilities.localDocuments
          ? { state: 'ready', value: result.items.map(({ documentId, revisionId, name }) => ({ documentId, revisionId, name })) }
          : { state: 'unavailable', message: '当前服务未配置本地资料来源；固定合成来源仍可单独选择用于演示' });
      },
      (error: unknown) => {
        if (!current()) return;
        if (error instanceof ServiceReportsClientError && error.code === 'FORBIDDEN') {
          client.withdraw();
          setLibrary({ state: 'unavailable', message: '当前身份没有资料库访问权限，请重新核验' });
        } else
          setLibrary({
            state: 'error',
            message:
              error instanceof ServiceReportsClientError && error.code === 'RATE_LIMITED'
                ? '资料库完整响应超过读取上限，未显示部分响应；可使用精确文档与修订核验'
                : '资料库选项无法完整校验，请刷新后重试',
          });
      },
    );
    return () => controller.abort();
  }, [client, authority, refresh, pageRequest]);
  const authorized = (scope: string) => {
    const value = client.authority();
    return (
      alive.current &&
      status === 'available' &&
      value !== null &&
      value.scope === scope &&
      sameActor(value.actor, actor)
    );
  };
  const openSource = (value: Source, opener: HTMLButtonElement) => {
    if (!authorized(value.scope)) throw new ServiceReportsClientError('FORBIDDEN');
    const handoff = { token: Symbol('service-report-source'), value, opener };
    if (firstPublishedToken === null) firstPublishedToken = handoff.token;
    sourceRef.current = handoff;
    setSource(handoff);
  };
  const download = (value: ServiceReportExport) => {
    if (!authorized(value.scope)) throw new ServiceReportsClientError('FORBIDDEN');
    const types = { json: 'application/json', csv: 'text/csv', html: 'text/html' };
    if (
      !Object.hasOwn(types, value.format) ||
      !/^[A-Za-z0-9_-]+\.(?:json|csv|html)$/.test(value.filename) ||
      !value.filename.endsWith(`.${value.format}`) ||
      new TextEncoder().encode(value.filename).byteLength > 180
    )
      throw new ServiceReportsClientError('INVALID_RESPONSE');
    // Copy synchronously: the adapter zeros its original bytes immediately after this handoff.
    const blob = new Blob([new Uint8Array(value.bytes)], {
      type: `${types[value.format]};charset=utf-8`,
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    try {
      link.href = url;
      link.download = value.filename;
      link.rel = 'noopener noreferrer';
      link.hidden = true;
      document.body.append(link);
      link.click();
    } finally {
      link.remove();
      URL.revokeObjectURL(url);
    }
  };
  return (
    <div className="sr-entry">
      <p className="sr-entry-note">可下载 JSON、CSV 和静态 HTML 历史快照；不提供 PDF、Word 或 Markdown。来源按已保存的精确修订核验后打开只读提取文本，不代表原件页面验收。</p>
      <ServiceReportsWorkspace
        client={client}
        commands={commands}
        actor={actor}
        status={status}
        routeEpoch={routeEpoch}
        initialSelection={selection}
        librarySourceChoices={library}
        librarySourceBinding={authority ? { ...authority, routeEpoch } : undefined}
        onRefreshLibrarySources={() => {
          listController.current?.abort();
          setLibrary({ state: 'loading', message: '正在重新载入资料库选项' });
          setPageRequest({ offset: 0, storeScope: page?.storeScope ?? pageRequest.storeScope });
          setRefresh((value) => value + 1);
        }}
        onNextLibrarySources={page?.capabilities.localDocuments && page.nextOffset !== null ? () => {
          listController.current?.abort();
          setLibrary({ state: 'loading', message: '正在读取下一页本地资料来源' });
          setPageRequest({ offset: page.nextOffset!, storeScope: page.storeScope });
        } : undefined}
        onOpenSource={openSource}
        onWithdrawSource={withdrawSource}
        onDownload={download}
        renderMail={({ customer, report, available }) => {
          const selected = report.state === 'ready' ? report.value : null;
          const mailReport: MailRead<ServiceMailReportPin> =
            selected && selected.state.archivedAt === null
              ? {
                  state: 'ready',
                  value: {
                    reportId: selected.id,
                    reportRevision: selected.revision,
                    snapshotSha256: selected.snapshotSha256,
                    customer: selected.snapshot.customer,
                    month: selected.snapshot.period.month,
                    timeZone: selected.snapshot.period.timeZone,
                  },
                }
              : { state: 'unknown', message: '请选择当前可授权且未归档的月报，再准备发送' };
          return (
            <ServiceReportMailWorkspace
              client={runtime.mailClient}
              commands={runtime.mailCommands}
              actor={actor}
              status={!mailAvailable ? 'unavailable' : available ? status : 'unknown'}
              routeEpoch={routeEpoch}
              customer={customer}
              report={mailReport}
            />
          );
        }}
      />
      <div className="sr-entry-library" aria-label="资料库读取状态">
        <p>
          本地资料仅在服务明确提供能力且完整核验后列出。固定合成来源是独立演示选项，不会替代读取失败的本地资料。
        </p>
        {library.state !== 'ready' && (
          <p role={library.state === 'error' ? 'alert' : 'status'}>{library.message}</p>
        )}
        {library.state === 'ready' && library.value.length === 0 && (
          <p role="status">本页没有可选的当前本地资料</p>
        )}
      </div>
      {source && authority?.scope === source.value.scope && (
        <PinnedSourcePanel handoff={source} onClose={() => withdrawToken(source.token)} />
      )}
    </div>
  );
}

function PinnedSourcePanel({ handoff, onClose }: { handoff: SourceHandoff; onClose: () => void }) {
  const heading = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const callback = useRef(onClose);
  callback.current = onClose;
  const userDismissal = useRef<symbol | null>(null);
  const dismiss = () => {
    userDismissal.current = handoff.token;
    callback.current();
  };
  useLayoutEffect(() => {
    // Opening disables the trigger during the read, so mount-time activeElement can be body.
    const token = handoff.token;
    const opener = handoff.opener;
    const dialog = panel.current;
    userDismissal.current = null;
    close.current?.focus();
    return () => {
      // Only a user dismissal owns restoration; withdrawal or route teardown never does.
      if (
        userDismissal.current === token &&
        dialog?.contains(document.activeElement) &&
        opener.isConnected &&
        !opener.disabled
      )
        opener.focus();
    };
  }, [handoff.token, handoff.opener]);
  const { document: source, pin } = handoff.value;
  return (
    <div className="sr-entry-backdrop">
      <div
        className="sr-entry-source"
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading}
        ref={panel}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            dismiss();
          }
          if (event.key === 'Tab') {
            // The read-only panel has one interactive control. Keep focus inside until it closes.
            event.preventDefault();
            close.current?.focus();
          }
        }}
      >
        <div className="sr-entry-source-heading">
          <h2 id={heading}>{source.title}</h2>
          <button ref={close} type="button" onClick={dismiss}>
            关闭来源
          </button>
        </div>
        <p>已核验内容身份的精确修订，只读提取文本。不是重新验收原件文件；此视图不提供原件页面映射。</p>
        <dl>
          <dt>文档标识</dt>
          <dd>{pin.documentId}</dd>
          <dt>修订标识</dt>
          <dd>{pin.revisionId}</dd>
          <dt>租户标识</dt>
          <dd>{pin.tenantId}</dd>
          <dt>集合标识</dt>
          <dd>{pin.collectionId}</dd>
          <dt>内容 SHA-256</dt>
          <dd>{pin.sha256}</dd>
        </dl>
        <pre className="sr-entry-source-body">{source.body}</pre>
      </div>
    </div>
  );
}
