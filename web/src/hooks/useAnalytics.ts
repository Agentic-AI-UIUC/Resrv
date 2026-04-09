import { useCallback, useEffect, useState } from "react";
import type { AnalyticsResponse, AnalyticsPeriod } from "../api/types";
import { fetchAnalytics } from "../api/client";

export function useAnalytics(period: AnalyticsPeriod = "week") {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchAnalytics({ period });
      setData(result);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to fetch analytics");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, error, loading, refresh };
}
