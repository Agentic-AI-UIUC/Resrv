import { useCallback, useEffect, useState } from "react";
import type { AnalyticsResponse, AnalyticsPeriod, MachineStat } from "../api/types";
import { fetchAnalytics, fetchTodayStats } from "../api/client";

export function useAnalytics(
  period: AnalyticsPeriod = "week",
  collegeId: number | null = null,
) {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [historical, today] = await Promise.all([
        fetchAnalytics({ period, college_id: collegeId }),
        fetchTodayStats(),
      ]);

      // When filtering by college, the today endpoint isn't college-aware,
      // so skip the merge to avoid double-counting unrelated jobs.
      if (collegeId == null && today.machines.length > 0) {
        const todayDate = today.date;

        // Add today's machines into the machine list (merge by machine_id)
        const machineMap = new Map<number, MachineStat>();
        for (const m of historical.machines) {
          machineMap.set(m.machine_id, { ...m });
        }
        for (const m of today.machines) {
          const existing = machineMap.get(m.machine_id);
          if (existing) {
            existing.total_jobs += m.total_jobs;
            existing.completed_jobs += m.completed_jobs;
            existing.unique_users += m.unique_users;
            existing.no_show_count += m.no_show_count;
            existing.cancelled_count += m.cancelled_count;
            existing.failure_count += m.failure_count;
          } else {
            machineMap.set(m.machine_id, { ...m });
          }
        }

        // Update summary
        const machines = Array.from(machineMap.values());
        const summary = {
          total_jobs: machines.reduce((s, m) => s + m.total_jobs, 0),
          completed_jobs: machines.reduce((s, m) => s + m.completed_jobs, 0),
          unique_users: machines.reduce((s, m) => s + m.unique_users, 0),
          no_show_count: machines.reduce((s, m) => s + m.no_show_count, 0),
          cancelled_count: machines.reduce((s, m) => s + m.cancelled_count, 0),
          failure_count: machines.reduce((s, m) => s + m.failure_count, 0),
          avg_wait_mins: historical.summary.avg_wait_mins,
          avg_serve_mins: historical.summary.avg_serve_mins,
        };

        // Add today to daily breakdown if not already there
        const todayJobs = today.machines.reduce((s, m) => s + m.total_jobs, 0);
        const todayCompleted = today.machines.reduce((s, m) => s + m.completed_jobs, 0);
        const breakdown = [...historical.daily_breakdown];
        const existingDay = breakdown.find((d) => d.date === todayDate);
        if (existingDay) {
          existingDay.total_jobs += todayJobs;
          existingDay.completed_jobs += todayCompleted;
        } else {
          breakdown.push({ date: todayDate, total_jobs: todayJobs, completed_jobs: todayCompleted });
        }

        setData({
          ...historical,
          summary,
          machines,
          daily_breakdown: breakdown,
        });
      } else {
        setData(historical);
      }

      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to fetch analytics");
    } finally {
      setLoading(false);
    }
  }, [period, collegeId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, error, loading, refresh };
}
