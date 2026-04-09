import type { MachineStat } from "../../api/types";

interface Props {
  machines: MachineStat[];
}

export function MachineTable({ machines }: Props) {
  return (
    <div className="rounded-xl bg-white shadow-sm border border-gray-200 overflow-hidden">
      <h3 className="text-sm font-medium text-gray-500 px-5 pt-5 pb-3">
        Per-Machine Breakdown
      </h3>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th className="px-5 py-2 font-medium">Machine</th>
              <th className="px-3 py-2 font-medium text-right">Jobs</th>
              <th className="px-3 py-2 font-medium text-right">Completed</th>
              <th className="px-3 py-2 font-medium text-right">Users</th>
              <th className="px-3 py-2 font-medium text-right">Avg Wait</th>
              <th className="px-3 py-2 font-medium text-right">Avg Serve</th>
              <th className="px-3 py-2 font-medium text-right">No-shows</th>
              <th className="px-3 py-2 font-medium text-right">Failures</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {machines.map((m) => (
              <tr key={m.machine_id} className="hover:bg-gray-50">
                <td className="px-5 py-3 font-medium text-gray-900">
                  {m.machine_name}
                </td>
                <td className="px-3 py-3 text-right">{m.total_jobs}</td>
                <td className="px-3 py-3 text-right">{m.completed_jobs}</td>
                <td className="px-3 py-3 text-right">{m.unique_users}</td>
                <td className="px-3 py-3 text-right">
                  {m.avg_wait_mins != null ? `${m.avg_wait_mins}m` : "—"}
                </td>
                <td className="px-3 py-3 text-right">
                  {m.avg_serve_mins != null ? `${m.avg_serve_mins}m` : "—"}
                </td>
                <td className="px-3 py-3 text-right">{m.no_show_count}</td>
                <td className="px-3 py-3 text-right">{m.failure_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
