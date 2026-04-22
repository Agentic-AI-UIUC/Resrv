import type {
  AnalyticsResponse,
  Machine,
  MachineQueue,
  QueueEntry,
  TodayResponse,
} from "./types";

const BASE = "/api";
const TOKEN_KEY = "reserv.auth.token";

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(
  path: string,
  opts?: RequestInit
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((opts?.headers as Record<string, string>) ?? {}),
  };
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  if (res.status === 401) {
    setAuthToken(null);
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// -- Auth --

export const login = (username: string, password: string) =>
  request<{ token: string; username: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });

export const fetchMe = () =>
  request<{ username: string; staff_id: number }>("/auth/me");

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
