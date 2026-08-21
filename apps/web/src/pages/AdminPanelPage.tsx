import { useEffect, useState } from "react";
import { adminStore } from "../stores/adminStore";
import { analyticsStore } from "../stores/analyticsStore";
import { mapsStore } from "../stores/mapsStore";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardAction } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";

function MetricTile(props: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <div className="text-sm font-medium text-muted-foreground">{props.label}</div>
      <div className="mt-1 text-2xl font-semibold">{props.value}</div>
    </div>
  );
}

export function AdminPanelPage() {
  const [admin, setAdmin] = useState(adminStore.state$.value);
  const [analytics, setAnalytics] = useState(analyticsStore.state$.value);
  const [maps, setMaps] = useState(mapsStore.state$.value);
  const [error, setError] = useState<string | null>(null);
  const [syncingAssets, setSyncingAssets] = useState(false);
  const [regeneratingDeployKey, setRegeneratingDeployKey] = useState(false);
  const [lastAssetJobId, setLastAssetJobId] = useState<string | null>(null);
  const [deployKeyCopied, setDeployKeyCopied] = useState(false);

  useEffect(() => {
    Promise.all([
      adminStore.loadUsers(),
      adminStore.loadAssets(),
      adminStore.loadDeployKey(),
      adminStore.loadSecurity(),
      adminStore.loadJobs(),
      mapsStore.load(),
      analyticsStore.loadOverview()
    ]).catch(console.error);

    const poll = window.setInterval(() => {
      Promise.all([adminStore.loadAssets(), adminStore.loadJobs()]).catch(console.error);
    }, 3000);

    const a = adminStore.state$.subscribe(setAdmin);
    const an = analyticsStore.state$.subscribe(setAnalytics);
    const m = mapsStore.state$.subscribe(setMaps);
    return () => {
      window.clearInterval(poll);
      a.unsubscribe();
      an.unsubscribe();
      m.unsubscribe();
    };
  }, []);

  const syncAssets = async () => {
    setError(null);
    setSyncingAssets(true);
    try {
      const result = await adminStore.enqueueAssetSync();
      setLastAssetJobId(result.job_id);
      await Promise.all([adminStore.loadAssets(), adminStore.loadJobs()]);
      toast.success("Asset sync triggered");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to enqueue asset sync");
    } finally {
      setSyncingAssets(false);
    }
  };

  const copyDeployKey = async () => {
    if (!admin.deployKey?.public_key) {
      return;
    }
    await navigator.clipboard.writeText(admin.deployKey.public_key);
    setDeployKeyCopied(true);
    setTimeout(() => setDeployKeyCopied(false), 1500);
  };

  const regenerateDeployKey = async () => {
    setError(null);
    setRegeneratingDeployKey(true);
    try {
      await adminStore.regenerateDeployKey();
      await adminStore.loadAssets();
      toast.success("Deploy key regenerated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to regenerate deploy key");
    } finally {
      setRegeneratingDeployKey(false);
    }
  };

  return (
    <section className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Admin Panel</CardTitle>
          <CardDescription>Unified operations dashboard for users, analytics, jobs, assets, and catalog manifest.</CardDescription>
          <CardAction>
            <Badge>Operations</Badge>
          </CardAction>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>System Snapshot</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MetricTile label="Users" value={admin.usersPagination.total || admin.users.length} />
            <MetricTile label="Catalog Maps" value={maps.maps.length} />
            <MetricTile label="Total Views" value={analytics.overview?.total_views ?? 0} />
            <MetricTile label="Total Downloads" value={analytics.overview?.total_downloads ?? 0} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Security</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Audit Chain</span>
              <span className="font-medium">{admin.security.audit_integrity?.ok ? "valid" : "broken"}</span>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm">
              <span className="text-muted-foreground">JWT Rotation</span>
              <span className="font-medium">{admin.security.secrets?.jwt.previous ?? "retired"}</span>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm">
              <span className="text-muted-foreground">OAuth Rotation</span>
              <span className="font-medium">{admin.security.secrets?.discord_oauth.previous ?? "retired"}</span>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Deploy Key Encryption</span>
              <span className="font-medium">{admin.security.secrets?.deploy_key_encryption.version ?? "n/a"}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Asset Status</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {admin.assets ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Branch</span>
                <span className="font-medium">{admin.assets.branch}</span>
              </div>
              <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm">
                <span className="text-muted-foreground">SHA</span>
                <span className="font-medium">{admin.assets.sha ?? "n/a"}</span>
              </div>
              <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Index State</span>
                <span className="font-medium">{admin.assets.index_state}</span>
              </div>
              {admin.assets.processing ? (
                <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm">
                  <span className="text-muted-foreground">Postprocess</span>
                  <span className="font-medium">
                    T:{admin.assets.processing.thumbnails_ready}/{admin.assets.processing.total_maps} M:
                    {admin.assets.processing.manifests_ready}/{admin.assets.processing.total_maps} Tiles:
                    {admin.assets.processing.tiles_ready}/{admin.assets.processing.total_maps}
                  </span>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No asset status loaded yet.</p>
          )}

          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">Actions</h4>
            <div className="flex flex-wrap gap-2">
              <Button onClick={syncAssets} disabled={syncingAssets}>
                {syncingAssets ? "Syncing..." : "Sync"}
              </Button>
            </div>
            {lastAssetJobId ? (
              <p className="text-sm text-muted-foreground">
                Last sync job: <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{lastAssetJobId}</code>
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">Repository Deploy Key (SSH)</h4>
            <p className="text-sm text-muted-foreground">
              Add this public key as a read-only deploy key on the assets repository.
            </p>
            {admin.deployKey ? (
              <>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">Key Name</span>
                    <span className="font-medium">{admin.deployKey.key_name}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">Algorithm</span>
                    <span className="font-medium">{admin.deployKey.algorithm}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">Last Used</span>
                    <span className="font-medium">{admin.deployKey.last_used_at ?? "never"}</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="ghost" onClick={copyDeployKey}>
                    {deployKeyCopied ? "Copied" : "Copy Public Key"}
                  </Button>
                  <Button onClick={regenerateDeployKey} disabled={regeneratingDeployKey}>
                    {regeneratingDeployKey ? "Regenerating..." : "Regenerate Key Pair"}
                  </Button>
                </div>
                <pre className="overflow-auto rounded-md bg-muted p-3 text-xs text-muted-foreground">
                  {admin.deployKey.public_key}
                </pre>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Deploy key not loaded yet.</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            {admin.jobs.map((job) => (
              <div
                key={job.id}
                className="flex flex-col gap-1 rounded-md border border-border/60 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span>
                  {job.job_type} • {job.status}
                  {job.queue_type ? ` • ${job.queue_type}` : ""}
                  {typeof job.priority === "number" ? ` • p${job.priority}` : ""}
                </span>
                <span className="text-muted-foreground">
                  {job.progress ? `${job.progress.processed}/${job.progress.total} ${job.progress.phase}` : "no progress"}
                  {job.error_class ? ` • ${job.error_class}` : ""}
                  {job.runbook_slug ? ` • ${job.runbook_slug}` : ""}
                </span>
              </div>
            ))}
            {admin.jobs.length === 0 ? <p className="text-sm text-muted-foreground">No jobs yet.</p> : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Catalog Manifest</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            {maps.maps.slice(0, 30).map((map) => (
              <div
                key={map.id}
                className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm"
              >
                <span>{map.name}</span>
                <span className="text-muted-foreground">{map.path}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
