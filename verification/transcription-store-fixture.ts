// Explicit fixture prerequisites only. No fetch interception or fallback context.
export const FIXTURE_STORE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const fixtureStoreHeaders = () => new Headers({'X-Transcription-Store-Id': FIXTURE_STORE_ID});
export function fixtureStoreUrl(path = '/') {
  const url = new URL(path, 'http://localhost');
  url.searchParams.set('transcriptStoreId', FIXTURE_STORE_ID);
  return `${url.pathname}${url.search}${url.hash}`;
}
export const fixtureStoreKey = (id: string) => `${FIXTURE_STORE_ID}:${id}`;
