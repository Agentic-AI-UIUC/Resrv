import type { AnalyticsSummary } from "../../api/types";

interface Props {
  summary: AnalyticsSummary;
}

export function SummaryCards({ summary }: Props) {
  const noShowRate =
    summary.total_jobs > 0
      ? ((summary.no_show_count / summary.total_jobs) * 100).toFixed(1)
      : "0.0";

  const ratingValue =
    summary.avg_rating != null
      ? `\u2605 ${summary.avg_rating.toFixed(1)}`
      : "\u2605 —";
  const ratingHint =
    summary.rating_count > 0
      ? `${summary.rating_count} ${summary.rating_count === 1 ? "rating" : "ratings"}`
      : "no ratings yet";

  const cards = [
    { label: "Total Visitors", value: summary.unique_users },
    { label: "Jobs Completed", value: summary.completed_jobs },
    {
      label: "Avg Wait",
      value: summary.avg_wait_mins != null ? `${summary.avg_wait_mins} min` : "—",
    },
    { label: "No-Show Rate", value: `${noShowRate}%` },
    { label: "Avg Rating", value: ratingValue, hint: ratingHint },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-xl bg-white p-5 shadow-sm border border-gray-200"
        >
          <p className="text-sm font-medium text-gray-500">{c.label}</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{c.value}</p>
          {"hint" in c && c.hint ? (
            <p className="mt-1 text-xs text-amber-500">{c.hint}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
