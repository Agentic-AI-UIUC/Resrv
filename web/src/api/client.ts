import type {
  AnalyticsResponse,
  Machine,
  MachineQueue,
  QueueEntry,
  TodayResponse,
} from "./types";

const BASE = "/api";

async function request<T>(
  path: string,
  opts?: RequestInit
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// -- Machines --

export const fetchMachines = () => request<Machine[]>("/machines/");

export const patchMachineStatus = (id: number, status: string) =>
  request<Machine>(`/machines/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });

// -- Queues --

export const fetchAllQueues = () => request<MachineQueue[]>("/queue/");

export const fetchMachineQueue = (machineId: number) =>
  request<QueueEntry[]>(`/queue/${machineId}`);

export const serveEntry = (entryId: number) =>
  request<QueueEntry>(`/queue/${entryId}/serve`, { method: "POST" });

export const leaveEntry = (entryId: number) =>
  request<QueueEntry>(`/queue/${entryId}/leave`, { method: "POST" });

export const completeEntry = (
  entryId: number,
  jobSuccessful: boolean,
  failureNotes?: string
) =>
  request<QueueEntry>(`/queue/${entryId}/complete`, {
    method: "POST",
    body: JSON.stringify({
      job_successful: jobSuccessful,
      failure_notes: failureNotes ?? null,
    }),
  });

export const bumpEntry = (entryId: number) =>
  request<QueueEntry>(`/queue/${entryId}/bump`, { method: "POST" });

// -- Health --

export const fetchHealth = () => request<{ status: string }>("/health");

// -- Analytics --

export const fetchAnalytics = (params?: {
  period?: string;
  start_date?: string;
  end_date?: string;
}) => {
  const qs = new URLSearchParams();
  if (params?.period) qs.set("period", params.period);
  if (params?.start_date) qs.set("start_date", params.start_date);
  if (params?.end_date) qs.set("end_date", params.end_date);
  const query = qs.toString();
  return request<AnalyticsResponse>(
    `/analytics/${query ? `?${query}` : ""}`
  );
};

export const fetchMachineAnalytics = (
  machineId: number,
  params?: { period?: string; start_date?: string; end_date?: string }
) => {
  const qs = new URLSearchParams();
  if (params?.period) qs.set("period", params.period);
  if (params?.start_date) qs.set("start_date", params.start_date);
  if (params?.end_date) qs.set("end_date", params.end_date);
  const query = qs.toString();
  return request<AnalyticsResponse>(
    `/analytics/${machineId}${query ? `?${query}` : ""}`
  );
};

export const fetchTodayStats = () =>
  request<TodayResponse>("/analytics/today");
