// Authored local DTO validation, not proof of backend identity or a cross-store snapshot.
export type RelationshipIntent = {workspaceId: string | null; sessionId: string | null; expectedRevision: number};
export function nextRelationshipRevision(revision: number): number | null {
  return Number.isSafeInteger(revision) && revision >= 0 && Number.isSafeInteger(revision + 1) ? revision + 1 : null;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalText = (value: unknown) => value === undefined || value === null || typeof value === 'string';
export function validRelationshipReceipt(value: unknown, intended: RelationshipIntent): boolean {
  const revision = nextRelationshipRevision(intended.expectedRevision);
  if (revision === null || !object(value) || ('replayed' in value && typeof value.replayed !== 'boolean') || !object(value.relationship)) return false;
  const receipt = value.relationship;
  return receipt.workspaceId === intended.workspaceId && receipt.sessionId === intended.sessionId &&
    Number.isSafeInteger(receipt.revision) && receipt.revision === revision && typeof receipt.stale === 'boolean' &&
    optionalText(receipt.workspaceName) && optionalText(receipt.sessionTitle);
}
