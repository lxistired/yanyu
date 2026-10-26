import type {ScheduleCadence} from '../scheduler/cadence.mjs';
export type InventoryDraft = {kind: ScheduleCadence['kind']; delay: string; time: string; timezone: string; weekdays: number[]; workspace: string; folder: string};
export type InventoryCommand = {id: string; idempotencyKey: string; handler: 'document-inventory-snapshot'; scope: {workspaceId: string | null; folderId: string | null}; cadence: ScheduleCadence};
export type InventoryPending = {command: InventoryCommand; uncertain: boolean};
export type InventorySnapshot = {draft: InventoryDraft; pending: InventoryPending | null};
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function recoveryKey(scope: string): string;
export function matchesInventoryCommand(schedule: unknown, command: InventoryCommand): boolean;
export class InventoryRecovery {
  constructor(storage: StoragePort, scope: string, initialDraft: InventoryDraft);
  readonly restored: boolean;
  snapshot(): InventorySnapshot;
  edit(draft: InventoryDraft): InventorySnapshot;
  begin(command: InventoryCommand): InventorySnapshot;
  markUncertain(): InventorySnapshot;
  rejectFirst(): InventorySnapshot;
  confirm(schedule: unknown): InventorySnapshot;
  discard(initialDraft: InventoryDraft): InventorySnapshot;
}
