import { request } from "./client";

export type AdminMachine = {
  id: number;
  name: string;
  slug: string;
  status: string;
  archived_at: string | null;
  created_at: string;
  embed_message_id?: string | null;
};

export const listMachines = (includeArchived = false) =>
  request<AdminMachine[]>(
    `/machines/${includeArchived ? "?include_archived=true" : ""}`
  );

export const createMachine = (name: string, slug: string) =>
  request<AdminMachine>(`/machines/`, {
    method: "POST",
    body: JSON.stringify({ name, slug }),
  });

export const patchMachine = (
  id: number,
  body: Partial<{ name: string; slug: string; status: string }>
) =>
  request<AdminMachine>(`/machines/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

export const archiveMachine = (id: number) =>
  request<{ status: string }>(`/machines/${id}`, { method: "DELETE" });

export const purgeMachine = (id: number, confirm_slug: string) =>
  request<{ status: string; queue_entries: number; analytics_snapshots: number }>(
    `/machines/${id}?purge=true`,
    {
      method: "DELETE",
      body: JSON.stringify({ confirm_slug }),
    }
  );

export const restoreMachine = (id: number) =>
  request<AdminMachine>(`/machines/${id}/restore`, { method: "POST" });

// ── Staff ──

export type StaffRow = {
  id: number;
  username: string;
  role: "admin" | "staff";
  created_at: string;
};

export const listStaff = () => request<StaffRow[]>(`/staff/`);

export const createStaff = (
  username: string,
  password: string,
  role: "admin" | "staff"
) =>
  request<StaffRow>(`/staff/`, {
    method: "POST",
    body: JSON.stringify({ username, password, role }),
  });

export const patchStaff = (
  id: number,
  body: { role?: "admin" | "staff"; password?: string }
) =>
  request<StaffRow>(`/staff/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

export const deleteStaff = (id: number) =>
  request<{ status: string }>(`/staff/${id}`, { method: "DELETE" });

// ── Settings ──

export const getSettings = () =>
  request<Record<string, string>>(`/settings/`);

export const patchSettings = (updates: Record<string, string>) =>
  request<Record<string, string>>(`/settings/`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });

export const getPublicSettings = () =>
  request<{ public_mode: string; maintenance_banner: string }>(
    `/public-settings/`
  );
