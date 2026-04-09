import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { MachineStat } from "../../api/types";

interface Props {
  machines: MachineStat[];
}

export function MachineUtilization({ machines }: Props) {
  const data = machines.map((m) => ({
    name: m.machine_name,
    total: m.total_jobs,
    completed: m.completed_jobs,
  }));

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm border border-gray-200">
      <h3 className="text-sm font-medium text-gray-500 mb-4">
        Machine Utilization
      </h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis type="number" tick={{ fontSize: 12 }} />
          <YAxis
            dataKey="name"
            type="category"
            tick={{ fontSize: 12 }}
            width={140}
          />
          <Tooltip />
          <Bar dataKey="total" fill="#6366f1" name="Total Jobs" />
          <Bar dataKey="completed" fill="#10b981" name="Completed" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
