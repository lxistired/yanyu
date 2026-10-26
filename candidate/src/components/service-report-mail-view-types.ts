import type {
  ServiceMailOverview,
  ServiceMailPreview,
  ServiceMailRecipient,
  ServiceMailReportPin,
  ServiceMailSubscription,
} from '../../shared/service-report-mail';
import type { ServiceCustomerPin } from '../../shared/service-reports';

/** Presentation never owns authority, transport, persistence, or a provider configuration. */
export type MailRead<T> =
  | { state: 'ready'; value: T }
  | { state: 'unknown' | 'loading' | 'unavailable' | 'error'; message: string };
export type MailCustomerSelection = {
  pin: ServiceCustomerPin;
  organizationName: string;
  contactName: string | null;
};
export type MailRecipientDraft = {
  id: string | null;
  expectedRevision: number | null;
  address: string;
};
export type MailSubscriptionDraft = {
  recipientId: string;
  timeZone: string;
  dayOfMonth: number;
  hour: number;
  consent: boolean;
};
export type MailPendingView = {
  token: string;
  label: string;
  sending: boolean;
  message: string;
};
export interface ServiceReportMailViewProps {
  customer: MailRead<MailCustomerSelection>;
  report: MailRead<ServiceMailReportPin>;
  overview: MailRead<ServiceMailOverview>;
  recipientDraft: MailRecipientDraft | null;
  selectedRecipientId: string;
  subscriptionDraft: MailSubscriptionDraft;
  preview: MailRead<ServiceMailPreview>;
  confirmed: boolean;
  sendBlockReason: string | null;
  sendWarning: string | null;
  pending: MailPendingView | null;
  busy: boolean;
  journalBlocked: boolean;
  error: string | null;
  notice: string | null;
  onRefresh: () => void;
  onAddRecipient: () => void;
  onEditRecipient: (recipient: ServiceMailRecipient) => void;
  onRecipientDraftChange: (draft: MailRecipientDraft) => void;
  onSaveRecipient: () => void;
  onCancelRecipientDraft: () => void;
  onDisableRecipient: (recipient: ServiceMailRecipient) => void;
  onSelectRecipient: (id: string) => void;
  onSubscriptionDraftChange: (draft: MailSubscriptionDraft) => void;
  onEnableSubscription: () => void;
  onPauseSubscription: (subscription: ServiceMailSubscription) => void;
  onUnsubscribe: (subscription: ServiceMailSubscription) => void;
  onPreview: () => void;
  onConfirmChange: (confirmed: boolean) => void;
  onSend: () => void;
  onCheckPending: () => void;
  onCancelPending: () => void;
  onCancelRequest: (id: string, revision: number) => void;
  onReconcileRequest: (id: string) => void;
}
