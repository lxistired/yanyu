import { AdapterError, type ServerContext } from '../shared/contracts';
import { AsyncLocalStorage } from 'node:async_hooks';

type Lifetime = { active: boolean; parent?: Lifetime; authority?: Authority; publication?: Authority };
type Authority = {
  check: () => void;
  identity: string;
  requestId: string;
  lifetime?: Lifetime;
  failure?: AdapterError;
  publication?: boolean;
  checking?: boolean;
};
const authorities = new WeakMap<ServerContext, Authority>();
const publicationAuthorities = new WeakMap<ServerContext, Authority>();
const lifetimes = new AsyncLocalStorage<Lifetime>();
const identity = (context: ServerContext) =>
  JSON.stringify([
    context.principal.tenantId,
    context.principal.subjectId,
    [...context.principal.collectionIds].sort(),
  ]);

/** Isolate one server request and expire inherited detached work when its handler settles.
 * This only establishes lifetime; native entry/commit/publication checks still authorize each use.
 */
export async function withRequestAuthorityLifetime<T>(action: () => Promise<T>): Promise<T> {
  const lifetime: Lifetime = { active: true, parent: lifetimes.getStore() };
  return lifetimes.run(lifetime, async () => {
    try {
      return await action();
    } finally {
      lifetime.active = false;
    }
  });
}
function currentAuthorities(context: ServerContext): Authority[] {
  const result = new Set<Authority>();
  const exact = authorities.get(context);
  if (exact) result.add(exact);
  const publication = publicationAuthorities.get(context);
  if (publication) result.add(publication);
  for (let frame = lifetimes.getStore(); frame; frame = frame.parent) {
    if (frame.authority) result.add(frame.authority);
    if (frame.publication) result.add(frame.publication);
  }
  return [...result];
}

export function hasRequestAuthority(context: ServerContext): boolean {
  return currentAuthorities(context).length > 0;
}

/** Trusted server composition only. Authority never comes from a JSON field on ServerContext. */
export function bindRequestAuthority(context: ServerContext, check: () => void): void {
  if (authorities.has(context) || typeof check !== 'function')
    throw new AdapterError('INVALID_REQUEST', '请求授权只能由服务端绑定一次');
  const lifetime = lifetimes.getStore();
  if (lifetime?.authority) throw new AdapterError('INVALID_REQUEST', '同一请求生命周期不能替换授权');
  const authority = { check, identity: identity(context), requestId: context.requestId, lifetime };
  authorities.set(context, authority);
  if (lifetime) lifetime.authority = authority;
  checkRequestAuthority(context);
}

/** Trusted host composition only. Add a local commit/publication fence without claiming that
 * an earlier remote observation is current remote authorization. The request's active operation
 * owns the check, budgets and captured source identities. No request DTO can install this fence.
 */
export function bindRequestPublicationFence(context: ServerContext, check: () => void): void {
  const lifetime = lifetimes.getStore();
  if (
    !lifetime?.active ||
    lifetime.publication ||
    publicationAuthorities.has(context) ||
    typeof check !== 'function'
  )
    throw new AdapterError('INVALID_REQUEST', '来源发布核对必须在请求生命周期内绑定一次');
  const authority: Authority = {
    check,
    identity: identity(context),
    requestId: context.requestId,
    lifetime,
    publication: true,
    checking: false,
  };
  publicationAuthorities.set(context, authority);
  lifetime.publication = authority;
  checkRequestAuthority(context);
}

/** Pure terminal state assertion. It never calls an authority adapter and therefore cannot
 * change a resource after its final source check. Observed denials remain latched even when
 * a trusted nested source callback caught them. Use after, not instead of, live observation.
 */
export function checkRequestAuthorityState(context: ServerContext): void {
  for (const authority of currentAuthorities(context)) {
    if (authority.failure) throw authority.failure;
    try {
      if (authority.lifetime && !authority.lifetime.active)
        throw new AdapterError('CANCELLED', '请求生命周期已结束');
      if (context.requestId !== authority.requestId || identity(context) !== authority.identity)
        throw new AdapterError('UNAUTHENTICATED', '请求副本不能改变已验证身份或请求标识');
      if (context.signal.aborted) throw new AdapterError('CANCELLED', '请求已取消');
    } catch (cause) {
      authority.failure =
        cause instanceof AdapterError ? cause : new AdapterError('PROVIDER_ERROR', '请求授权状态核对失败');
      throw authority.failure;
    }
  }
  if (context.signal.aborted) throw new AdapterError('CANCELLED', '请求已取消');
}

/** Unbound legacy/local contexts retain their existing authority contract. Bound requests fail
 * permanently after observed denial, even if a trusted nested callback catches the first error.
 */
export function checkRequestAuthority(context: ServerContext): void {
  for (const authority of currentAuthorities(context)) {
    if (authority.failure) throw authority.failure;
    try {
      if (authority.lifetime && !authority.lifetime.active)
        throw new AdapterError('CANCELLED', '请求生命周期已结束');
      if (context.requestId !== authority.requestId || identity(context) !== authority.identity)
        throw new AdapterError('UNAUTHENTICATED', '请求副本不能改变已验证身份或请求标识');
      if (context.signal.aborted) throw new AdapterError('CANCELLED', '请求已取消');
      // A trusted source fence may recheck the same current actor while inspecting local inventory.
      // Reentry still checks lifetime, identity, cancellation and every other authority above/below;
      // only this already-running synchronous publication callback is omitted in the nested pass.
      if (authority.publication && authority.checking) continue;
      authority.checking = true;
      let value: unknown;
      try {
        value = authority.check();
      } finally {
        authority.checking = false;
      }
      if (value !== undefined) {
        void Promise.resolve(value).catch(() => undefined);
      }
      if (authority.failure) throw authority.failure;
      if (value !== undefined) {
        throw new AdapterError('PROVIDER_ERROR', '请求授权核对必须同步完成');
      }
      if (context.signal.aborted) throw new AdapterError('CANCELLED', '请求已取消');
    } catch (cause) {
      authority.failure =
        cause instanceof AdapterError ? cause : new AdapterError('PROVIDER_ERROR', '请求授权核对失败');
      throw authority.failure;
    }
  }
  // A nested source check can observe and catch denial of an authority already checked above.
  // The outer publication must still fail; a catch cannot turn that request usable again.
  for (const authority of currentAuthorities(context)) if (authority.failure) throw authority.failure;
}
