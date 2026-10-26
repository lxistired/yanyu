import type { MeetingNotificationTarget } from './meeting-reminders';
/** Local metadata only. No source, message, objective, or generated-answer content. */
export interface HomeSummary {
  observedAt: string;
  recentSessions: {
    state: 'available' | 'unavailable';
    items: Array<{
      id: string;
      workspaceId: string;
      title: string;
      pinned: boolean;
      lastActivityAt: string;
    }>;
    hasMore: boolean;
  };
  attentionPlans: {
    state: 'available' | 'unavailable';
    items: Array<{
      planId: string;
      sessionId: string;
      sessionTitle: string;
      status: 'awaiting-approval' | 'awaiting-answers' | 'interrupted';
      updatedAt: string;
    }>;
    hasMore: boolean;
  };
  notifications: {
    state: 'available' | 'unavailable';
    unreadCount: number | null;
    items: Array<{
      id: string;
      revision: number;
      title: string;
      createdAt: string;
      target: { kind: 'schedule-run'; id: string } | MeetingNotificationTarget;
    }>;
    hasMore: boolean;
  };
}

export const WORKBENCH_LIMITS = Object.freeze({
  requestBytes: 16 * 1024,
  responseBytes: 128 * 1024,
  maxReadRows: 4_000,
  maxReadBytes: 16 * 1024 * 1024,
});
