import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { adminStore } from "../stores/adminStore";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardAction } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function AdminAssetsPage() {
  const [state, setState] = useState(adminStore.state$.value);
  const [lastJobId, setLastJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([adminStore.loadAssets(), adminStore.loadDeployKey(), adminStore.loadJobs()]).catch(console.error);
    const poll = window.setInterval(() => {
      Promise.all([adminStore.loadAssets(), adminStore.loadJobs()]).catch(console.error);
    }, 3000);
    const sub = adminStore.state$.subscribe(setState);
    return () => {
      window.clearInterval(poll);
      sub.unsubscribe();
    };
  }, []);

  const enqueue = async (run: () => Promise<{ job_id: string }>) => {
    setError(null);
    try {
      const result = await run();
      setLastJobId(result.job_id);
      await Promise.all([adminStore.loadAssets(), adminStore.loadJobs()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "operation failed");
    }
  };

  return (
    <section className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Admin Assets</CardTitle>
          <CardDescription>Control sync/reindex jobs and monitor repository state.</CardDescription>
          <CardAction>
            <Badge variant={state.assets ? "default" : "outline"}>
              {state.assets ? "Connected" : "Unavailable"}
            </Badge>
          </CardAction>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Repository Status</CardTitle>
        </CardHeader>
        <CardContent>
          {state.assets ? (
            <div className="flex flex-col gap-1.5 text-sm">
              <div><span className="font-medium">Branch:</span> {state.assets.branch}</div>
              <div><span className="font-medium">SHA:</span> {state.assets.sha ?? "n/a"}</div>
              <div><span className="font-medium">Index State:</span> {state.assets.index_state}</div>
              <div><span className="font-medium">Deploy Key:</span> {state.assets.has_deploy_key ? "present" : "missing"}</div>
              {state.assets.processing ? (
                <div>
                  <span className="font-medium">Processing:</span>{" "}
                  {state.assets.processing.thumbnails_ready}/{state.assets.processing.total_maps} thumbs,{" "}
                  {state.assets.processing.manifests_ready}/{state.assets.processing.total_maps} manifests,{" "}
                  {state.assets.processing.tiles_ready}/{state.assets.processing.total_maps} tiles
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No asset status loaded yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Repository Deploy Key (SSH)</CardTitle>
          <CardDescription>
            Add this public key as a read-only Deploy Key in your assets repository settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {state.deployKey ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  onClick={() => navigator.clipboard.writeText(state.deployKey?.public_key ?? "")}
                >
                  Copy Public Key
                </Button>
                <Button
                  onClick={async () => {
                    setError(null);
                    try {
                      await adminStore.regenerateDeployKey();
                      await adminStore.loadAssets();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "failed to regenerate key");
                    }
                  }}
                >
                  Regenerate Key Pair
                </Button>
              </div>
              <pre className="overflow-auto rounded-md bg-muted p-3 text-xs text-muted-foreground">
                {state.deployKey.public_key}
              </pre>
              <div className="text-sm text-muted-foreground">
                Last used: {state.deployKey.last_used_at ?? "never"}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Generating deploy key...</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => enqueue(() => adminStore.enqueueAssetSync())}>Sync Repo</Button>
            <Button variant="ghost" onClick={() => enqueue(() => adminStore.enqueueReindex())}>Reindex</Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Sync now triggers post-processing automatically: thumbnail generation, 1/2 and 1/4
            prerenders, and 64/128/256 tile prerendering before reindex.
          </p>
        </CardContent>
      </Card>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {lastJobId ? (
        <Card>
          <CardContent>
            <p className="text-sm">
              Last job: <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{lastJobId}</code>{" "}
              <Link to="/admin/jobs" className="font-medium text-primary underline-offset-4 hover:underline">
                track in Admin Jobs
              </Link>
            </p>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
