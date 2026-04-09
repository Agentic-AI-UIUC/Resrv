# Analytics Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Full operational analytics dashboard with daily snapshots, live today stats, AI summaries, and a React frontend with charts.

**Architecture:** Pre-computed daily snapshots in `analytics_snapshots` table, populated by background job in the queue agent. Three new API endpoints serve historical + live data. React Router splits the app into `/` (queues) and `/analytics` (charts). Recharts for visualization.

**Tech Stack:** Python (aiosqlite, FastAPI, OpenAI), React 19, React Router v7, Recharts, Tailwind CSS v4

**Design doc:** `docs/plans/2026-04-09-analytics-dashboard-design.md`

---

### Task 1: Database Migration — Add New Columns to analytics_snapshots

**Files:**
- Modify: `db/database.py:102-120` (the `_migrate` function)

**Step 1: Add migration logic**

In `db/database.py`, extend `_migrate` to add four new columns to `analytics_snapshots` if they don't exist:

```python
    # Add new analytics columns if missing
    cursor = await db.execute("PRAGMA table_info(analytics_snapshots)")
    snap_columns = {row[1] for row in await cursor.fetchall()}
    if "no_show_count" not in snap_columns:
        await db.execute(
            "ALTER TABLE analytics_snapshots ADD COLUMN no_show_count INTEGER NOT NULL DEFAULT 0"
        )
    if "cancelled_count" not in snap_columns:
        await db.execute(
            "ALTER TABLE analytics_snapshots ADD COLUMN cancelled_count INTEGER NOT NULL DEFAULT 0"
        )
    if "unique_users" not in snap_columns:
        await db.execute(
            "ALTER TABLE analytics_snapshots ADD COLUMN unique_users INTEGER NOT NULL DEFAULT 0"
        )
    if "failure_count" not in snap_columns:
        await db.execute(
            "ALTER TABLE analytics_snapshots ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0"
        )
```

Append this block at the end of the existing `_migrate` function, after the user signup column migrations.

**Step 2: Verify migration runs**

Run: `python -c "import asyncio; from db.database import init_db; asyncio.run(init_db()); print('OK')"`
Expected: `OK`

**Step 3: Commit**

```bash
git add db/database.py
git commit -m "feat: add no_show_count, cancelled_count, unique_users, failure_count to analytics_snapshots"
```

---

### Task 2: Analytics Model Helpers + Tests

**Files:**
- Modify: `db/models.py` (append after the Queue Entries section, before the trailing newline)
- Test: `tests/test_db.py` (append new tests)

**Step 1: Write the failing tests**

Append to `tests/test_db.py`:

```python
# ── Analytics helpers ───────────────────────────────────────────────────


async def test_insert_analytics_snapshot(db):
    """insert_analytics_snapshot stores a row and get_snapshots retrieves it."""
    await models.insert_analytics_snapshot(
        date="2026-04-08",
        machine_id=1,
        total_jobs=10,
        completed_jobs=8,
        avg_wait_mins=5.5,
        avg_serve_mins=20.0,
        peak_hour=14,
        ai_summary="Busy day.",
        no_show_count=1,
        cancelled_count=1,
        unique_users=7,
        failure_count=0,
    )
    rows = await models.get_analytics_snapshots(
        start_date="2026-04-08", end_date="2026-04-08"
    )
    assert len(rows) == 1
    row = rows[0]
    assert row["total_jobs"] == 10
    assert row["completed_jobs"] == 8
    assert row["unique_users"] == 7
    assert row["no_show_count"] == 1
    assert row["ai_summary"] == "Busy day."


async def test_get_snapshots_date_range(db):
    """get_analytics_snapshots filters by date range."""
    for day in ("2026-04-06", "2026-04-07", "2026-04-08"):
        await models.insert_analytics_snapshot(
            date=day, machine_id=1, total_jobs=5, completed_jobs=4,
            avg_wait_mins=3.0, avg_serve_mins=15.0, peak_hour=10,
            ai_summary="", no_show_count=0, cancelled_count=0,
            unique_users=3, failure_count=0,
        )
    rows = await models.get_analytics_snapshots(
        start_date="2026-04-07", end_date="2026-04-08"
    )
    assert len(rows) == 2


async def test_get_snapshots_by_machine(db):
    """get_analytics_snapshots filters by machine_id."""
    await models.insert_analytics_snapshot(
        date="2026-04-08", machine_id=1, total_jobs=5, completed_jobs=4,
        avg_wait_mins=3.0, avg_serve_mins=15.0, peak_hour=10,
        ai_summary="", no_show_count=0, cancelled_count=0,
        unique_users=3, failure_count=0,
    )
    await models.insert_analytics_snapshot(
        date="2026-04-08", machine_id=2, total_jobs=8, completed_jobs=7,
        avg_wait_mins=4.0, avg_serve_mins=18.0, peak_hour=11,
        ai_summary="", no_show_count=0, cancelled_count=0,
        unique_users=5, failure_count=0,
    )
    rows = await models.get_analytics_snapshots(
        start_date="2026-04-08", end_date="2026-04-08", machine_id=2
    )
    assert len(rows) == 1
    assert rows[0]["machine_id"] == 2


async def test_compute_live_today_stats(db):
    """compute_live_today_stats returns current day metrics from queue_entries."""
    user = await models.get_or_create_user("stats1", "StatsUser")
    machine = await models.get_machine_by_slug("laser-cutter")

    # Create an entry and complete it
    entry = await models.join_queue(user["id"], machine["id"])
    await models.update_entry_status(entry["id"], "serving")
    await models.update_entry_status(entry["id"], "completed", job_successful=1)

    stats = await models.compute_live_today_stats()
    assert len(stats) > 0
    machine_stat = next(s for s in stats if s["machine_id"] == machine["id"])
    assert machine_stat["total_jobs"] >= 1
    assert machine_stat["completed_jobs"] >= 1
```

**Step 2: Run tests to verify they fail**

Run: `pytest tests/test_db.py::test_insert_analytics_snapshot tests/test_db.py::test_compute_live_today_stats -v`
Expected: FAIL with `AttributeError: module 'db.models' has no attribute 'insert_analytics_snapshot'`

**Step 3: Write the implementations**

Append to `db/models.py` after the `reset_stale_queues` function (before the trailing blank line):

```python
# ── Analytics ───────────────────────────────────────────────────────────


async def insert_analytics_snapshot(
    *,
    date: str,
    machine_id: int,
    total_jobs: int,
    completed_jobs: int,
    avg_wait_mins: float | None,
    avg_serve_mins: float | None,
    peak_hour: int | None,
    ai_summary: str | None,
    no_show_count: int,
    cancelled_count: int,
    unique_users: int,
    failure_count: int,
) -> None:
    """Insert a single analytics snapshot row."""
    db = await get_db()
    await db.execute(
        """
        INSERT INTO analytics_snapshots
            (date, machine_id, total_jobs, completed_jobs, avg_wait_mins,
             avg_serve_mins, peak_hour, ai_summary, no_show_count,
             cancelled_count, unique_users, failure_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (date, machine_id, total_jobs, completed_jobs, avg_wait_mins,
         avg_serve_mins, peak_hour, ai_summary, no_show_count,
         cancelled_count, unique_users, failure_count),
    )
    await db.commit()


async def get_analytics_snapshots(
    *,
    start_date: str,
    end_date: str,
    machine_id: int | None = None,
) -> list[dict[str, Any]]:
    """Get analytics snapshots for a date range, optionally filtered by machine."""
    db = await get_db()
    sql = """
        SELECT s.*, m.name as machine_name, m.slug as machine_slug
        FROM analytics_snapshots s
        JOIN machines m ON m.id = s.machine_id
        WHERE s.date >= ? AND s.date <= ?
    """
    params: list[Any] = [start_date, end_date]
    if machine_id is not None:
        sql += " AND s.machine_id = ?"
        params.append(machine_id)
    sql += " ORDER BY s.date ASC, s.machine_id ASC"
    cursor = await db.execute(sql, params)
    return _rows_to_dicts(await cursor.fetchall())


async def compute_live_today_stats() -> list[dict[str, Any]]:
    """Compute analytics for today from live queue_entries data."""
    db = await get_db()
    cursor = await db.execute(
        """
        SELECT
            qe.machine_id,
            m.name as machine_name,
            m.slug as machine_slug,
            COUNT(*) as total_jobs,
            SUM(CASE WHEN qe.status = 'completed' THEN 1 ELSE 0 END) as completed_jobs,
            SUM(CASE WHEN qe.status = 'no_show' THEN 1 ELSE 0 END) as no_show_count,
            SUM(CASE WHEN qe.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count,
            SUM(CASE WHEN qe.job_successful = 0 THEN 1 ELSE 0 END) as failure_count,
            COUNT(DISTINCT qe.user_id) as unique_users,
            AVG(CASE
                WHEN qe.serving_at IS NOT NULL
                THEN (julianday(qe.serving_at) - julianday(qe.joined_at)) * 24 * 60
            END) as avg_wait_mins,
            AVG(CASE
                WHEN qe.completed_at IS NOT NULL AND qe.serving_at IS NOT NULL
                THEN (julianday(qe.completed_at) - julianday(qe.serving_at)) * 24 * 60
            END) as avg_serve_mins
        FROM queue_entries qe
        JOIN machines m ON m.id = qe.machine_id
        WHERE date(qe.joined_at) = date('now')
        GROUP BY qe.machine_id
        ORDER BY qe.machine_id
        """
    )
    rows = _rows_to_dicts(await cursor.fetchall())
    # Compute peak hour per machine
    for row in rows:
        peak_cursor = await db.execute(
            """
            SELECT CAST(strftime('%H', qe.joined_at) AS INTEGER) as hour,
                   COUNT(*) as cnt
            FROM queue_entries qe
            WHERE qe.machine_id = ? AND date(qe.joined_at) = date('now')
            GROUP BY hour ORDER BY cnt DESC LIMIT 1
            """,
            (row["machine_id"],),
        )
        peak_row = await peak_cursor.fetchone()
        row["peak_hour"] = dict(peak_row)["hour"] if peak_row else None
    return rows
```

**Step 4: Run tests to verify they pass**

Run: `pytest tests/test_db.py -v`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add db/models.py tests/test_db.py
git commit -m "feat: add analytics model helpers (insert, query, live stats)"
```

---

### Task 3: Daily Analytics Background Job

**Files:**
- Modify: `agent/loop.py:49-66` (add analytics call in `_agent_tick`) and append new functions

**Step 1: Add imports**

At the top of `agent/loop.py`, after `from db import models`, add:

```python
from datetime import datetime, timedelta
```

**Step 2: Add the analytics computation function**

Append before the `_dm_user` helper:

```python
# --------------------------------------------------------------------------- #
# Daily analytics snapshot
# --------------------------------------------------------------------------- #

_last_snapshot_date: str | None = None


async def _compute_daily_analytics() -> None:
    """Compute and store analytics snapshot for yesterday (once per day)."""
    global _last_snapshot_date

    yesterday = (datetime.utcnow() - timedelta(days=1)).strftime("%Y-%m-%d")

    # Only run once per day
    if _last_snapshot_date == yesterday:
        return
    _last_snapshot_date = yesterday

    # Check if snapshots already exist for yesterday
    existing = await models.get_analytics_snapshots(
        start_date=yesterday, end_date=yesterday
    )
    if existing:
        return

    from db.database import get_db

    db = await get_db()

    machines = await models.get_machines()
    for machine in machines:
        mid = machine["id"]

        # Compute metrics from queue_entries
        cursor = await db.execute(
            """
            SELECT
                COUNT(*) as total_jobs,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_jobs,
                SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) as no_show_count,
                SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count,
                SUM(CASE WHEN job_successful = 0 THEN 1 ELSE 0 END) as failure_count,
                COUNT(DISTINCT user_id) as unique_users,
                AVG(CASE
                    WHEN serving_at IS NOT NULL
                    THEN (julianday(serving_at) - julianday(joined_at)) * 24 * 60
                END) as avg_wait_mins,
                AVG(CASE
                    WHEN completed_at IS NOT NULL AND serving_at IS NOT NULL
                    THEN (julianday(completed_at) - julianday(serving_at)) * 24 * 60
                END) as avg_serve_mins
            FROM queue_entries
            WHERE machine_id = ? AND date(joined_at) = ?
            """,
            (mid, yesterday),
        )
        row = dict(await cursor.fetchone())

        if row["total_jobs"] == 0:
            continue  # skip machines with no activity

        # Peak hour
        peak_cursor = await db.execute(
            """
            SELECT CAST(strftime('%H', joined_at) AS INTEGER) as hour,
                   COUNT(*) as cnt
            FROM queue_entries
            WHERE machine_id = ? AND date(joined_at) = ?
            GROUP BY hour ORDER BY cnt DESC LIMIT 1
            """,
            (mid, yesterday),
        )
        peak_row = await peak_cursor.fetchone()
        peak_hour = dict(peak_row)["hour"] if peak_row else None

        # AI summary
        ai_summary = await _generate_ai_summary(machine["name"], row, yesterday)

        await models.insert_analytics_snapshot(
            date=yesterday,
            machine_id=mid,
            total_jobs=row["total_jobs"],
            completed_jobs=row["completed_jobs"],
            avg_wait_mins=row["avg_wait_mins"],
            avg_serve_mins=row["avg_serve_mins"],
            peak_hour=peak_hour,
            ai_summary=ai_summary,
            no_show_count=row["no_show_count"],
            cancelled_count=row["cancelled_count"],
            unique_users=row["unique_users"],
            failure_count=row["failure_count"],
        )

    log.info("Analytics snapshots computed for %s", yesterday)


async def _generate_ai_summary(
    machine_name: str, stats: dict, date: str
) -> str | None:
    """Generate a natural-language analytics summary using OpenAI."""
    try:
        from openai import AsyncOpenAI

        client = AsyncOpenAI()
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "system",
                    "content": "You are a concise analytics assistant for a university maker space. Write a 1-2 sentence summary of the machine usage stats provided.",
                },
                {
                    "role": "user",
                    "content": (
                        f"Machine: {machine_name}, Date: {date}\n"
                        f"Total jobs: {stats['total_jobs']}, "
                        f"Completed: {stats['completed_jobs']}, "
                        f"No-shows: {stats['no_show_count']}, "
                        f"Cancelled: {stats['cancelled_count']}, "
                        f"Avg wait: {stats['avg_wait_mins']:.1f} min, "
                        f"Avg serve: {stats['avg_serve_mins']:.1f} min"
                    ),
                },
            ],
            max_tokens=100,
        )
        return response.choices[0].message.content
    except Exception:
        log.warning("AI summary generation failed for %s", machine_name)
        return None
```

**Step 3: Call the analytics function from `_agent_tick`**

In the `_agent_tick` function, add `await _compute_daily_analytics()` after `await _daily_reset()`:

```python
@tasks.loop(seconds=settings.agent_tick_seconds)
async def _agent_tick() -> None:
    try:
        await _process_machines()
        await _send_reminders()
        await _expire_grace_period()
        await _daily_reset()
        await _compute_daily_analytics()
    except Exception:
        log.exception("Agent tick failed")
```

**Step 4: Commit**

```bash
git add agent/loop.py
git commit -m "feat: add daily analytics snapshot computation with AI summaries"
```

---

### Task 4: Analytics API Endpoints + Tests

**Files:**
- Create: `api/routes/analytics.py`
- Modify: `api/main.py` (register new router)
- Test: `tests/test_api.py` (append tests)

**Step 1: Write the failing tests**

Append to `tests/test_api.py` (check the file to see what test client fixture name is used — it's likely `client`):

```python
# ── Analytics endpoints ─────────────────────────────────────────────────


async def test_analytics_empty(client):
    resp = client.get("/api/analytics/?period=day")
    assert resp.status_code == 200
    data = resp.json()
    assert data["machines"] == []


async def test_analytics_with_snapshot(db, client):
    from db import models

    await models.insert_analytics_snapshot(
        date="2026-04-08",
        machine_id=1,
        total_jobs=10,
        completed_jobs=8,
        avg_wait_mins=5.5,
        avg_serve_mins=20.0,
        peak_hour=14,
        ai_summary="Good day.",
        no_show_count=1,
        cancelled_count=1,
        unique_users=7,
        failure_count=0,
    )
    resp = client.get("/api/analytics/?start_date=2026-04-08&end_date=2026-04-08")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["machines"]) == 1
    assert data["summary"]["total_jobs"] == 10


async def test_analytics_machine_filter(db, client):
    from db import models

    await models.insert_analytics_snapshot(
        date="2026-04-08", machine_id=1, total_jobs=5, completed_jobs=4,
        avg_wait_mins=3.0, avg_serve_mins=15.0, peak_hour=10,
        ai_summary="", no_show_count=0, cancelled_count=0,
        unique_users=3, failure_count=0,
    )
    await models.insert_analytics_snapshot(
        date="2026-04-08", machine_id=2, total_jobs=8, completed_jobs=7,
        avg_wait_mins=4.0, avg_serve_mins=18.0, peak_hour=11,
        ai_summary="", no_show_count=0, cancelled_count=0,
        unique_users=5, failure_count=0,
    )
    resp = client.get("/api/analytics/2?start_date=2026-04-08&end_date=2026-04-08")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["machines"]) == 1
    assert data["machines"][0]["machine_id"] == 2


async def test_analytics_today(db, client):
    resp = client.get("/api/analytics/today")
    assert resp.status_code == 200
    data = resp.json()
    assert "machines" in data
```

**Step 2: Run to verify they fail**

Run: `pytest tests/test_api.py::test_analytics_empty -v`
Expected: FAIL (404 — route doesn't exist yet)

**Step 3: Create `api/routes/analytics.py`**

```python
"""Analytics endpoints — pre-computed snapshots + live today stats."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from db import models

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


# ── Schemas ──────────────────────────────────────────────────────────────


class MachineStat(BaseModel):
    machine_id: int
    machine_name: str
    total_jobs: int
    completed_jobs: int
    unique_users: int
    avg_wait_mins: float | None
    avg_serve_mins: float | None
    no_show_count: int
    cancelled_count: int
    failure_count: int
    peak_hour: int | None
    ai_summary: str | None


class DailyBreakdown(BaseModel):
    date: str
    total_jobs: int
    completed_jobs: int


class AnalyticsSummary(BaseModel):
    total_jobs: int
    completed_jobs: int
    unique_users: int
    avg_wait_mins: float | None
    avg_serve_mins: float | None
    no_show_count: int
    cancelled_count: int
    failure_count: int


class AnalyticsResponse(BaseModel):
    period: str
    start_date: str
    end_date: str
    summary: AnalyticsSummary
    machines: list[MachineStat]
    daily_breakdown: list[DailyBreakdown]


class TodayResponse(BaseModel):
    date: str
    machines: list[MachineStat]


# ── Helpers ──────────────────────────────────────────────────────────────


def _date_range(
    period: str | None,
    start_date: str | None,
    end_date: str | None,
) -> tuple[str, str, str]:
    """Resolve period/start/end into concrete date strings."""
    today = datetime.utcnow().date()
    if start_date and end_date:
        return (period or "custom", start_date, end_date)
    if period == "week":
        start = today - timedelta(days=7)
    elif period == "month":
        start = today - timedelta(days=30)
    else:
        start = today - timedelta(days=1)
        period = "day"
    return (period, start.isoformat(), today.isoformat())


def _aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate snapshot rows into summary + per-machine + daily breakdown."""
    if not rows:
        return {
            "summary": {
                "total_jobs": 0, "completed_jobs": 0, "unique_users": 0,
                "avg_wait_mins": None, "avg_serve_mins": None,
                "no_show_count": 0, "cancelled_count": 0, "failure_count": 0,
            },
            "machines": [],
            "daily_breakdown": [],
        }

    # Per-machine aggregation
    machine_map: dict[int, dict[str, Any]] = {}
    for r in rows:
        mid = r["machine_id"]
        if mid not in machine_map:
            machine_map[mid] = {
                "machine_id": mid,
                "machine_name": r.get("machine_name", ""),
                "total_jobs": 0, "completed_jobs": 0, "unique_users": 0,
                "no_show_count": 0, "cancelled_count": 0, "failure_count": 0,
                "peak_hour": r.get("peak_hour"),
                "ai_summary": r.get("ai_summary"),
                "_wait_sum": 0.0, "_wait_count": 0,
                "_serve_sum": 0.0, "_serve_count": 0,
            }
        m = machine_map[mid]
        m["total_jobs"] += r["total_jobs"]
        m["completed_jobs"] += r["completed_jobs"]
        m["unique_users"] += r.get("unique_users", 0)
        m["no_show_count"] += r.get("no_show_count", 0)
        m["cancelled_count"] += r.get("cancelled_count", 0)
        m["failure_count"] += r.get("failure_count", 0)
        if r.get("avg_wait_mins") is not None:
            m["_wait_sum"] += r["avg_wait_mins"] * r["total_jobs"]
            m["_wait_count"] += r["total_jobs"]
        if r.get("avg_serve_mins") is not None:
            m["_serve_sum"] += r["avg_serve_mins"] * r["completed_jobs"]
            m["_serve_count"] += r["completed_jobs"]
        m["ai_summary"] = r.get("ai_summary")  # keep latest
        m["peak_hour"] = r.get("peak_hour")

    machines = []
    for m in machine_map.values():
        machines.append({
            "machine_id": m["machine_id"],
            "machine_name": m["machine_name"],
            "total_jobs": m["total_jobs"],
            "completed_jobs": m["completed_jobs"],
            "unique_users": m["unique_users"],
            "avg_wait_mins": round(m["_wait_sum"] / m["_wait_count"], 1) if m["_wait_count"] else None,
            "avg_serve_mins": round(m["_serve_sum"] / m["_serve_count"], 1) if m["_serve_count"] else None,
            "no_show_count": m["no_show_count"],
            "cancelled_count": m["cancelled_count"],
            "failure_count": m["failure_count"],
            "peak_hour": m["peak_hour"],
            "ai_summary": m["ai_summary"],
        })

    # Daily breakdown
    day_map: dict[str, dict[str, int]] = {}
    for r in rows:
        d = r["date"]
        if d not in day_map:
            day_map[d] = {"date": d, "total_jobs": 0, "completed_jobs": 0}
        day_map[d]["total_jobs"] += r["total_jobs"]
        day_map[d]["completed_jobs"] += r["completed_jobs"]

    # Summary totals
    summary = {
        "total_jobs": sum(m["total_jobs"] for m in machines),
        "completed_jobs": sum(m["completed_jobs"] for m in machines),
        "unique_users": sum(m["unique_users"] for m in machines),
        "avg_wait_mins": None,
        "avg_serve_mins": None,
        "no_show_count": sum(m["no_show_count"] for m in machines),
        "cancelled_count": sum(m["cancelled_count"] for m in machines),
        "failure_count": sum(m["failure_count"] for m in machines),
    }
    wait_vals = [m["avg_wait_mins"] for m in machines if m["avg_wait_mins"] is not None]
    serve_vals = [m["avg_serve_mins"] for m in machines if m["avg_serve_mins"] is not None]
    if wait_vals:
        summary["avg_wait_mins"] = round(sum(wait_vals) / len(wait_vals), 1)
    if serve_vals:
        summary["avg_serve_mins"] = round(sum(serve_vals) / len(serve_vals), 1)

    return {
        "summary": summary,
        "machines": machines,
        "daily_breakdown": sorted(day_map.values(), key=lambda d: d["date"]),
    }


# ── Endpoints ────────────────────────────────────────────────────────────


@router.get("/today", response_model=TodayResponse)
async def get_today_stats() -> dict:
    """Live-computed stats for today (not in snapshots yet)."""
    today = datetime.utcnow().date().isoformat()
    stats = await models.compute_live_today_stats()
    machines = [
        {
            "machine_id": s["machine_id"],
            "machine_name": s["machine_name"],
            "total_jobs": s["total_jobs"],
            "completed_jobs": s["completed_jobs"],
            "unique_users": s["unique_users"],
            "avg_wait_mins": round(s["avg_wait_mins"], 1) if s["avg_wait_mins"] else None,
            "avg_serve_mins": round(s["avg_serve_mins"], 1) if s["avg_serve_mins"] else None,
            "no_show_count": s["no_show_count"],
            "cancelled_count": s["cancelled_count"],
            "failure_count": s["failure_count"],
            "peak_hour": s.get("peak_hour"),
            "ai_summary": None,
        }
        for s in stats
    ]
    return {"date": today, "machines": machines}


@router.get("/{machine_id}", response_model=AnalyticsResponse)
async def get_machine_analytics(
    machine_id: int,
    period: str | None = "day",
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict:
    """Analytics snapshots for a specific machine."""
    p, sd, ed = _date_range(period, start_date, end_date)
    rows = await models.get_analytics_snapshots(
        start_date=sd, end_date=ed, machine_id=machine_id
    )
    agg = _aggregate(rows)
    return {"period": p, "start_date": sd, "end_date": ed, **agg}


@router.get("/", response_model=AnalyticsResponse)
async def get_analytics(
    period: str | None = "day",
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict:
    """Analytics snapshots for all machines."""
    p, sd, ed = _date_range(period, start_date, end_date)
    rows = await models.get_analytics_snapshots(start_date=sd, end_date=ed)
    agg = _aggregate(rows)
    return {"period": p, "start_date": sd, "end_date": ed, **agg}
```

**Important:** The `/today` route must be defined BEFORE `/{machine_id}` so FastAPI doesn't interpret "today" as a machine_id.

**Step 4: Register the router in `api/main.py`**

Add after the queue router import:

```python
from api.routes.analytics import router as analytics_router
```

And after the `app.include_router(queue_router)` line:

```python
app.include_router(analytics_router)
```

**Step 5: Run tests**

Run: `pytest tests/test_api.py -v`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add api/routes/analytics.py api/main.py tests/test_api.py
git commit -m "feat: add analytics API endpoints (snapshots + live today)"
```

---

### Task 5: Frontend — Install Dependencies + React Router Setup

**Files:**
- Modify: `web/package.json` (add dependencies)
- Modify: `web/src/main.tsx` (wrap with BrowserRouter)
- Create: `web/src/pages/Dashboard.tsx` (extract existing queue view)
- Modify: `web/src/App.tsx` (add Router + NavBar)
- Create: `web/src/components/NavBar.tsx`

**Step 1: Install dependencies**

```bash
cd web && npm install react-router-dom recharts && cd ..
```

**Step 2: Create `web/src/components/NavBar.tsx`**

```tsx
import { Link, useLocation } from "react-router-dom";
import { ConnectionStatus } from "./ConnectionStatus";

export function NavBar() {
  const { pathname } = useLocation();

  const linkClass = (path: string) =>
    `px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
      pathname === path
        ? "bg-indigo-100 text-indigo-700"
        : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
    }`;

  return (
    <header className="bg-white border-b border-gray-200 shadow-sm">
      <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
                Reserv
              </h1>
              <p className="text-sm text-gray-500">SCD Queue Management</p>
            </div>
            <nav className="flex gap-1">
              <Link to="/" className={linkClass("/")}>
                Queues
              </Link>
              <Link to="/analytics" className={linkClass("/analytics")}>
                Analytics
              </Link>
            </nav>
          </div>
          <ConnectionStatus />
        </div>
      </div>
    </header>
  );
}
```

**Step 3: Create `web/src/pages/Dashboard.tsx`**

Extract the current queue dashboard content from `App.tsx` into this file:

```tsx
import { useQueues } from "../hooks/useQueues";
import { MachineColumn } from "../components/MachineColumn";

export function Dashboard() {
  const { queues, error, loading, refresh } = useQueues(3000);

  return (
    <>
      <div className="flex items-center justify-end mb-4">
        <button
          onClick={refresh}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 transition-colors cursor-pointer"
        >
          Refresh
        </button>
      </div>

      {loading && (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-emerald-600" />
        </div>
      )}

      {error && !loading && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center">
          <p className="font-medium text-red-800">Failed to load queues</p>
          <p className="mt-1 text-sm text-red-600">{error}</p>
          <button
            onClick={refresh}
            className="mt-3 rounded-md bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && (
        <div className="flex flex-wrap gap-4 justify-center lg:justify-start">
          {queues.map((q) => (
            <MachineColumn key={q.machine_id} queue={q} onRefresh={refresh} />
          ))}
        </div>
      )}
    </>
  );
}
```

**Step 4: Rewrite `web/src/App.tsx` with routing**

```tsx
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { NavBar } from "./components/NavBar";
import { Dashboard } from "./pages/Dashboard";
import { Analytics } from "./pages/Analytics";

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-gray-100">
        <NavBar />
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/analytics" element={<Analytics />} />
          </Routes>
        </main>
        <footer className="py-6 text-center text-sm text-gray-400">
          Built by <span className="font-bold">Agentic AI @ UIUC</span>
        </footer>
      </div>
    </BrowserRouter>
  );
}
```

**Step 5: Create placeholder `web/src/pages/Analytics.tsx`**

```tsx
export function Analytics() {
  return (
    <div className="text-center py-20 text-gray-500">
      Analytics — loading...
    </div>
  );
}
```

**Step 6: Verify build**

```bash
cd web && npm run build && cd ..
```
Expected: Build succeeds

**Step 7: Commit**

```bash
git add web/
git commit -m "feat: add React Router with NavBar, extract Dashboard page"
```

---

### Task 6: Frontend — API Client + Types + Hook

**Files:**
- Modify: `web/src/api/types.ts`
- Modify: `web/src/api/client.ts`
- Create: `web/src/hooks/useAnalytics.ts`

**Step 1: Add TypeScript types to `web/src/api/types.ts`**

Append to the file:

```typescript
// ── Analytics ───────────────────────────────────────────────────────────

export interface MachineStat {
  machine_id: number;
  machine_name: string;
  total_jobs: number;
  completed_jobs: number;
  unique_users: number;
  avg_wait_mins: number | null;
  avg_serve_mins: number | null;
  no_show_count: number;
  cancelled_count: number;
  failure_count: number;
  peak_hour: number | null;
  ai_summary: string | null;
}

export interface DailyBreakdown {
  date: string;
  total_jobs: number;
  completed_jobs: number;
}

export interface AnalyticsSummary {
  total_jobs: number;
  completed_jobs: number;
  unique_users: number;
  avg_wait_mins: number | null;
  avg_serve_mins: number | null;
  no_show_count: number;
  cancelled_count: number;
  failure_count: number;
}

export interface AnalyticsResponse {
  period: string;
  start_date: string;
  end_date: string;
  summary: AnalyticsSummary;
  machines: MachineStat[];
  daily_breakdown: DailyBreakdown[];
}

export interface TodayResponse {
  date: string;
  machines: MachineStat[];
}

export type AnalyticsPeriod = "day" | "week" | "month";
```

**Step 2: Add API client functions to `web/src/api/client.ts`**

Append to the file:

```typescript
// -- Analytics --

export const fetchAnalytics = (params?: {
  period?: string;
  start_date?: string;
  end_date?: string;
}) => {
  const qs = new URLSearchParams();
  if (params?.period) qs.set("period", params.period);
  if (params?.start_date) qs.set("start_date", params.start_date);
  if (params?.end_date) qs.set("end_date", params.end_date);
  const query = qs.toString();
  return request<import("./types").AnalyticsResponse>(
    `/analytics/${query ? `?${query}` : ""}`
  );
};

export const fetchMachineAnalytics = (
  machineId: number,
  params?: { period?: string; start_date?: string; end_date?: string }
) => {
  const qs = new URLSearchParams();
  if (params?.period) qs.set("period", params.period);
  if (params?.start_date) qs.set("start_date", params.start_date);
  if (params?.end_date) qs.set("end_date", params.end_date);
  const query = qs.toString();
  return request<import("./types").AnalyticsResponse>(
    `/analytics/${machineId}${query ? `?${query}` : ""}`
  );
};

export const fetchTodayStats = () =>
  request<import("./types").TodayResponse>("/analytics/today");
```

**Step 3: Create `web/src/hooks/useAnalytics.ts`**

```typescript
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
```

**Step 4: Verify build**

```bash
cd web && npm run build && cd ..
```

**Step 5: Commit**

```bash
git add web/src/api/ web/src/hooks/useAnalytics.ts
git commit -m "feat: add analytics TypeScript types, API client, and data hook"
```

---

### Task 7: Frontend — Analytics Page with Charts

**Files:**
- Create: `web/src/components/analytics/SummaryCards.tsx`
- Create: `web/src/components/analytics/AttendanceChart.tsx`
- Create: `web/src/components/analytics/MachineUtilization.tsx`
- Create: `web/src/components/analytics/PeakHours.tsx`
- Create: `web/src/components/analytics/MachineTable.tsx`
- Create: `web/src/components/analytics/AISummary.tsx`
- Modify: `web/src/pages/Analytics.tsx` (replace placeholder)

**Step 1: Create `web/src/components/analytics/SummaryCards.tsx`**

```tsx
import type { AnalyticsSummary } from "../../api/types";

interface Props {
  summary: AnalyticsSummary;
}

export function SummaryCards({ summary }: Props) {
  const noShowRate =
    summary.total_jobs > 0
      ? ((summary.no_show_count / summary.total_jobs) * 100).toFixed(1)
      : "0.0";

  const cards = [
    { label: "Total Visitors", value: summary.unique_users },
    { label: "Jobs Completed", value: summary.completed_jobs },
    {
      label: "Avg Wait",
      value: summary.avg_wait_mins != null ? `${summary.avg_wait_mins} min` : "—",
    },
    { label: "No-Show Rate", value: `${noShowRate}%` },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-xl bg-white p-5 shadow-sm border border-gray-200"
        >
          <p className="text-sm font-medium text-gray-500">{c.label}</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{c.value}</p>
        </div>
      ))}
    </div>
  );
}
```

**Step 2: Create `web/src/components/analytics/AttendanceChart.tsx`**

```tsx
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
```

**Step 3: Create `web/src/components/analytics/MachineUtilization.tsx`**

```tsx
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
```

**Step 4: Create `web/src/components/analytics/PeakHours.tsx`**

```tsx
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
  // Aggregate peak hours across machines into a distribution
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
```

**Step 5: Create `web/src/components/analytics/MachineTable.tsx`**

```tsx
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
```

**Step 6: Create `web/src/components/analytics/AISummary.tsx`**

```tsx
import { useState } from "react";
import type { MachineStat } from "../../api/types";

interface Props {
  machines: MachineStat[];
}

export function AISummary({ machines }: Props) {
  const [expanded, setExpanded] = useState(false);
  const summaries = machines.filter((m) => m.ai_summary);

  if (summaries.length === 0) return null;

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm border border-gray-200">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-sm font-medium text-gray-500 cursor-pointer w-full text-left"
      >
        <span className={`transition-transform ${expanded ? "rotate-90" : ""}`}>
          &#9654;
        </span>
        AI Summary
      </button>
      {expanded && (
        <div className="mt-3 space-y-2">
          {summaries.map((m) => (
            <div key={m.machine_id} className="text-sm text-gray-700">
              <span className="font-medium">{m.machine_name}:</span>{" "}
              {m.ai_summary}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 7: Rewrite `web/src/pages/Analytics.tsx`**

```tsx
import { useState } from "react";
import type { AnalyticsPeriod } from "../api/types";
import { useAnalytics } from "../hooks/useAnalytics";
import { SummaryCards } from "../components/analytics/SummaryCards";
import { AISummary } from "../components/analytics/AISummary";
import { AttendanceChart } from "../components/analytics/AttendanceChart";
import { MachineUtilization } from "../components/analytics/MachineUtilization";
import { PeakHours } from "../components/analytics/PeakHours";
import { MachineTable } from "../components/analytics/MachineTable";

const periods: { label: string; value: AnalyticsPeriod }[] = [
  { label: "Day", value: "day" },
  { label: "Week", value: "week" },
  { label: "Month", value: "month" },
];

export function Analytics() {
  const [period, setPeriod] = useState<AnalyticsPeriod>("week");
  const { data, error, loading } = useAnalytics(period);

  return (
    <div className="space-y-6">
      {/* Period selector */}
      <div className="flex items-center gap-2">
        {periods.map((p) => (
          <button
            key={p.value}
            onClick={() => setPeriod(p.value)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
              period === p.value
                ? "bg-indigo-600 text-white"
                : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-indigo-600" />
        </div>
      )}

      {error && !loading && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center">
          <p className="font-medium text-red-800">Failed to load analytics</p>
          <p className="mt-1 text-sm text-red-600">{error}</p>
        </div>
      )}

      {data && !loading && (
        <>
          <SummaryCards summary={data.summary} />
          <AISummary machines={data.machines} />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <AttendanceChart data={data.daily_breakdown} />
            <MachineUtilization machines={data.machines} />
          </div>

          <PeakHours machines={data.machines} />
          <MachineTable machines={data.machines} />
        </>
      )}
    </div>
  );
}
```

**Step 8: Verify build**

```bash
cd web && npm run build && cd ..
```
Expected: Build succeeds with no TypeScript errors

**Step 9: Commit**

```bash
git add web/src/
git commit -m "feat: add analytics page with charts, summary cards, and AI digest"
```

---

### Task 8: Run Full Test Suite + Verify

**Step 1: Run backend tests**

```bash
pytest tests/ -v
```
Expected: ALL PASS

**Step 2: Run frontend build**

```bash
cd web && npm run build && cd ..
```
Expected: Build succeeds

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat: analytics dashboard — complete implementation"
```
