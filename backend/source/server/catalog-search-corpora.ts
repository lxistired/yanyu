import { createHash } from 'node:crypto';
import { AdapterError, type RetrievalAdapter, type ServerContext } from '../shared/contracts';
import {
  CATALOG_SEARCH_LIMITS as L,
  type CatalogCorpus,
  type CatalogIdentity,
} from '../shared/catalog-search';
/** Trustworthy original-source dates only. Invalid or absent source values remain unknown. */
export function catalogDate(
  value: unknown,
  kind: Exclude<CatalogIdentity['sourceDateKind'], 'unknown'>,
): Pick<CatalogIdentity, 'sourceDate' | 'sourceDateKind'> {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    return { sourceDate: null, sourceDateKind: 'unknown' };
  return { sourceDate: value, sourceDateKind: kind };
}
/** Complete bounded identities, never a relevance/top-N query or copied source bodies. */
export function identityCorpus(input: {
  id: string;
  label: string;
  identities(context: ServerContext): readonly CatalogIdentity[];
  retrieval: RetrievalAdapter;
}): CatalogCorpus {
  function current(context: ServerContext) {
    if (context.signal.aborted) throw new AdapterError('CANCELLED', '检索已取消');
    const identities = input.identities(context);
    if (context.signal.aborted) throw new AdapterError('CANCELLED', '检索已取消');
    if (identities.length > L.documents)
      throw new AdapterError('PROVIDER_ERROR', '完整资料目录超过本次检索工作上限；没有返回截断计数');
    const items = identities
      .map((item) => ({ ...item, ...(item.companyIds ? { companyIds: [...item.companyIds].sort() } : {}) }))
      .sort((a, b) =>
        a.documentId < b.documentId
          ? -1
          : a.documentId > b.documentId
            ? 1
            : a.revisionId.localeCompare(b.revisionId),
      );
    if (new Set(items.map((item) => item.documentId)).size !== items.length)
      throw new AdapterError('PROVIDER_ERROR', '资料目录存在重复的当前公开标识');
    const serialized = JSON.stringify(items);
    if (Buffer.byteLength(serialized) > L.snapshotBytes)
      throw new AdapterError('PROVIDER_ERROR', '完整资料目录身份超过工作上限；未截断');
    const snapshotId = createHash('sha256')
      .update(
        JSON.stringify({
          corpus: input.id,
          tenant: context.principal.tenantId,
          owner: context.principal.subjectId,
          collections: [...context.principal.collectionIds].sort(),
          items,
        }),
      )
      .digest('hex');
    return { items, snapshotId };
  }
  return {
    id: input.id,
    label: input.label,
    getSnapshotIdentity: async (context) => current(context).snapshotId,
    guardSnapshot: (context, snapshotId) => {
      if (current(context).snapshotId !== snapshotId)
        throw new AdapterError('CONFLICT', '资料目录或当前权限已改变，请重新检索');
    },
    getDocumentVersion: (context, id, revision) => input.retrieval.getDocument(context, id, revision),
    enumerate: async (context, request) => {
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > L.enumerationPageSize)
        throw new AdapterError('INVALID_REQUEST', '资料目录分页大小无效');
      const result = current(context);
      if (request.snapshotId && request.snapshotId !== result.snapshotId)
        throw new AdapterError('CONFLICT', '资料目录已改变，请重新检索');
      let offset = 0;
      if (request.cursor !== undefined) {
        try {
          if (request.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(request.cursor)) throw Error();
          const cursor = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')) as {
            snapshotId: unknown;
            offset: unknown;
          };
          if (
            Object.keys(cursor).sort().join(',') !== 'offset,snapshotId' ||
            cursor.snapshotId !== result.snapshotId ||
            !Number.isSafeInteger(cursor.offset) ||
            Number(cursor.offset) < 1 ||
            Number(cursor.offset) > result.items.length
          )
            throw Error();
          offset = Number(cursor.offset);
        } catch {
          throw new AdapterError('CONFLICT', '资料目录游标无效或已经过期');
        }
      }
      const items = result.items.slice(offset, offset + request.limit);
      return {
        snapshotId: result.snapshotId,
        items,
        nextCursor:
          offset + items.length < result.items.length
            ? Buffer.from(
                JSON.stringify({ snapshotId: result.snapshotId, offset: offset + items.length }),
              ).toString('base64url')
            : null,
      };
    },
  };
}
export function unavailableCorpus(id: string, label: string, retrieval: RetrievalAdapter): CatalogCorpus {
  return {
    id,
    label,
    availability: async () => ({
      available: false,
      detail: '该资料适配器未提供完整目录协议；无法声称全量检索',
    }),
    getSnapshotIdentity: async () => {
      throw new AdapterError('PROVIDER_ERROR', '完整资料目录尚未配置');
    },
    getDocumentVersion: (ctx, id, revision) => retrieval.getDocument(ctx, id, revision),
  };
}
