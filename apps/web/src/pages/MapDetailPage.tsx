import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { deleteJson, getJson, postJson } from "../api/client";
import { authStore } from "../stores/authStore";
import type { MapSummary } from "../types/map";
import type { MapPreview } from "../types/map";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { FEATURE_FLAGS } from "@/lib/featureFlags";

const MonacoEditor = lazy(() => import("@monaco-editor/react"));

type MapDetailPayload = {
  map: {
    id: string;
    name: string;
    path: string;
    tags?: string[];
    about_md?: string;
    about_html?: string;
    poi?: unknown;
    status?: string;
  };
  stats: { views: number; downloads: number; votes: number } | null;
  preview: MapPreview;
  donation_url?: string | null;
  user_voted?: boolean;
};

type PoiEntry = { id: string; x: number; y: number; label: string; note?: string };

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const STILL_PROCESSING_POLL_MS = 4000;

function normalizePoi(value: unknown): PoiEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const x = Number(row.x);
      const y = Number(row.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return {
        id: String(row.id ?? crypto.randomUUID()),
        x,
        y,
        label: String(row.label ?? "POI"),
        note: row.note ? String(row.note) : ""
      } as PoiEntry;
    })
    .filter((v): v is PoiEntry => Boolean(v));
}

export function MapDetailPage() {
  const { id } = useParams();
  const normalizedMapId = useMemo(() => {
    const raw = id ?? "";
    try {
      return encodeURIComponent(decodeURIComponent(raw));
    } catch {
      return encodeURIComponent(raw);
    }
  }, [id]);

  const [detail, setDetail] = useState<MapDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userVoted, setUserVoted] = useState(false);
  const [auth, setAuth] = useState(authStore.state$.value);
  const [relatedMaps, setRelatedMaps] = useState<MapSummary[]>([]);
  const [poi, setPoi] = useState<PoiEntry[]>([]);
  const [editPoiMode, setEditPoiMode] = useState(false);
  const [savingPoi, setSavingPoi] = useState(false);
  const [dd2vttCountdown, setDd2vttCountdown] = useState<number | null>(null);
  const [dd2vttDialogOpen, setDd2vttDialogOpen] = useState(false);
  const [dd2vttDownloading, setDd2vttDownloading] = useState(false);
  const dd2vttFiredRef = useRef(false);
  const [metadataName, setMetadataName] = useState("");
  const [metadataTags, setMetadataTags] = useState("");
  const [metadataAbout, setMetadataAbout] = useState("");
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [metadataMode, setMetadataMode] = useState<"view" | "edit">("view");

  // pan/zoom viewer state
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragState = useRef<{ dragging: boolean; startX: number; startY: number; panX: number; panY: number }>({
    dragging: false,
    startX: 0,
    startY: 0,
    panX: 0,
    panY: 0
  });

  const isAdmin = auth.user?.role === "admin";
  const isSuperAdmin = Boolean(auth.user?.is_super_admin);
  const canDownloadDd2vtt = auth.authenticated && auth.user?.role !== "guest";
  const poiEditorEnabled = FEATURE_FLAGS.poiEditor && isAdmin;

  useEffect(() => {
    if (!id || !normalizedMapId) return;
    const sessionId = crypto.randomUUID();
    const start = Date.now();
    postJson(`/api/v1/maps/${normalizedMapId}/view-start`, { session_id: sessionId }).catch(console.error);
    return () => {
      const duration_ms = Date.now() - start;
      postJson(`/api/v1/maps/${normalizedMapId}/view-end`, { session_id: sessionId, duration_ms }).catch(console.error);
    };
  }, [id, normalizedMapId]);

  useEffect(() => {
    authStore.refresh().catch(() => undefined);
    const sub = authStore.state$.subscribe(setAuth);
    return () => sub.unsubscribe();
  }, []);

  const loadDetail = useCallback(() => {
    if (!id || !normalizedMapId) return Promise.resolve();
    return getJson<MapDetailPayload>(`/api/v1/maps/${normalizedMapId}`).then((payload) => {
      setDetail(payload);
      setUserVoted(Boolean(payload.user_voted));
      setPoi(normalizePoi(payload.map.poi));
      setMetadataName(payload.map.name ?? "");
      setMetadataTags((payload.map.tags ?? []).join(", "));
      setMetadataAbout(payload.map.about_md ?? "");
      setMetadataMode("view");
      return payload;
    });
  }, [id, normalizedMapId]);

  useEffect(() => {
    if (!id || !normalizedMapId) return;
    setLoading(true);
    setError(null);
    loadDetail()
      .then((payload) => {
        if (!payload) return;
        return postJson("/api/v1/analytics/donation", {
          event_type: "impression",
          placement: "map_detail_cta",
          map_id: payload.map.id
        }).catch(() => undefined);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "failed to load map");
      })
      .finally(() => setLoading(false));
  }, [id, normalizedMapId, loadDetail]);

  // Poll for status while the map's preview isn't ready yet (processing pipeline still running).
  useEffect(() => {
    if (!id || !normalizedMapId) return;
    if (!detail) return;
    if (detail.preview.available) return;
    const status = detail.map.status;
    if (status === "error") return;
    const timer = window.setInterval(() => {
      loadDetail().catch(() => undefined);
    }, STILL_PROCESSING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [id, normalizedMapId, detail, loadDetail]);

  useEffect(() => {
    if (!id || !normalizedMapId) return;
    getJson<{ items?: MapSummary[]; maps?: MapSummary[] }>(
      `/api/v1/maps/${normalizedMapId}/related?limit=8`
    )
      .then((payload) => setRelatedMaps(payload.items ?? payload.maps ?? []))
      .catch(() => setRelatedMaps([]));
  }, [id, normalizedMapId]);

  const donateUrl = useMemo(() => detail?.donation_url ?? "https://ko-fi.com/mbround18", [detail?.donation_url]);
  const preview = detail?.preview;

  const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

  const fitToViewport = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height || !preview?.width || !preview?.height) return;
    const scale = clampZoom(Math.min(rect.width / preview.width, rect.height / preview.height));
    setZoom(scale);
    setPan({
      x: (rect.width - preview.width * scale) / 2,
      y: (rect.height - preview.height * scale) / 2
    });
  }, [preview?.width, preview?.height]);

  // Land on a fully-zoomed-out view of the map instead of native pixel scale,
  // which for large source images looked "zoomed in" by default.
  useEffect(() => {
    if (!preview?.available) return;
    fitToViewport();
  }, [preview?.available, preview?.width, preview?.height, fitToViewport]);

  // React registers onWheel as a passive native listener, so preventDefault()
  // inside a synthetic handler can't stop the page from scrolling underneath
  // the viewer. Attach a real, non-passive listener directly to the element
  // instead so wheeling over the canvas zooms it without touching page scroll.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !preview?.available) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const delta = event.deltaY > 0 ? 0.9 : 1.1;
      setZoom((prevZoom) => {
        const nextZoom = clampZoom(prevZoom * delta);
        setPan((prevPan) => ({
          x: pointerX - ((pointerX - prevPan.x) / prevZoom) * nextZoom,
          y: pointerY - ((pointerY - prevPan.y) / prevZoom) * nextZoom
        }));
        return nextZoom;
      });
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [preview?.available]);

  // Left-click drags to pan; middle-click (button 1) always pans too, WebGL-map-style,
  // regardless of POI edit mode -- and we suppress its native autoscroll behavior.
  const isPannableButton = (button: number) => button === 0 || button === 1;

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!preview?.available) return;
    if (!isPannableButton(event.button)) return;
    if (event.button === 1) event.preventDefault();
    if (poiEditorEnabled && editPoiMode && event.button === 0) return;
    (event.target as Element).setPointerCapture?.(event.pointerId);
    dragState.current = { dragging: true, startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current.dragging) return;
    const dx = event.clientX - dragState.current.startX;
    const dy = event.clientY - dragState.current.startY;
    setPan({ x: dragState.current.panX + dx, y: dragState.current.panY + dy });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    dragState.current.dragging = false;
    (event.target as Element).releasePointerCapture?.(event.pointerId);
  };

  const onAuxClick = (event: React.MouseEvent<HTMLDivElement>) => {
    // Stop the browser's default middle-click behavior (e.g. paste-navigate) inside the viewer.
    if (event.button === 1) event.preventDefault();
  };

  const onViewportClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!poiEditorEnabled || !editPoiMode || !preview?.available) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const localX = event.clientX - rect.left - pan.x;
    const localY = event.clientY - rect.top - pan.y;
    const wx = Math.max(0, Math.round(localX / zoom));
    const wy = Math.max(0, Math.round(localY / zoom));
    setPoi((prev) => [...prev, { id: crypto.randomUUID(), x: wx, y: wy, label: `POI ${prev.length + 1}`, note: "" }]);
  };

  const resetView = () => {
    fitToViewport();
  };

  const onDownloadImage = () => {
    if (!preview?.image_url) return;
    window.open(preview.image_url, "_blank", "noopener,noreferrer");
  };

  const dd2vttFilename = useMemo(() => {
    const base = (detail?.map.name || detail?.map.path || "map")
      .replace(/[^a-z0-9-_ ]+/gi, "")
      .trim();
    return `${base || "map"}.dd2vtt`;
  }, [detail?.map.name, detail?.map.path]);

  const saveFileToDisk = async (url: string, filename: string) => {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) throw new Error(`download failed: ${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  };

  const onStartDd2vttCountdown = () => {
    if (!canDownloadDd2vtt) return;
    dd2vttFiredRef.current = false;
    setDd2vttDialogOpen(true);
    setDd2vttCountdown(5);
  };

  const closeDd2vttDialog = () => {
    setDd2vttDialogOpen(false);
    setDd2vttCountdown(null);
    setDd2vttDownloading(false);
  };

  const onDownloadDd2vtt = async () => {
    if (!id || !normalizedMapId || !preview?.dd2vtt_download_url || !canDownloadDd2vtt) return;
    setDd2vttDownloading(true);
    try {
      await postJson(`/api/v1/maps/${normalizedMapId}/download`).catch(() => undefined);
      try {
        await saveFileToDisk(preview.dd2vtt_download_url, dd2vttFilename);
      } catch {
        // Cross-origin storage host may not allow fetch()/CORS -- fall back to a plain navigation.
        window.open(preview.dd2vtt_download_url, "_blank", "noopener,noreferrer");
      }
    } finally {
      closeDd2vttDialog();
    }
  };

  const triggerDd2vttDownload = () => {
    if (dd2vttFiredRef.current) return;
    dd2vttFiredRef.current = true;
    onDownloadDd2vtt();
  };

  useEffect(() => {
    if (dd2vttCountdown === null) return;
    if (dd2vttCountdown <= 0) {
      triggerDd2vttDownload();
      return;
    }
    const t = window.setTimeout(() => setDd2vttCountdown((v) => (v ?? 1) - 1), 1000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dd2vttCountdown]);

  const onDonate = async () => {
    if (!id || !normalizedMapId) return;
    await postJson("/api/v1/analytics/donation", {
      event_type: "click",
      placement: "map_detail_cta",
      map_id: normalizedMapId
    }).catch(() => undefined);
    window.open(donateUrl, "_blank", "noopener,noreferrer");
  };

  const toggleVote = async () => {
    if (!id || !normalizedMapId) return;
    try {
      if (userVoted) {
        await deleteJson(`/api/v1/maps/${normalizedMapId}/vote`);
        setUserVoted(false);
        setDetail((prev) =>
          prev
            ? {
                ...prev,
                stats: prev.stats ? { ...prev.stats, votes: Math.max(0, prev.stats.votes - 1) } : prev.stats
              }
            : prev
        );
      } else {
        await postJson(`/api/v1/maps/${normalizedMapId}/vote`);
        setUserVoted(true);
        setDetail((prev) =>
          prev
            ? {
                ...prev,
                stats: prev.stats ? { ...prev.stats, votes: prev.stats.votes + 1 } : prev.stats
              }
            : prev
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "vote failed");
    }
  };

  const removePoi = (poiId: string) => {
    setPoi((prev) => prev.filter((entry) => entry.id !== poiId));
  };

  const updatePoi = (poiId: string, patch: Partial<PoiEntry>) => {
    setPoi((prev) => prev.map((entry) => (entry.id === poiId ? { ...entry, ...patch } : entry)));
  };

  const savePoiMetadata = async () => {
    if (!id || !normalizedMapId || !poiEditorEnabled) return;
    setSavingPoi(true);
    setError(null);
    try {
      await postJson(`/api/v1/admin/maps/metadata/${normalizedMapId}`, { poi });
      setDetail((prev) => (prev ? { ...prev, map: { ...prev.map, poi } } : prev));
      setEditPoiMode(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to save POIs");
    } finally {
      setSavingPoi(false);
    }
  };

  const saveMapMetadata = async () => {
    if (!id || !normalizedMapId || !isSuperAdmin) return;
    setSavingMetadata(true);
    setError(null);
    try {
      const tags = metadataTags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      await postJson(`/api/v1/admin/maps/metadata/${normalizedMapId}`, {
        display_name: metadataName.trim(),
        tags,
        about_md: metadataAbout
      });
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              map: {
                ...prev.map,
                name: metadataName.trim() || prev.map.name,
                tags,
                about_md: metadataAbout
              }
            }
          : prev
      );
      setMetadataMode("view");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to save metadata");
    } finally {
      setSavingMetadata(false);
    }
  };

  const discardMapMetadataChanges = () => {
    if (!detail) return;
    setMetadataName(detail.map.name ?? "");
    setMetadataTags((detail.map.tags ?? []).join(", "));
    setMetadataAbout(detail.map.about_md ?? "");
    setMetadataMode("view");
  };

  const startEditingMetadata = () => {
    if (!isSuperAdmin) return;
    setMetadataMode("edit");
  };

  const discardPoiChanges = () => {
    setPoi(normalizePoi(detail?.map.poi));
    setEditPoiMode(false);
  };

  const processingMessage =
    detail?.map.status === "error"
      ? "Map processing failed. An admin can re-run asset sync."
      : "Preparing the full-size preview image, check back shortly...";

  return (
    <div className="flex flex-col gap-6">
      <Card className="border-border/60">
        <CardContent className="flex flex-col gap-4 px-6 pt-2 pb-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium uppercase tracking-wide text-primary">Map Detail</p>
            <h2 className="text-2xl font-semibold tracking-tight">{detail?.map.name ?? "Loading map..."}</h2>
            <p className="text-muted-foreground">{detail?.map.path ?? "Preparing explorer and map telemetry..."}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(detail?.map.tags ?? []).map((tag) => (
              <Badge variant="outline" key={`${detail?.map.id}-${tag}`}>
                {tag}
              </Badge>
            ))}
            <Badge>Tracking Active</Badge>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-6">
        <Card className="border-border/60">
          <CardContent className="flex flex-col gap-3 px-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setZoom((z) => clampZoom(z * 1.2))}
                  disabled={!preview?.available}
                >
                  Zoom In
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setZoom((z) => clampZoom(z / 1.2))}
                  disabled={!preview?.available}
                >
                  Zoom Out
                </Button>
                <Button size="sm" variant="outline" onClick={resetView} disabled={!preview?.available}>
                  Reset View
                </Button>
              </div>
              <span className="text-sm text-muted-foreground">
                Scroll to zoom. Drag or middle-click-drag to pan.
              </span>
            </div>
            {preview?.available ? (
              <div
                ref={viewportRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerUp}
                onAuxClick={onAuxClick}
                onClick={onViewportClick}
                className="relative h-[70vh] min-h-[480px] w-full overflow-hidden rounded-lg border border-border/60 bg-muted"
                style={{
                  cursor:
                    poiEditorEnabled && editPoiMode
                      ? "crosshair"
                      : dragState.current.dragging
                        ? "grabbing"
                        : "grab",
                  touchAction: "none",
                  overscrollBehavior: "contain"
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    transformOrigin: "0 0",
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
                  }}
                >
                  <img
                    src={preview.image_url}
                    alt={detail?.map.name ?? "Map preview"}
                    draggable={false}
                    style={{ display: "block", maxWidth: "none", userSelect: "none" }}
                    width={preview.width}
                    height={preview.height}
                  />
                  {poi.map((entry) => (
                    <div
                      key={entry.id}
                      style={{
                        position: "absolute",
                        left: entry.x,
                        top: entry.y,
                        transform: "translate(-50%, -50%)",
                        pointerEvents: "none"
                      }}
                      title={entry.note}
                      className="flex flex-col items-center gap-1"
                    >
                      <span className="block h-3 w-3 rounded-full border-2 border-background bg-primary shadow" />
                      <span className="whitespace-nowrap rounded bg-background/90 px-1.5 py-0.5 text-xs font-medium shadow">
                        {entry.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex min-h-[480px] items-center justify-center rounded-lg border border-dashed border-border/60 text-center text-muted-foreground">
                {processingMessage}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4 sm:grid-cols-2">
          <Card className="border-border/60">
            <CardHeader>
              <CardTitle>Actions</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 px-6">
              <div className="flex flex-wrap gap-2">
                <Button onClick={onDownloadImage} disabled={!preview?.image_url}>
                  Download Image
                </Button>
                {canDownloadDd2vtt ? (
                  <Button variant="outline" onClick={onStartDd2vttCountdown} disabled={!preview?.dd2vtt_download_url}>
                    Download DD2VTT
                  </Button>
                ) : (
                  <Badge variant="secondary">Sign in as User+ for DD2VTT</Badge>
                )}
                <Button variant="outline" onClick={toggleVote}>
                  {userVoted ? "Remove Thumbs Up" : "Thumbs Up"}
                </Button>
                <Button variant="secondary" onClick={onDonate}>
                  Donate
                </Button>
              </div>
            </CardContent>
          </Card>

          <Dialog
            open={dd2vttDialogOpen}
            onOpenChange={(open) => {
              if (!open) closeDd2vttDialog();
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Support the project before you download</DialogTitle>
                <DialogDescription>
                  This DD2VTT file is free. If it&apos;s useful to you, a donation helps keep new maps coming.
                </DialogDescription>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                {dd2vttDownloading
                  ? "Saving the file to your device..."
                  : `Your download starts automatically in ${dd2vttCountdown ?? 0}s.`}
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={closeDd2vttDialog} disabled={dd2vttDownloading}>
                  Cancel
                </Button>
                <Button variant="secondary" onClick={onDonate}>
                  Donate
                </Button>
                <Button onClick={triggerDd2vttDownload} disabled={dd2vttDownloading}>
                  {dd2vttDownloading ? "Downloading..." : "Download Now"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Card className="border-border/60">
            <CardHeader>
              <CardTitle>Legend &amp; Stats</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 px-6">
              {detail?.stats ? (
                <div className="grid grid-cols-3 gap-2">
                  <div className="min-w-0 rounded-lg border border-border/60 p-2 text-center">
                    <strong className="block truncate text-[11px] leading-tight font-medium tracking-normal text-muted-foreground uppercase">
                      Views
                    </strong>
                    <div className="mt-1 text-lg font-semibold">{detail.stats.views}</div>
                  </div>
                  <div className="min-w-0 rounded-lg border border-border/60 p-2 text-center">
                    <strong className="block truncate text-[11px] leading-tight font-medium tracking-normal text-muted-foreground uppercase">
                      Downloads
                    </strong>
                    <div className="mt-1 text-lg font-semibold">{detail.stats.downloads}</div>
                  </div>
                  <div className="min-w-0 rounded-lg border border-border/60 p-2 text-center">
                    <strong className="block truncate text-[11px] leading-tight font-medium tracking-normal text-muted-foreground uppercase">
                      Votes
                    </strong>
                    <div className="mt-1 text-lg font-semibold">{detail.stats.votes}</div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No stats yet.</p>
              )}
              <div className="overflow-x-auto rounded-md bg-muted px-3 py-2">
                <code className="text-xs">{detail?.map.id ?? id}</code>
              </div>
            </CardContent>
          </Card>
        </div>

        {poiEditorEnabled ? (
          <Card className="border-border/60">
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div className="flex flex-col gap-1.5">
                <CardTitle>POI Edit Mode</CardTitle>
                <CardDescription>Toggle edit mode and click the map to add POIs in real time.</CardDescription>
              </div>
              <Badge variant={editPoiMode ? "secondary" : "outline"}>{editPoiMode ? "Edit" : "View"}</Badge>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 px-6">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditPoiMode((v) => !v)}>
                  {editPoiMode ? "Stop Editing" : "Edit POIs"}
                </Button>
                <Button size="sm" onClick={savePoiMetadata} disabled={!editPoiMode || savingPoi}>
                  {savingPoi ? "Saving..." : "Save POIs"}
                </Button>
                <Button size="sm" variant="ghost" onClick={discardPoiChanges} disabled={!editPoiMode}>
                  Discard
                </Button>
              </div>
              <div className="flex flex-col gap-2">
                {poi.map((entry) => (
                  <div key={entry.id} className="flex flex-col gap-2 rounded-md border border-border/60 p-3">
                    <div className="flex flex-col gap-1.5">
                      <Label>Label</Label>
                      <Input
                        value={entry.label}
                        onChange={(e) => updatePoi(entry.id, { label: e.target.value })}
                        disabled={!editPoiMode}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>Note</Label>
                      <Input
                        value={entry.note ?? ""}
                        onChange={(e) => updatePoi(entry.id, { note: e.target.value })}
                        disabled={!editPoiMode}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">
                        x:{entry.x} y:{entry.y}
                      </span>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={!editPoiMode}
                        onClick={() => removePoi(entry.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
                {!poi.length ? <p className="text-sm text-muted-foreground">No POIs yet.</p> : null}
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Card className="border-border/60">
        <CardHeader>
          <CardTitle>About This Map</CardTitle>
          <CardDescription>Context, lore, and setup notes.</CardDescription>
        </CardHeader>
        <CardContent className="px-6">
          {detail?.map.about_md ? (
            detail.map.about_html ? (
              <div
                className="prose prose-invert max-w-none text-sm"
                dangerouslySetInnerHTML={{ __html: detail.map.about_html }}
              />
            ) : (
              <pre className="whitespace-pre-wrap text-sm text-muted-foreground">{detail.map.about_md}</pre>
            )
          ) : (
            <p className="text-sm text-muted-foreground">No about content available yet.</p>
          )}
        </CardContent>
      </Card>

      {isSuperAdmin ? (
        <Card className="border-border/60">
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <CardTitle>Map Metadata Editor</CardTitle>
              <CardDescription>Super admin-only display name, tags, and markdown controls.</CardDescription>
            </div>
            <Badge variant="secondary">{metadataMode === "edit" ? "Edit Mode" : "View Mode"}</Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 px-6">
            {metadataMode === "view" ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Display Name</p>
                    <p className="text-sm">{metadataName || "—"}</p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Tags</p>
                    <div className="flex flex-wrap gap-1.5">
                      {metadataTags
                        .split(",")
                        .map((tag) => tag.trim())
                        .filter(Boolean)
                        .map((tag) => (
                          <Badge variant="outline" key={tag}>
                            {tag}
                          </Badge>
                        ))}
                      {!metadataTags.trim() ? <p className="text-sm text-muted-foreground">No tags.</p> : null}
                    </div>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">About (Markdown)</p>
                  <pre className="max-h-[280px] overflow-auto rounded-md border border-border/60 bg-muted p-3 text-sm whitespace-pre-wrap">
                    {metadataAbout || "No about content yet."}
                  </pre>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={startEditingMetadata}>Edit Metadata</Button>
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="metadata-name">Display Name</Label>
                    <Input
                      id="metadata-name"
                      value={metadataName}
                      onChange={(e) => setMetadataName(e.target.value)}
                      placeholder="Dwarven Forge"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="metadata-tags">Tags (comma-separated)</Label>
                    <Input
                      id="metadata-tags"
                      value={metadataTags}
                      onChange={(e) => setMetadataTags(e.target.value)}
                      placeholder="Dungeons, Dwarven Forge"
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <p className="text-sm text-muted-foreground">About (Markdown)</p>
                  <div className={cn("overflow-hidden rounded-md border border-border/60")}>
                    <Suspense fallback={<Skeleton className="h-[280px] w-full" />}>
                      <MonacoEditor
                        height="280px"
                        defaultLanguage="markdown"
                        language="markdown"
                        theme="vs-dark"
                        value={metadataAbout}
                        onChange={(value) => setMetadataAbout(value ?? "")}
                        options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: "on" }}
                      />
                    </Suspense>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={saveMapMetadata} disabled={savingMetadata}>
                    {savingMetadata ? "Saving..." : "Save Metadata"}
                  </Button>
                  <Button variant="outline" onClick={discardMapMetadataChanges} disabled={savingMetadata}>
                    Discard Changes
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-border/60">
        <CardHeader>
          <CardTitle>Continue Exploring</CardTitle>
          <CardDescription>Related maps chosen by shared tags and nearby world paths.</CardDescription>
        </CardHeader>
        <CardContent className="px-6">
          <div className="flex gap-3 overflow-x-auto pb-2">
            {relatedMaps.map((map) => (
              <Link
                key={map.id}
                to={`/maps/${encodeURIComponent(map.id)}`}
                className="w-48 shrink-0 rounded-lg border border-border/60 p-3 transition-colors hover:border-primary/60 hover:bg-accent"
              >
                <div className="truncate font-medium">{map.name}</div>
                <div className="truncate text-sm text-muted-foreground">{map.path}</div>
              </Link>
            ))}
            {!relatedMaps.length ? (
              <p className="text-sm text-muted-foreground">No related maps yet. Sync more assets to enrich recommendations.</p>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
