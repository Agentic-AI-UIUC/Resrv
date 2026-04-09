# Analytics Dashboard — Design

**Date:** 2026-04-09
**Status:** Approved

## Summary

Add a full operational analytics dashboard to the Reserv web frontend. Admins can view daily, weekly, and monthly stats including attendance counts, wait/serve times, no-show rates, machine utilization, peak hours, and AI-generated summaries. Uses pre-computed daily snapshots for fast reads, with live queries for today's partial data.

## Data Model

Extend the existing `analytics_snapshots` table with four new columns:

| Column | Type | New? | Purpose |
|--------|------|------|---------|
| `date` | TEXT | Exists | Day (YYYY-MM-DD) |
| `machine_id` | INTEGER FK | Exists | Per-machine stats |
| `total_jobs` | INTEGER | Exists | Entries that entered the queue |
| `completed_jobs` | INTEGER | Exists | Entries with status=completed |
| `avg_wait_mins` | REAL | Exists | Mean(serving_at - joined_at) |
| `avg_serve_mins` | REAL | Exists | Mean(completed_at - serving_at) |
| `peak_hour` | INTEGER | Exists | Hour (0-23) with most joins |
| `ai_summary` | TEXT | Exists | OpenAI-generated summary |
| `no_show_count` | INTEGER | **Yes** | Entries with status=no_show |
| `cancelled_count` | INTEGER | **Yes** | Entries with status=cancelled |
| `unique_users` | INTEGER | **Yes** | Distinct user_ids for the day |
| `failure_count` | INTEGER | **Yes** | Entries where job_successful=0 |

## Background Job

Add an `_analytics_tick` method to the existing queue agent (`bot/agent.py`). Runs once daily at the configured reset hour (after queue reset). Steps:

1. Query `queue_entries` for the previous day, grouped by `machine_id`
2. Compute all metrics (totals, averages, peak hour, unique users)
3. Call OpenAI API to generate a natural-language summary per machine
4. Insert rows into `analytics_snapshots` (one row per machine per day)

## API Endpoints

| Method | Path | Query Params | Response |
|--------|------|-------------|----------|
| GET | `/api/analytics/` | `period=day|week|month`, `start_date`, `end_date` | All snapshots for date range, aggregated |
| GET | `/api/analytics/{machine_id}` | Same as above | Snapshots for one machine |
| GET | `/api/analytics/today` | — | Live-computed stats for today (not yet in snapshots) |

### Response Shape

```json
{
  "period": "week",
  "start_date": "2026-04-03",
  "end_date": "2026-04-09",
  "summary": {
    "total_jobs": 142,
    "completed_jobs": 128,
    "unique_users": 67,
    "avg_wait_mins": 8.3,
    "avg_serve_mins": 22.1,
    "no_show_count": 6,
    "cancelled_count": 8,
    "failure_count": 3
  },
  "machines": [
    {
      "machine_id": 1,
      "machine_name": "Large Format Printer",
      "total_jobs": 30,
      "completed_jobs": 27,
      "unique_users": 18,
      "avg_wait_mins": 6.2,
      "avg_serve_mins": 25.0,
      "no_show_count": 1,
      "cancelled_count": 2,
      "failure_count": 1,
      "peak_hour": 14,
      "ai_summary": "Steady day with 30 jobs..."
    }
  ],
  "daily_breakdown": [
    { "date": "2026-04-03", "total_jobs": 18, "completed_jobs": 16 }
  ]
}
```

## Frontend

### Navigation

Add React Router (`react-router-dom`):
- `/` — Queue dashboard (existing)
- `/analytics` — Analytics page (new)
- Nav bar at top of both pages with links

### Analytics Page Layout

1. **Period selector** — Day / Week / Month toggle buttons + date picker
2. **Summary cards row** — Total Visitors, Jobs Completed, Avg Wait Time, No-Show Rate (as percentage)
3. **AI Summary card** — Collapsible card showing the natural-language digest for the selected period
4. **Attendance chart** — Line chart showing daily job counts over the selected period
5. **Machine utilization** — Horizontal bar chart comparing machines by total jobs
6. **Peak hours** — Bar chart showing busiest hours of the day
7. **Per-machine table** — Sortable table with all metrics per machine

### Charting Library

Recharts — lightweight, React-native, works well with Vite + Tailwind.

### Design Style

Match the existing dashboard aesthetic: dark/neutral background, Tailwind utility classes, card-based layout, blurple accent color matching Discord branding.

## Files to Change

### Backend
- `db/database.py` — migration to add 4 new columns to `analytics_snapshots`
- `db/models.py` — analytics query helpers (insert snapshot, get snapshots by date range, compute live today stats)
- `bot/agent.py` — daily analytics computation job
- `api/routes/analytics.py` — new router with 3 endpoints
- `api/main.py` — register analytics router
- `tests/test_db.py` — tests for analytics model helpers
- `tests/test_api.py` — tests for analytics API endpoints

### Frontend
- `web/package.json` — add `react-router-dom`, `recharts`
- `web/src/App.tsx` — add Router, nav bar, route definitions
- `web/src/api/types.ts` — analytics response types
- `web/src/api/client.ts` — analytics fetch functions
- `web/src/hooks/useAnalytics.ts` — data fetching hook
- `web/src/pages/Dashboard.tsx` — extract existing queue view
- `web/src/pages/Analytics.tsx` — new analytics page
- `web/src/components/NavBar.tsx` — shared navigation
- `web/src/components/analytics/` — SummaryCards, AttendanceChart, MachineUtilization, PeakHours, MachineTable, AISummary
