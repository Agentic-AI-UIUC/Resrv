# Post-Visit Feedback Form Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a post-completion 1-5 star rating + optional comment captured via Discord DM, surfaced in the analytics dashboard, chatbot, and a new admin Feedback page.

**Architecture:** New `feedback` table with FK to `queue_entries` (UNIQUE per entry, ON DELETE CASCADE). Bot's existing success/failure DM in `bot/cogs/dm.py` triggers a follow-up `RatingView` after the user acknowledges completion; star clicks open a `FeedbackModal` with one optional `TextInput`. Backend exposes a staff GET endpoint and joins feedback into `compute_analytics_response` (summary, machines, colleges blocks all gain `avg_rating` + `rating_count`). Frontend gains an `/admin/feedback` page and lightweight `★ x.x (n)` accents on existing analytics cards.

**Tech Stack:** Python (FastAPI, aiosqlite, discord.py), React + Vite + Tailwind, SQLite (WAL).

**Design doc:** `docs/plans/2026-04-27-feedback-form-design.md`.

**Key prior learnings to respect:**
- Partial unique indexes & idempotent writes go in `_migrate` post-CREATE TABLE (learnings.md 2026-04-22).
- Backfills run AFTER seed steps in `init_db` (learnings.md 2026-04-22).
- Soft-deleted parents need their child cascade paths updated (learnings.md 2026-04-22). Here we use `ON DELETE CASCADE` so existing `purge_machine` works automatically.
- Persistent views need `bot.add_view()` + `timeout=None`; ephemeral views use a bounded timeout (learnings.md 2026-04-02). `RatingView` uses `timeout=600` and is NOT registered as persistent.
- DM modals can only carry `TextInput`; rating uses a separate ephemeral `View` first (same pattern as the college signup).
- `register_user` / `update_user_profile` / `models.create_*` raise typed errors; routes translate to 4xx with explicit messages.
- Cross-user access returns 404 (CLAUDE.md). N/A here; feedback is staff-readable.

---

## Task 1: DB schema — `feedback` table + `analytics_snapshots` rating columns

**Files:**
- Modify: `db/database.py` (`_create_tables`, `_migrate`)
- Test: `tests/test_db.py` (extend, +5 tests)

**Step 1: Write the failing tests**

Append to `tests/test_db.py`:

```python
async def test_feedback_table_exists_with_check_constraint(db):
    conn = await models.get_db()
    cursor = await conn.execute("PRAGMA table_info(feedback)")
    cols = {row[1] for row in await cursor.fetchall()}
    assert {"id", "queue_entry_id", "rating", "comment", "created_at"} <= cols


async def test_feedback_unique_per_queue_entry(db):
    conn = await models.get_db()
    user = await models.get_or_create_user(discord_id="ftest1", discord_name="u")
    machine = await models.get_machines()
    # join + serve + complete one entry
    entry = await models.join_queue(user["id"], machine[0]["id"])
    await models.update_entry_status(entry["id"], "serving")
    await models.update_entry_status(entry["id"], "completed", job_successful=1)
    await conn.execute(
        "INSERT INTO feedback (queue_entry_id, rating) VALUES (?, ?)",
        (entry["id"], 5),
    )
    await conn.commit()
    with pytest.raises(Exception):
        await conn.execute(
            "INSERT INTO feedback (queue_entry_id, rating) VALUES (?, ?)",
            (entry["id"], 3),
        )


async def test_feedback_check_blocks_invalid_rating(db):
    conn = await models.get_db()
    user = await models.get_or_create_user(discord_id="ftest2", discord_name="u")
    machine = await models.get_machines()
    entry = await models.join_queue(user["id"], machine[0]["id"])
    with pytest.raises(Exception):
        await conn.execute(
            "INSERT INTO feedback (queue_entry_id, rating) VALUES (?, ?)",
            (entry["id"], 0),
        )
    with pytest.raises(Exception):
        await conn.execute(
            "INSERT INTO feedback (queue_entry_id, rating) VALUES (?, ?)",
            (entry["id"], 6),
        )


async def test_feedback_cascades_on_queue_entry_delete(db):
    conn = await models.get_db()
    user = await models.get_or_create_user(discord_id="ftest3", discord_name="u")
    machine = await models.get_machines()
    entry = await models.join_queue(user["id"], machine[0]["id"])
    await conn.execute(
        "INSERT INTO feedback (queue_entry_id, rating, comment) VALUES (?, ?, ?)",
        (entry["id"], 4, "ok"),
    )
    await conn.commit()
    await conn.execute("DELETE FROM queue_entries WHERE id = ?", (entry["id"],))
    await conn.commit()
    cursor = await conn.execute(
        "SELECT COUNT(*) AS cnt FROM feedback WHERE queue_entry_id = ?",
        (entry["id"],),
    )
    row = await cursor.fetchone()
    assert row["cnt"] == 0


async def test_analytics_snapshots_has_rating_columns(db):
    conn = await models.get_db()
    cursor = await conn.execute("PRAGMA table_info(analytics_snapshots)")
    cols = {row[1] for row in await cursor.fetchall()}
    assert "avg_rating" in cols
    assert "rating_count" in cols
```

**Step 2: Run tests red**

```
pytest tests/test_db.py -v -k feedback
pytest tests/test_db.py::test_analytics_snapshots_has_rating_columns -v
```

Expected: 5 FAILs (no `feedback` table, missing snapshot cols).

**Step 3: Add table to `_create_tables`**

In `db/database.py` `_create_tables`, inside the `executescript` block, add (after `chat_messages`):

```sql
CREATE TABLE IF NOT EXISTS feedback (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_entry_id  INTEGER NOT NULL UNIQUE
                    REFERENCES queue_entries(id) ON DELETE CASCADE,
    rating          INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment         TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

Also add `avg_rating REAL` and `rating_count INTEGER NOT NULL DEFAULT 0` to the `analytics_snapshots` table definition.

**Step 4: Add migration block to `_migrate`**

Append (after the colleges migration block, before chat tables ARE re-created defensively at the end):

```python
# Feedback table — additive on upgrade.
await db.execute(
    """
    CREATE TABLE IF NOT EXISTS feedback (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_entry_id  INTEGER NOT NULL UNIQUE
                        REFERENCES queue_entries(id) ON DELETE CASCADE,
        rating          INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment         TEXT,
        created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    )
    """
)
await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_feedback_created_at "
    "ON feedback(created_at DESC)"
)

# analytics_snapshots — add rating columns if missing.
cursor = await db.execute("PRAGMA table_info(analytics_snapshots)")
snap_cols_v3 = {row[1] for row in await cursor.fetchall()}
if "avg_rating" not in snap_cols_v3:
    await db.execute(
        "ALTER TABLE analytics_snapshots ADD COLUMN avg_rating REAL"
    )
if "rating_count" not in snap_cols_v3:
    await db.execute(
        "ALTER TABLE analytics_snapshots "
        "ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0"
    )
```

**Step 5: Run tests green**

```
pytest tests/test_db.py -v
```

Expected: 5 new tests PASS, all existing test_db tests still PASS.

**Step 6: Commit**

```bash
git add db/database.py tests/test_db.py
git commit -m "feat(db): feedback table + analytics_snapshots rating cols

- feedback (id, queue_entry_id UNIQUE FK ON DELETE CASCADE, rating CHECK 1..5,
  comment, created_at) + idx_feedback_created_at
- analytics_snapshots gains avg_rating REAL NULL, rating_count INTEGER DEFAULT 0
- Idempotent migration; no backfill"
```

---

## Task 2: DB models — feedback CRUD + aggregate helpers

**Files:**
- Modify: `db/models.py` (append helpers + `FeedbackAlreadyExistsError`)
- Test: `tests/test_feedback_db.py` (new)

**Step 1: Write the failing tests**

Create `tests/test_feedback_db.py`:

```python
"""DB-layer tests for the feedback table."""
import pytest
from db import models

pytestmark = pytest.mark.asyncio


async def _make_completed_entry(*, discord_id: str, college_name: str | None = None):
    """Helper: create user (optionally with college), join+serve+complete an entry."""
    user = await models.get_or_create_user(discord_id=discord_id, discord_name="u")
    if college_name:
        college = await models.create_college(college_name)
        await models.register_user(
            user_id=user["id"], full_name="X", email=f"{discord_id}@illinois.edu",
            major="CS", college_id=college["id"], graduation_year="2027",
        )
    machines = await models.get_machines()
    entry = await models.join_queue(user["id"], machines[0]["id"])
    await models.update_entry_status(entry["id"], "serving")
    await models.update_entry_status(entry["id"], "completed", job_successful=1)
    return entry, user, machines[0]


async def test_create_feedback(db):
    entry, _, _ = await _make_completed_entry(discord_id="fb-create")
    row = await models.create_feedback(
        queue_entry_id=entry["id"], rating=5, comment="great",
    )
    assert row["id"] > 0
    assert row["rating"] == 5
    assert row["comment"] == "great"


async def test_create_feedback_with_null_comment(db):
    entry, _, _ = await _make_completed_entry(discord_id="fb-null")
    row = await models.create_feedback(
        queue_entry_id=entry["id"], rating=3, comment=None,
    )
    assert row["comment"] is None


async def test_create_feedback_dup_raises(db):
    entry, _, _ = await _make_completed_entry(discord_id="fb-dup")
    await models.create_feedback(queue_entry_id=entry["id"], rating=4, comment=None)
    with pytest.raises(models.FeedbackAlreadyExistsError):
        await models.create_feedback(queue_entry_id=entry["id"], rating=2, comment=None)


async def test_get_feedback_by_entry_returns_none_when_absent(db):
    entry, _, _ = await _make_completed_entry(discord_id="fb-none")
    assert await models.get_feedback_by_entry(entry["id"]) is None


async def test_list_feedback_ordered_desc(db):
    e1, _, _ = await _make_completed_entry(discord_id="fb-1")
    e2, _, _ = await _make_completed_entry(discord_id="fb-2")
    await models.create_feedback(queue_entry_id=e1["id"], rating=1, comment="bad")
    await models.create_feedback(queue_entry_id=e2["id"], rating=5, comment="ok")
    rows = await models.list_feedback()
    # most recent first; e2 inserted second, so it leads
    assert rows[0]["queue_entry_id"] == e2["id"]
    assert rows[1]["queue_entry_id"] == e1["id"]


async def test_list_feedback_filters_by_min_max_rating(db):
    e1, _, _ = await _make_completed_entry(discord_id="fb-r1")
    e2, _, _ = await _make_completed_entry(discord_id="fb-r2")
    e3, _, _ = await _make_completed_entry(discord_id="fb-r3")
    await models.create_feedback(queue_entry_id=e1["id"], rating=2, comment=None)
    await models.create_feedback(queue_entry_id=e2["id"], rating=4, comment=None)
    await models.create_feedback(queue_entry_id=e3["id"], rating=5, comment=None)
    rows = await models.list_feedback(min_rating=3)
    assert {r["queue_entry_id"] for r in rows} == {e2["id"], e3["id"]}
    rows = await models.list_feedback(max_rating=4)
    assert {r["queue_entry_id"] for r in rows} == {e1["id"], e2["id"]}


async def test_list_feedback_includes_joined_fields(db):
    entry, user, machine = await _make_completed_entry(
        discord_id="fb-joined", college_name="JoinedCollege",
    )
    await models.create_feedback(
        queue_entry_id=entry["id"], rating=4, comment="nice",
    )
    rows = await models.list_feedback()
    row = next(r for r in rows if r["queue_entry_id"] == entry["id"])
    assert row["machine_name"] == machine["name"]
    assert row["college_name"] == "JoinedCollege"
    assert row["full_name"] == "X"
    assert row["user_id"] == user["id"]


async def test_feedback_aggregates_overall_handles_empty(db):
    agg = await models.feedback_aggregates_overall("2000-01-01", "2099-01-01")
    assert agg["rating_count"] == 0
    assert agg["avg_rating"] is None


async def test_feedback_aggregates_overall_computes(db):
    e1, _, _ = await _make_completed_entry(discord_id="agg-1")
    e2, _, _ = await _make_completed_entry(discord_id="agg-2")
    await models.create_feedback(queue_entry_id=e1["id"], rating=3, comment=None)
    await models.create_feedback(queue_entry_id=e2["id"], rating=5, comment=None)
    agg = await models.feedback_aggregates_overall("2000-01-01", "2099-01-01")
    assert agg["rating_count"] == 2
    assert agg["avg_rating"] == 4.0
```

**Step 2: Run tests red**

```
pytest tests/test_feedback_db.py -v
```

Expected: 9 FAILs (helpers not defined).

**Step 3: Append helpers to `db/models.py`**

```python
class FeedbackAlreadyExistsError(Exception):
    """Raised when a queue_entry already has feedback."""


async def create_feedback(
    *, queue_entry_id: int, rating: int, comment: str | None
) -> dict:
    db = await get_db()
    try:
        cursor = await db.execute(
            "INSERT INTO feedback (queue_entry_id, rating, comment) "
            "VALUES (?, ?, ?) RETURNING *",
            (queue_entry_id, rating, comment),
        )
    except Exception as e:
        if "UNIQUE" in str(e):
            raise FeedbackAlreadyExistsError(queue_entry_id) from e
        raise
    row = await cursor.fetchone()
    await db.commit()
    return dict(row)


async def get_feedback_by_entry(queue_entry_id: int) -> dict | None:
    db = await get_db()
    cursor = await db.execute(
        "SELECT * FROM feedback WHERE queue_entry_id = ?", (queue_entry_id,)
    )
    row = await cursor.fetchone()
    return dict(row) if row else None


async def list_feedback(
    *,
    limit: int = 50,
    machine_id: int | None = None,
    college_id: int | None = None,
    min_rating: int | None = None,
    max_rating: int | None = None,
) -> list[dict]:
    db = await get_db()
    where = []
    params: list = []
    if machine_id is not None:
        where.append("qe.machine_id = ?")
        params.append(machine_id)
    if college_id is not None:
        where.append("u.college_id = ?")
        params.append(college_id)
    if min_rating is not None:
        where.append("f.rating >= ?")
        params.append(min_rating)
    if max_rating is not None:
        where.append("f.rating <= ?")
        params.append(max_rating)
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    sql = f"""
        SELECT
            f.id, f.queue_entry_id, f.rating, f.comment, f.created_at,
            u.id           AS user_id,
            u.full_name    AS full_name,
            u.discord_name AS discord_name,
            m.id           AS machine_id,
            m.name         AS machine_name,
            u.college_id   AS college_id,
            COALESCE(c.name, 'Unspecified') AS college_name
        FROM feedback f
        JOIN queue_entries qe ON qe.id = f.queue_entry_id
        JOIN users u          ON u.id  = qe.user_id
        JOIN machines m       ON m.id  = qe.machine_id
        LEFT JOIN colleges c  ON c.id  = u.college_id
        {where_sql}
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT ?
    """
    params.append(limit)
    cursor = await db.execute(sql, tuple(params))
    return [dict(r) for r in await cursor.fetchall()]


async def feedback_aggregates_overall(
    start: str, end: str, *,
    college_id: int | None = None, machine_id: int | None = None,
) -> dict:
    db = await get_db()
    where = ["f.created_at BETWEEN ? AND ?"]
    params: list = [start, end]
    if college_id is not None:
        where.append("u.college_id = ?")
        params.append(college_id)
    if machine_id is not None:
        where.append("qe.machine_id = ?")
        params.append(machine_id)
    sql = f"""
        SELECT AVG(f.rating) AS avg_rating, COUNT(f.rating) AS rating_count
        FROM feedback f
        JOIN queue_entries qe ON qe.id = f.queue_entry_id
        JOIN users u          ON u.id  = qe.user_id
        WHERE {" AND ".join(where)}
    """
    row = await (await db.execute(sql, tuple(params))).fetchone()
    return {
        "avg_rating": row["avg_rating"],
        "rating_count": row["rating_count"],
    }


async def feedback_aggregates_by_machine(
    start: str, end: str, *, college_id: int | None = None,
) -> dict[int, dict]:
    db = await get_db()
    where = ["f.created_at BETWEEN ? AND ?"]
    params: list = [start, end]
    if college_id is not None:
        where.append("u.college_id = ?")
        params.append(college_id)
    sql = f"""
        SELECT qe.machine_id AS machine_id,
               AVG(f.rating) AS avg_rating,
               COUNT(f.rating) AS rating_count
        FROM feedback f
        JOIN queue_entries qe ON qe.id = f.queue_entry_id
        JOIN users u          ON u.id  = qe.user_id
        WHERE {" AND ".join(where)}
        GROUP BY qe.machine_id
    """
    cursor = await db.execute(sql, tuple(params))
    rows = await cursor.fetchall()
    return {
        row["machine_id"]: {
            "avg_rating": row["avg_rating"],
            "rating_count": row["rating_count"],
        }
        for row in rows
    }


async def feedback_aggregates_by_college(
    start: str, end: str, *, machine_id: int | None = None,
) -> dict[int, dict]:
    db = await get_db()
    where = ["f.created_at BETWEEN ? AND ?"]
    params: list = [start, end]
    if machine_id is not None:
        where.append("qe.machine_id = ?")
        params.append(machine_id)
    sql = f"""
        SELECT COALESCE(u.college_id, 0) AS college_id,
               AVG(f.rating)              AS avg_rating,
               COUNT(f.rating)            AS rating_count
        FROM feedback f
        JOIN queue_entries qe ON qe.id = f.queue_entry_id
        JOIN users u          ON u.id  = qe.user_id
        WHERE {" AND ".join(where)}
        GROUP BY COALESCE(u.college_id, 0)
    """
    cursor = await db.execute(sql, tuple(params))
    rows = await cursor.fetchall()
    return {
        row["college_id"]: {
            "avg_rating": row["avg_rating"],
            "rating_count": row["rating_count"],
        }
        for row in rows
    }
```

**Step 4: Run tests green**

```
pytest tests/test_feedback_db.py tests/test_db.py -v
```

Expected: All PASS.

**Step 5: Commit**

```bash
git add db/models.py tests/test_feedback_db.py
git commit -m "feat(db): feedback helpers + aggregate queries

- create_feedback raises FeedbackAlreadyExistsError on UNIQUE
- list_feedback joins users + machines + colleges with composable filters
- Per-overall / per-machine / per-college aggregate helpers"
```

---

## Task 3: API — `/api/feedback/` staff GET

**Files:**
- Create: `api/routes/feedback.py`
- Modify: `api/main.py` (mount router)
- Test: `tests/test_feedback_api.py` (new)

**Step 1: Write the failing tests**

Create `tests/test_feedback_api.py` (mirror `tests/test_colleges_api.py` style for fixtures/auth helper):

```python
"""HTTP-layer tests for /api/feedback."""
import pytest
from db import models

pytestmark = pytest.mark.asyncio


def _staff_headers(client):
    res = client.post("/api/auth/login", json={"username": "admin", "password": "changeme"})
    return {"Authorization": f"Bearer {res.json()['token']}"}


async def _seed_one_feedback(rating=5, college_name="Listed"):
    user = await models.get_or_create_user(discord_id="fbapi", discord_name="u")
    college = await models.create_college(college_name)
    await models.register_user(
        user_id=user["id"], full_name="API User",
        email="api@illinois.edu", major="CS",
        college_id=college["id"], graduation_year="2027",
    )
    machines = await models.get_machines()
    entry = await models.join_queue(user["id"], machines[0]["id"])
    await models.update_entry_status(entry["id"], "serving")
    await models.update_entry_status(entry["id"], "completed", job_successful=1)
    await models.create_feedback(
        queue_entry_id=entry["id"], rating=rating, comment="hello",
    )
    return entry, user, machines[0], college


async def test_get_feedback_requires_staff(client):
    res = client.get("/api/feedback/")
    assert res.status_code == 401


async def test_get_feedback_returns_joined_rows(client):
    await _seed_one_feedback(rating=4)
    res = client.get("/api/feedback/", headers=_staff_headers(client))
    assert res.status_code == 200
    body = res.json()
    assert len(body) >= 1
    row = body[0]
    assert row["rating"] == 4
    assert row["comment"] == "hello"
    assert row["full_name"] == "API User"
    assert row["machine_name"]
    assert row["college_name"] == "Listed"


async def test_get_feedback_filters_by_min_rating(client):
    e1, _, _, _ = await _seed_one_feedback(rating=2, college_name="A")
    res = client.get(
        "/api/feedback/?min_rating=4", headers=_staff_headers(client)
    )
    body = res.json()
    assert all(r["rating"] >= 4 for r in body)


async def test_get_feedback_filters_by_machine_id(client):
    _, _, machine, _ = await _seed_one_feedback(rating=5, college_name="M")
    res = client.get(
        f"/api/feedback/?machine_id={machine['id']}",
        headers=_staff_headers(client),
    )
    body = res.json()
    assert all(r["machine_id"] == machine["id"] for r in body)


async def test_get_feedback_invalid_min_rating_returns_422(client):
    res = client.get(
        "/api/feedback/?min_rating=-1", headers=_staff_headers(client)
    )
    assert res.status_code == 422


async def test_get_feedback_limit_caps_results(client):
    for i in range(5):
        await _seed_one_feedback(rating=3, college_name=f"C{i}")
    res = client.get(
        "/api/feedback/?limit=2", headers=_staff_headers(client)
    )
    body = res.json()
    assert len(body) == 2
```

(Adjust fixture name to `client` and the auth helper signature to match the actual conftest in this repo, mirroring `tests/test_colleges_api.py`.)

**Step 2: Run tests red**

Expected: 6 FAILs (router not mounted).

**Step 3: Create `api/routes/feedback.py`**

```python
"""Feedback browse routes — staff-only read."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from api.auth import require_staff
from db import models

router = APIRouter(prefix="/api/feedback", tags=["feedback"])


class FeedbackRow(BaseModel):
    id: int
    queue_entry_id: int
    rating: int
    comment: str | None
    created_at: str
    user_id: int
    full_name: str | None
    discord_name: str | None
    machine_id: int
    machine_name: str
    college_id: int | None
    college_name: str


@router.get("/", response_model=list[FeedbackRow],
            dependencies=[Depends(require_staff)])
async def list_feedback_endpoint(
    limit: int = Query(50, ge=1, le=500),
    machine_id: int | None = Query(None, ge=1),
    college_id: int | None = Query(None, ge=1),
    min_rating: int | None = Query(None, ge=1, le=5),
    max_rating: int | None = Query(None, ge=1, le=5),
):
    rows = await models.list_feedback(
        limit=limit,
        machine_id=machine_id,
        college_id=college_id,
        min_rating=min_rating,
        max_rating=max_rating,
    )
    return [FeedbackRow(**r) for r in rows]
```

**Step 4: Mount in `api/main.py`**

```python
from api.routes import feedback as feedback_routes
app.include_router(feedback_routes.router)
```

**Step 5: Run tests green**

```
pytest tests/test_feedback_api.py tests/ 2>&1 | tail -10
```

Expected: All PASS.

**Step 6: Commit**

```bash
git add api/routes/feedback.py api/main.py tests/test_feedback_api.py
git commit -m "feat(api): /api/feedback staff GET with composable filters

- limit, machine_id, college_id, min/max_rating
- 422 on out-of-range rating filters
- Returns joined rows with user/machine/college names"
```

---

## Task 4: Discord — `RatingView` + `FeedbackModal`, wired into `dm.py`

**Files:**
- Modify: `bot/cogs/dm.py` (post-completion DM flow)
- Test: `tests/test_feedback_flow.py` (new)

**Step 1: Read `bot/cogs/dm.py`**

Locate the success/failure ack flow (`FallbackActions` view callbacks). The `update_entry_status(... "completed", ...)` calls are on both Yes (success) and No (failure-with-notes) branches. The new flow inserts a follow-up DM right after each.

**Step 2: Write the failing tests**

Create `tests/test_feedback_flow.py`:

```python
"""Discord-side feedback flow."""
import pytest
from unittest.mock import AsyncMock, MagicMock

from bot.cogs.dm import RatingView, FeedbackModal, send_rating_dm
from db import models

pytestmark = pytest.mark.asyncio


@pytest.fixture
def fake_user():
    u = MagicMock()
    u.send = AsyncMock()
    return u


@pytest.fixture
def fake_interaction():
    inter = MagicMock()
    inter.response.send_modal = AsyncMock()
    inter.response.send_message = AsyncMock()
    inter.response.edit_message = AsyncMock()
    inter.message.edit = AsyncMock()
    return inter


async def _make_completed_entry(discord_id):
    user = await models.get_or_create_user(discord_id=discord_id, discord_name="u")
    machines = await models.get_machines()
    entry = await models.join_queue(user["id"], machines[0]["id"])
    await models.update_entry_status(entry["id"], "serving")
    await models.update_entry_status(entry["id"], "completed", job_successful=1)
    return entry, machines[0]


async def test_send_rating_dm_sends_view(db, fake_user):
    entry, machine = await _make_completed_entry("rate-dm")
    await send_rating_dm(fake_user, queue_entry_id=entry["id"],
                         machine_name=machine["name"])
    fake_user.send.assert_awaited_once()
    args, kwargs = fake_user.send.call_args
    assert isinstance(kwargs["view"], RatingView)
    assert machine["name"] in (kwargs.get("content") or args[0])


async def test_star_button_opens_modal(db, fake_interaction):
    entry, machine = await _make_completed_entry("rate-star")
    view = RatingView(queue_entry_id=entry["id"], machine_name=machine["name"])
    star4 = next(b for b in view.children if getattr(b, "_rating", None) == 4)
    await star4.callback(fake_interaction)
    fake_interaction.response.send_modal.assert_awaited_once()
    modal = fake_interaction.response.send_modal.call_args.args[0]
    assert isinstance(modal, FeedbackModal)
    assert modal._rating == 4
    assert modal._queue_entry_id == entry["id"]


async def test_modal_submit_writes_row_and_acks(db, fake_interaction):
    entry, machine = await _make_completed_entry("rate-submit")
    modal = FeedbackModal(queue_entry_id=entry["id"], rating=5,
                          machine_name=machine["name"])
    modal.comment = MagicMock(value="great")
    await modal.on_submit(fake_interaction)
    saved = await models.get_feedback_by_entry(entry["id"])
    assert saved["rating"] == 5
    assert saved["comment"] == "great"
    fake_interaction.response.send_message.assert_awaited_once()


async def test_modal_submit_blank_comment_writes_null(db, fake_interaction):
    entry, machine = await _make_completed_entry("rate-blank")
    modal = FeedbackModal(queue_entry_id=entry["id"], rating=3,
                          machine_name=machine["name"])
    modal.comment = MagicMock(value="")
    await modal.on_submit(fake_interaction)
    saved = await models.get_feedback_by_entry(entry["id"])
    assert saved["comment"] is None


async def test_modal_submit_duplicate_shows_friendly_error(db, fake_interaction):
    entry, machine = await _make_completed_entry("rate-dup")
    await models.create_feedback(queue_entry_id=entry["id"], rating=2,
                                  comment=None)
    modal = FeedbackModal(queue_entry_id=entry["id"], rating=4,
                          machine_name=machine["name"])
    modal.comment = MagicMock(value="late")
    await modal.on_submit(fake_interaction)
    fake_interaction.response.send_message.assert_awaited_once()
    args, kwargs = fake_interaction.response.send_message.call_args
    msg = args[0] if args else kwargs.get("content", "")
    assert "already" in msg.lower()


async def test_skip_button_writes_nothing(db, fake_interaction):
    entry, machine = await _make_completed_entry("rate-skip")
    view = RatingView(queue_entry_id=entry["id"], machine_name=machine["name"])
    skip = next(b for b in view.children if getattr(b, "_rating", None) is None)
    await skip.callback(fake_interaction)
    assert await models.get_feedback_by_entry(entry["id"]) is None
```

**Step 3: Run tests red**

```
pytest tests/test_feedback_flow.py -v
```

Expected: All FAIL — types don't exist.

**Step 4: Implement `RatingView`, `FeedbackModal`, `send_rating_dm` in `bot/cogs/dm.py`**

Append (read existing `dm.py` first to match style):

```python
import discord


async def send_rating_dm(user: discord.User | discord.Member, *,
                          queue_entry_id: int, machine_name: str) -> None:
    """Send the post-completion rating prompt to the user via DM.
    Silently swallows discord.Forbidden (DMs disabled)."""
    try:
        await user.send(
            content=f"How was your experience using **{machine_name}**?",
            view=RatingView(queue_entry_id=queue_entry_id,
                            machine_name=machine_name),
        )
    except discord.Forbidden:
        log.warning("cannot DM user %s — DMs disabled", user.id)


class _RatingButton(discord.ui.Button):
    def __init__(self, *, rating: int | None, label: str, custom_id: str,
                  style: discord.ButtonStyle = discord.ButtonStyle.secondary,
                  row: int = 0):
        super().__init__(label=label, custom_id=custom_id, style=style, row=row)
        self._rating = rating  # None = Skip

    async def callback(self, interaction: discord.Interaction) -> None:
        view: RatingView = self.view  # type: ignore[assignment]
        if self._rating is None:
            # Skip path: edit the parent message, disable buttons, no DB write.
            for child in view.children:
                if isinstance(child, discord.ui.Button):
                    child.disabled = True
            await interaction.response.edit_message(
                content="Thanks anyway!", view=view,
            )
            return
        await interaction.response.send_modal(FeedbackModal(
            queue_entry_id=view._queue_entry_id,
            rating=self._rating,
            machine_name=view._machine_name,
        ))


class RatingView(discord.ui.View):
    def __init__(self, *, queue_entry_id: int, machine_name: str) -> None:
        super().__init__(timeout=600)
        self._queue_entry_id = queue_entry_id
        self._machine_name = machine_name
        for n in range(1, 6):
            self.add_item(_RatingButton(
                rating=n, label=f"{n}★",
                custom_id=f"rate:{queue_entry_id}:{n}", row=0,
            ))
        self.add_item(_RatingButton(
            rating=None, label="Skip",
            custom_id=f"rate:{queue_entry_id}:skip", row=1,
        ))


class FeedbackModal(discord.ui.Modal, title="Tell us more (optional)"):
    comment = discord.ui.TextInput(
        label="Your feedback",
        style=discord.TextStyle.paragraph,
        placeholder="What worked? What didn't? (optional)",
        required=False,
        max_length=500,
    )

    def __init__(self, *, queue_entry_id: int, rating: int,
                  machine_name: str) -> None:
        super().__init__()
        self._queue_entry_id = queue_entry_id
        self._rating = rating
        self._machine_name = machine_name

    async def on_submit(self, interaction: discord.Interaction) -> None:
        comment_val = (self.comment.value or "").strip() or None
        try:
            await models.create_feedback(
                queue_entry_id=self._queue_entry_id,
                rating=self._rating,
                comment=comment_val,
            )
        except models.FeedbackAlreadyExistsError:
            await interaction.response.send_message(
                "You've already submitted feedback for this visit.",
                ephemeral=True,
            )
            return
        except Exception:
            log.exception("feedback submit failed for entry %s",
                          self._queue_entry_id)
            await interaction.response.send_message(
                "Visit no longer found — feedback discarded.",
                ephemeral=True,
            )
            return
        await interaction.response.send_message(
            f"Thanks for the {self._rating}★ rating!",
            ephemeral=True,
        )
```

**Step 5: Wire `send_rating_dm` into the existing success/failure branches**

In `bot/cogs/dm.py`, locate every place where `update_entry_status(<id>, "completed", ...)` is called from `FallbackActions` (or its equivalent). Right after the call (and before the existing ack reply), invoke:

```python
await send_rating_dm(
    interaction.user,
    queue_entry_id=entry_id,
    machine_name=machine["name"],
)
```

(Get `machine` via `models.get_machine(entry["machine_id"])` if not already in scope.)

This applies to both the Yes (success) branch and the No-with-notes (failure) branch — Q3 said the trigger is when the user has acknowledged the visit, regardless of outcome.

Do NOT wire it into agent-driven (grace-expired) completions or staff-driven completions; the user isn't in the loop there.

**Step 6: Run tests green**

```
pytest tests/test_feedback_flow.py tests/ 2>&1 | tail -10
```

Expected: 6 new PASS, full suite still green.

**Step 7: Commit**

```bash
git add bot/cogs/dm.py tests/test_feedback_flow.py
git commit -m "feat(bot): post-completion rating DM (RatingView + FeedbackModal)

- RatingView: 5 star buttons + Skip, ephemeral pattern (timeout=600)
- FeedbackModal: optional paragraph TextInput; submits via create_feedback
- send_rating_dm wired into both Yes and No success-ack branches
- Duplicate / missing-entry / forbidden DM all surface friendly messages"
```

---

## Task 5: API — analytics rating fields

**Files:**
- Modify: `api/routes/analytics.py` (extend `AnalyticsSummary`, `MachineStat`, `CollegeStat`; rewire `compute_analytics_response`)
- Test: `tests/test_analytics_api.py` (extend, +3 tests)

**Step 1: Write the failing tests**

Append to `tests/test_analytics_api.py`:

```python
async def test_analytics_summary_avg_rating_none_when_empty(client):
    h = _staff_headers(client)
    body = client.get("/api/analytics/summary?period=week", headers=h).json()
    assert body["summary"]["rating_count"] >= 0
    if body["summary"]["rating_count"] == 0:
        assert body["summary"]["avg_rating"] is None


async def test_analytics_summary_avg_rating_matches(client):
    # seed two completed entries with 4 and 5 ratings
    e1 = await _seed_completed_entry(discord_id="ar-1")
    e2 = await _seed_completed_entry(discord_id="ar-2")
    await models.create_feedback(queue_entry_id=e1["id"], rating=4, comment=None)
    await models.create_feedback(queue_entry_id=e2["id"], rating=5, comment=None)
    h = _staff_headers(client)
    body = client.get("/api/analytics/summary?period=week", headers=h).json()
    assert body["summary"]["rating_count"] == 2
    assert body["summary"]["avg_rating"] == 4.5


async def test_analytics_machines_and_colleges_have_rating_fields(client):
    h = _staff_headers(client)
    body = client.get("/api/analytics/summary?period=week", headers=h).json()
    if body["machines"]:
        assert "avg_rating" in body["machines"][0]
        assert "rating_count" in body["machines"][0]
    if body["colleges"]:
        assert "avg_rating" in body["colleges"][0]
        assert "rating_count" in body["colleges"][0]
```

(`_seed_completed_entry` helper — define in conftest or local to the file.)

**Step 2: Run tests red**

Expected: 3 FAILs (fields missing).

**Step 3: Extend Pydantic models**

```python
class AnalyticsSummary(BaseModel):
    ...
    avg_rating: float | None = None
    rating_count: int = 0


class MachineStat(BaseModel):
    ...
    avg_rating: float | None = None
    rating_count: int = 0


class CollegeStat(BaseModel):
    ...
    avg_rating: float | None = None
    rating_count: int = 0
```

**Step 4: Wire feedback aggregates into `compute_analytics_response`**

In each of the three aggregation paths:

- **Summary block**: call `models.feedback_aggregates_overall(start, end, college_id=college_id, machine_id=machine_id)`; set `avg_rating` and `rating_count` from the result.
- **Machines block**: call `models.feedback_aggregates_by_machine(start, end, college_id=college_id)`; merge per-machine rating into each `MachineStat` (default to None / 0 when machine has no feedback).
- **Colleges block**: call `models.feedback_aggregates_by_college(start, end, machine_id=machine_id)`; merge into each `CollegeStat`.

(Both aggregate helpers honor the same filters the existing analytics queries do, so feedback narrows correctly when `college_id` / `machine_id` is set.)

**Step 5: Run tests green**

```
pytest tests/test_analytics_api.py tests/ 2>&1 | tail -10
```

**Step 6: Commit**

```bash
git add api/routes/analytics.py tests/test_analytics_api.py
git commit -m "feat(api): analytics summary/machines/colleges include avg_rating

- Three new fields on AnalyticsSummary, MachineStat, CollegeStat
- compute_analytics_response merges feedback aggregates into existing blocks
- avg_rating None when rating_count == 0; honors college_id / machine_id filters"
```

---

## Task 6: Agent — daily snapshot includes rating

**Files:**
- Modify: `agent/loop.py` (the daily-snapshot computation)
- Test: `tests/test_agent.py` (extend, +1 test)

**Step 1: Write the failing test**

Append to `tests/test_agent.py`:

```python
async def test_daily_snapshot_includes_rating_columns(db):
    # seed feedback in today's range
    user = await models.get_or_create_user(discord_id="snap-1", discord_name="u")
    machines = await models.get_machines()
    entry = await models.join_queue(user["id"], machines[0]["id"])
    await models.update_entry_status(entry["id"], "serving")
    await models.update_entry_status(entry["id"], "completed", job_successful=1)
    await models.create_feedback(queue_entry_id=entry["id"], rating=5,
                                  comment=None)

    from agent.loop import _compute_daily_snapshots
    await _compute_daily_snapshots()

    conn = await models.get_db()
    cursor = await conn.execute(
        "SELECT avg_rating, rating_count FROM analytics_snapshots "
        "WHERE machine_id = ? ORDER BY id DESC LIMIT 1",
        (machines[0]["id"],),
    )
    row = await cursor.fetchone()
    assert row["rating_count"] == 1
    assert row["avg_rating"] == 5.0
```

**Step 2: Run test red**

**Step 3: Update `_compute_daily_snapshots` in `agent/loop.py`**

The existing GROUP BY on `queue_entries` produces the per-machine row. Add a LEFT JOIN onto `feedback`:

```sql
LEFT JOIN feedback f ON f.queue_entry_id = qe.id
```

In the SELECT list:
```sql
AVG(f.rating)   AS avg_rating,
COUNT(f.rating) AS rating_count
```

In the INSERT/UPSERT, include the two new columns. Make sure the date window for `f.created_at` matches the snapshot day.

**Step 4: Run test green**

**Step 5: Commit**

```bash
git add agent/loop.py tests/test_agent.py
git commit -m "feat(agent): daily snapshot computes avg_rating + rating_count"
```

---

## Task 7: Frontend — types + API client + analytics card accents

**Files:**
- Modify: `web/src/api/types.ts`
- Modify: `web/src/api/admin.ts`
- Modify: `web/src/pages/Analytics.tsx` (and child cards if any) — render `★ x.x (n)` accent

**Step 1: Add types**

In `web/src/api/types.ts`:

```typescript
export interface FeedbackRow {
  id: number;
  queue_entry_id: number;
  rating: number;
  comment: string | null;
  created_at: string;
  user_id: number;
  full_name: string | null;
  discord_name: string | null;
  machine_id: number;
  machine_name: string;
  college_id: number | null;
  college_name: string;
}
```

Extend `AnalyticsSummary`, `MachineStat`, `CollegeStat`:

```typescript
export interface AnalyticsSummary {
  ...
  avg_rating: number | null;
  rating_count: number;
}
// same two fields on MachineStat and CollegeStat
```

**Step 2: Add admin client**

In `web/src/api/admin.ts`:

```typescript
import type { FeedbackRow } from "./types";

export const listFeedback = (params: {
  machineId?: number; collegeId?: number;
  minRating?: number; maxRating?: number; limit?: number;
} = {}): Promise<FeedbackRow[]> => {
  const qs = new URLSearchParams();
  if (params.machineId)  qs.set("machine_id",  String(params.machineId));
  if (params.collegeId)  qs.set("college_id",  String(params.collegeId));
  if (params.minRating)  qs.set("min_rating",  String(params.minRating));
  if (params.maxRating)  qs.set("max_rating",  String(params.maxRating));
  if (params.limit)      qs.set("limit",       String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request<FeedbackRow[]>(`/feedback/${suffix}`);
};
```

(Match the actual `request` helper signature — adjust as needed.)

**Step 3: Render `★ x.x (n)` accent on machine/college cards**

In `web/src/pages/Analytics.tsx` (and `MachineUtilization` / `CollegeUtilization` child cards if those render per-row text), add a small line:

```tsx
{stat.avg_rating !== null
  ? `★ ${stat.avg_rating.toFixed(1)} (${stat.rating_count})`
  : "★ — (0)"}
```

Use Tailwind `text-xs text-amber-400` (or whatever matches the design system).

**Step 4: Verify TypeScript compiles**

```
cd web && npx tsc -b
```

**Step 5: Commit**

```bash
git add web/src/api/types.ts web/src/api/admin.ts web/src/pages/Analytics.tsx
git commit -m "feat(web): feedback types + listFeedback client + analytics rating accents"
```

---

## Task 8: Frontend — `/admin/feedback` page

**Files:**
- Create: `web/src/pages/admin/Feedback.tsx`
- Modify: `web/src/App.tsx` (add route under `RequireStaff`)
- Modify: admin nav component (add Feedback tab)

**Step 1: Create `web/src/pages/admin/Feedback.tsx`**

Mirror `web/src/pages/admin/Colleges.tsx` for layout style. Key elements:

- Filter row (Machine, College, Rating dropdowns).
- Table: time (relative + tooltip), user (`{full_name} ({college_name})`), machine, 5-star rating, comment row underneath in muted text.
- "Load more" button (cursor-by-`created_at`, or just bump `limit` since dataset is small).
- Empty state: "No feedback yet for these filters."

Pseudo-component:

```tsx
const Feedback: React.FC = () => {
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [machineId, setMachineId] = useState<number | null>(null);
  const [collegeId, setCollegeId] = useState<number | null>(null);
  const [minRating, setMinRating] = useState<number | null>(null);
  const [limit, setLimit]   = useState(50);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    listFeedback({
      machineId: machineId ?? undefined,
      collegeId: collegeId ?? undefined,
      minRating: minRating ?? undefined,
      limit,
    })
      .then(setRows)
      .finally(() => setLoading(false));
  }, [machineId, collegeId, minRating, limit]);

  // ... render
};
```

**Step 2: Wire into `App.tsx` + nav**

Read `App.tsx`; add:

```tsx
import Feedback from "./pages/admin/Feedback";
<Route path="/admin/feedback" element={<Feedback />} />
```

(Inside the `<RequireStaff>` block — staff can read; not admin-gated.)

In the admin nav component (where Colleges / Staff / Settings tabs live), add a NavLink to `/admin/feedback` labelled "Feedback".

**Step 3: TypeScript check**

```
cd web && npx tsc -b
```

**Step 4: Manual smoke test (skip if headless — note in report)**

If the dev server is running:
- `/admin/feedback` lists rows with full attribution.
- Filter by machine, college, rating works.
- Empty state appears when filters return nothing.

**Step 5: Commit**

```bash
git add web/src/pages/admin/Feedback.tsx web/src/App.tsx <nav-component-path>
git commit -m "feat(web): /admin/feedback page (filterable list of recent ratings)"
```

---

## Task 9: Chat test extension + final verification

**Files:**
- Modify: `tests/test_chat_api.py` (extend, +1 test)

**Step 1: Add the test**

```python
def test_chat_system_prompt_contains_avg_rating(
    client, mock_openai, seeded_completed_jobs,
):
    """The analytics blob fed to the model must include avg_rating
    so the chatbot can answer 'which machine has the highest rating?'."""
    # Optionally seed at least one feedback row so the field is non-null.
    h = _staff_headers(client)
    res = client.post(
        "/api/analytics/chat",
        headers=h,
        json={"message": "ignored, mock returns canned reply"},
    )
    assert res.status_code == 200
    captured_kwargs = mock_openai.call_args.kwargs
    system_prompt = next(
        m["content"] for m in captured_kwargs["messages"] if m["role"] == "system"
    )
    assert "\"avg_rating\"" in system_prompt
```

(Adapt to the existing `mock_openai` shape — the prior chat test used a dict-style fixture; match whatever's in this codebase now.)

**Step 2: Run the test + full suite + tsc**

```
cd /Users/ash/Desktop/Reserv && pytest tests/ 2>&1 | tail -10
cd web && npx tsc -b
```

Confirm both clean. Note the final test count for the report.

**Step 3: Commit**

```bash
git add tests/test_chat_api.py
git commit -m "test(chat): assert system prompt includes avg_rating field"
```

---

## Task 10: Memory + CLAUDE.md updates

**Files:**
- Modify: `short_term_memory.md` (prepend new entry; existing entries stay)
- Modify: `CLAUDE.md` (`## Completed Work` — add new entry after the most recent one)

**Step 1: Prepend to `short_term_memory.md`**

```markdown
## 2026-04-27 — Post-Visit Feedback Form
Shipped on `feat/customizable-admin`. ~221 tests passing, tsc clean.
(Adjust count to whatever pytest reports after Task 9.)

**Backend:**
- New `feedback` table (id, queue_entry_id UNIQUE FK ON DELETE CASCADE,
  rating CHECK(1..5), comment TEXT NULL, created_at) + `idx_feedback_created_at`
  (created in `_migrate` post-CREATE).
- `analytics_snapshots` gains `avg_rating REAL NULL` and
  `rating_count INTEGER NOT NULL DEFAULT 0`.
- `db/models.py`: `create_feedback`, `get_feedback_by_entry`, `list_feedback`
  (joined w/ users + machines + colleges, composable filters), aggregate
  helpers (overall, by_machine, by_college). `FeedbackAlreadyExistsError` on dup.
- `api/routes/feedback.py`: staff GET `/api/feedback/` with filters
  (`limit`, `machine_id`, `college_id`, `min_rating`, `max_rating`).
  No write/edit endpoints — bot is the only writer.
- `compute_analytics_response`: summary, machines, colleges blocks all gain
  `avg_rating` + `rating_count`. Aggregates honor existing filters.
- Daily snapshot (`agent/loop.py`) JOINs feedback for per-machine rating.

**Discord:**
- `bot/cogs/dm.py`: new `RatingView` (`timeout=600`, 5 star buttons + Skip)
  and `FeedbackModal` (one optional paragraph TextInput, max 500 chars).
- `send_rating_dm` invoked right after `update_entry_status(... "completed", ...)`
  in BOTH success and failure branches of the user-acknowledged path.
- `FeedbackAlreadyExistsError` → ephemeral "already submitted"; missing entry
  → "Visit no longer found".

**Frontend:**
- Types: `FeedbackRow`, `avg_rating`/`rating_count` on `AnalyticsSummary`,
  `MachineStat`, `CollegeStat`.
- `listFeedback` admin client.
- `/admin/feedback` page (staff-only): filter by machine/college/rating,
  paginated list of joined rows.
- Analytics dashboard cards now render `★ x.x (n)` accents on machine and
  college rows.

**Auth & scope:** GET `/api/feedback/` is staff (`require_staff`); no write
endpoints exist. Bot DMs only on the user-acknowledged completion path.

**Docs:**
- Design: `docs/plans/2026-04-27-feedback-form-design.md`.
- Plan: `docs/plans/2026-04-27-feedback-form.md`.

**Commits:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7, Task 8,
Task 9 (10 logical commits).
```

(Replace the Task placeholders with actual SHAs the executor produced.)

**Step 2: Append to CLAUDE.md `## Completed Work`** (after most-recent entry):

```markdown
### 2026-04-27 — Post-Visit Feedback (Discord rating + analytics rollup)
- After acknowledging a completion ("Did your job succeed? Yes/No"), the user gets a follow-up DM with a 5-star rating view; clicking a star opens an optional comment modal. One feedback per visit (UNIQUE on `queue_entry_id`); cascades on entry delete.
- New `feedback` table; `analytics_snapshots` gains `avg_rating` + `rating_count`. `compute_analytics_response` merges feedback aggregates into the summary, machines, and colleges blocks; chatbot picks up the dimension automatically.
- New `/admin/feedback` page lists recent ratings with full attribution (`full_name`, college, machine), filterable by machine / college / rating. Staff-readable, no admin write surface.
- Conventions: `FeedbackAlreadyExistsError` (409-equivalent in modal), `★ x.x (n)` accents on machine/college analytics cards, daily snapshot now includes feedback aggregates.
```

**Step 3: Commit**

```bash
git add short_term_memory.md CLAUDE.md
git commit -m "docs: capture feedback-form shipped state in memory + completed work"
```

---

## Done

Implementation is complete when:
- All ~221 tests pass.
- `tsc --noEmit` (`npx tsc -b`) clean.
- Manual smoke checklist passes (rating DM arrives → modal opens → row written → admin page shows the row → analytics card shows `★ x.x (n)`).
- `short_term_memory.md` and `CLAUDE.md` updated with actual commit SHAs.
- Branch `feat/customizable-admin` ready for `/gitpush`.
