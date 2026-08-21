import FlexSearch from "flexsearch";
import { BehaviorSubject } from "rxjs";
import { getJson } from "../api/client";
import type { MapSummary } from "../types/map";

type MapsState = {
  loading: boolean;
  loadingMore: boolean;
  maps: MapSummary[];
  filtered: MapSummary[];
  query: string;
  nextCursor: string | null;
  hasMore: boolean;
  /** True total map count on the server, independent of how many pages we've loaded so far. */
  total: number;
};

const state$ = new BehaviorSubject<MapsState>({
  loading: false,
  loadingMore: false,
  maps: [],
  filtered: [],
  query: "",
  nextCursor: null,
  hasMore: false,
  total: 0
});

const index = new FlexSearch.Index({ tokenize: "forward" });

export const mapsStore = {
  state$,
  async load() {
    state$.next({ ...state$.value, loading: true });
    const payload = await getJson<{ maps?: MapSummary[]; items?: MapSummary[]; next_cursor?: string | null; total?: number }>(
      "/api/v1/maps?limit=48"
    );
    const items = payload.items ?? payload.maps ?? [];
    items.forEach((map) => index.add(map.id, `${map.name} ${map.path} ${(map.tags ?? []).join(" ")}`));
    state$.next({
      ...state$.value,
      loading: false,
      maps: items,
      filtered: items,
      nextCursor: payload.next_cursor ?? null,
      hasMore: !!payload.next_cursor,
      total: payload.total ?? items.length
    });
  },
  async loadMore() {
    if (!state$.value.nextCursor || state$.value.loadingMore) return;
    state$.next({ ...state$.value, loadingMore: true });
    const payload = await getJson<{ maps?: MapSummary[]; items?: MapSummary[]; next_cursor?: string | null; total?: number }>(
      `/api/v1/maps?limit=48&cursor=${encodeURIComponent(state$.value.nextCursor)}`
    );
    const incoming = payload.items ?? payload.maps ?? [];
    const existing = new Map(state$.value.maps.map((m) => [m.id, m]));
    incoming.forEach((m) => existing.set(m.id, m));
    incoming.forEach((map) => index.add(map.id, `${map.name} ${map.path} ${(map.tags ?? []).join(" ")}`));
    const merged = Array.from(existing.values());
    const q = state$.value.query.trim();
    const filtered = !q
      ? merged
      : merged.filter((m) => (index.search(q) as string[]).includes(m.id));
    state$.next({
      ...state$.value,
      loadingMore: false,
      maps: merged,
      filtered,
      nextCursor: payload.next_cursor ?? null,
      hasMore: !!payload.next_cursor,
      total: payload.total ?? state$.value.total
    });
  },
  setQuery(query: string) {
    const q = query.trim();
    if (!q) {
      state$.next({ ...state$.value, query, filtered: state$.value.maps });
      return;
    }
    const ids = index.search(q) as string[];
    const filtered = state$.value.maps.filter((m) => ids.includes(m.id));
    state$.next({ ...state$.value, query, filtered });
  }
};
