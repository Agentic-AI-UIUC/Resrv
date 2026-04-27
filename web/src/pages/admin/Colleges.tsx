import { useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  archiveCollege,
  createCollege,
  listAllColleges,
  patchCollege,
  purgeCollege,
  restoreCollege,
} from "../../api/admin";
import type { AdminCollege } from "../../api/types";

export function AdminColleges() {
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const [colleges, setColleges] = useState<AdminCollege[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [purgeTarget, setPurgeTarget] = useState<AdminCollege | null>(null);
  const [purgeTyped, setPurgeTyped] = useState("");
  const [purgeError, setPurgeError] = useState<string | null>(null);

  async function refresh() {
    try {
      const rows = await listAllColleges();
      setColleges(rows);
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
      await createCollege(newName.trim());
      setNewName("");
      setCreating(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function startEdit(c: AdminCollege) {
    setEditingId(c.id);
    setEditingName(c.name);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingName("");
  }

  async function saveEdit(c: AdminCollege) {
    const next = editingName.trim();
    if (!next || next === c.name) {
      cancelEdit();
      return;
    }
    setError(null);
    try {
      await patchCollege(c.id, next);
      cancelEdit();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleArchive(c: AdminCollege) {
    if (!confirm(`Archive "${c.name}"? Existing users keep their reference.`))
      return;
    setError(null);
    try {
      await archiveCollege(c.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRestore(c: AdminCollege) {
    setError(null);
    try {
      await restoreCollege(c.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function openPurge(c: AdminCollege) {
    setPurgeTarget(c);
    setPurgeTyped("");
    setPurgeError(null);
  }

  function closePurge() {
    setPurgeTarget(null);
    setPurgeTyped("");
    setPurgeError(null);
  }

  async function handlePurge() {
    if (!purgeTarget) return;
    setPurgeError(null);
    try {
      await purgeCollege(purgeTarget.id, purgeTyped);
      closePurge();
      await refresh();
    } catch (e) {
      setPurgeError(e instanceof Error ? e.message : String(e));
    }
  }

  const active = colleges.filter((c) => !c.archived_at);
  const archived = colleges.filter((c) => c.archived_at);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Colleges</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="rounded border-gray-300"
            />
            Show archived
          </label>
          {!creating && (
            <button
              onClick={() => setCreating(true)}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Add college
            </button>
          )}
        </div>
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
          <input
            placeholder="Name (e.g. Grainger College of Engineering)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
            minLength={1}
            className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <div className="mt-3 flex gap-2">
            <button
              type="submit"
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setNewName("");
              }}
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
                <th className="px-4 py-2 text-right text-xs font-semibold uppercase text-gray-500">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {active.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">
                    {editingId === c.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          autoFocus
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEdit(c);
                            if (e.key === "Escape") cancelEdit();
                          }}
                          className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                        />
                        <button
                          onClick={() => saveEdit(c)}
                          className="rounded border border-indigo-300 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
                        >
                          Save
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => startEdit(c)}
                        className="text-left hover:underline"
                        title="Click to rename"
                      >
                        {c.name}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {isAdmin && editingId !== c.id && (
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => startEdit(c)}
                          className="rounded-lg border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleArchive(c)}
                          className="rounded-lg border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50"
                        >
                          Archive
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {active.length === 0 && (
                <tr>
                  <td
                    colSpan={2}
                    className="px-4 py-6 text-center text-sm text-gray-500"
                  >
                    No active colleges.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {showArchived && (
        <section>
          <h3 className="mb-3 text-sm font-semibold uppercase text-gray-500">
            Archived ({archived.length})
          </h3>
          {archived.length === 0 ? (
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
              No archived colleges.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50 shadow-sm">
              <table className="min-w-full divide-y divide-gray-200">
                <tbody className="divide-y divide-gray-100">
                  {archived.map((c) => (
                    <tr key={c.id}>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {c.name}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-400">
                        archived {c.archived_at}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {isAdmin && (
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => handleRestore(c)}
                              className="rounded-lg border border-indigo-300 px-3 py-1 text-sm font-medium text-indigo-700 hover:bg-indigo-50"
                            >
                              Restore
                            </button>
                            <button
                              onClick={() => openPurge(c)}
                              className="rounded-lg border border-red-300 px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-50"
                            >
                              Purge…
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {purgeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-red-700">
              Permanently delete “{purgeTarget.name}”
            </h3>
            <p className="mt-2 text-sm text-gray-600">
              This cannot be undone. The college will be removed entirely. If
              users still reference it, the server will reject the request.
            </p>
            <p className="mt-3 text-sm text-gray-700">
              Type the college name{" "}
              <code className="rounded bg-gray-100 px-1 font-mono">
                {purgeTarget.name}
              </code>{" "}
              to confirm:
            </p>
            <input
              value={purgeTyped}
              onChange={(e) => setPurgeTyped(e.target.value)}
              className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
            />
            {purgeError && (
              <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {purgeError}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={closePurge}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handlePurge}
                disabled={purgeTyped !== purgeTarget.name}
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

export default AdminColleges;
