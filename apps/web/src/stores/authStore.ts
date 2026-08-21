import { BehaviorSubject } from "rxjs";
import { deleteJson, getJson, postJson } from "../api/client";

type AuthState = {
  loading: boolean;
  checked: boolean;
  authenticated: boolean;
  user: {
    id: string;
    discord_id: string;
    username: string;
    role: string;
    is_super_admin: boolean;
    avatar_url: string | null;
  } | null;
  sessions: Array<{
    id: string;
    created_at: string;
    expires_at: string;
    last_seen_at: string | null;
    revoked_at: string | null;
    revoked_reason: string | null;
    current: boolean;
    active: boolean;
  }>;
};

const state$ = new BehaviorSubject<AuthState>({
  loading: false,
  checked: false,
  authenticated: false,
  user: null,
  sessions: []
});

export const authStore = {
  state$,
  async refresh() {
    state$.next({ ...state$.value, loading: true });
    try {
      const payload = await getJson<{ authenticated: boolean; user: AuthState["user"] }>("/api/v1/auth/me");
      state$.next({
        ...state$.value,
        loading: false,
        checked: true,
        authenticated: payload.authenticated,
        user: payload.user
      });
    } catch (err) {
      state$.next({ ...state$.value, loading: false, checked: true, authenticated: false, user: null });
      throw err;
    }
  },
  async loadSessions() {
    const payload = await getJson<{ sessions: AuthState["sessions"] }>("/api/v1/auth/sessions");
    state$.next({ ...state$.value, sessions: payload.sessions });
  },
  async revokeSession(id: string) {
    await deleteJson(`/api/v1/auth/sessions/${id}`);
    await this.loadSessions();
    await this.refresh();
  },
  async revokeOtherSessions() {
    await deleteJson("/api/v1/auth/sessions/others");
    await this.loadSessions();
  },
  async logout() {
    await postJson<void>("/api/v1/auth/logout");
    state$.next({ ...state$.value, authenticated: false, user: null, sessions: [] });
  }
};
