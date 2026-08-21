import { useEffect, useState } from "react";
import { postJson } from "../api/client";
import { authStore } from "../stores/authStore";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export function LoginPage() {
  const [state, setState] = useState(authStore.state$.value);

  useEffect(() => {
    authStore.refresh().catch(console.error);
    authStore.loadSessions().catch(() => undefined);
    const sub = authStore.state$.subscribe(setState);
    return () => sub.unsubscribe();
  }, []);

  const login = async () => {
    const payload = await postJson<{ auth_url: string }>("/api/v1/auth/discord/start");
    window.location.href = payload.auth_url;
  };

  const logout = async () => {
    await authStore.logout();
  };

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <Card className="border-border/60">
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <CardTitle className="text-xl">Login</CardTitle>
            <CardDescription>Use Discord OAuth to access your account and admin surfaces.</CardDescription>
          </div>
          {state.authenticated ? <Badge>Authenticated</Badge> : null}
        </CardHeader>
      </Card>

      {!state.authenticated ? (
        <Card className="border-border/60">
          <CardContent className="flex flex-col gap-4 px-6">
            <p className="text-sm text-muted-foreground">
              Single Sign-On is handled by Discord and returns a secured session cookie.
            </p>
            <div>
              <Button onClick={login}>Continue with Discord</Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          <Card className="border-border/60">
            <CardHeader>
              <CardTitle>Account</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 px-6">
              <p className="text-sm text-muted-foreground">
                Signed in as <strong className="text-foreground">{state.user?.username}</strong> ({state.user?.role})
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={logout}>
                  Logout
                </Button>
                <Button variant="outline" onClick={() => authStore.revokeOtherSessions()}>
                  Revoke Other Sessions
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/60">
            <CardHeader>
              <CardTitle>Active Sessions</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 px-6">
              {state.sessions.map((session) => (
                <div
                  key={session.id}
                  className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2"
                >
                  <span className="text-sm text-muted-foreground">
                    {session.current ? "Current Device" : "Device"} | Active: {session.active ? "yes" : "no"}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => authStore.revokeSession(session.id)}>
                    Revoke
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
