export type ScheduleCadence =
  | {kind: 'once'; at: string; timezone: string}
  | {kind: 'daily'; time: string; timezone: string}
  | {kind: 'weekly'; time: string; timezone: string; weekdays: number[]};
export function validateScheduleCadence(value: unknown): ScheduleCadence;
export function nextScheduleOccurrence(cadence: ScheduleCadence, after: string, inclusive?: boolean): string | null;
export function previousScheduleOccurrence(cadence: ScheduleCadence, before: string, inclusive?: boolean): string | null;
