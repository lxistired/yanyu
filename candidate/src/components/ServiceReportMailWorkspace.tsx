import { useLayoutEffect, useRef, useState } from 'react';
import { readerCanonical } from '../../shared/reader-reference';
import {
  serviceMailIntentIdentity,
  serviceMailBlocksEquivalentIntent,
} from '../../shared/service-report-mail';
import type {
  ServiceMailOverview,
  ServiceMailPreview,
  ServiceMailRecipient,
  ServiceMailReportPin,
  ServiceMailSubscription,
} from '../../shared/service-report-mail';
import type { ServiceReportsActor } from '../adapters/service-reports';
import {
  ServiceMailClientError,
  type ServiceMailIntent,
  type ServiceReportMailClient,
  type ServiceReportMailCommands,
} from '../adapters/service-report-mail';
import { ServiceReportMailView } from './ServiceReportMailView';
import type {
  MailCustomerSelection,
  MailRead,
  MailRecipientDraft,
  MailSubscriptionDraft,
} from './service-report-mail-view-types';

export interface ServiceReportMailWorkspaceProps {
  /** Host-owned, long-lived client and journal; never create a second controller during route remount. */
  client: ServiceReportMailClient;
  commands: ServiceReportMailCommands;
  actor: ServiceReportsActor | null;
  status: 'available' | 'unknown' | 'unavailable';
  routeEpoch: number;
  /** Current monthly owner supplies this selection and the exact currently authorized immutable report. */
  customer: MailRead<MailCustomerSelection>;
  report: MailRead<ServiceMailReportPin>;
}
const same = (left: unknown, right: unknown) =>
  readerCanonical(left) === readerCanonical(right);
const unknown = <T,>(message: string): MailRead<T> => ({
  state: 'unknown',
  message,
});
const failure = (error: unknown) =>
  error instanceof ServiceMailClientError
    ? error.message
    : '邮件设置暂时不可用，请重新读取';
function customerRef(selection: MailCustomerSelection) {
  return {
    organizationId: selection.pin.organizationId,
    contactId: selection.pin.contactId,
  };
}
function forCustomer(
  value: ServiceMailOverview,
  selection: MailCustomerSelection,
): ServiceMailOverview {
  const ref = customerRef(selection),
    subscriptions = value.subscriptions.filter((item) =>
      same(item.customer, ref),
    ),
    requests = value.requests.filter((item) =>
      same(item.confirmation.report.customer, ref),
    ),
    subscriptionIds = new Set(subscriptions.map((item) => item.id));
  return {
    ...value,
    recipients: value.recipients.filter((item) => same(item.customer, ref)),
    subscriptions,
    requests,
    occurrences: value.occurrences.filter((item) =>
      subscriptionIds.has(item.subscriptionId),
    ),
  };
}
/** Mirrors the transactional server equivalence rule; bounded UI history is not authoritative. */
function sendHistoryGuard(
  value: ServiceMailOverview | null,
  report: MailRead<ServiceMailReportPin>,
  recipientId: string,
): { blocked: string | null; warning: string | null } {
  if (!value || report.state !== 'ready')
    return { blocked: null, warning: null };
  const recipient = value.recipients.find(
    (row) => row.id === recipientId && !row.disabled,
  );
  if (!recipient) return { blocked: null, warning: null };
  const identity = serviceMailIntentIdentity({
    report: report.value,
    recipientAddress: recipient.address,
  });
  const matches = value.requests.filter(
    (request) => serviceMailIntentIdentity(request.confirmation) === identity,
  );
  const unresolved = matches.find(serviceMailBlocksEquivalentIntent);
  if (unresolved)
    return {
      blocked: `同一月报快照与邮箱已有待确认请求 ${unresolved.id}。请先刷新、核对或取消原请求；未知或在途结果不能视为未发送。`,
      warning: null,
    };
  const accepted = matches.find(
    (request) => request.state === 'provider-accepted',
  );
  const warning = !accepted
    ? null
    : accepted.simulated
      ? '同一快照与邮箱已有模拟接受记录。再次确认会创建另一条模拟发送请求；模拟接受不代表真实发送或送达。'
      : value.provider.mode === 'synthetic'
        ? '同一快照与邮箱此前已被服务商接受。再次确认会创建另一条模拟发送请求；本地模拟不会再次发送真实邮件。接受不等于送达。'
        : '同一快照与邮箱此前已被服务商接受。再次确认会发送另一份副本；服务商接受不等于送达。';
  return { blocked: null, warning };
}

/** A new actor/customer/report/status/navigation epoch withdraws all old presentation synchronously. */
export function ServiceReportMailWorkspace(
  props: ServiceReportMailWorkspaceProps,
) {
  const key = readerCanonical([
    props.actor,
    props.status,
    props.routeEpoch,
    props.customer,
    props.report,
  ]);
  return <ServiceReportMailSession key={key} {...props} />;
}
function ServiceReportMailSession(props: ServiceReportMailWorkspaceProps) {
  const { client, commands } = props;
  const latest = useRef(props);
  latest.current = props;
  const alive = useRef(false),
    generation = useRef(0),
    hadAuthority = useRef(false),
    busyRef = useRef(false),
    requestAbort = useRef<AbortController | null>(null);
  const selection =
    props.customer.state === 'ready' ? props.customer.value : null;
  const initialZone =
    props.report.state === 'ready'
      ? props.report.value.timeZone
      : 'Asia/Shanghai';
  const [overview, setOverview] = useState<MailRead<ServiceMailOverview>>(
    unknown('请选择当前可访问客户，再读取邮件设置'),
  );
  const overviewRef = useRef<ServiceMailOverview | null>(null);
  const [preview, setPreview] = useState<MailRead<ServiceMailPreview>>(
    unknown('先选择邮箱并生成精确预览'),
  );
  const previewRef = useRef<ServiceMailPreview | null>(null),
    previewSerial = useRef(0);
  const [confirmed, setConfirmed] = useState(false),
    confirmedRef = useRef(false);
  const [recipientDraft, setRecipientDraft] =
      useState<MailRecipientDraft | null>(null),
    draftRef = useRef<MailRecipientDraft | null>(null);
  const [selectedRecipientId, setSelectedRecipientId] = useState(''),
    selectedRecipientRef = useRef('');
  const [subscriptionDraft, setSubscriptionDraft] =
    useState<MailSubscriptionDraft>({
      recipientId: '',
      timeZone: initialZone,
      dayOfMonth: 1,
      hour: 9,
      consent: false,
    });
  const subscriptionRef = useRef(subscriptionDraft);
  const [commandView, setCommandView] = useState<
    ReturnType<ServiceReportMailCommands['view']>
  >({ pending: null, error: null, blocked: false });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const authorized = () => {
    const p = latest.current,
      authority = client.authority();
    return (
      alive.current &&
      p.status === 'available' &&
      p.actor !== null &&
      p.customer.state === 'ready' &&
      authority !== null &&
      same(authority.actor, p.actor)
    );
  };
  const fresh = (epoch: number) => authorized() && generation.current === epoch;
  const unlocked = () =>
    authorized() &&
    !busyRef.current &&
    !commands.view().pending &&
    !commands.view().blocked;
  const setBusyState = (value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  };
  function invalidatePreview() {
    previewSerial.current++;
    previewRef.current = null;
    confirmedRef.current = false;
    setConfirmed(false);
    setPreview(unknown('邮箱、月报或通道变化后，需要重新预览并确认'));
  }
  function clearConsent() {
    subscriptionRef.current = { ...subscriptionRef.current, consent: false };
    setSubscriptionDraft(subscriptionRef.current);
  }
  function updateDraft(value: MailRecipientDraft | null) {
    draftRef.current = value;
    setRecipientDraft(value);
  }
  function refresh() {
    const p = latest.current;
    if (
      !alive.current ||
      busyRef.current ||
      p.status !== 'available' ||
      !p.actor ||
      p.customer.state !== 'ready'
    )
      return;
    const epoch = ++generation.current;
    requestAbort.current?.abort();
    const controller = new AbortController();
    requestAbort.current = controller;
    invalidatePreview();
    clearConsent();
    overviewRef.current = null;
    setOverview({
      state: 'loading',
      message: '正在读取当前客户的邮件设置与发送记录',
    });
    setBusyState(true);
    setError(null);
    void client
      .overview(controller.signal)
      .then(
        (value) => {
          if (!fresh(epoch) || latest.current.customer.state !== 'ready')
            return;
          const bounded = forCustomer(value, latest.current.customer.value);
          overviewRef.current = bounded;
          setOverview({ state: 'ready', value: bounded });
          if (
            !bounded.recipients.some(
              (item) =>
                item.id === selectedRecipientRef.current && !item.disabled,
            )
          ) {
            selectedRecipientRef.current = '';
            setSelectedRecipientId('');
          }
          if (
            !bounded.recipients.some(
              (item) =>
                item.id === subscriptionRef.current.recipientId &&
                !item.disabled,
            )
          ) {
            subscriptionRef.current = {
              ...subscriptionRef.current,
              recipientId: '',
              consent: false,
            };
            setSubscriptionDraft(subscriptionRef.current);
          }
          setCommandView(commands.view());
        },
        (caught: unknown) => {
          if (alive.current && epoch === generation.current) {
            overviewRef.current = null;
            setOverview({
              state:
                caught instanceof ServiceMailClientError &&
                caught.code === 'FORBIDDEN'
                  ? 'unavailable'
                  : 'error',
              message: failure(caught),
            });
          }
        },
      )
      .finally(() => {
        if (alive.current && epoch === generation.current) setBusyState(false);
      });
  }
  useLayoutEffect(() => {
    const lifetimeGeneration = generation;
    alive.current = true;
    const sync = () => {
      if (!alive.current) return;
      const authority = client.authority();
      if (authority && same(authority.actor, latest.current.actor)) {
        hadAuthority.current = true;
        setCommandView(commands.view());
      } else {
        // Withdraw every presentation owned by the old authority, including drafts.
        // Do not abort the initial overview that is still establishing authority.
        if (hadAuthority.current) {
          hadAuthority.current = false;
          generation.current++;
          requestAbort.current?.abort();
          setBusyState(false);
        }
        overviewRef.current = null;
        invalidatePreview();
        updateDraft(null);
        selectedRecipientRef.current = '';
        setSelectedRecipientId('');
        subscriptionRef.current = {
          recipientId: '',
          timeZone: initialZone,
          dayOfMonth: 1,
          hour: 9,
          consent: false,
        };
        setSubscriptionDraft(subscriptionRef.current);
        setError(null);
        setNotice(null);
        setOverview(unknown('当前访问范围尚未确认，请重新读取'));
        setCommandView({ pending: null, error: null, blocked: true });
      }
    };
    const unsubscribeCommands = commands.subscribe(sync),
      unsubscribeClient = client.subscribe(sync);
    if (props.status === 'available' && selection && props.actor) refresh();
    else
      setOverview({
        state: props.status === 'unavailable' ? 'unavailable' : 'unknown',
        message:
          props.status === 'unavailable'
            ? '当前身份无权读取月报邮件设置'
            : '请先选择可访问客户与当前身份',
      });
    return () => {
      alive.current = false;
      busyRef.current = false;
      lifetimeGeneration.current++;
      requestAbort.current?.abort();
      unsubscribeCommands();
      unsubscribeClient();
      client.invalidateReads();
    };
    // The keyed session binds these inputs for its lifetime. Host-owned controllers are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, commands]);
  function chooseRecipient(id: string) {
    if (!unlocked()) return;
    invalidatePreview();
    selectedRecipientRef.current = id;
    setSelectedRecipientId(id);
    setNotice(null);
  }
  function preparePreview() {
    if (
      !unlocked() ||
      latest.current.report.state !== 'ready' ||
      !selection ||
      sendHistoryGuard(
        overviewRef.current,
        latest.current.report,
        selectedRecipientRef.current,
      ).blocked
    )
      return;
    const row = overviewRef.current?.recipients.find(
        (item) => item.id === selectedRecipientRef.current && !item.disabled,
      ),
      report = latest.current.report.value,
      p = overviewRef.current?.provider;
    if (
      !row ||
      !p ||
      p.mode === 'unavailable' ||
      !same(report.customer, customerRef(selection))
    )
      return;
    invalidatePreview();
    const serial = previewSerial.current,
      epoch = generation.current;
    const controller = new AbortController();
    requestAbort.current = controller;
    setPreview({
      state: 'loading',
      message: '正在核验精确月报、收件邮箱与邮件通道',
    });
    setBusyState(true);
    setError(null);
    void client
      .preview(
        {
          reportId: report.reportId,
          expectedRevision: report.reportRevision,
          recipientId: row.id,
          recipientRevision: row.revision,
        },
        controller.signal,
      )
      .then((value) => {
        if (!fresh(epoch) || serial !== previewSerial.current) return;
        if (
          !same(value.confirmation.report, report) ||
          value.confirmation.recipientAddress !== row.address ||
          value.confirmation.providerRegistrationRevision !==
            p.registrationRevision ||
          !same(value.provider, p)
        )
          throw new ServiceMailClientError('CONFLICT');
        previewRef.current = value;
        setPreview({ state: 'ready', value });
      })
      .catch((caught: unknown) => {
        if (fresh(epoch) && serial === previewSerial.current) {
          previewRef.current = null;
          setPreview({ state: 'error', message: failure(caught) });
          setError(failure(caught));
        }
      })
      .finally(() => {
        if (alive.current && epoch === generation.current) setBusyState(false);
      });
  }
  function execute(intent: ServiceMailIntent, success: string) {
    if (!unlocked()) return;
    const epoch = generation.current;
    invalidatePreview();
    clearConsent();
    setBusyState(true);
    setError(null);
    setNotice(null);
    void commands
      .submit(intent)
      .then(
        () => {
          if (fresh(epoch)) {
            updateDraft(null);
            setNotice(success);
          }
        },
        (caught: unknown) => {
          if (alive.current && epoch === generation.current)
            setError(failure(caught));
        },
      )
      .finally(() => {
        if (alive.current && epoch === generation.current) {
          setBusyState(false);
          setCommandView(commands.view());
          if (
            authorized() &&
            !commands.view().pending &&
            !commands.view().blocked
          )
            refresh();
        }
      });
  }
  function saveRecipient() {
    const draft = draftRef.current;
    if (!draft || !selection) return;
    execute(
      {
        action: 'saveRecipient',
        input: {
          id: draft.id,
          expectedRevision: draft.expectedRevision,
          customer: customerRef(selection),
          address: draft.address.trim(),
          disabled: false,
        },
      },
      '邮箱地址已保存；没有自动订阅，也没有发送验证邮件',
    );
  }
  function disableRecipient(row: ServiceMailRecipient) {
    const current = overviewRef.current?.recipients.find((item) =>
      same(item, row),
    );
    if (!current) return;
    execute(
      {
        action: 'saveRecipient',
        input: {
          id: row.id,
          expectedRevision: row.revision,
          customer: row.customer,
          address: row.address,
          disabled: true,
        },
      },
      '邮箱已停用；原发送记录仍保留，已交付服务商的邮件不能撤回',
    );
  }
  function enableSubscription() {
    const draft = subscriptionRef.current,
      overview = overviewRef.current,
      row = overview?.recipients.find(
        (item) => item.id === draft.recipientId && !item.disabled,
      );
    if (
      !draft.consent ||
      !selection ||
      !overview ||
      !row ||
      overview.provider.mode === 'unavailable' ||
      !overview.provider.registrationRevision
    )
      return;
    const prior = overview.subscriptions.find(
      (item) => item.recipientId === row.id,
    );
    execute(
      {
        action: 'saveSubscription',
        input: {
          id: prior?.id ?? null,
          expectedRevision: prior?.revision ?? null,
          customer: customerRef(selection),
          recipientId: row.id,
          recipientRevision: row.revision,
          providerRegistrationRevision: overview.provider.registrationRevision,
          timeZone: draft.timeZone,
          dayOfMonth: draft.dayOfMonth,
          hour: draft.hour,
          enabled: true,
          unsubscribed: false,
          consent: 'monthly-previous-completed-month',
        },
      },
      '月度订阅已保存；从下个本地日历月起按计划处理，不补发错过的月份',
    );
  }
  function stopSubscription(
    row: ServiceMailSubscription,
    unsubscribed: boolean,
  ) {
    if (!overviewRef.current?.subscriptions.some((item) => same(item, row)))
      return;
    execute(
      {
        action: 'saveSubscription',
        input: {
          id: row.id,
          expectedRevision: row.revision,
          customer: row.customer,
          recipientId: row.recipientId,
          recipientRevision: row.recipientRevision,
          providerRegistrationRevision: row.providerRegistrationRevision,
          timeZone: row.timeZone,
          dayOfMonth: row.dayOfMonth,
          hour: row.hour,
          enabled: false,
          unsubscribed,
          consent: 'monthly-previous-completed-month',
        },
      },
      unsubscribed
        ? '已退订并撤销后续月度发送授权；已交付服务商的邮件不能撤回'
        : '订阅已暂停；已交付服务商的邮件不能撤回',
    );
  }
  function sendNow() {
    const value = previewRef.current;
    if (
      !value ||
      !confirmedRef.current ||
      latest.current.report.state !== 'ready' ||
      !same(value.confirmation.report, latest.current.report.value) ||
      sendHistoryGuard(
        overviewRef.current,
        latest.current.report,
        selectedRecipientRef.current,
      ).blocked
    )
      return;
    const row = overviewRef.current?.recipients.find(
      (item) => item.id === value.confirmation.recipientId && !item.disabled,
    );
    if (
      !row ||
      row.id !== selectedRecipientRef.current ||
      row.revision !== value.confirmation.recipientRevision ||
      row.address !== value.confirmation.recipientAddress ||
      overviewRef.current?.provider.registrationRevision !==
        value.confirmation.providerRegistrationRevision
    ) {
      invalidatePreview();
      return;
    }
    execute(
      {
        action: 'sendNow',
        input: {
          confirmation: value.confirmation,
          consent: 'send-exact-report-to-exact-recipient',
        },
      },
      '精确发送请求已保存，后续由服务器处理；请刷新记录核对，不代表已送达',
    );
  }
  function resolvePending(cancel: boolean) {
    if (
      !authorized() ||
      busyRef.current ||
      !commands.view().pending ||
      commands.view().pending?.sending
    )
      return;
    const epoch = generation.current;
    setBusyState(true);
    setError(null);
    invalidatePreview();
    clearConsent();
    void (cancel ? commands.cancel() : commands.check())
      .then(
        (result) => {
          if (!fresh(epoch)) return;
          // An absent result keeps the original intent unresolved. A verified
          // terminal result closes its old edit before fresh rows are read.
          if (!('outcome' in result) || result.outcome !== 'absent')
            updateDraft(null);
          setNotice(
            'outcome' in result && result.outcome === 'absent'
              ? '服务端暂未找到原操作；这不证明不会提交。恢复记录继续保留，可稍后检查或请求取消'
              : 'outcome' in result && result.outcome === 'cancelled'
                ? '服务端已确认取消尚未提交的原操作，可以重新预览后创建新操作'
                : '服务端已确认原操作提交成功，正在读取最新记录',
          );
        },
        (caught: unknown) => {
          if (alive.current && epoch === generation.current)
            setError(failure(caught));
        },
      )
      .finally(() => {
        if (alive.current && epoch === generation.current) {
          setBusyState(false);
          setCommandView(commands.view());
          if (authorized()) refresh();
        }
      });
  }
  function reconcile(requestId: string) {
    if (
      !unlocked() ||
      !overviewRef.current?.requests.some(
        (item) =>
          item.id === requestId &&
          ['dispatching', 'outcome-unknown', 'provider-accepted'].includes(
            item.state,
          ),
      )
    )
      return;
    const epoch = generation.current;
    setBusyState(true);
    setError(null);
    invalidatePreview();
    void client
      .reconcile(requestId)
      .then(
        () => {
          if (fresh(epoch))
            setNotice('已核对同一发送请求的服务商结果，没有创建新发送');
        },
        (caught: unknown) => {
          if (alive.current && epoch === generation.current)
            setError(failure(caught));
        },
      )
      .finally(() => {
        if (alive.current && epoch === generation.current) {
          setBusyState(false);
          if (authorized()) refresh();
        }
      });
  }
  const displayCustomer =
    props.status === 'available'
      ? props.customer
      : unknown<MailCustomerSelection>('当前客户访问不可用');
  const displayReport =
    props.status === 'available' &&
    selection &&
    props.report.state === 'ready' &&
    same(props.report.value.customer, customerRef(selection))
      ? props.report
      : unknown<ServiceMailReportPin>('请选择当前客户下可访问的精确月报');
  const sendGuard = sendHistoryGuard(
    overview.state === 'ready' ? overview.value : null,
    displayReport,
    selectedRecipientId,
  );
  return (
    <ServiceReportMailView
      customer={displayCustomer}
      report={displayReport}
      overview={overview}
      recipientDraft={recipientDraft}
      selectedRecipientId={selectedRecipientId}
      subscriptionDraft={subscriptionDraft}
      preview={preview}
      confirmed={confirmed}
      sendBlockReason={sendGuard.blocked}
      sendWarning={sendGuard.warning}
      pending={commandView.pending}
      busy={busy}
      journalBlocked={commandView.blocked}
      error={error ?? commandView.error}
      notice={notice}
      onRefresh={refresh}
      onAddRecipient={() => {
        if (unlocked()) {
          invalidatePreview();
          updateDraft({ id: null, expectedRevision: null, address: '' });
        }
      }}
      onEditRecipient={(row) => {
        if (
          unlocked() &&
          overviewRef.current?.recipients.some((item) => same(item, row))
        ) {
          invalidatePreview();
          clearConsent();
          updateDraft({
            id: row.id,
            expectedRevision: row.revision,
            address: row.address,
          });
        }
      }}
      onRecipientDraftChange={(draft) => {
        if (
          unlocked() &&
          draftRef.current &&
          draft.id === draftRef.current.id &&
          draft.expectedRevision === draftRef.current.expectedRevision
        ) {
          invalidatePreview();
          updateDraft(draft);
        }
      }}
      onSaveRecipient={saveRecipient}
      onCancelRecipientDraft={() => updateDraft(null)}
      onDisableRecipient={disableRecipient}
      onSelectRecipient={chooseRecipient}
      onSubscriptionDraftChange={(draft) => {
        if (!unlocked()) return;
        const previous = subscriptionRef.current;
        const onlyConsent = same(
          { ...draft, consent: false },
          { ...previous, consent: false },
        );
        subscriptionRef.current = {
          ...draft,
          consent: onlyConsent ? draft.consent : false,
        };
        setSubscriptionDraft(subscriptionRef.current);
      }}
      onEnableSubscription={enableSubscription}
      onPauseSubscription={(row) => stopSubscription(row, false)}
      onUnsubscribe={(row) => stopSubscription(row, true)}
      onPreview={preparePreview}
      onConfirmChange={(value) => {
        if (unlocked() && previewRef.current) {
          confirmedRef.current = value;
          setConfirmed(value);
        }
      }}
      onSend={sendNow}
      onCheckPending={() => resolvePending(false)}
      onCancelPending={() => resolvePending(true)}
      onCancelRequest={(requestId, expectedRevision) => {
        if (
          overviewRef.current?.requests.some(
            (item) =>
              item.id === requestId &&
              item.revision === expectedRevision &&
              !item.cancellationRequested &&
              ['queued', 'blocked', 'dispatching', 'outcome-unknown'].includes(
                item.state,
              ),
          )
        )
          execute(
            { action: 'cancelRequest', input: { requestId, expectedRevision } },
            '取消请求已记录；请核对结果，不能承诺撤回已在途的邮件',
          );
      }}
      onReconcileRequest={reconcile}
    />
  );
}
