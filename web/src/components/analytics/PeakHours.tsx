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

export function PeakHours({ machines }: Props) {
  const hourCounts: Record<number, number> = {};
  for (const m of machines) {
    if (m.peak_hour != null) {
      hourCounts[m.peak_hour] = (hourCounts[m.peak_hour] || 0) + m.total_jobs;
    }
  }

  const data = Object.entries(hourCounts)
    .map(([hour, count]) => ({
      hour: `${hour}:00`,
      jobs: count,
    }))
    .sort((a, b) => parseInt(a.hour) - parseInt(b.hour));

  if (data.length === 0) {
    return (
      <div className="rounded-xl bg-white p-5 shadow-sm border border-gray-200">
        <h3 className="text-sm font-medium text-gray-500 mb-4">Peak Hours</h3>
        <p className="text-sm text-gray-400">No data available</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm border border-gray-200">
      <h3 className="text-sm font-medium text-gray-500 mb-4">Peak Hours</h3>
      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="hour" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} />
          <Tooltip />
          <Bar dataKey="jobs" fill="#f59e0b" name="Jobs" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
