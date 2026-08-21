import { useEffect, useMemo, useState } from "react";
import { adminStore } from "../stores/adminStore";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardAction } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

const PAGE_SIZE_OPTIONS = [25, 50, 100];
const ROLES = ["guest", "user", "contributor", "admin"];

export function AdminUsersPage() {
  const [state, setState] = useState(adminStore.state$.value);
  const [pendingRoles, setPendingRoles] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const [pageSize, setPageSize] = useState(25);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const sub = adminStore.state$.subscribe(setState);
    return () => sub.unsubscribe();
  }, []);

  useEffect(() => {
    setLoading(true);
    adminStore
      .loadUsers({ page: 1, cursor: null, page_size: pageSize, query: "", role: roleFilter })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [pageSize, roleFilter]);

  useEffect(() => {
    setCursor(null);
    setCursorStack([null]);
  }, [query, roleFilter, pageSize]);

  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true);
      adminStore
        .loadUsers({ page: 1, cursor, page_size: pageSize, role: roleFilter, query: query.trim() })
        .catch(console.error)
        .finally(() => setLoading(false));
    }, 180);
    return () => clearTimeout(t);
  }, [cursor, pageSize, roleFilter, query]);

  const pagedUsers = useMemo(() => state.users, [state.users]);
  const selectedSessions = selectedUserId ? state.userSessions[selectedUserId] ?? [] : [];

  const applyRole = async (userId: string, role: string) => {
    try {
      await adminStore.setRole(userId, role);
      toast.success("Role updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update role");
    }
  };

  const revokeSession = async (userId: string, sessionId: string) => {
    try {
      await adminStore.revokeUserSession(userId, sessionId);
      toast.success("Session revoked");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke session");
    }
  };

  return (
    <section className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Admin Users</CardTitle>
          <CardDescription>Role management and session controls with fast search for large user counts.</CardDescription>
          <CardAction>
            <Badge variant="secondary">{state.users.length} users</Badge>
          </CardAction>
        </CardHeader>
      </Card>

      <Card>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="users-search">Search</Label>
              <Input
                id="users-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="username, discord id, role"
                className="w-64"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Role</Label>
              <Select value={roleFilter} onValueChange={setRoleFilter}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">all</SelectItem>
                  {ROLES.map((role) => (
                    <SelectItem key={role} value={role}>{role}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Page Size</Label>
              <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((opt) => (
                    <SelectItem key={opt} value={String(opt)}>{opt}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Badge variant="outline">
              Showing {pagedUsers.length} of {state.usersPagination.total}
            </Badge>
            {loading ? <Badge variant="secondary">Loading</Badge> : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Discord ID</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedUsers.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <div>{user.username}</div>
                    <small className="text-muted-foreground">{user.id}</small>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs">{user.discord_id}</code>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={pendingRoles[user.id] ?? user.role}
                      onValueChange={(value) => setPendingRoles((curr) => ({ ...curr, [user.id]: value }))}
                    >
                      <SelectTrigger className="w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES.map((role) => (
                          <SelectItem key={role} value={role}>{role}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => applyRole(user.id, pendingRoles[user.id] ?? user.role)}
                      >
                        Apply Role
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          setSelectedUserId(user.id);
                          await adminStore.loadUserSessions(user.id);
                        }}
                      >
                        Sessions
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {pagedUsers.length === 0 && !loading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    No users match current search/filter.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <div className="flex items-center justify-center gap-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (cursorStack.length <= 1) return;
                const nextStack = cursorStack.slice(0, -1);
                setCursorStack(nextStack);
                setCursor(nextStack[nextStack.length - 1] ?? null);
              }}
              disabled={cursorStack.length <= 1}
            >
              Prev
            </Button>
            <span className="text-sm text-muted-foreground">Cursor page {cursorStack.length}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const next = state.usersPagination.next_cursor ?? null;
                if (!next) return;
                setCursorStack((curr) => [...curr, next]);
                setCursor(next);
              }}
              disabled={!state.usersPagination.next_cursor}
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>

      {selectedUserId ? (
        <Card>
          <CardHeader>
            <CardTitle>User Sessions</CardTitle>
            <CardDescription>Selected user: {selectedUserId}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2">
              {selectedSessions.map((session) => (
                <div
                  key={session.id}
                  className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <Badge variant={session.active ? "default" : "outline"}>
                      {session.active ? "Active" : "Inactive"}
                    </Badge>
                    <span className="text-muted-foreground">{session.id}</span>
                  </span>
                  <Button size="sm" variant="destructive" onClick={() => revokeSession(selectedUserId, session.id)}>
                    Revoke
                  </Button>
                </div>
              ))}
              {selectedSessions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No sessions loaded.</p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
