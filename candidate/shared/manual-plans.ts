import type { DomainRecord } from './workspace';
/** Original local manual plan, not an AI/session planner or an execution schedule. */
export const MANUAL_PLAN_STATES = ['draft', 'planned', 'in-progress', 'completed', 'cancelled'] as const;
export type ManualPlanState = typeof MANUAL_PLAN_STATES[number];
export type ManualPlanFields = { title: string; objective: string; notes: string; targetDate: string | null };
export type ManualPlanData = ManualPlanFields & {
  schemaVersion: 1; provenance: 'user-authored-local'; state: ManualPlanState;
  /** Optional for legacy plans. Revisions describe the explicitly reviewed snapshot, not live target state. */
  sessionLink?: ManualPlanSessionLink | null;
  /** Optional for legacy plans. A stored shortcut only, not verified transcript existence or ownership. */
  materialLink?: ManualPlanMaterialLink | null;
  /** Independent document shortcut; current metadata and PDF admission are never persisted. */
  documentLink?: ManualPlanDocumentLink | null;
  /** Additional explicitly saved source pointers; legacy single slots remain independent. */
  materialLinks?: ManualPlanSourceLink[];
};
export type ManualPlanRecord = DomainRecord<ManualPlanData> & { kind: 'manual-research-plan'; /** Read-only local get provenance; absent in historical receipts. */ storeScope?:string };
export type ManualPlanCommand = { idempotencyKey: string };
export type ManualPlanMutation = ManualPlanCommand & { id: string; expectedRevision: number };
export type CreateManualPlan = ManualPlanCommand & Pick<ManualPlanFields, 'title' | 'objective'> & Partial<Pick<ManualPlanFields, 'notes' | 'targetDate'>>;
export type UpdateManualPlan = ManualPlanMutation & { patch: Partial<ManualPlanFields> };
export type SetManualPlanState = ManualPlanMutation & { state: ManualPlanState };
export type GetManualPlan = { id: string; includeDeleted?: boolean; scope?:string };
export type ListManualPlans = {
  offset?: number; limit?: number; query?: string; state?: ManualPlanState;
  fromDate?: string; toDate?: string; includeDeleted?: boolean;
  sort?: 'targetDate' | 'updatedAt'; direction?: 'asc' | 'desc';
};
export type ManualPlanPage = { items: ManualPlanRecord[]; total: number; offset: number; nextOffset: number | null };
export const MANUAL_PLAN_LIMITS = { titleBytes: 720, textBytes: 8000, queryBytes: 600,
  materialLinks: 100, commandBytes: 30 * 1024, defaultLimit: 25, maxLimit: 100, maxOffset: 4000, scanRows: 4000,
  scanBytes: 16 * 1024 * 1024, pageBytes: 256 * 1024 } as const;

/** One local ordinary session only. This does not run research or configure any provider. */
export type ManualPlanSessionTarget = { workspaceId:string; sessionId:string; workspaceRevision:number; sessionRevision:number };
export type ManualPlanSessionLink = ManualPlanSessionTarget & { scope:string };
export type SetManualPlanSessionLink = ManualPlanMutation & { scope:string; sessionLink:ManualPlanSessionTarget|null };
export type ManualPlanSessionChoicesRequest = { id:string; expectedRevision:number; workspaceId:string|null; offset?:number; scope:string };
export type ManualPlanSessionChoice = { id:string; title:string; revision:number };
export type ManualPlanSessionChoices = {
  scope:string; planId:string; planRevision:number; workspace:ManualPlanSessionChoice|null;
  items:ManualPlanSessionChoice[]; total:number; offset:number; nextOffset:number|null;
  currentLink:{status:'none'|'available'|'stale'|'unavailable';workspaceTitle?:string;sessionTitle?:string};
};


/** Exact saved link captured by an explicit open. Every page is a fresh current read,
 * not an opening grant or a frozen snapshot; this operation never writes a receipt. */
export type ManualPlanLinkedSessionRequest = {
  id:string; expectedRevision:number; scope:string; sessionLink:ManualPlanSessionLink;
  offset?:number; limit?:number;
};
export type ManualPlanLinkedSessionMessage = DomainRecord<{
  sessionId:string; role:'user'|'assistant'|'system'; content:string; sequence?:number;
}> & {kind:'message'};
export type ManualPlanLinkedSession = {
  scope:string; planId:string; planRevision:number; sessionLink:ManualPlanSessionLink;
  workspace:ManualPlanSessionChoice;
  /** Model/mode/role are saved manual metadata, never evidence of AI execution. */
  session:ManualPlanSessionChoice & {workspaceId:string; mode:'quick'|'deep'|'plan'|'daily'; model:string};
  items:ManualPlanLinkedSessionMessage[]; total:number; offset:number; nextOffset:number|null;
};

/** Transcript store lineage is separate from the owner-scoped plan store authority. */
export type ManualPlanMaterialLink = { kind:'transcript'; transcriptStoreId:string; jobId:string };
export type SetManualPlanMaterialLink = ManualPlanMutation & { scope:string; materialLink:ManualPlanMaterialLink|null };

/** Document source lineage is separate from the plan store and transcript source. */
export type ManualPlanDocumentLink = { kind:'document'; documentStoreId:string; documentId:string };
export type SetManualPlanDocumentLink = ManualPlanMutation & { scope:string; documentLink:ManualPlanDocumentLink|null };

/** Typed source identity, never a title, URL, array position, or current preview. */
export type ManualPlanSourceLink = ManualPlanMaterialLink | ManualPlanDocumentLink;
export type AddManualPlanMaterialLinks = ManualPlanMutation & { scope:string; materialLinks:ManualPlanSourceLink[] };
export type RemoveManualPlanMaterialLink = ManualPlanMutation & { scope:string; materialLink:ManualPlanSourceLink };
export function manualPlanSourceKey(link: ManualPlanSourceLink): string {
  return JSON.stringify(link.kind === 'transcript'
    ? [link.kind, link.transcriptStoreId, link.jobId]
    : [link.kind, link.documentStoreId, link.documentId]);
}
/** Stable union: old transcript slot, old document slot, then additional selections.
 * Pure projection over already validated data; does not rewrite legacy records. */
export function effectiveManualPlanLinks(data: Pick<ManualPlanData, 'materialLink' | 'documentLink' | 'materialLinks'>): ManualPlanSourceLink[] {
  const result: ManualPlanSourceLink[] = [], seen = new Set<string>();
  for (const link of [data.materialLink, data.documentLink, ...(data.materialLinks ?? [])]) {
    if (!link) continue;
    const key = manualPlanSourceKey(link);
    if (!seen.has(key)) { seen.add(key); result.push(link); }
  }
  return result;
}
