import { BehaviorSubject } from "rxjs";
import { deleteJson, getJson, postJson } from "../api/client";

type AdminState = {
  users: Array<{ id: string; discord_id: string; username: string; role: string }>;
  usersPagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
    query: string;
    role: string;
    cursor?: string | null;
    next_cursor?: string | null;
  };
  userSessions: Record<string, Array<{
    id: string;
    created_at: string;
    expires_at: string;
    last_seen_at: string | null;
    revoked_at: string | null;
    revoked_reason: string | null;
    active: boolean;
  }>>;
  assets: {
    branch: string;
    sha: string | null;
    index_state: string;
    has_deploy_key?: boolean;
    processing?: {
      total_maps: number;
      thumbnails_ready: number;
      manifests_ready: number;
      tiles_ready: number;
    } | null;
  } | null;
  deployKey: {
    key_name: string;
    algorithm: string;
    public_key: string;
    created_at: string;
    updated_at: string;
    last_used_at: string | null;
  } | null;
  jobs: Array<{
    id: string;
    job_type: string;
    status: string;
    queue_type?: string;
    priority?: number;
    idempotency_key?: string | null;
    attempts?: number;
    error_class?: string | null;
    runbook_slug?: string | null;
    dead_lettered?: boolean;
    progress?: { processed: number; total: number; phase: string } | null;
    created_at?: string;
  }>;
  mapMetadata: Array<{
    id: string;
    path: string;
    display_name: string;
    tags: string[];
    updated_at: string;
  }>;
  selectedMapMetadata: {
    id: string;
    path: string;
    display_name: string;
    tags: string[];
    about_md: string;
    source_about_md?: string | null;
    poi: unknown;
    updated_at: string;
  } | null;
  security: {
    audit_integrity?: { ok: boolean; failing_id?: number | null; expected_hash?: string | null } | null;
    secrets?: {
      jwt: { current: string; previous: string };
      discord_oauth: { current: string; previous: string };
      deploy_key_encryption: { version: string; state: string };
    } | null;
  };
};

type EnqueueResponse = {
  job_id: string;
  status: string;
  profile?: string;
};

const state$ = new BehaviorSubject<AdminState>({
  users: [],
  usersPagination: {
    page: 1,
    page_size: 50,
    total: 0,
    total_pages: 1,
    query: "",
    role: "all",
    cursor: null,
    next_cursor: null
  },
  userSessions: {},
  assets: null,
  deployKey: null,
  jobs: [],
  mapMetadata: [],
  selectedMapMetadata: null,
  security: {
    audit_integrity: null,
    secrets: null
  }
});

export const adminStore = {
  state$,
  async loadUsers(params?: Partial<AdminState["usersPagination"]>) {
    const next = { ...state$.value.usersPagination, ...params };
    const query = new URLSearchParams();
    query.set("role", next.role);
    query.set("query", next.query);
    query.set("limit", String(next.page_size));
    if (next.cursor) {
      query.set("cursor", next.cursor);
    } else {
      query.set("page", String(next.page));
      query.set("page_size", String(next.page_size));
    }
    const payload = await getJson<{
      users?: Array<{ id: string; discord_id: string; username: string; role: string }>;
      items?: Array<{ id: string; discord_id: string; username: string; role: string }>;
      next_cursor?: string | null;
      pagination: AdminState["usersPagination"];
    }>(`/api/v1/admin/users?${query.toString()}`);
    state$.next({
      ...state$.value,
      users: payload.items ?? payload.users ?? [],
      usersPagination: {
        ...payload.pagination,
        cursor: next.cursor ?? null,
        next_cursor: payload.next_cursor ?? null
      }
    });
  },
  async setRole(id: string, role: string) {
    await postJson(`/api/v1/admin/users/${id}/role`, { role });
    await this.loadUsers();
  },
  async loadUserSessions(userId: string) {
    const payload = await getJson<{ sessions: NonNullable<AdminState["userSessions"][string]> }>(`/api/v1/admin/users/${userId}/sessions`);
    state$.next({
      ...state$.value,
      userSessions: { ...state$.value.userSessions, [userId]: payload.sessions }
    });
  },
  async revokeUserSession(userId: string, sessionId: string) {
    await deleteJson(`/api/v1/admin/users/${userId}/sessions/${sessionId}`);
    await this.loadUserSessions(userId);
  },
  async loadAssets() {
    const payload = await getJson<{
      branch: string;
      sha: string | null;
      index_state: string;
      has_deploy_key?: boolean;
      processing?: {
        total_maps: number;
        thumbnails_ready: number;
        manifests_ready: number;
        tiles_ready: number;
      } | null;
    }>("/api/v1/admin/assets/status");
    state$.next({ ...state$.value, assets: payload });
  },
  async loadDeployKey() {
    const payload = await getJson<AdminState["deployKey"]>("/api/v1/admin/assets/deploy-key");
    state$.next({ ...state$.value, deployKey: payload });
  },
  async regenerateDeployKey() {
    const payload = await postJson<AdminState["deployKey"]>("/api/v1/admin/assets/deploy-key/regenerate");
    state$.next({ ...state$.value, deployKey: payload });
    return payload;
  },
  enqueueAssetSync() {
    return postJson<EnqueueResponse>("/api/v1/admin/assets/sync");
  },
  enqueueReindex() {
    return postJson<EnqueueResponse>("/api/v1/admin/assets/reindex");
  },
  async loadJobs() {
    try {
      const payload = await getJson<{ jobs?: AdminState["jobs"]; items?: AdminState["jobs"] }>("/api/v1/admin/jobs");
      state$.next({ ...state$.value, jobs: payload.items ?? payload.jobs ?? [] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("404")) {
        state$.next({ ...state$.value, jobs: [] });
        return;
      }
      throw err;
    }
  },
  async loadMapMetadata() {
    const payload = await getJson<{ maps: AdminState["mapMetadata"] }>("/api/v1/admin/maps/metadata");
    state$.next({ ...state$.value, mapMetadata: payload.maps });
  },
  async loadMapMetadataById(id: string) {
    const payload = await getJson<NonNullable<AdminState["selectedMapMetadata"]>>(`/api/v1/admin/maps/metadata/${id}`);
    state$.next({ ...state$.value, selectedMapMetadata: payload });
    return payload;
  },
  async updateMapMetadata(
    id: string,
    update: Partial<Pick<NonNullable<AdminState["selectedMapMetadata"]>, "display_name" | "tags" | "about_md" | "poi">>
  ) {
    await postJson(`/api/v1/admin/maps/metadata/${id}`, update);
    await this.loadMapMetadataById(id);
    await this.loadMapMetadata();
  },
  enqueueConvert(profile: string) {
    return postJson<EnqueueResponse>("/api/v1/admin/assets/convert-images", { profile });
  },
  async loadSecurity() {
    const [audit_integrity, secrets] = await Promise.all([
      getJson<{ ok: boolean; failing_id?: number | null; expected_hash?: string | null }>("/api/v1/admin/security/audit-integrity"),
      getJson<{
        jwt: { current: string; previous: string };
        discord_oauth: { current: string; previous: string };
        deploy_key_encryption: { version: string; state: string };
      }>("/api/v1/admin/security/secrets")
    ]);
    state$.next({
      ...state$.value,
      security: {
        audit_integrity,
        secrets
      }
    });
  }
};
