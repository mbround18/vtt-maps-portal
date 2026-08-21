import { BehaviorSubject } from "rxjs";
import { getJson } from "../api/client";

type Overview = {
  total_views: number;
  total_downloads: number;
  total_votes: number;
  avg_view_duration_ms: number;
  donation_click_through_rate: number;
  app: {
    active_sessions: number;
    auth_login_success_24h: number;
    auth_login_failed_24h: number;
    csrf_failures_24h: number;
    unauthorized_24h: number;
    rate_limited_24h: number;
    consent_denied_24h: number;
    tracked_views_24h: number;
    tracked_donations_24h: number;
  };
};

type TimeseriesPoint = {
  day: string;
  views: number;
  downloads: number;
  votes_cast: number;
  donation_impressions: number;
  donation_clicks: number;
  donation_conversion_hints: number;
  auth_login_success: number;
  auth_login_failed: number;
  csrf_failures: number;
  unauthorized: number;
  rate_limited: number;
  consent_denied: number;
};

type TopMap = {
  map_id: string;
  views: number;
  downloads: number;
  votes: number;
  avg_duration_ms: number;
};

type Funnel = {
  map_id: string | null;
  impressions: number;
  clicks: number;
  conversion_hints: number;
  ctr: number;
  conversion_hint_rate: number;
};

type AnalyticsState = {
  loading: boolean;
  overview: Overview | null;
  timeseries: TimeseriesPoint[];
  topMaps: TopMap[];
  funnel: Funnel | null;
};

const state$ = new BehaviorSubject<AnalyticsState>({
  loading: false,
  overview: null,
  timeseries: [],
  topMaps: [],
  funnel: null
});

export const analyticsStore = {
  state$,
  async loadOverview() {
    const overview = await getJson<Overview>("/api/v1/analytics/overview");
    state$.next({ ...state$.value, overview });
  },
  async loadTimeseries(from: string, to: string) {
    const payload = await getJson<{ points: TimeseriesPoint[] }>(
      `/api/v1/analytics/timeseries?from=${from}&to=${to}&bucket=day`
    );
    state$.next({ ...state$.value, timeseries: payload.points });
  },
  async loadTopMaps(limit = 10, from?: string, to?: string) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const payload = await getJson<{ maps: TopMap[] }>(`/api/v1/analytics/top-maps?${params.toString()}`);
    state$.next({ ...state$.value, topMaps: payload.maps });
  },
  async loadFunnel(mapId?: string, from?: string, to?: string) {
    const params = new URLSearchParams();
    if (mapId) params.set("map_id", mapId);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const query = params.toString();
    const payload = await getJson<Funnel>(`/api/v1/analytics/funnel${query ? `?${query}` : ""}`);
    state$.next({ ...state$.value, funnel: payload });
  },
  async refreshAll(from: string, to: string) {
    state$.next({ ...state$.value, loading: true });
    await Promise.all([
      this.loadOverview(),
      this.loadTimeseries(from, to),
      this.loadTopMaps(10, from, to),
      this.loadFunnel(undefined, from, to)
    ]);
    state$.next({ ...state$.value, loading: false });
  }
};
