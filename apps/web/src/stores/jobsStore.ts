import { BehaviorSubject } from "rxjs";
import { getJson, postJson } from "../api/client";

export type JobProgress = {
  processed: number;
  total: number;
  phase: string;
};

export type Job = {
  id: string;
  status: string;
  job_type: string;
  queue_type?: string;
  priority?: number;
  idempotency_key?: string | null;
  attempts?: number;
  error_class?: string | null;
  runbook_slug?: string | null;
  dead_lettered?: boolean;
  error?: string | null;
  progress?: JobProgress | null;
  payload?: Record<string, unknown>;
};

const state$ = new BehaviorSubject<{ selected?: Job }>({});

export const jobsStore = {
  state$,
  async load(id: string) {
    const selected = await getJson<Job>(`/api/v1/admin/jobs/${id}`);
    state$.next({ selected });
    return selected;
  },
  stream(id: string, onUpdate: (job: Job) => void, onError?: (message: string) => void) {
    const es = new EventSource(`/api/v1/admin/jobs/${id}/stream`, { withCredentials: true });

    es.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as Job;
        state$.next({ selected: next });
        onUpdate(next);
      } catch {
        onError?.("failed to parse stream payload");
      }
    };

    es.onerror = () => {
      onError?.("job stream disconnected");
    };

    return () => es.close();
  },
  cancel(id: string) {
    return postJson<{ id: string; status: string }>(`/api/v1/admin/jobs/${id}/cancel`);
  },
  retry(id: string, force = false) {
    return postJson<{ job_id: string; status: string; retry_of: string }>(
      `/api/v1/admin/jobs/${id}/retry`,
      { force }
    );
  }
};
