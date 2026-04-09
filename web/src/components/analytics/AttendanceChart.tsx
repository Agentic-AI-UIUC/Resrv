import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { DailyBreakdown } from "../../api/types";

interface Props {
  data: DailyBreakdown[];
}

export function AttendanceChart({ data }: Props) {
  return (
    <div className="rounded-xl bg-white p-5 shadow-sm border border-gray-200">
      <h3 className="text-sm font-medium text-gray-500 mb-4">
        Attendance Over Time
      </h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="date" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} />
          <Tooltip />
          <Line
            type="monotone"
            dataKey="total_jobs"
            stroke="#6366f1"
            strokeWidth={2}
            name="Total Jobs"
          />
          <Line
            type="monotone"
            dataKey="completed_jobs"
            stroke="#10b981"
            strokeWidth={2}
            name="Completed"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
