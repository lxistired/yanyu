import { readerCanonical } from '../../shared/reader-reference';
import {
  SERVICE_MAIL_LIMITS as L,
  type PreviewServiceMail,
  type ServiceMailCommand,
  type ServiceMailCommandResolution,
  type ServiceMailConfirmation,
  type ServiceMailOccurrence,
  type ServiceMailOverview,
  type ServiceMailPreview,
  type ServiceMailProvider,
  type ServiceMailRecipient,
  type ServiceMailReportPin,
  type ServiceMailRequest,
  type ServiceMailSubscription,
} from '../../shared/service-report-mail';
import type { ServiceCustomer } from '../../shared/service-reports';
import {
  parseServiceReportsJson,
  type ServiceReportsActor,
  type ServiceReportsAuthority,
} from './service-reports';

export type ServiceMailErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_RESPONSE'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'UNAVAILABLE'
  | 'CANCELLED'
  | 'STORAGE'
  | 'PENDING';
const messages: Record<ServiceMailErrorCode, string> = {
  INVALID_REQUEST: '邮件操作内容无效，未发送',
  INVALID_RESPONSE: '邮件响应无法验证，已撤回显示；未确认的原操作仍保留',
  FORBIDDEN: '当前身份或访问范围已改变，请重新读取邮件设置',
  CONFLICT: '邮箱、月报或通道版本已改变，请重新读取并确认',
  NOT_FOUND: '这条邮件记录当前不可用',
  UNAVAILABLE: '邮件操作结果尚未确认，请检查原操作，不要重复发送',
  CANCELLED: '本次读取已撤回；未确认的原操作仍保留',
  STORAGE: '恢复记录无法可靠保存或读取；已阻止新操作，原记录未删除',
  PENDING: '请先检查或取消尚未提交的原操作，结果未确认时不能创建新操作',
};
export class ServiceMailClientError extends Error {
  constructor(public readonly code: ServiceMailErrorCode) {
    super(messages[code]);
    this.name = 'ServiceMailClientError';
  }
}
function fail(code: ServiceMailErrorCode = 'INVALID_REQUEST'): never {
  throw new ServiceMailClientError(code);
}
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const same = (a: unknown, b: unknown) =>
  readerCanonical(a) === readerCanonical(b);
function object(
  value: unknown,
  required: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(value);
  if (
    keys.length !== required.length ||
    keys.some((key) => typeof key !== 'string' || !required.includes(key)) ||
    required.some((key) => !Object.hasOwn(descriptors, key))
  )
    return fail();
  for (const descriptor of Object.values(descriptors))
    if (
      !('value' in descriptor) ||
      !descriptor.enumerable ||
      descriptor.value === undefined
    )
      fail();
  return value as Record<string, unknown>;
}
function string(value: unknown, maximum = 256, multiline = false): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    bytes(value) > maximum * 4 ||
    /[\u202a-\u202e\u2066-\u2069]/u.test(value) ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return (
        code === 127 ||
        (code < 32 && (!multiline || ![9, 10, 13].includes(code)))
      );
    }) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    return fail();
  return value;
}
function id(value: unknown): string {
  const v = string(value, 100);
  if (!/^[A-Za-z0-9_-]+$/u.test(v)) return fail();
  return v;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
    return fail();
  return value;
}
function integer(
  value: unknown,
  min = 1,
  max = Number.MAX_SAFE_INTEGER - 1,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    return fail();
  return value as number;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') return fail();
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) return fail();
  return value as T;
}
function literal<T extends string | number | boolean>(
  value: unknown,
  expected: T,
): T {
  if (value !== expected) return fail();
  return expected;
}
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}
function time(value: unknown): string {
  const v = string(value, 24);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString() !== v
  )
    return fail();
  return v;
}
function month(value: unknown): string {
  const v = string(value, 7);
  if (
    !/^\d{4}-(0[1-9]|1[0-2])$/u.test(v) ||
    Number(v.slice(0, 4)) < 1970 ||
    Number(v.slice(0, 4)) > 9998
  )
    return fail();
  return v;
}
function zone(value: unknown): string {
  const v = string(value, 100);
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
  } catch {
    return fail();
  }
  return v;
}
function address(value: unknown): string {
  const v = string(value, 254);
  if (
    !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u.test(
      v,
    ) ||
    v.split('@')[0].length > 64
  )
    return fail();
  return v;
}
function customer(value: unknown): ServiceCustomer {
  const v = object(value, ['organizationId', 'contactId']);
  return {
    organizationId: id(v.organizationId),
    contactId: nullable(v.contactId, id),
  };
}
function list<T>(
  value: unknown,
  maximum: number,
  parse: (value: unknown) => T,
): T[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  for (let index = 0; index < value.length; index++) {
    const d = Object.getOwnPropertyDescriptor(value, String(index));
    if (!d || !('value' in d) || !d.enumerable) fail();
  }
  return value.map(parse);
}
function unique<T extends { id: string }>(value: T[]): T[] {
  if (new Set(value.map((item) => item.id)).size !== value.length) fail();
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function requireServiceMailReportPin(
  value: unknown,
): ServiceMailReportPin {
  const v = object(value, [
    'reportId',
    'reportRevision',
    'snapshotSha256',
    'customer',
    'month',
    'timeZone',
  ]);
  return {
    reportId: id(v.reportId),
    reportRevision: integer(v.reportRevision),
    snapshotSha256: digest(v.snapshotSha256),
    customer: customer(v.customer),
    month: month(v.month),
    timeZone: zone(v.timeZone),
  };
}
function confirmation(value: unknown): ServiceMailConfirmation {
  const v = object(value, [
    'report',
    'recipientId',
    'recipientRevision',
    'recipientAddress',
    'providerRegistrationRevision',
    'renderedContentSha256',
    'currentActivitiesCensusSha256',
  ]);
  return {
    report: requireServiceMailReportPin(v.report),
    recipientId: id(v.recipientId),
    recipientRevision: integer(v.recipientRevision),
    recipientAddress: address(v.recipientAddress),
    providerRegistrationRevision: string(v.providerRegistrationRevision),
    renderedContentSha256: digest(v.renderedContentSha256),
    currentActivitiesCensusSha256: digest(v.currentActivitiesCensusSha256),
  };
}
function provider(value: unknown): ServiceMailProvider {
  const v = object(value, ['mode', 'registrationRevision', 'sender']);
  const result: ServiceMailProvider = {
    mode: choice(v.mode, ['unavailable', 'synthetic', 'configured']),
    registrationRevision: nullable(v.registrationRevision, string),
    sender: nullable(v.sender, address),
  };
  if (
    result.mode !== 'unavailable' &&
    (!result.registrationRevision || !result.sender)
  )
    return fail();
  return result;
}
function recipient(value: unknown): ServiceMailRecipient {
  const v = object(value, [
    'id',
    'revision',
    'customer',
    'address',
    'disabled',
    'updatedAt',
    'mailboxVerified',
  ]);
  return {
    id: id(v.id),
    revision: integer(v.revision),
    customer: customer(v.customer),
    address: address(v.address),
    disabled: bool(v.disabled),
    updatedAt: time(v.updatedAt),
    mailboxVerified: literal(v.mailboxVerified, false),
  };
}
function subscription(value: unknown): ServiceMailSubscription {
  const v = object(value, [
    'id',
    'revision',
    'customer',
    'recipientId',
    'recipientRevision',
    'providerRegistrationRevision',
    'timeZone',
    'dayOfMonth',
    'hour',
    'enabled',
    'unsubscribed',
    'nextDueMonth',
    'updatedAt',
    'consent',
    'missedPolicy',
    'zeroEntryPolicy',
    'changedActivityPolicy',
  ]);
  const enabled = bool(v.enabled),
    unsubscribed = bool(v.unsubscribed);
  if (enabled && unsubscribed) fail();
  return {
    id: id(v.id),
    revision: integer(v.revision),
    customer: customer(v.customer),
    recipientId: id(v.recipientId),
    recipientRevision: integer(v.recipientRevision),
    providerRegistrationRevision: string(v.providerRegistrationRevision),
    timeZone: zone(v.timeZone),
    dayOfMonth: integer(v.dayOfMonth, 1, 28),
    hour: integer(v.hour, 0, 23),
    enabled,
    unsubscribed,
    nextDueMonth: month(v.nextDueMonth),
    updatedAt: time(v.updatedAt),
    consent: literal(v.consent, 'monthly-previous-completed-month'),
    missedPolicy: literal(v.missedPolicy, 'pause-without-catch-up'),
    zeroEntryPolicy: literal(v.zeroEntryPolicy, 'send-empty-report'),
    changedActivityPolicy: literal(
      v.changedActivityPolicy,
      'fresh-snapshot-at-occurrence',
    ),
  };
}
const blockReasons = [
  'unconfigured',
  'authority-unavailable',
  'consent-changed',
  'recipient-changed',
  'report-changed',
  'source-unavailable',
  'missed-occurrence',
  'provider-changed',
] as const;
function requestRow(value: unknown): ServiceMailRequest {
  const v = object(value, [
    'id',
    'revision',
    'createdAt',
    'updatedAt',
    'confirmation',
    'subscription',
    'state',
    'blockedReason',
    'providerRequestId',
    'acceptedAt',
    'simulated',
    'delivery',
    'cancellationRequested',
    'attemptCount',
    'deliveryReceipt',
  ]);
  const sub =
    v.subscription === null
      ? null
      : object(v.subscription, ['id', 'revision', 'dueMonth']);
  const receipt =
    v.deliveryReceipt === null
      ? null
      : object(v.deliveryReceipt, [
          'providerReceiptId',
          'providerRequestId',
          'registrationRevision',
          'envelopeSha256',
          'deliveredAt',
        ]);
  const result: ServiceMailRequest = {
    id: id(v.id),
    revision: integer(v.revision),
    createdAt: time(v.createdAt),
    updatedAt: time(v.updatedAt),
    confirmation: confirmation(v.confirmation),
    subscription: sub
      ? {
          id: id(sub.id),
          revision: integer(sub.revision),
          dueMonth: month(sub.dueMonth),
        }
      : null,
    state: choice(v.state, [
      'queued',
      'blocked',
      'dispatching',
      'provider-accepted',
      'known-rejected',
      'outcome-unknown',
      'cancelled-before-dispatch',
    ]),
    blockedReason: nullable(v.blockedReason, (reason) =>
      choice(reason, blockReasons),
    ),
    providerRequestId: nullable(v.providerRequestId, string),
    acceptedAt: nullable(v.acceptedAt, time),
    simulated: bool(v.simulated),
    delivery: choice(v.delivery, ['unknown', 'confirmed-delivered']),
    cancellationRequested: bool(v.cancellationRequested),
    attemptCount: integer(v.attemptCount, 0),
    deliveryReceipt: receipt
      ? {
          providerReceiptId: string(receipt.providerReceiptId),
          providerRequestId: string(receipt.providerRequestId),
          registrationRevision: string(receipt.registrationRevision),
          envelopeSha256: digest(receipt.envelopeSha256),
          deliveredAt: time(receipt.deliveredAt),
        }
      : null,
  };
  if (
    (result.state === 'blocked') !== (result.blockedReason !== null) ||
    (result.state === 'provider-accepted' &&
      (!result.providerRequestId || !result.acceptedAt)) ||
    (result.simulated &&
      (result.delivery !== 'unknown' || result.deliveryReceipt !== null))
  )
    fail();
  if (
    (result.delivery === 'confirmed-delivered') !==
      (result.deliveryReceipt !== null) ||
    (result.deliveryReceipt &&
      (result.state !== 'provider-accepted' ||
        result.deliveryReceipt.providerRequestId !== result.providerRequestId ||
        result.deliveryReceipt.registrationRevision !==
          result.confirmation.providerRegistrationRevision))
  )
    fail();
  return result;
}
function occurrence(value: unknown): ServiceMailOccurrence {
  const v = object(value, [
    'id',
    'subscriptionId',
    'subscriptionRevision',
    'dueMonth',
    'reportMonth',
    'state',
    'requestId',
    'blockedReason',
  ]);
  return {
    id: id(v.id),
    subscriptionId: id(v.subscriptionId),
    subscriptionRevision: integer(v.subscriptionRevision),
    dueMonth: month(v.dueMonth),
    reportMonth: month(v.reportMonth),
    state: choice(v.state, ['reserved', 'queued', 'blocked']),
    requestId: nullable(v.requestId, id),
    blockedReason: nullable(v.blockedReason, (reason) =>
      choice(reason, blockReasons),
    ),
  };
}
function overview(value: unknown): ServiceMailOverview {
  const v = object(value, [
    'scope',
    'provider',
    'recipients',
    'subscriptions',
    'requests',
    'occurrences',
    'truncated',
  ]);
  return {
    scope: digest(v.scope),
    provider: provider(v.provider),
    recipients: unique(list(v.recipients, L.recipients, recipient)),
    subscriptions: unique(list(v.subscriptions, L.subscriptions, subscription)),
    requests: unique(list(v.requests, L.pageRows, requestRow)),
    occurrences: unique(list(v.occurrences, L.pageRows, occurrence)),
    truncated: bool(v.truncated),
  };
}
function preview(
  value: unknown,
  query: PreviewServiceMail,
): ServiceMailPreview {
  const v = object(value, [
    'scope',
    'confirmation',
    'provider',
    'subject',
    'text',
    'html',
    'envelopeBytes',
    'sharingPurpose',
    'delivery',
  ]);
  const c = confirmation(v.confirmation),
    p = provider(v.provider);
  if (
    c.report.reportId !== query.reportId ||
    c.report.reportRevision !== query.expectedRevision ||
    c.recipientId !== query.recipientId ||
    c.recipientRevision !== query.recipientRevision ||
    p.mode === 'unavailable' ||
    p.registrationRevision !== c.providerRegistrationRevision
  )
    fail();
  return {
    scope: digest(v.scope),
    confirmation: c,
    provider: p,
    subject: string(v.subject, 1000),
    text: string(v.text, L.envelopeBytes, true),
    html: string(v.html, L.envelopeBytes, true),
    envelopeBytes: integer(v.envelopeBytes, 1, L.envelopeBytes),
    sharingPurpose: literal(v.sharingPurpose, 'monthly-service-report'),
    delivery: literal(v.delivery, 'unknown'),
  };
}
const commandFields = {
  saveRecipient: ['id', 'expectedRevision', 'customer', 'address', 'disabled'],
  saveSubscription: [
    'id',
    'expectedRevision',
    'customer',
    'recipientId',
    'recipientRevision',
    'providerRegistrationRevision',
    'timeZone',
    'dayOfMonth',
    'hour',
    'enabled',
    'unsubscribed',
    'consent',
  ],
  sendNow: ['confirmation', 'consent'],
  cancelRequest: ['requestId', 'expectedRevision'],
} as const;
export function requireServiceMailCommand(value: unknown): ServiceMailCommand {
  const v = object(value, ['action', 'input']),
    action = choice(v.action, [
      'saveRecipient',
      'saveSubscription',
      'sendNow',
      'cancelRequest',
    ]);
  const q = object(v.input, [
      'scope',
      'idempotencyKey',
      ...commandFields[action],
    ]),
    base = { scope: digest(q.scope), idempotencyKey: id(q.idempotencyKey) };
  let result: ServiceMailCommand;
  if (action === 'saveRecipient' || action === 'saveSubscription') {
    const ref = {
      id: nullable(q.id, id),
      expectedRevision: nullable(q.expectedRevision, integer),
      customer: customer(q.customer),
    };
    if ((ref.id === null) !== (ref.expectedRevision === null)) fail();
    if (action === 'saveRecipient')
      result = {
        action,
        input: {
          ...base,
          ...ref,
          address: address(q.address),
          disabled: bool(q.disabled),
        },
      };
    else {
      const enabled = bool(q.enabled),
        unsubscribed = bool(q.unsubscribed);
      if (enabled && unsubscribed) fail();
      result = {
        action,
        input: {
          ...base,
          ...ref,
          recipientId: id(q.recipientId),
          recipientRevision: integer(q.recipientRevision),
          providerRegistrationRevision: string(q.providerRegistrationRevision),
          timeZone: zone(q.timeZone),
          dayOfMonth: integer(q.dayOfMonth, 1, 28),
          hour: integer(q.hour, 0, 23),
          enabled,
          unsubscribed,
          consent: literal(q.consent, 'monthly-previous-completed-month'),
        },
      };
    }
  } else if (action === 'sendNow')
    result = {
      action,
      input: {
        ...base,
        confirmation: confirmation(q.confirmation),
        consent: literal(q.consent, 'send-exact-report-to-exact-recipient'),
      },
    };
  else
    result = {
      action,
      input: {
        ...base,
        requestId: id(q.requestId),
        expectedRevision: integer(q.expectedRevision),
      },
    };
  if (bytes(JSON.stringify({ command: result })) > L.requestBytes) fail();
  return freeze(result);
}
async function hash(value: unknown): Promise<string> {
  const result = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(readerCanonical(value)),
  );
  return Array.from(new Uint8Array(result), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function serviceMailCommandFingerprint(
  value: unknown,
): Promise<string> {
  return hash(requireServiceMailCommand(value));
}

export type ServiceMailIntent = {
  [K in ServiceMailCommand['action']]: {
    action: K;
    input: Omit<
      Extract<ServiceMailCommand, { action: K }>['input'],
      'scope' | 'idempotencyKey'
    >;
  };
}[ServiceMailCommand['action']];
export type ServiceMailMutationResult =
  ServiceMailRecipient | ServiceMailSubscription | ServiceMailRequest;
type Route =
  | 'overview'
  | 'preview'
  | 'recoverCommand'
  | 'cancelCommand'
  | 'reconcile'
  | 'runNow'
  | ServiceMailCommand['action'];
function input(route: Route, value: unknown): unknown {
  if (route === 'overview') return object(value, []);
  if (route === 'preview') {
    const v = object(value, [
      'reportId',
      'expectedRevision',
      'recipientId',
      'recipientRevision',
    ]);
    return {
      reportId: id(v.reportId),
      expectedRevision: integer(v.expectedRevision),
      recipientId: id(v.recipientId),
      recipientRevision: integer(v.recipientRevision),
    };
  }
  if (route === 'recoverCommand' || route === 'cancelCommand')
    return {
      command: requireServiceMailCommand(object(value, ['command']).command),
    };
  if (route === 'reconcile' || route === 'runNow')
    return { requestId: id(object(value, ['requestId']).requestId) };
  return requireServiceMailCommand({ action: route, input: value }).input;
}
async function output(
  route: Route,
  value: unknown,
  query: unknown,
): Promise<object> {
  const q = query as Record<string, unknown>;
  if (route === 'overview') return overview(value);
  if (route === 'preview') {
    const result = preview(value, query as PreviewServiceMail),
      content = {
        subject: result.subject,
        text: result.text,
        html: result.html,
      };
    if (
      (await hash(content)) !== result.confirmation.renderedContentSha256 ||
      bytes(
        readerCanonical({
          schema: 1,
          sender: result.provider.sender,
          recipient: result.confirmation.recipientAddress,
          ...content,
          confirmation: result.confirmation,
          key: `mreq_${'0'.repeat(64)}`,
          envelopeSha256: '0'.repeat(64),
        }),
      ) !== result.envelopeBytes
    )
      fail();
    return result;
  }
  if (route === 'recoverCommand' || route === 'cancelCommand') {
    const raw = object(value, [
      'scope',
      'idempotencyKey',
      'fingerprint',
      'outcome',
      ...(value &&
      typeof value === 'object' &&
      Object.getOwnPropertyDescriptor(value, 'outcome')?.value === 'committed'
        ? ['target', 'id']
        : []),
    ]);
    const command = q.command as ServiceMailCommand,
      result = {
        scope: digest(raw.scope),
        idempotencyKey: id(raw.idempotencyKey),
        fingerprint: digest(raw.fingerprint),
      },
      outcome = choice(raw.outcome, ['absent', 'cancelled', 'committed']);
    if (
      result.scope !== command.input.scope ||
      result.idempotencyKey !== command.input.idempotencyKey ||
      result.fingerprint !== (await serviceMailCommandFingerprint(command)) ||
      (route === 'cancelCommand' && outcome === 'absent')
    )
      fail();
    if (outcome !== 'committed') return { ...result, outcome };
    const target =
      command.action === 'saveRecipient'
        ? 'recipient'
        : command.action === 'saveSubscription'
          ? 'subscription'
          : 'request';
    literal(raw.target, target);
    const targetId = id(raw.id);
    if (
      ('id' in command.input &&
        command.input.id !== null &&
        command.input.id !== targetId) ||
      (command.action === 'cancelRequest' &&
        command.input.requestId !== targetId)
    )
      fail();
    return { ...result, outcome, target, id: targetId };
  }
  if (route === 'saveRecipient') {
    const row = recipient(value);
    if (
      (q.id !== null &&
        (row.id !== q.id || row.revision <= Number(q.expectedRevision))) ||
      !same(row.customer, q.customer) ||
      row.address !== q.address ||
      row.disabled !== q.disabled
    )
      fail();
    return row;
  }
  if (route === 'saveSubscription') {
    const row = subscription(value);
    if (
      (q.id !== null &&
        (row.id !== q.id || row.revision <= Number(q.expectedRevision))) ||
      !same(row.customer, q.customer) ||
      commandFields.saveSubscription
        .filter((key) => key !== 'id' && key !== 'expectedRevision')
        .some((key) => !same(row[key as keyof ServiceMailSubscription], q[key]))
    )
      fail();
    return row;
  }
  const row = requestRow(value);
  if (
    route === 'sendNow'
      ? !same(row.confirmation, q.confirmation)
      : row.id !== q.requestId
  )
    fail();
  return row;
}
function discard(response: Response) {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    /* no unsafe body consumption on HTTP errors */
  }
}
function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (!settled) {
        settled = true;
        signal.removeEventListener('abort', abort);
        reject(new ServiceMailClientError('CANCELLED'));
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        if (settled) {
          late?.(value);
          return;
        }
        settled = true;
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener('abort', abort);
          reject(error);
        }
      },
    );
    if (signal.aborted) abort();
  });
}
const byteTag = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
)?.get;
async function readJson(
  response: Response,
  signal: AbortSignal,
  current: () => void,
): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (
    (length !== null &&
      (!/^\d+$/u.test(length) || Number(length) > L.responseBytes)) ||
    !response.body
  ) {
    discard(response);
    return fail('INVALID_RESPONSE');
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0,
    reads = 0,
    complete = false;
  try {
    for (;;) {
      current();
      if (++reads > 65536) fail('INVALID_RESPONSE');
      const chunk = await abortable(reader.read(), signal);
      current();
      if (chunk.done) break;
      if (
        !ArrayBuffer.isView(chunk.value) ||
        byteTag?.call(chunk.value) !== 'Uint8Array' ||
        (total += chunk.value.byteLength) > L.responseBytes
      )
        fail('INVALID_RESPONSE');
      chunks.push(new Uint8Array(chunk.value));
    }
    if (length !== null && Number(length) !== total) fail('INVALID_RESPONSE');
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    complete = true;
    return parseServiceReportsJson(
      new TextDecoder('utf-8', { fatal: true }).decode(body),
      L.responseBytes,
    );
  } finally {
    if (!complete) {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        /* best effort */
      }
    }
    try {
      reader.releaseLock();
    } catch {
      /* aborted read may retain the lock */
    }
  }
}
const verifiedResults = new WeakMap<
  object,
  { command: ServiceMailCommand; authority: ServiceReportsAuthority }
>();
export function createServiceReportMailClient(options: {
  fetch: typeof globalThis.fetch;
  getActor: () => ServiceReportsActor | null;
  getScope: () => string | null;
}) {
  const controllers = new Set<AbortController>(),
    listeners = new Set<() => void>();
  let selectedActor: ServiceReportsActor | null = null,
    scope: string | null = null,
    selectedScope: string | null = null,
    generation = 0;
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const invalidate = (clear = false) => {
    generation++;
    if (clear) scope = null;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    emit();
  };
  const synchronize = () => {
    let next: ServiceReportsActor | null = null,
      nextScope: string | null = null;
    try {
      const raw = options.getActor();
      if (raw !== null) {
        const v = object(raw, ['binding', 'epoch']);
        next = { binding: string(v.binding), epoch: integer(v.epoch, 0) };
      }
      const rawScope = options.getScope();
      nextScope = rawScope === null ? null : digest(rawScope);
    } catch {
      next = null;
      nextScope = null;
    }
    if (!same(next, selectedActor) || nextScope !== selectedScope) {
      selectedActor = next;
      selectedScope = nextScope;
      invalidate(true);
    }
    return next;
  };
  const authority = (): ServiceReportsAuthority | null => {
    const actor = synchronize();
    return actor && scope ? freeze({ actor, scope }) : null;
  };
  async function send(
    route: Route,
    raw: unknown,
    external?: AbortSignal,
  ): Promise<object> {
    const query = input(route, raw),
      body = JSON.stringify(query);
    if (bytes(body) > L.requestBytes) fail();
    const actor = synchronize();
    if (
      !actor ||
      selectedScope === null ||
      (route !== 'overview' && scope === null)
    )
      fail('FORBIDDEN');
    const expectedScope = scope,
      epoch = generation,
      controller = new AbortController(),
      expires = Date.now() + L.operationMilliseconds;
    const command = [
      'saveRecipient',
      'saveSubscription',
      'sendNow',
      'cancelRequest',
    ].includes(route)
      ? requireServiceMailCommand({ action: route, input: query })
      : route === 'recoverCommand' || route === 'cancelCommand'
        ? (query as { command: ServiceMailCommand }).command
        : null;
    if (command && command.input.scope !== expectedScope) fail('FORBIDDEN');
    let timedOut = false;
    const abort = () => controller.abort();
    external?.addEventListener('abort', abort, { once: true });
    if (external?.aborted) abort();
    controllers.add(controller);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, L.operationMilliseconds);
    const current = () => {
      if (
        !same(synchronize(), actor) ||
        (route !== 'overview' && scope !== expectedScope)
      )
        fail('FORBIDDEN');
      if (Date.now() >= expires) {
        timedOut = true;
        controller.abort();
      }
      if (generation !== epoch || controller.signal.aborted)
        fail(timedOut ? 'UNAVAILABLE' : 'CANCELLED');
    };
    try {
      current();
      const response = await abortable(
        Promise.resolve().then(() => {
          current();
          return options.fetch(`/api/service-report-mail/${route}`, {
            method: 'POST',
            credentials: 'same-origin',
            redirect: 'error',
            cache: 'no-store',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body,
            signal: controller.signal,
          });
        }),
        controller.signal,
        discard,
      );
      try {
        current();
      } catch (error) {
        discard(response);
        throw error;
      }
      if (response.redirected || response.status !== 200) {
        discard(response);
        if ([401, 403].includes(response.status)) {
          invalidate(true);
          fail('FORBIDDEN');
        }
        if (response.status === 409) fail('CONFLICT');
        if (response.status === 404) fail('NOT_FOUND');
        if (response.status === 400) fail('INVALID_REQUEST');
        fail('UNAVAILABLE');
      }
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/iu.test(
          response.headers.get('content-type') ?? '',
        )
      ) {
        discard(response);
        fail('INVALID_RESPONSE');
      }
      let result: object, resultScope: string;
      try {
        const wire = object(
          await readJson(response, controller.signal, current),
          ['scope', 'result'],
        );
        resultScope = digest(wire.scope);
        result = await abortable(
          output(route, wire.result, query),
          controller.signal,
        );
        if ('scope' in result && result.scope !== resultScope) fail();
      } catch (error) {
        if (
          error instanceof ServiceMailClientError &&
          ['CANCELLED', 'FORBIDDEN', 'UNAVAILABLE'].includes(error.code)
        )
          throw error;
        return fail('INVALID_RESPONSE');
      }
      current();
      if (
        (expectedScope !== null && resultScope !== expectedScope) ||
        resultScope !== selectedScope
      ) {
        invalidate(true);
        fail('FORBIDDEN');
      }
      if (route === 'overview') {
        scope = resultScope;
        emit();
      }
      if (command && (!('outcome' in result) || result.outcome !== 'absent'))
        verifiedResults.set(result, {
          command,
          authority: { actor: actor!, scope: resultScope },
        });
      return freeze(result);
    } catch (error) {
      if (!same(synchronize(), actor)) return fail('FORBIDDEN');
      if (error instanceof ServiceMailClientError && error.code === 'FORBIDDEN')
        throw error;
      if (timedOut) return fail('UNAVAILABLE');
      if (controller.signal.aborted || generation !== epoch)
        return fail('CANCELLED');
      if (error instanceof ServiceMailClientError) throw error;
      return fail('UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', abort);
      controllers.delete(controller);
    }
  }
  return Object.freeze({
    authority,
    invalidateReads: () => invalidate(),
    withdraw: () => invalidate(true),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    overview: (signal?: AbortSignal) =>
      send('overview', {}, signal) as Promise<ServiceMailOverview>,
    preview: (value: PreviewServiceMail, signal?: AbortSignal) =>
      send('preview', value, signal) as Promise<ServiceMailPreview>,
    mutate: (value: ServiceMailCommand, signal?: AbortSignal) => {
      const command = requireServiceMailCommand(value);
      return send(
        command.action,
        command.input,
        signal,
      ) as Promise<ServiceMailMutationResult>;
    },
    recoverCommand: (command: ServiceMailCommand, signal?: AbortSignal) =>
      send(
        'recoverCommand',
        { command },
        signal,
      ) as Promise<ServiceMailCommandResolution>,
    cancelCommand: (command: ServiceMailCommand, signal?: AbortSignal) =>
      send(
        'cancelCommand',
        { command },
        signal,
      ) as Promise<ServiceMailCommandResolution>,
    reconcile: (requestId: string, signal?: AbortSignal) =>
      send('reconcile', { requestId }, signal) as Promise<ServiceMailRequest>,
  });
}
export type ServiceReportMailClient = ReturnType<
  typeof createServiceReportMailClient
>;

export const SERVICE_MAIL_JOURNAL_PREFIX = 'research-service:pending-mail:v1:';
const JOURNAL = Object.freeze({
  slots: 32,
  scanKeys: 4096,
  bytes: L.requestBytes + 4096,
  totalBytes: 1024 * 1024,
});
export type ServiceMailPendingRecord = Readonly<{
  schema: 1;
  actorBinding: string;
  scope: string;
  command: ServiceMailCommand;
}>;
function storageOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ServiceMailClientError) throw error;
    return fail('STORAGE');
  }
}
function journalKey(scope: string, token: string) {
  return `${SERVICE_MAIL_JOURNAL_PREFIX}${digest(scope)}:${id(token)}`;
}
function record(
  raw: string,
  expectedScope: string,
  token: string,
): ServiceMailPendingRecord {
  try {
    const v = object(parseServiceReportsJson(raw, JOURNAL.bytes), [
        'schema',
        'actorBinding',
        'scope',
        'command',
      ]),
      command = requireServiceMailCommand(v.command);
    if (
      v.schema !== 1 ||
      v.scope !== expectedScope ||
      command.input.scope !== expectedScope ||
      command.input.idempotencyKey !== token
    )
      fail('STORAGE');
    return freeze({
      schema: 1 as const,
      actorBinding: string(v.actorBinding),
      scope: digest(v.scope),
      command,
    });
  } catch {
    return fail('STORAGE');
  }
}
function entries(storage: Storage): Map<string, string> {
  const count = integer(storage.length, 0, JOURNAL.scanKeys),
    values = new Map<string, string>();
  let total = 0;
  for (let index = 0; index < count; index++) {
    const key = storage.key(index);
    if (typeof key !== 'string') fail('STORAGE');
    if (!key!.startsWith(SERVICE_MAIL_JOURNAL_PREFIX)) continue;
    const match = /^([a-f0-9]{64}):([A-Za-z0-9_-]{1,100})$/u.exec(
        key!.slice(SERVICE_MAIL_JOURNAL_PREFIX.length),
      ),
      raw = storage.getItem(key!);
    if (!match || raw === null || values.has(key!)) fail('STORAGE');
    record(raw!, match![1], match![2]);
    total += bytes(raw!);
    values.set(key!, raw!);
    if (values.size > JOURNAL.slots || total > JOURNAL.totalBytes)
      fail('STORAGE');
  }
  if (storage.length !== count) fail('STORAGE');
  return values;
}
export function readServiceMailPending(
  storage: Storage,
  authority: ServiceReportsAuthority,
): ServiceMailPendingRecord | null {
  return storageOperation(() => {
    const prefix = `${SERVICE_MAIL_JOURNAL_PREFIX}${digest(authority.scope)}:`,
      binding = string(authority.actor.binding),
      owned = [...entries(storage)]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, raw]) =>
          record(raw, authority.scope, key.slice(prefix.length)),
        );
    if (owned.some((item) => item.actorBinding !== binding)) fail('FORBIDDEN');
    return owned[0] ?? null;
  });
}
function prepare(
  storage: Storage,
  authority: ServiceReportsAuthority,
  command: ServiceMailCommand,
): ServiceMailPendingRecord {
  return storageOperation(() => {
    const values = entries(storage),
      key = journalKey(authority.scope, command.input.idempotencyKey);
    if (command.input.scope !== authority.scope) fail('FORBIDDEN');
    if (
      [...values.keys()].some((item) =>
        item.startsWith(`${SERVICE_MAIL_JOURNAL_PREFIX}${authority.scope}:`),
      ) ||
      storage.getItem(key) !== null
    )
      fail('PENDING');
    const value = freeze({
        schema: 1 as const,
        actorBinding: string(authority.actor.binding),
        scope: authority.scope,
        command,
      }),
      raw = JSON.stringify(value);
    if (
      bytes(raw) > JOURNAL.bytes ||
      values.size >= JOURNAL.slots ||
      [...values.values()].reduce((sum, item) => sum + bytes(item), 0) +
        bytes(raw) >
        JOURNAL.totalBytes
    )
      fail('STORAGE');
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) fail('STORAGE');
    return record(raw, authority.scope, command.input.idempotencyKey);
  });
}
function settle(
  storage: Storage,
  authority: ServiceReportsAuthority,
  pending: ServiceMailPendingRecord,
  result: object,
  current: () => void,
) {
  const verified = verifiedResults.get(result);
  if (
    !verified ||
    !same(verified.authority, authority) ||
    !same(verified.command, pending.command) ||
    pending.actorBinding !== authority.actor.binding
  )
    fail('FORBIDDEN');
  storageOperation(() => {
    const key = journalKey(
        authority.scope,
        pending.command.input.idempotencyKey,
      ),
      raw = storage.getItem(key);
    if (raw === null) fail('PENDING');
    const saved = record(
      raw!,
      authority.scope,
      pending.command.input.idempotencyKey,
    );
    if (!same(saved, pending) || storage.getItem(key) !== raw) fail('PENDING');
    current();
    storage.removeItem(key);
    if (storage.getItem(key) !== null) fail('STORAGE');
    verifiedResults.delete(result);
  });
}
const commandLabels: Record<ServiceMailCommand['action'], string> = {
  saveRecipient: '保存邮箱地址',
  saveSubscription: '更新月度订阅',
  sendNow: '发起精确月报发送',
  cancelRequest: '取消原发送请求',
};
const activeLocks = new WeakMap<Storage, Set<string>>();
export function createServiceReportMailCommands(
  client: ServiceReportMailClient,
  options: { storage: Storage; createKey?: () => string },
) {
  const storage = options.storage,
    makeKey = options.createKey ?? (() => globalThis.crypto.randomUUID()),
    listeners = new Set<() => void>();
  let active: { scope: string; token: string } | null = null,
    error: ServiceMailClientError | null = null,
    disposed = false;
  const emit = () => {
      for (const listener of listeners) listener();
    },
    unsubscribe = client.subscribe(emit);
  const storageChanged = (event: StorageEvent) => {
    if (
      event.storageArea === storage &&
      (event.key === null || event.key.startsWith(SERVICE_MAIL_JOURNAL_PREFIX))
    )
      emit();
  };
  if (typeof window !== 'undefined')
    window.addEventListener('storage', storageChanged);
  const current = (): ServiceReportsAuthority => {
    const value = client.authority();
    if (disposed || !value) return fail('FORBIDDEN');
    return value;
  };
  const view = () => {
    try {
      const authority = current(),
        pending = readServiceMailPending(storage, authority);
      if (!pending)
        return {
          pending: null,
          error: error?.message ?? null,
          blocked: error?.code === 'STORAGE',
        };
      const sending =
        active?.scope === authority.scope &&
        active.token === pending.command.input.idempotencyKey;
      return {
        pending: {
          token: pending.command.input.idempotencyKey,
          label: commandLabels[pending.command.action],
          sending,
          message: sending
            ? '正在确认原操作，恢复记录已先行保存'
            : '原操作结果尚未确认。请检查服务端记录，或取消尚未提交的同一操作；不会自动重新发送',
        },
        error: error?.message ?? null,
        blocked: false,
      };
    } catch (caught) {
      return {
        pending: null,
        error:
          caught instanceof ServiceMailClientError
            ? caught.message
            : messages.STORAGE,
        blocked: true,
      };
    }
  };
  const run = (
    mode: 'new' | 'check' | 'cancel',
    intent?: ServiceMailIntent,
  ): Promise<ServiceMailMutationResult | ServiceMailCommandResolution> => {
    let authority: ServiceReportsAuthority | undefined,
      pending: ServiceMailPendingRecord;
    let locks = activeLocks.get(storage);
    if (!locks) {
      locks = new Set();
      activeLocks.set(storage, locks);
    }
    let claimed = false;
    try {
      authority = current();
      if (active || locks.has(authority.scope)) fail('PENDING');
      locks.add(authority.scope);
      claimed = true;
      if (mode === 'new') {
        const v = object(intent, ['action', 'input']),
          action = choice(v.action, [
            'saveRecipient',
            'saveSubscription',
            'sendNow',
            'cancelRequest',
          ]),
          q = object(v.input, commandFields[action]);
        const command = requireServiceMailCommand({
          action,
          input: {
            ...q,
            scope: authority.scope,
            idempotencyKey: id(makeKey()),
          },
        });
        pending = prepare(storage, authority, command);
      } else {
        const existing = readServiceMailPending(storage, authority);
        if (!existing) fail('PENDING');
        pending = existing!;
      }
      active = {
        scope: authority.scope,
        token: pending.command.input.idempotencyKey,
      };
      error = null;
      emit();
    } catch (caught) {
      if (claimed && authority) locks.delete(authority.scope);
      error =
        caught instanceof ServiceMailClientError
          ? caught
          : new ServiceMailClientError('STORAGE');
      emit();
      return Promise.reject(error);
    }
    const capturedAuthority = authority,
      captured = pending;
    return (async () => {
      try {
        const assertCurrent = () => {
          if (!same(current(), capturedAuthority)) fail('FORBIDDEN');
        };
        assertCurrent();
        const result =
          mode === 'new'
            ? await client.mutate(captured.command)
            : mode === 'check'
              ? await client.recoverCommand(captured.command)
              : await client.cancelCommand(captured.command);
        assertCurrent();
        if (!('outcome' in result) || result.outcome !== 'absent')
          settle(storage, capturedAuthority, captured, result, assertCurrent);
        return result;
      } catch (caught) {
        error =
          caught instanceof ServiceMailClientError
            ? caught
            : new ServiceMailClientError('UNAVAILABLE');
        throw error;
      } finally {
        locks!.delete(capturedAuthority.scope);
        active = null;
        emit();
      }
    })();
  };
  return Object.freeze({
    view,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    submit: (intent: ServiceMailIntent) => run('new', intent),
    check: () => run('check'),
    cancel: () => run('cancel'),
    dispose: () => {
      disposed = true;
      unsubscribe();
      if (typeof window !== 'undefined')
        window.removeEventListener('storage', storageChanged);
      listeners.clear();
    },
  });
}
export type ServiceReportMailCommands = ReturnType<
  typeof createServiceReportMailCommands
>;
