/** Optional canonical UTC calendar dates. Absence, unlike an empty value, is unbounded. */
export type CreatedDateQuery = {createdFrom?: string; createdThrough?: string};
export type CreatedDateSelection = {createdFrom: string; createdThrough: string};
export function utcCalendarStart(value: unknown): number | null;
export function createdDateBounds(from: string | undefined, through: string | undefined): {start: number | null; endExclusive: number | null} | null;
export function storedCreatedInstant(value: unknown): number | null;
