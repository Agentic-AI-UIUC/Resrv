import { useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  archiveMachine,
  createMachine,
  listMachines,
  patchMachine,
  purgeMachine,
  restoreMachine,
  type AdminMachine,
} from "../../api/admin";

export function AdminMachines() {
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const [machines, setMachines] = useState<AdminMachine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [purgeTarget, setPurgeTarget] = useState<AdminMachine | null>(null);
  const [purgeTyped, setPurgeTyped] = useState("");

  async function refresh() {
    try {
      const rows = await listMachines(true);
      setMachines(rows);
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
      await createMachine(newName, newSlug);
      setNewName("");
      setNewSlug("");
      setCreating(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleStatus(m: AdminMachine, status: string) {
    setError(null);
    try {
      await patchMachine(m.id, { status });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleArchive(m: AdminMachine) {
    if (!confirm(`Archive "${m.name}"? History will be preserved.`)) return;
    setError(null);
    try {
      await archiveMachine(m.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRestore(m: AdminMachine) {
    setError(null);
    try {
      await restoreMachine(m.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handlePurge() {
    if (!purgeTarget) return;
    setError(null);
    try {
      await purgeMachine(purgeTarget.id, purgeTyped);
      setPurgeTarget(null);
      setPurgeTyped("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const active = machines.filter((m) => !m.archived_at);
  const archived = machines.filter((m) => m.archived_at);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Machines</h2>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            Add machine
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input
              placeholder="Name (e.g. Vinyl Cutter)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <input
              placeholder="slug (e.g. vinyl-cutter)"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
              pattern="^[a-z0-9]+(-[a-z0-9]+)*$"
              required
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
            />
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

      <section>
        <h3 className="mb-3 text-sm font-semibold uppercase text-gray-500">
          Active ({active.length})
        </h3>
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                  Name
                </th>
                <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                  Slug
                </th>
                <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                  Status
                </th>
                <th className="px-4 py-2 text-right text-xs font-semibold uppercase text-gray-500">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {active.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">
                    {m.name}
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-gray-600">
                    {m.slug}
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={m.status}
                      onChange={(e) => handleStatus(m, e.target.value)}
                      className="rounded border border-gray-300 px-2 py-1 text-sm"
                    >
                      <option value="active">active</option>
                      <option value="maintenance">maintenance</option>
                      <option value="offline">offline</option>
                    </select>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {isAdmin && (
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => handleArchive(m)}
                          className="rounded-lg border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50"
                        >
                          Archive
                        </button>
                        <button
                          onClick={() => setPurgeTarget(m)}
                          className="rounded-lg border border-red-300 px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-50"
                        >
                          Delete…
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {active.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-sm text-gray-500">
                    No active machines.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {archived.length > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-semibold uppercase text-gray-500">
            Archived ({archived.length})
          </h3>
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50 shadow-sm">
            <table className="min-w-full divide-y divide-gray-200">
              <tbody className="divide-y divide-gray-100">
                {archived.map((m) => (
                  <tr key={m.id}>
                    <td className="px-4 py-3 text-sm text-gray-600">{m.name}</td>
                    <td className="px-4 py-3 text-sm font-mono text-gray-500">
                      {m.slug}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">
                      archived {m.archived_at}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {isAdmin && (
                        <button
                          onClick={() => handleRestore(m)}
                          className="rounded-lg border border-indigo-300 px-3 py-1 text-sm font-medium text-indigo-700 hover:bg-indigo-50"
                        >
                          Restore
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {purgeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-red-700">
              Permanently delete “{purgeTarget.name}”
            </h3>
            <p className="mt-2 text-sm text-gray-600">
              This cannot be undone. All queue history and analytics for this
              machine will be destroyed.
            </p>
            <p className="mt-3 text-sm text-gray-700">
              Type the slug <code className="rounded bg-gray-100 px-1 font-mono">{purgeTarget.slug}</code> to confirm:
            </p>
            <input
              value={purgeTyped}
              onChange={(e) => setPurgeTyped(e.target.value)}
              className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  setPurgeTarget(null);
                  setPurgeTyped("");
                }}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handlePurge}
                disabled={purgeTyped !== purgeTarget.slug}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:bg-red-300"
              >
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
