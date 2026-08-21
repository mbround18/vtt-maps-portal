import * as d3 from "d3";
import { useEffect, useMemo, useRef, useState } from "react";
import { analyticsStore } from "../stores/analyticsStore";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardAction } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type TimeseriesPoint = {
  day: string;
  views: number;
};

function MetricCard(props: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <div className="text-sm font-medium text-muted-foreground">{props.label}</div>
      <div className="mt-1 text-2xl font-semibold">{props.value}</div>
    </div>
  );
}

export function AdminAnalyticsPage() {
  const [state, setState] = useState(analyticsStore.state$.value);
  const [selectedMap, setSelectedMap] = useState<string>("");
  const [engagementCounter, setEngagementCounter] = useState(0);
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const engagementCounterRef = useRef(0);

  useEffect(() => {
    analyticsStore.refreshAll(from, to).catch(console.error);
    const sub = analyticsStore.state$.subscribe(setState);
    return () => sub.unsubscribe();
  }, [from, to]);

  const timeseriesChart = useMemo(() => {
    const width = 860;
    const height = 260;
    const margin = { top: 20, right: 24, bottom: 34, left: 48 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const data = state.timeseries;
    if (!data.length) return null;

    const x = d3
      .scaleTime()
      .domain(d3.extent(data, (d) => new Date(d.day)) as [Date, Date])
      .range([0, innerW]);
    const y = d3
      .scaleLinear()
      .domain([0, d3.max(data, (d) => d.views) ?? 1])
      .nice()
      .range([innerH, 0]);

    const line = d3
      .line<TimeseriesPoint>()
      .x((d) => x(new Date(d.day)))
      .y((d) => y(d.views))
      .curve(d3.curveMonotoneX);

    const area = d3
      .area<TimeseriesPoint>()
      .x((d) => x(new Date(d.day)))
      .y0(innerH)
      .y1((d) => y(d.views))
      .curve(d3.curveMonotoneX);

    const xTicks = x.ticks(6);
    const yTicks = y.ticks(4);

    return { width, height, margin, innerW, innerH, x, y, line, area, data, xTicks, yTicks };
  }, [state.timeseries]);

  const engagementScore = useMemo(() => {
    const durationMinutes = overviewDurationToMinutes(state.overview?.avg_view_duration_ms ?? 0);
    const volume = (state.overview?.total_views ?? 0) * 1
      + (state.overview?.total_downloads ?? 0) * 3
      + (state.overview?.total_votes ?? 0) * 4;
    const depthMultiplier = Math.min(2.5, 1 + durationMinutes / 4);
    return Math.round(volume * depthMultiplier);
  }, [state.overview]);

  const engagementMixChart = useMemo(() => {
    if (!state.overview) return null;
    const data = [
      { label: "Views", value: state.overview.total_views, color: "#60a5fa" },
      { label: "Downloads", value: state.overview.total_downloads, color: "#f59e0b" },
      { label: "Votes", value: state.overview.total_votes, color: "#34d399" }
    ].filter((d) => d.value > 0);
    if (!data.length) return null;

    const width = 300;
    const height = 240;
    const radius = Math.min(width, height) / 2 - 12;
    const pie = d3.pie<{ label: string; value: number; color: string }>().value((d) => d.value);
    const arc = d3.arc<d3.PieArcDatum<{ label: string; value: number; color: string }>>()
      .innerRadius(radius * 0.5)
      .outerRadius(radius);
    const total = data.reduce((sum, row) => sum + row.value, 0);
    return { width, height, radius, arcs: pie(data), arc, total };
  }, [state.overview]);

  const topMapsChart = useMemo(() => {
    const width = 860;
    const height = 340;
    const margin = { top: 20, right: 24, bottom: 80, left: 48 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const data = state.topMaps.slice(0, 10);
    if (!data.length) return null;

    const x = d3
      .scaleBand()
      .domain(data.map((d) => d.map_id))
      .range([0, innerW])
      .padding(0.22);
    const y = d3
      .scaleLinear()
      .domain([0, d3.max(data, (d) => d.views) ?? 1])
      .nice()
      .range([innerH, 0]);

    return { width, height, margin, innerH, x, y, data };
  }, [state.topMaps]);

  const funnelChart = useMemo(() => {
    if (!state.funnel) return null;
    const width = 320;
    const height = 260;
    const radius = Math.min(width, height) / 2 - 12;
    const arcsData = [
      { label: "Impressions", value: state.funnel.impressions, color: "#60a5fa" },
      { label: "Clicks", value: state.funnel.clicks, color: "#f59e0b" },
      { label: "Conversion Hints", value: state.funnel.conversion_hints, color: "#34d399" }
    ].filter((d) => d.value > 0);
    if (!arcsData.length) return null;

    const pie = d3.pie<{ label: string; value: number; color: string }>().value((d) => d.value);
    const arc = d3.arc<d3.PieArcDatum<{ label: string; value: number; color: string }>>()
      .innerRadius(radius * 0.52)
      .outerRadius(radius);
    const total = arcsData.reduce((sum, row) => sum + row.value, 0);
    return { width, height, radius, arcs: pie(arcsData), arc, total };
  }, [state.funnel]);

  useEffect(() => {
    const start = performance.now();
    const durationMs = 700;
    const initial = engagementCounterRef.current;
    const target = engagementScore;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = Math.round(initial + (target - initial) * eased);
      engagementCounterRef.current = value;
      setEngagementCounter(value);
      if (t < 1) requestAnimationFrame(step);
    };
    const id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, [engagementScore]);

  if (state.loading && !state.overview) {
    return (
      <section className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Admin Analytics</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Loading...</p>
          </CardContent>
        </Card>
      </section>
    );
  }

  const overview = state.overview;
  if (!overview) {
    return (
      <section className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Admin Analytics</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">No analytics available yet.</p>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Admin Analytics</CardTitle>
          <CardDescription>Engagement, funnel, and security telemetry overview.</CardDescription>
          <CardAction>
            <Badge>Live Metrics</Badge>
          </CardAction>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Engagement Overview</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
            <div className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">Engagement Score</span>
              <strong className="text-4xl font-semibold">{formatCompact(engagementCounter)}</strong>
              <small className="text-sm text-muted-foreground">Weighted from views, downloads, votes, and session depth.</small>
            </div>
            {engagementMixChart ? (
              <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center">
                <svg viewBox={`0 0 ${engagementMixChart.width} ${engagementMixChart.height}`} className="w-full max-w-[220px]">
                  <g transform={`translate(${engagementMixChart.width / 2},${engagementMixChart.height / 2})`}>
                    {engagementMixChart.arcs.map((arcItem) => (
                      <path key={arcItem.data.label} d={engagementMixChart.arc(arcItem) ?? ""} fill={arcItem.data.color} />
                    ))}
                    <text textAnchor="middle" y={-4} fill="#dbeafe" fontSize={14} fontWeight={700}>
                      {formatCompact(engagementMixChart.total)}
                    </text>
                    <text textAnchor="middle" y={14} fill="#94a3b8" fontSize={11}>
                      Total Events
                    </text>
                  </g>
                </svg>
                <div className="flex flex-col gap-1.5">
                  {engagementMixChart.arcs.map((arcItem) => (
                    <div key={arcItem.data.label} className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: arcItem.data.color }} />
                      <small className="text-sm text-muted-foreground">
                        {arcItem.data.label}: {formatCompact(arcItem.data.value)}
                      </small>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <MetricCard label="Total Views" value={overview.total_views} />
            <MetricCard label="Total Downloads" value={overview.total_downloads} />
            <MetricCard label="Total Votes" value={overview.total_votes} />
            <MetricCard label="Avg View Duration (ms)" value={overview.avg_view_duration_ms} />
            <MetricCard
              label="Donation CTR"
              value={`${(overview.donation_click_through_rate * 100).toFixed(2)}%`}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Views Trend</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="analytics-from">From</Label>
              <Input id="analytics-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="analytics-to">To</Label>
              <Input id="analytics-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <Button variant="outline" onClick={() => analyticsStore.refreshAll(from, to)}>Refresh Range</Button>
          </div>
          {timeseriesChart ? (
            <div className="overflow-x-auto">
              <svg viewBox={`0 0 ${timeseriesChart.width} ${timeseriesChart.height}`} className="w-full min-w-[640px]">
                <g transform={`translate(${timeseriesChart.margin.left},${timeseriesChart.margin.top})`}>
                  {timeseriesChart.yTicks.map((tick) => (
                    <g key={`y-${tick}`} transform={`translate(0,${timeseriesChart.y(tick)})`}>
                      <line x1={0} x2={timeseriesChart.innerW} y1={0} y2={0} stroke="rgba(148,163,184,0.2)" />
                      <text x={-10} y={4} textAnchor="end" fill="#94a3b8" fontSize={11}>{tick}</text>
                    </g>
                  ))}
                  <path d={timeseriesChart.area(timeseriesChart.data) ?? ""} fill="url(#viewsArea)" />
                  <path d={timeseriesChart.line(timeseriesChart.data) ?? ""} fill="none" stroke="#60a5fa" strokeWidth={2.5} />
                  {timeseriesChart.data.map((d) => (
                    <circle key={d.day} cx={timeseriesChart.x(new Date(d.day))} cy={timeseriesChart.y(d.views)} r={3} fill="#93c5fd" />
                  ))}
                  {timeseriesChart.xTicks.map((tick) => (
                    <text
                      key={`x-${tick.toISOString()}`}
                      x={timeseriesChart.x(tick)}
                      y={timeseriesChart.innerH + 20}
                      textAnchor="middle"
                      fill="#94a3b8"
                      fontSize={11}
                    >
                      {d3.timeFormat("%m-%d")(tick)}
                    </text>
                  ))}
                </g>
                <defs>
                  <linearGradient id="viewsArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgba(96,165,250,0.45)" />
                    <stop offset="100%" stopColor="rgba(96,165,250,0.02)" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
          ) : <p className="text-sm text-muted-foreground">No timeseries data yet.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Top Maps</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {topMapsChart ? (
            <div className="overflow-x-auto">
              <svg viewBox={`0 0 ${topMapsChart.width} ${topMapsChart.height}`} className="w-full min-w-[640px]">
                <g transform={`translate(${topMapsChart.margin.left},${topMapsChart.margin.top})`}>
                  {topMapsChart.data.map((map) => {
                    const x = topMapsChart.x(map.map_id) ?? 0;
                    const y = topMapsChart.y(map.views);
                    const h = topMapsChart.innerH - y;
                    return (
                      <g key={map.map_id}>
                        <rect x={x} y={y} width={topMapsChart.x.bandwidth()} height={h} rx={6} fill="#f59e0b" />
                        <text x={x + topMapsChart.x.bandwidth() / 2} y={y - 6} textAnchor="middle" fill="#fde68a" fontSize={11}>
                          {map.views}
                        </text>
                        <text
                          transform={`translate(${x + topMapsChart.x.bandwidth() / 2},${topMapsChart.innerH + 14}) rotate(35)`}
                          textAnchor="start"
                          fill="#94a3b8"
                          fontSize={10}
                        >
                          {map.map_id.slice(0, 28)}
                        </text>
                      </g>
                    );
                  })}
                </g>
              </svg>
            </div>
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Map</TableHead>
                <TableHead>Views</TableHead>
                <TableHead>Downloads</TableHead>
                <TableHead>Votes</TableHead>
                <TableHead>Avg Duration (ms)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.topMaps.map((map) => (
                <TableRow key={map.map_id}>
                  <TableCell>{map.map_id}</TableCell>
                  <TableCell>{map.views}</TableCell>
                  <TableCell>{map.downloads}</TableCell>
                  <TableCell>{map.votes}</TableCell>
                  <TableCell>{map.avg_duration_ms}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Donation Funnel</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Map</Label>
              <Select value={selectedMap || "__all__"} onValueChange={(v) => setSelectedMap(v === "__all__" ? "" : v)}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All Maps</SelectItem>
                  {state.topMaps.map((m) => (
                    <SelectItem key={m.map_id} value={m.map_id}>
                      {m.map_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" onClick={() => analyticsStore.loadFunnel(selectedMap || undefined, from, to)}>
              Refresh Funnel
            </Button>
          </div>
          {state.funnel && (
            <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
              {funnelChart ? (
                <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center">
                  <svg viewBox={`0 0 ${funnelChart.width} ${funnelChart.height}`} className="w-full max-w-[220px]">
                    <g transform={`translate(${funnelChart.width / 2},${funnelChart.height / 2})`}>
                      {funnelChart.arcs.map((arcItem) => (
                        <path key={arcItem.data.label} d={funnelChart.arc(arcItem) ?? ""} fill={arcItem.data.color} />
                      ))}
                      <text textAnchor="middle" y={-4} fill="#dbeafe" fontSize={14} fontWeight={700}>
                        {formatCompact(funnelChart.total)}
                      </text>
                      <text textAnchor="middle" y={14} fill="#94a3b8" fontSize={11}>
                        Funnel Events
                      </text>
                    </g>
                  </svg>
                  <div className="flex flex-col gap-1.5">
                    {funnelChart.arcs.map((arcItem) => (
                      <div key={arcItem.data.label} className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: arcItem.data.color }} />
                        <small className="text-sm text-muted-foreground">
                          {arcItem.data.label}: {formatCompact(arcItem.data.value)} ({Math.round((arcItem.data.value / Math.max(1, funnelChart.total)) * 100)}%)
                        </small>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <MetricCard label="Impressions" value={state.funnel.impressions} />
                <MetricCard label="Clicks" value={state.funnel.clicks} />
                <MetricCard label="Conversion Hints" value={state.funnel.conversion_hints} />
                <MetricCard label="CTR" value={`${(state.funnel.ctr * 100).toFixed(2)}%`} />
                <MetricCard
                  label="Conversion Hint Rate"
                  value={`${(state.funnel.conversion_hint_rate * 100).toFixed(2)}%`}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Application Security (24h)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <MetricCard label="Active Sessions" value={overview.app.active_sessions} />
            <MetricCard label="Login Success" value={overview.app.auth_login_success_24h} />
            <MetricCard label="Login Failures" value={overview.app.auth_login_failed_24h} />
            <MetricCard label="CSRF Failures" value={overview.app.csrf_failures_24h} />
            <MetricCard label="Unauthorized" value={overview.app.unauthorized_24h} />
            <MetricCard label="Rate Limited" value={overview.app.rate_limited_24h} />
            <MetricCard label="Consent Denied" value={overview.app.consent_denied_24h} />
            <MetricCard label="Tracked Views (24h)" value={overview.app.tracked_views_24h} />
            <MetricCard
              label="Tracked Donations (24h)"
              value={overview.app.tracked_donations_24h}
            />
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function overviewDurationToMinutes(durationMs: number): number {
  return Math.max(0, durationMs) / 1000 / 60;
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
