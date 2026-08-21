import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getJson, postJson } from "../api/client";
import { authStore } from "../stores/authStore";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";

type InteractionsPayload = {
  summary: {
    views: number;
    downloads: number;
    votes: number;
  };
  recent: {
    views: Array<{ map_id: string; started_at: string; ended_at: string | null; duration_ms: number | null }>;
    downloads: Array<{ map_id: string; downloaded_at: string }>;
    votes: Array<{ map_id: string; created_at: string }>;
  };
};

export function AccountPage() {
  const navigate = useNavigate();
  const [auth, setAuth] = useState(authStore.state$.value);
  const [interactions, setInteractions] = useState<InteractionsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletePhrase, setDeletePhrase] = useState("");
  const [confirmOne, setConfirmOne] = useState(false);
  const [confirmTwo, setConfirmTwo] = useState(false);
  const [confirmThree, setConfirmThree] = useState(false);
  const canDelete = deletePhrase.trim() === "DELETE MY ACCOUNT" && confirmOne && confirmTwo && confirmThree;

  useEffect(() => {
    authStore.refresh().catch(console.error);
    authStore.loadSessions().catch(() => undefined);
    const sub = authStore.state$.subscribe(setAuth);
    return () => sub.unsubscribe();
  }, []);

  useEffect(() => {
    if (!auth.authenticated) {
      setLoading(false);
      return;
    }
    setLoading(true);
    getJson<InteractionsPayload>("/api/v1/account/interactions")
      .then(setInteractions)
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load account"))
      .finally(() => setLoading(false));
  }, [auth.authenticated]);

  const timeline = useMemo(() => {
    if (!interactions) return [];
    const merged = [
      ...interactions.recent.views.map((v) => ({ type: "view", when: v.started_at, map: v.map_id })),
      ...interactions.recent.downloads.map((d) => ({ type: "download", when: d.downloaded_at, map: d.map_id })),
      ...interactions.recent.votes.map((v) => ({ type: "vote", when: v.created_at, map: v.map_id }))
    ];
    return merged.sort((a, b) => b.when.localeCompare(a.when)).slice(0, 40);
  }, [interactions]);

  const downloadData = async () => {
    const response = await fetch("/api/v1/account/export", {
      method: "GET",
      credentials: "include",
      headers: { "x-device-fingerprint": localStorage.getItem("vttmaps.device_fp") ?? "unknown" }
    });
    if (!response.ok) throw new Error(`request failed: ${response.status}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vttmaps-account-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const deleteAccount = async () => {
    if (!canDelete) return;
    await postJson("/api/v1/account/delete", {
      confirmation_phrase: deletePhrase,
      confirm_one: confirmOne,
      confirm_two: confirmTwo,
      confirm_three: confirmThree
    });
    await authStore.refresh();
    navigate("/login");
  };

  if (!auth.authenticated) {
    return (
      <Card className="border-border/60">
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Sign in to view your interactions and privacy controls.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="border-border/60">
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <CardTitle className="text-xl">Account</CardTitle>
            <CardDescription>Track what you did, when you did it, and control your personal data lifecycle.</CardDescription>
          </div>
          <Badge>{auth.user?.username}</Badge>
        </CardHeader>
      </Card>

      {loading ? (
        <Card className="border-border/60">
          <CardContent className="flex flex-col gap-2 px-6">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-1/2" />
          </CardContent>
        </Card>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {interactions ? (
        <Card className="border-border/60">
          <CardHeader>
            <CardTitle>My Interactions</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-3 px-6">
            <div className="rounded-lg border border-border/60 p-4">
              <strong className="text-xs uppercase tracking-wide text-muted-foreground">Views</strong>
              <div className="mt-1 text-2xl font-semibold">{interactions.summary.views}</div>
            </div>
            <div className="rounded-lg border border-border/60 p-4">
              <strong className="text-xs uppercase tracking-wide text-muted-foreground">Downloads</strong>
              <div className="mt-1 text-2xl font-semibold">{interactions.summary.downloads}</div>
            </div>
            <div className="rounded-lg border border-border/60 p-4">
              <strong className="text-xs uppercase tracking-wide text-muted-foreground">Votes</strong>
              <div className="mt-1 text-2xl font-semibold">{interactions.summary.votes}</div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-border/60">
        <CardHeader>
          <CardTitle>Activity Timeline</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 px-6">
          {timeline.map((event, index) => (
            <div
              className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2"
              key={`${event.type}-${event.when}-${index}`}
            >
              <span className="text-sm">
                {event.type.toUpperCase()} • {event.map}
              </span>
              <span className="text-sm text-muted-foreground">{new Date(event.when).toLocaleString()}</span>
            </div>
          ))}
          {timeline.length === 0 ? (
            <p className="text-sm text-muted-foreground">No interactions tracked yet.</p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardHeader>
          <CardTitle>Data Privacy</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 px-6">
          <Button variant="outline" onClick={downloadData}>
            Download My Data
          </Button>
          <Button variant="outline" onClick={() => authStore.logout()}>
            Sign Out
          </Button>
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardHeader>
          <CardTitle>Delete Account</CardTitle>
          <CardDescription>
            This permanently removes your profile and interactions from our system and signs you out.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-6">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delete-phrase">
              Type <code className="rounded bg-muted px-1 py-0.5 text-xs">DELETE MY ACCOUNT</code>
            </Label>
            <Input id="delete-phrase" value={deletePhrase} onChange={(e) => setDeletePhrase(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={confirmOne} onCheckedChange={(v) => setConfirmOne(v === true)} />
            I understand this action is permanent.
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={confirmTwo} onCheckedChange={(v) => setConfirmTwo(v === true)} />
            I want all account-linked interaction data deleted.
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={confirmThree} onCheckedChange={(v) => setConfirmThree(v === true)} />
            I understand I will be signed out immediately.
          </label>
          <div>
            <Button variant="destructive" disabled={!canDelete} onClick={deleteAccount}>
              Delete My Account
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
