import { ApiError } from './api';

/** These endpoints only return bounded local metadata. Never sends owner overrides. */
export async function workbenchCall<T>(path: string, input: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
    cache: 'no-store',
  });
  const payload = await response.json();
  if (!response.ok)
    throw new ApiError(
      payload.error ?? {
        code: 'PROVIDER_ERROR',
        message: '本地工作台暂不可用，请重试',
        retryable: true,
      },
    );
  return payload;
}
export function invalidatesWorkbenchCache(error: unknown): boolean {
  return (
    error instanceof ApiError && ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'].includes(error.detail.code)
  );
}
