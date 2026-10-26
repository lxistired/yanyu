import {validStoreId} from './transcription-store-session';
import type { ResearchPage } from './research-experience-types';
export const pages = ['home','research','companies','chat','roadshow','files','documents','reader','materials','tasks','usage','workspace','organization','calendar','planner','automation','scheduled','settings'] as const satisfies readonly ResearchPage[];
export type SettingsPanel = 'overview' | 'feedback' | 'capabilities' | 'help';
export type OrdinaryRoute = { page: ResearchPage; panel: SettingsPanel; unknown?: string };
export function readOrdinaryRoute(url: URL): OrdinaryRoute {
  const page = url.searchParams.get('page') ?? 'home';
  const panel = url.searchParams.get('panel') ?? 'overview';
  if (!pages.includes(page as ResearchPage)) return {page:'home',panel:'overview',unknown:page};
  if (page === 'settings' && !['overview','feedback','capabilities','help'].includes(panel)) return {page:'settings',panel:'overview',unknown:panel};
  return {page:page as ResearchPage,panel:page === 'settings' ? panel as SettingsPanel : 'overview'};
}
export function ordinaryRouteUrl(route: OrdinaryRoute, current: string) {
  const url = new URL(current);
  // Job selectors belong only to a files visit, not later ordinary navigation.
  if (route.page !== 'files' || url.searchParams.get('page') !== 'files') url.searchParams.delete('transcriptJob');
  url.searchParams.set('page',route.unknown ?? route.page);
  url.searchParams.delete('panel'); if(route.page === 'settings' && route.panel !== 'overview') url.searchParams.set('panel',route.panel);
  return url;
}
export function routeKey(route: OrdinaryRoute) { return `${route.page}/${route.panel}/${route.unknown ?? ''}`; }
/** Every history operation invalidates earlier synthetic requests, including replace and pop. */
export class OrdinaryRequestLifetime {
  epoch = 0;
  advance() { return ++this.epoch; }
  async guard<T>(work: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    const epoch = this.epoch;
    if(signal?.aborted) throw new DOMException('Request cancelled','AbortError');
    const value = await work();
    if(epoch !== this.epoch || signal?.aborted) throw new DOMException('Route changed','AbortError');
    return value;
  }
}

/** Narrow local research destination. No provider URLs, guessed document links or extra filters. */
export function researchTranscriptDestination(destination: string, current: string): URL | null {
  try {
    const base = new URL(current), url = new URL(destination, base);
    if (url.origin !== base.origin || url.pathname !== base.pathname || url.username || url.password || url.hash) return null;
    const params = url.searchParams;
    if ([...params.keys()].length !== 3 || params.getAll('transcriptStoreId').length !== 1 || !validStoreId(params.get('transcriptStoreId')) || params.getAll('page').length !== 1 || params.get('page') !== 'files' || params.getAll('transcriptJob').length !== 1 ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(params.get('transcriptJob') ?? '')) return null;
    return url;
  } catch { return null; }
}
