/** Owner-entered local meetings only; these records never imply invitations or external attendance. */
export type MeetingReminderState =
  'scheduled' | 'notified' | 'missed' | 'cancelled' | 'acknowledged' | 'stale';
export type MeetingReminderReason =
  | 'meeting-changed'
  | 'meeting-unavailable'
  | 'meeting-cancelled'
  | 'meeting-completed'
  | 'rescheduled'
  | 'user-cancelled'
  | 'past-grace'
  | null;
export type MeetingReminderData = {
  meetingId: string;
  meetingRevision: number;
  startsAt: string;
  timezone: string;
  leadSeconds: number;
  dueAt: string;
  occurrenceId: string;
  state: 'active' | 'cancelled';
};
export type MeetingReminderOccurrenceData = {
  reminderId: string;
  reminderRevision: number;
  meetingId: string;
  meetingRevision: number;
  startsAt: string;
  timezone: string;
  leadSeconds: number;
  dueAt: string;
  state: Exclude<MeetingReminderState, 'acknowledged'>;
  reason: MeetingReminderReason;
  notificationId: string | null;
  resolvedAt: string | null;
};
export type MeetingNotificationTarget = {
  kind: 'meeting-reminder';
  id: string;
  meetingId: string;
  meetingRevision: number;
};
export type MeetingReminderView = {
  id: string;
  revision: number;
  occurrenceId: string;
  meetingId: string;
  meetingRevision: number;
  startsAt: string;
  timezone: string;
  dueAt: string;
  leadSeconds: number;
  state: MeetingReminderState;
  reason: MeetingReminderReason;
  notificationId: string | null;
};
export type CalendarMeeting = {
  id: string;
  revision: number;
  title: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  location: string;
  state: 'scheduled' | 'cancelled' | 'completed';
  localOnly: true;
  reminder: MeetingReminderView | null;
};
export type MeetingCalendarPage = {
  scope: string;
  observedAt: string;
  items: CalendarMeeting[];
  total: number;
  offset: number;
  nextOffset: number | null;
  timezone: string;
  policy: { delivery: 'in-app'; graceSeconds: number; processRequired: true; catchUp: false };
};
export type MeetingReminderDetail = {
  scope: string;
  meeting: CalendarMeeting | null;
  reminder: MeetingReminderView | null;
  occurrence: MeetingReminderView | null;
};
export type CalendarMeetingsRequest = {
  from: string;
  to: string;
  timezone: string;
  offset?: number;
  limit?: number;
};
export type ConfigureMeetingReminder = {
  scope: string;
  meetingId: string;
  expectedMeetingRevision: number;
  expectedRevision: number;
  leadSeconds: number;
  idempotencyKey: string;
};
export type MutateMeetingReminder = {
  scope: string;
  id: string;
  expectedRevision: number;
  idempotencyKey: string;
};
export type AcknowledgeMeetingReminder = {
  scope: string;
  occurrenceId: string;
  expectedRevision: number;
  idempotencyKey: string;
};
export const MEETING_REMINDER_LIMITS = Object.freeze({
  reminders: 100,
  occurrences: 1000,
  pageSize: 50,
  rangeDays: 62,
  horizonDays: 366,
  leadSeconds: 7 * 86400,
  graceSeconds: 90,
  requestBytes: 16 * 1024,
  responseBytes: 256 * 1024,
  readRows: 4000,
  readBytes: 16 * 1024 * 1024,
});
