import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { CollegeStat } from "../../api/types";

interface Props {
  colleges: CollegeStat[];
  onSelect?: (collegeId: number | null) => void;
}

export function CollegeUtilization({ colleges, onSelect }: Props) {
  // Sort by total_jobs desc; recharts renders top-down for vertical layout.
  const sorted = [...colleges].sort((a, b) => b.total_jobs - a.total_jobs);
  const data = sorted.map((c) => ({
    college_id: c.college_id,
    name: c.college_name,
    total: c.total_jobs,
    completed: c.completed_jobs,
  }));

  const handleClick = (data: unknown) => {
    if (!onSelect) return;
    // recharts hands us the original datum on `payload`.
    const cid =
      data && typeof data === "object" && "payload" in data
        ? ((data as { payload?: { college_id?: number } }).payload?.college_id ??
          null)
        : null;
    if (cid == null || cid === 0) return;
    onSelect(cid);
  };

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm border border-gray-200">
      <h3 className="text-sm font-medium text-gray-500 mb-4">
        By College
      </h3>
      {data.length === 0 ? (
        <div className="flex h-[300px] items-center justify-center text-sm text-gray-400">
          No college data for this range.
        </div>
      ) : (
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
            <Bar
              dataKey="total"
              fill="#8b5cf6"
              name="Total Jobs"
              cursor={onSelect ? "pointer" : undefined}
              onClick={handleClick}
            />
            <Bar
              dataKey="completed"
              fill="#10b981"
              name="Completed"
              cursor={onSelect ? "pointer" : undefined}
              onClick={handleClick}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
