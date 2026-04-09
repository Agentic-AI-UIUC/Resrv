"""Analytics endpoints — pre-computed snapshots + live today stats."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from db import models

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


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


def _date_range(
    period: str | None,
    start_date: str | None,
    end_date: str | None,
) -> tuple[str, str, str]:
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
        m["ai_summary"] = r.get("ai_summary")
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

    day_map: dict[str, dict[str, int]] = {}
    for r in rows:
        d = r["date"]
        if d not in day_map:
            day_map[d] = {"date": d, "total_jobs": 0, "completed_jobs": 0}
        day_map[d]["total_jobs"] += r["total_jobs"]
        day_map[d]["completed_jobs"] += r["completed_jobs"]

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


@router.get("/today", response_model=TodayResponse)
async def get_today_stats() -> dict:
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
    p, sd, ed = _date_range(period, start_date, end_date)
    rows = await models.get_analytics_snapshots(start_date=sd, end_date=ed)
    agg = _aggregate(rows)
    return {"period": p, "start_date": sd, "end_date": ed, **agg}
