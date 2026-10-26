import type { ServiceCommand, ServiceCustomer } from "./service-reports";

/** B03 mail is outbound sharing consent, never a CRM read/served/attendance fact. */
export const SERVICE_MAIL_LIMITS = Object.freeze({
  requestBytes: 32 * 1024,
  envelopeBytes: 2 * 1024 * 1024,
  responseBytes: 3 * 1024 * 1024,
  gatewayResponseBytes: 16 * 1024,
  recordBytes: 16 * 1024,
  ownerRows: 4000,
  ownerCommands: 8000,
  recipients: 100,
  subscriptions: 100,
  pageRows: 100,
  operationMilliseconds: 30_000,
  transportMilliseconds: 10_000,
  leaseMilliseconds: 45_000,
  occurrenceGraceMilliseconds: 24 * 60 * 60 * 1000,
});
export type ServiceMailProvider = {
  mode: "unavailable" | "synthetic" | "configured";
  registrationRevision: string | null;
  sender: string | null;
};
export type ServiceMailRecipient = {
  id: string;
  revision: number;
  customer: ServiceCustomer;
  address: string;
  disabled: boolean;
  updatedAt: string;
  mailboxVerified: false;
};
export type ServiceMailSubscription = {
  id: string;
  revision: number;
  customer: ServiceCustomer;
  recipientId: string;
  recipientRevision: number;
  providerRegistrationRevision: string;
  timeZone: string;
  dayOfMonth: number;
  hour: number;
  enabled: boolean;
  unsubscribed: boolean;
  nextDueMonth: string;
  updatedAt: string;
  consent: "monthly-previous-completed-month";
  missedPolicy: "pause-without-catch-up";
  zeroEntryPolicy: "send-empty-report";
  changedActivityPolicy: "fresh-snapshot-at-occurrence";
};
export type ServiceMailReportPin = {
  reportId: string;
  reportRevision: number;
  snapshotSha256: string;
  customer: ServiceCustomer;
  month: string;
  timeZone: string;
};
export type ServiceMailConfirmation = {
  report: ServiceMailReportPin;
  currentActivitiesCensusSha256: string;
  recipientId: string;
  recipientRevision: number;
  recipientAddress: string;
  providerRegistrationRevision: string;
  renderedContentSha256: string;
};
export type ServiceMailPreview = {
  scope: string;
  confirmation: ServiceMailConfirmation;
  provider: ServiceMailProvider;
  subject: string;
  text: string;
  html: string;
  envelopeBytes: number;
  sharingPurpose: "monthly-service-report";
  delivery: "unknown";
};
export type ServiceMailState =
  | "queued"
  | "blocked"
  | "dispatching"
  | "provider-accepted"
  | "known-rejected"
  | "outcome-unknown"
  | "cancelled-before-dispatch";
export type ServiceMailBlockReason =
  | "unconfigured"
  | "authority-unavailable"
  | "consent-changed"
  | "recipient-changed"
  | "report-changed"
  | "source-unavailable"
  | "missed-occurrence"
  | "provider-changed";
export type ServiceMailRequest = {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  confirmation: ServiceMailConfirmation;
  subscription: { id: string; revision: number; dueMonth: string } | null;
  state: ServiceMailState;
  blockedReason: ServiceMailBlockReason | null;
  providerRequestId: string | null;
  acceptedAt: string | null;
  simulated: boolean;
  delivery: "unknown" | "confirmed-delivered";
  cancellationRequested: boolean;
  attemptCount: number;
  deliveryReceipt: ServiceMailDeliveryReceipt | null;
};
export type ServiceMailOccurrence = {
  id: string;
  subscriptionId: string;
  subscriptionRevision: number;
  dueMonth: string;
  reportMonth: string;
  state: "reserved" | "queued" | "blocked";
  requestId: string | null;
  blockedReason: ServiceMailBlockReason | null;
};
export type ServiceMailOverview = {
  scope: string;
  provider: ServiceMailProvider;
  recipients: ServiceMailRecipient[];
  subscriptions: ServiceMailSubscription[];
  requests: ServiceMailRequest[];
  occurrences: ServiceMailOccurrence[];
  truncated: boolean;
};
export type SaveServiceMailRecipient = ServiceCommand & {
  id: string | null;
  expectedRevision: number | null;
  customer: ServiceCustomer;
  address: string;
  disabled: boolean;
};
export type SaveServiceMailSubscription = ServiceCommand & {
  id: string | null;
  expectedRevision: number | null;
  customer: ServiceCustomer;
  recipientId: string;
  recipientRevision: number;
  providerRegistrationRevision: string;
  timeZone: string;
  dayOfMonth: number;
  hour: number;
  enabled: boolean;
  unsubscribed: boolean;
  consent: "monthly-previous-completed-month";
};
export type PreviewServiceMail = {
  reportId: string;
  expectedRevision: number;
  recipientId: string;
  recipientRevision: number;
};
export type SendServiceMail = ServiceCommand & {
  confirmation: ServiceMailConfirmation;
  consent: "send-exact-report-to-exact-recipient";
};
export type CancelServiceMail = ServiceCommand & {
  requestId: string;
  expectedRevision: number;
};
export type ServiceMailCommand =
  | { action: "saveRecipient"; input: SaveServiceMailRecipient }
  | { action: "saveSubscription"; input: SaveServiceMailSubscription }
  | { action: "sendNow"; input: SendServiceMail }
  | { action: "cancelRequest"; input: CancelServiceMail };
export type ServiceMailDeliveryReceipt = {
  providerReceiptId: string;
  providerRequestId: string;
  registrationRevision: string;
  envelopeSha256: string;
  deliveredAt: string;
};
/** Fingerprint is SHA-256 of readerCanonical({action,input}); no request field is omitted. */
export type ServiceMailCommandResolution = {
  scope: string;
  idempotencyKey: string;
  fingerprint: string;
} & (
  | { outcome: "absent" }
  | { outcome: "cancelled" }
  | {
      outcome: "committed";
      target: "recipient" | "subscription" | "request";
      id: string;
    }
);

/** Owner scope is supplied by the trusted ledger/client actor, not by this key. Destination
 * preserves the potentially case-sensitive local part and folds only the DNS domain. */
export function serviceMailIntentIdentity(
  confirmation: Pick<ServiceMailConfirmation, "report" | "recipientAddress">,
): string {
  const address = confirmation.recipientAddress,
    at = address.lastIndexOf("@");
  return JSON.stringify([
    confirmation.report.snapshotSha256,
    confirmation.report.customer.organizationId,
    confirmation.report.customer.contactId,
    address.slice(0, at) + "@" + address.slice(at + 1).toLowerCase(),
  ]);
}
export function serviceMailBlocksEquivalentIntent(
  request: ServiceMailRequest,
): boolean {
  return (
    request.state === "queued" ||
    request.state === "dispatching" ||
    request.state === "outcome-unknown" ||
    (request.state === "blocked" &&
      request.blockedReason !== "missed-occurrence")
  );
}
