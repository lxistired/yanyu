/** Display-only values. These never authorize providers, sources, execution, or notifications. */
export type PreferenceValues = {
  homeShowRecentSessions: boolean;
  homeShowNotifications: boolean;
  dateDisplay: 'browser' | 'utc';
  density: 'comfortable' | 'compact';
};

export interface PreferenceSnapshot {
  schemaVersion: 1;
  /** Response-only cache namespace for the verified owner; never an authority input. */
  scopeKey: string;
  /** Zero represents virtual defaults and does not imply that a row was written. */
  revision: number;
  persisted: boolean;
  updatedAt: string | null;
  values: PreferenceValues;
}

export interface SavePreferencesRequest {
  /** Stale-identity fence copied from a fresh read; never selects or grants an owner scope. */
  expectedScopeKey: string;
  expectedRevision: number;
  values: PreferenceValues;
  idempotencyKey: string;
}

export const DEFAULT_PREFERENCES: Readonly<PreferenceValues> = Object.freeze({
  homeShowRecentSessions: true,
  homeShowNotifications: true,
  dateDisplay: 'browser',
  density: 'comfortable',
});

export const PREFERENCES_LIMITS = Object.freeze({
  commandBytes: 16 * 1024,
  responseBytes: 128 * 1024,
  idempotencyKeyBytes: 100,
});
