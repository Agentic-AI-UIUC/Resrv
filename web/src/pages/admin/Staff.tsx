import { useEffect, useState } from "react";
import {
  createStaff,
  deleteStaff,
  listStaff,
  patchStaff,
  type StaffRow,
} from "../../api/admin";

export function AdminStaff() {
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    username: "",
    password: "",
    role: "staff" as "admin" | "staff",
  });
  const [pwReset, setPwReset] = useState<{ id: number; pw: string } | null>(null);

  async function refresh() {
    try {
      setRows(await listStaff());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createStaff(form.username, form.password, form.role);
      setForm({ username: "", password: "", role: "staff" });
      setCreating(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRoleChange(row: StaffRow, role: "admin" | "staff") {
    setError(null);
    try {
      await patchStaff(row.id, { role });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDelete(row: StaffRow) {
    if (!confirm(`Delete "${row.username}"?`)) return;
    setError(null);
    try {
      await deleteStaff(row.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function submitPwReset() {
    if (!pwReset) return;
    setError(null);
    try {
      await patchStaff(pwReset.id, { password: pwReset.pw });
      setPwReset(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Staff</h2>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            Add staff
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {creating && (
        <form
          onSubmit={handleCreate}
          className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <input
              placeholder="username"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              required
              minLength={3}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <input
              placeholder="password"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
              minLength={6}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <select
              value={form.role}
              onChange={(e) =>
                setForm({ ...form, role: e.target.value as "admin" | "staff" })
              }
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="staff">staff</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="submit"
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                Username
              </th>
              <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                Role
              </th>
              <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                Created
              </th>
              <th className="px-4 py-2 text-right text-xs font-semibold uppercase text-gray-500">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-3 text-sm font-medium text-gray-900">
                  {row.username}
                </td>
                <td className="px-4 py-3">
                  <select
                    value={row.role}
                    onChange={(e) =>
                      handleRoleChange(
                        row,
                        e.target.value as "admin" | "staff"
                      )
                    }
                    className="rounded border border-gray-300 px-2 py-1 text-sm"
                  >
                    <option value="staff">staff</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">
                  {row.created_at}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setPwReset({ id: row.id, pw: "" })}
                      className="rounded-lg border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Reset password
                    </button>
                    <button
                      onClick={() => handleDelete(row)}
                      className="rounded-lg border border-red-300 px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pwReset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Reset password</h3>
            <input
              type="password"
              placeholder="New password"
              value={pwReset.pw}
              onChange={(e) => setPwReset({ ...pwReset, pw: e.target.value })}
              minLength={6}
              className="mt-3 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setPwReset(null)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={submitPwReset}
                disabled={pwReset.pw.length < 6}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:bg-indigo-300"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
