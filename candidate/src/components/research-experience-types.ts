import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { MeetingNotificationTarget } from '../../shared/meeting-reminders';
import type { PreferenceValues } from '../../shared/preferences';
import type { HomeSummary } from '../../shared/workbench';

/** Presentation routes only. The App continues to own every URL and identity transition. */
export type ResearchPage =
  | 'home'
  | 'research'
  | 'companies'
  | 'chat'
  | 'roadshow'
  | 'files'
  | 'documents'
  | 'reader'
  | 'materials'
  | 'tasks'
  | 'usage'
  | 'workspace'
  | 'organization'
  | 'calendar'
  | 'planner'
  | 'automation'
  | 'scheduled'
  | 'settings';

export interface ResearchNavigationItem {
  id: ResearchPage;
  name: string;
  icon: LucideIcon;
}

export interface ResearchAppShellProps {
  activePage: ResearchPage;
  navigation: readonly ResearchNavigationItem[];
  currentModeLabel: string;
  /** Keep capability, permission, connection and recovery notices visible here. */
  statusSlot: ReactNode;
  children: ReactNode;
  onNavigate: (page: ResearchPage) => void;
  onOpenHelp?: () => void;
}

export type HomeNotification = HomeSummary['notifications']['items'][number];
export interface HomePendingNotification {
  id: string;
  expectedRevision: number;
  idempotencyKey: string;
}

export interface HomeDashboardViewProps {
  preferences: PreferenceValues;
  summary: HomeSummary | undefined;
  query: string;
  onQueryChange: (value: string) => void;
  loading: boolean;
  available?: boolean;
  error: string;
  syntheticTestData?: boolean;
  pending?: HomePendingNotification;
  marking?: string;
  markError: string;
  onRefresh: () => void;
  /** The owner creates the idempotency key and sends the command, never this view. */
  onMarkRead: (notification: HomeNotification) => void;
  /** The owner reuses the exact pending command. */
  onRetryMark: () => void;
  onAsk: (question: string) => void;
  onOpenSession: (id: string) => void;
  onOpenPlan: (planId: string, sessionId: string) => void;
  onOpenAutomations: () => void;
  onOpenMeetingNotification?: (target: MeetingNotificationTarget) => void;
  onOpenUsage: () => void;
  onNavigate: (page: 'companies' | 'research' | 'roadshow' | 'files' | 'workspace') => void;
  /** Optional owner-supplied presentation; absent means capability is not inferred. */
  recordingEntry?: 'record' | 'import' | 'inspect' | 'native';
  /** Explicit recording entry only; ordinary roadshow navigation remains unchanged. */
  onOpenRecording?: () => void;
  /** Lets the complete planner remain reachable when a metadata projection is bounded. */
  onOpenPlans?: () => void;
  /** Contextual safety notices remain visible, before the relevant actions. */
  safetySlot?: ReactNode;
  /** Independently authorized catalog leaf; never gated by workbench summary availability. */
  researchFeedSlot?: ReactNode;
}
