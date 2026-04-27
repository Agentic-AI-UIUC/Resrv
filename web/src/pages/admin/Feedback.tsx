import { Fragment, useEffect, useMemo, useState } from "react";
import { listFeedback } from "../../api/admin";
import { fetchMachines, listColleges } from "../../api/client";
import type {
  CollegeSummary,
  FeedbackRow,
  Machine,
} from "../../api/types";

const RATING_OPTIONS: { value: string; label: string }[] = [
  { value: "any", label: "Any rating" },
  { value: "5", label: "5 stars" },
  { value: "4", label: "4 stars" },
  { value: "3", label: "3 stars" },
  { value: "2", label: "2 stars" },
  { value: "1", label: "1 star" },
  { value: "below4", label: "Below 4 (≤ 3)" },
  { value: "below3", label: "Below 3 (≤ 2)" },
];

function renderStars(rating: number): string {
  const clamped = Math.max(0, Math.min(5, Math.round(rating)));
  return "★".repeat(clamped) + "☆".repeat(5 - clamped);
}

function formatLocalTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export function AdminFeedback() {
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [colleges, setColleges] = useState<CollegeSummary[]>([]);
  const [machineId, setMachineId] = useState<number | null>(null);
  const [collegeId, setCollegeId] = useState<number | null>(null);
  const [ratingFilter, setRatingFilter] = useState<string>("any");
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMachines()
      .then(setMachines)
      .catch(() => {});
    listColleges()
      .then(setColleges)
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params: {
      limit: number;
      machineId?: number;
      collegeId?: number;
      minRating?: number;
      maxRating?: number;
    } = { limit };
    if (machineId) params.machineId = machineId;
    if (collegeId) params.collegeId = collegeId;
    if (ratingFilter === "below3") params.maxRating = 2;
    else if (ratingFilter === "below4") params.maxRating = 3;
    else if (/^[1-5]$/.test(ratingFilter)) {
      params.minRating = Number(ratingFilter);
      params.maxRating = Number(ratingFilter);
    }
    listFeedback(params)
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [machineId, collegeId, ratingFilter, limit]);

  const reachedLimit = useMemo(
    () => rows.length >= limit,
    [rows.length, limit],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Feedback</h2>
        <div className="text-sm text-gray-500">
          {loading ? "Loading…" : `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`}
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-gray-500">
              Machine
            </span>
            <select
              value={machineId ?? ""}
              onChange={(e) => {
                setLimit(50);
                setMachineId(e.target.value ? Number(e.target.value) : null);
              }}
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">All machines</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-gray-500">
              College
            </span>
            <select
              value={collegeId ?? ""}
              onChange={(e) => {
                setLimit(50);
                setCollegeId(e.target.value ? Number(e.target.value) : null);
              }}
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">All colleges</option>
              {colleges.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-gray-500">
              Rating
            </span>
            <select
              value={ratingFilter}
              onChange={(e) => {
                setLimit(50);
                setRatingFilter(e.target.value);
              }}
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {RATING_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                Time
              </th>
              <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                User
              </th>
              <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                Machine
              </th>
              <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                Rating
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((row) => {
              const userLabel = row.full_name
                ? `${row.full_name} (${row.college_name})`
                : `${row.discord_name ?? "Unknown"} (${row.college_name})`;
              return (
                <Fragment key={row.id}>
                  <tr>
                    <td
                      className="px-4 py-3 text-sm text-gray-700"
                      title={row.created_at}
                    >
                      {formatLocalTime(row.created_at)}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">
                      {userLabel}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">
                      {row.machine_name}
                    </td>
                    <td
                      className="px-4 py-3 text-sm font-mono text-amber-600"
                      title={`${row.rating} / 5`}
                    >
                      {renderStars(row.rating)}
                    </td>
                  </tr>
                  <tr className="bg-gray-50/50">
                    <td colSpan={4} className="px-4 pb-3 pt-0 text-sm text-zinc-500">
                      {row.comment ?? (
                        <span className="italic text-gray-400">(no comment)</span>
                      )}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
            {!loading && rows.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-8 text-center text-sm text-gray-500"
                >
                  No feedback yet for these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && reachedLimit && (
        <div className="flex justify-center">
          <button
            onClick={() => setLimit((n) => n + 50)}
            disabled={loading}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}

export default AdminFeedback;
