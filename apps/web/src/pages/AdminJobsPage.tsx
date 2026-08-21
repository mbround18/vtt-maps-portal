import { FormEvent, useEffect, useRef, useState } from "react";
import { jobsStore, type Job } from "../stores/jobsStore";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardAction } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";

function statusBadgeVariant(status?: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "completed":
      return "default";
    case "running":
      return "secondary";
    case "failed":
      return "destructive";
    case "cancelled":
      return "outline";
    default:
      return "outline";
  }
}

export function AdminJobsPage() {
  const [id, setId] = useState("");
  const [job, setJob] = useState<Job | undefined>(jobsStore.state$.value.selected);
  const [streaming, setStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const closeRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    const sub = jobsStore.state$.subscribe((next) => setJob(next.selected));
    return () => {
      sub.unsubscribe();
      closeRef.current?.();
    };
  }, []);

  const load = async (event: FormEvent) => {
    event.preventDefault();
    if (!id.trim()) return;

    closeRef.current?.();
    setStreaming(false);
    setStreamError(null);

    await jobsStore.load(id.trim());

    const close = jobsStore.stream(
      id.trim(),
      (next) => {
        setJob(next);
        if (next.status === "completed" || next.status === "failed" || next.status === "cancelled") {
          setStreaming(false);
          closeRef.current?.();
        }
      },
      (message) => {
        setStreamError(message);
        setStreaming(false);
      }
    );

    closeRef.current = close;
    setStreaming(true);
  };

  const cancel = async () => {
    if (!job?.id) return;
    try {
      setStreamError(null);
      await jobsStore.cancel(job.id);
      await jobsStore.load(job.id);
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : "cancel failed");
    }
  };

  const retry = async () => {
    if (!job?.id) return;
    try {
      setStreamError(null);
      const next = await jobsStore.retry(job.id, !!job.dead_lettered);
      setId(next.job_id);
      closeRef.current?.();
      setStreaming(false);
      await jobsStore.load(next.job_id);
      const close = jobsStore.stream(
        next.job_id,
        (streamed) => {
          setJob(streamed);
          if (streamed.status === "completed" || streamed.status === "failed" || streamed.status === "cancelled") {
            setStreaming(false);
            closeRef.current?.();
          }
        },
        (message) => {
          setStreamError(message);
          setStreaming(false);
        }
      );
      closeRef.current = close;
      setStreaming(true);
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : "retry failed");
    }
  };

  const progressPct = job?.progress && job.progress.total > 0
    ? Math.round((job.progress.processed / job.progress.total) * 100)
    : null;

  return (
    <section className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Admin Jobs</CardTitle>
          <CardDescription>Load a job, stream live status updates, cancel or retry where applicable.</CardDescription>
          <CardAction>
            <Badge variant={streaming ? "default" : "outline"}>{streaming ? "Streaming" : "Idle"}</Badge>
          </CardAction>
        </CardHeader>
      </Card>

      <Card>
        <CardContent>
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={load}>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="job-id">Job ID</Label>
              <Input id="job-id" value={id} onChange={(e) => setId(e.target.value)} placeholder="Job ID" />
            </div>
            <Button type="submit">Load + Stream</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              onClick={cancel}
              disabled={!job?.id || job?.status === "completed" || job?.status === "failed" || job?.status === "cancelled"}
            >
              Cancel Job
            </Button>
            <Button
              onClick={retry}
              disabled={!job?.id || (job?.status !== "failed" && job?.status !== "cancelled")}
            >
              Retry Job
            </Button>
          </div>
        </CardContent>
      </Card>

      {job ? (
        <Card>
          <CardHeader>
            <CardTitle>Job State</CardTitle>
            <CardAction>
              <Badge variant={statusBadgeVariant(job.status)}>{job.status}</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {progressPct !== null ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{job.progress?.phase}</span>
                  <span>
                    {job.progress?.processed}/{job.progress?.total} ({progressPct}%)
                  </span>
                </div>
                <Progress value={progressPct} />
              </div>
            ) : null}
            <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs text-muted-foreground">
              {JSON.stringify(job, null, 2)}
            </pre>
          </CardContent>
        </Card>
      ) : null}

      {streamError ? (
        <Alert variant="destructive">
          <AlertDescription>{streamError}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
