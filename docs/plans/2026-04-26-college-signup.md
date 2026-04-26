# College Signup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the freeform `college` text field in Discord signup with an admin-managed UIUC college list, surfaced via a two-step ephemeral select → modal flow, and add a college dimension to analytics.

**Architecture:** New `colleges` table (soft-delete via partial unique index) with `users.college_id` FK. Discord flow becomes ephemeral `StringSelect` view → existing `SignupModal` (now 4 fields, prefilled on re-signup). New `/admin/colleges` page mirrors `/admin/machines`. `compute_analytics_response` gains a `college_id` filter and a `colleges: list[CollegeStat]` block; the chatbot picks it up for free.

**Tech Stack:** Python (FastAPI, aiosqlite, discord.py), React + Vite + Tailwind, SQLite (WAL).

**Design doc:** `docs/plans/2026-04-26-college-signup-design.md`.

**Key prior learnings to respect:**
- Partial unique indexes go in `_migrate`, AFTER the column exists (learnings.md 2026-04-22).
- Backfill data migrations run AFTER seed steps in `init_db` (learnings.md 2026-04-22).
- Modals can only hold `TextInput`; `StringSelect` lives in a separate `View` (Discord constraint).
- Persistent views need `timeout=None` + `bot.add_view()`; ephemeral views use `timeout=120` (learnings.md 2026-04-02).
- Soft-deleted parent + FK-referencing children must be added to `purge_*` cascade paths (learnings.md 2026-04-22).
- OpenAI clients are lazy (`_make_openai_client`); no behavior change here, just don't break it.
- Cross-user access returns 404 not 403 (CLAUDE.md). N/A for this work but keep in mind.

---

## Task 1: DB schema — `colleges` table, `users.college_id`, drop `users.college`

**Files:**
- Modify: `db/database.py:39-144` (`_create_tables`)
- Modify: `db/database.py:147-291` (`_migrate`)
- Modify: `db/database.py:8-22` (`init_db` — add `_seed_colleges` call)
- Create: `db/database.py` `_seed_colleges` helper
- Test: `tests/test_db.py` (extend)

**Step 1: Write the failing test**

Append to `tests/test_db.py`:

```python
async def test_colleges_table_seeded_on_fresh_db(memory_db):
    db = await models.get_db()
    cursor = await db.execute(
        "SELECT name FROM colleges WHERE archived_at IS NULL ORDER BY id"
    )
    rows = [row["name"] for row in await cursor.fetchall()]
    assert "Grainger College of Engineering" in rows
    assert "Gies College of Business" in rows
    assert len(rows) >= 15

async def test_users_college_id_column_exists(memory_db):
    db = await models.get_db()
    cursor = await db.execute("PRAGMA table_info(users)")
    cols = {row[1] for row in await cursor.fetchall()}
    assert "college_id" in cols
    assert "college" not in cols  # legacy column dropped

async def test_partial_unique_index_blocks_duplicate_active_name(memory_db):
    db = await models.get_db()
    await db.execute("INSERT INTO colleges (name) VALUES (?)", ("Test College",))
    with pytest.raises(Exception):
        await db.execute("INSERT INTO colleges (name) VALUES (?)", ("Test College",))

async def test_partial_unique_index_allows_archived_duplicate(memory_db):
    db = await models.get_db()
    await db.execute(
        "INSERT INTO colleges (name, archived_at) VALUES (?, datetime('now'))",
        ("Archived College",),
    )
    # active insert with same name must succeed
    await db.execute("INSERT INTO colleges (name) VALUES (?)", ("Archived College",))

async def test_migration_wipes_registered_flag_for_existing_users(memory_db):
    """Upgrade path: existing registered users should be flipped to registered=0
    so they re-pick a college on next Join Queue press."""
    db = await models.get_db()
    # Simulate a pre-migration registered user. memory_db has already run init_db,
    # so we manually re-flip then re-run _migrate to confirm idempotence + wipe.
    await db.execute(
        "INSERT INTO users (discord_id, discord_name, full_name, email, major, "
        "graduation_year, registered) VALUES (?, ?, ?, ?, ?, ?, 1)",
        ("999", "legacy", "Legacy User", "legacy@illinois.edu", "CS", "2027"),
    )
    await db.commit()
    from db import database
    await database._migrate(db)
    cursor = await db.execute(
        "SELECT registered FROM users WHERE discord_id = '999'"
    )
    row = await cursor.fetchone()
    assert row["registered"] == 0
```

**Step 2: Run tests to verify they fail**

Run: `pytest tests/test_db.py::test_colleges_table_seeded_on_fresh_db tests/test_db.py::test_users_college_id_column_exists tests/test_db.py::test_partial_unique_index_blocks_duplicate_active_name tests/test_db.py::test_partial_unique_index_allows_archived_duplicate tests/test_db.py::test_migration_wipes_registered_flag_for_existing_users -v`

Expected: 5 FAILs (no `colleges` table, `college` still present, etc.).

**Step 3: Add table to `_create_tables`**

In `db/database.py` `_create_tables`, add inside the `executescript` block (after the `users` table, before `queue_entries`):

```sql
CREATE TABLE IF NOT EXISTS colleges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    archived_at TEXT
);
```

**Step 4: Add migration block to `_migrate`**

Append to `db/database.py` `_migrate` (after the existing user-column migrations, before the chat tables block):

```python
# Colleges table — may be missing on upgrades.
await db.execute(
    """
    CREATE TABLE IF NOT EXISTS colleges (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        archived_at TEXT
    )
    """
)
# Partial unique index AFTER the table exists (learnings.md 2026-04-22).
await db.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_colleges_name_active "
    "ON colleges(name) WHERE archived_at IS NULL"
)

# Add users.college_id (nullable FK).
cursor = await db.execute("PRAGMA table_info(users)")
user_cols_v2 = {row[1] for row in await cursor.fetchall()}
if "college_id" not in user_cols_v2:
    await db.execute(
        "ALTER TABLE users ADD COLUMN college_id INTEGER REFERENCES colleges(id)"
    )

# Drop legacy users.college (free-text, replaced by FK). Safe on SQLite >= 3.35.
if "college" in user_cols_v2:
    await db.execute("ALTER TABLE users DROP COLUMN college")

# Re-signup wipe: any user previously marked registered=1 must re-pick a college.
# Idempotent — once flipped to 0 they no longer match the predicate.
await db.execute("UPDATE users SET registered = 0 WHERE registered = 1")
```

**Step 5: Add `_seed_colleges` helper and wire into `init_db`**

In `db/database.py`, add new helper near `_seed_machines`:

```python
async def _seed_colleges(db: aiosqlite.Connection) -> None:
    """Seed the standard UIUC colleges if missing. Idempotent."""
    colleges = [
        "Grainger College of Engineering",
        "Gies College of Business",
        "College of Liberal Arts and Sciences",
        "College of Agricultural, Consumer and Environmental Sciences",
        "College of Education",
        "College of Fine and Applied Arts",
        "College of Media",
        "School of Information Sciences",
        "College of Applied Health Sciences",
        "Division of General Studies",
        "School of Social Work",
        "School of Labor and Employment Relations",
        "Carle Illinois College of Medicine",
        "College of Veterinary Medicine",
        "College of Law",
    ]
    for name in colleges:
        await db.execute(
            """
            INSERT INTO colleges (name)
            SELECT ?
            WHERE NOT EXISTS (
                SELECT 1 FROM colleges WHERE name = ? AND archived_at IS NULL
            )
            """,
            (name, name),
        )
```

In `init_db`, add `await _seed_colleges(_db)` after `await _seed_machines(_db)`.

Also remove the legacy `college TEXT` column from `_create_tables` (line 67) — `users` table now lists `college_id INTEGER REFERENCES colleges(id)` instead.

**Step 6: Run tests to verify they pass**

Run: `pytest tests/test_db.py -v`

Expected: All 5 new tests PASS plus all existing test_db tests still PASS.

**Step 7: Commit**

```bash
git add db/database.py tests/test_db.py
git commit -m "feat(db): add colleges table, drop users.college, wipe registered flag

- New colleges table with soft-delete (archived_at + partial unique index)
- users.college_id FK replaces freeform users.college
- _seed_colleges idempotently inserts the 15 UIUC colleges
- _migrate flips registered=1 -> 0 so existing users re-pick on next join

Refs design: docs/plans/2026-04-26-college-signup-design.md"
```

---

## Task 2: DB models — college helpers + `register_user` signature change

**Files:**
- Modify: `db/models.py:416-459` (existing `register_user` and `update_user_profile`)
- Modify: `db/models.py` (append college helpers near the end of the file)
- Test: `tests/test_colleges_db.py` (new)

**Step 1: Write the failing tests**

Create `tests/test_colleges_db.py`:

```python
"""DB-layer tests for the colleges table."""
import pytest
from db import models


@pytest.mark.asyncio
async def test_create_college(memory_db):
    college = await models.create_college("Test College")
    assert college["id"] > 0
    assert college["name"] == "Test College"
    assert college["archived_at"] is None


@pytest.mark.asyncio
async def test_create_college_dup_active_raises(memory_db):
    await models.create_college("Dup College")
    with pytest.raises(models.DuplicateCollegeError):
        await models.create_college("Dup College")


@pytest.mark.asyncio
async def test_list_active_colleges_excludes_archived(memory_db):
    a = await models.create_college("Active A")
    b = await models.create_college("Archived B")
    await models.archive_college(b["id"])
    rows = await models.list_active_colleges()
    names = {r["name"] for r in rows}
    assert "Active A" in names
    assert "Archived B" not in names


@pytest.mark.asyncio
async def test_list_all_colleges_includes_archived(memory_db):
    a = await models.create_college("ListAll A")
    b = await models.create_college("ListAll B")
    await models.archive_college(b["id"])
    rows = await models.list_all_colleges()
    names = {r["name"] for r in rows}
    assert "ListAll A" in names
    assert "ListAll B" in names


@pytest.mark.asyncio
async def test_update_college_renames(memory_db):
    college = await models.create_college("Old Name")
    await models.update_college(college["id"], name="New Name")
    fetched = await models.get_college(college["id"])
    assert fetched["name"] == "New Name"


@pytest.mark.asyncio
async def test_archive_then_restore(memory_db):
    college = await models.create_college("Archive Restore")
    await models.archive_college(college["id"])
    fetched = await models.get_college(college["id"])
    assert fetched["archived_at"] is not None
    await models.restore_college(college["id"])
    fetched = await models.get_college(college["id"])
    assert fetched["archived_at"] is None


@pytest.mark.asyncio
async def test_count_users_in_college(memory_db):
    college = await models.create_college("Count College")
    user = await models.get_or_create_user(discord_id="42", discord_name="u")
    await models.register_user(
        user_id=user["id"],
        full_name="Test",
        email="test@illinois.edu",
        major="CS",
        college_id=college["id"],
        graduation_year="2027",
    )
    count = await models.count_users_in_college(college["id"])
    assert count == 1


@pytest.mark.asyncio
async def test_purge_college_blocked_with_users(memory_db):
    college = await models.create_college("Purge Blocked")
    user = await models.get_or_create_user(discord_id="43", discord_name="u")
    await models.register_user(
        user_id=user["id"],
        full_name="Test",
        email="test2@illinois.edu",
        major="CS",
        college_id=college["id"],
        graduation_year="2027",
    )
    with pytest.raises(models.CollegeInUseError):
        await models.purge_college(college["id"])


@pytest.mark.asyncio
async def test_purge_college_succeeds_with_no_users(memory_db):
    college = await models.create_college("Purge OK")
    await models.purge_college(college["id"])
    assert await models.get_college(college["id"]) is None


@pytest.mark.asyncio
async def test_register_user_writes_college_id(memory_db):
    college = await models.create_college("Reg College")
    user = await models.get_or_create_user(discord_id="44", discord_name="u")
    await models.register_user(
        user_id=user["id"],
        full_name="Reg User",
        email="reg@illinois.edu",
        major="CS",
        college_id=college["id"],
        graduation_year="2027",
    )
    fetched = await models.get_user_by_discord_id("44")
    assert fetched["college_id"] == college["id"]
    assert fetched["registered"] == 1
```

**Step 2: Run tests to verify they fail**

Run: `pytest tests/test_colleges_db.py -v`

Expected: All 10 FAIL with `AttributeError: module 'db.models' has no attribute 'create_college'` (etc.).

**Step 3: Add helpers to `db/models.py`**

Append to `db/models.py`:

```python
class DuplicateCollegeError(Exception):
    """Raised when creating/restoring a college that conflicts with an active row."""


class CollegeInUseError(Exception):
    """Raised when purging a college that still has users referencing it."""


async def create_college(name: str) -> dict:
    db = await get_db()
    try:
        cursor = await db.execute(
            "INSERT INTO colleges (name) VALUES (?) RETURNING *", (name,)
        )
    except Exception as e:
        if "UNIQUE" in str(e):
            raise DuplicateCollegeError(name) from e
        raise
    row = await cursor.fetchone()
    await db.commit()
    return dict(row)


async def list_active_colleges() -> list[dict]:
    db = await get_db()
    cursor = await db.execute(
        "SELECT * FROM colleges WHERE archived_at IS NULL ORDER BY name"
    )
    return [dict(r) for r in await cursor.fetchall()]


async def list_all_colleges() -> list[dict]:
    db = await get_db()
    cursor = await db.execute("SELECT * FROM colleges ORDER BY archived_at IS NULL DESC, name")
    return [dict(r) for r in await cursor.fetchall()]


async def get_college(college_id: int) -> dict | None:
    db = await get_db()
    cursor = await db.execute("SELECT * FROM colleges WHERE id = ?", (college_id,))
    row = await cursor.fetchone()
    return dict(row) if row else None


async def update_college(college_id: int, *, name: str) -> dict | None:
    db = await get_db()
    try:
        await db.execute(
            "UPDATE colleges SET name = ? WHERE id = ?", (name, college_id)
        )
    except Exception as e:
        if "UNIQUE" in str(e):
            raise DuplicateCollegeError(name) from e
        raise
    await db.commit()
    return await get_college(college_id)


async def archive_college(college_id: int) -> bool:
    db = await get_db()
    cursor = await db.execute(
        "UPDATE colleges SET archived_at = datetime('now') "
        "WHERE id = ? AND archived_at IS NULL",
        (college_id,),
    )
    await db.commit()
    return cursor.rowcount > 0


async def restore_college(college_id: int) -> bool:
    db = await get_db()
    target = await get_college(college_id)
    if target is None:
        return False
    # 409-equivalent: refuse if an active twin exists with the same name
    cursor = await db.execute(
        "SELECT 1 FROM colleges WHERE name = ? AND archived_at IS NULL AND id != ?",
        (target["name"], college_id),
    )
    if await cursor.fetchone():
        raise DuplicateCollegeError(target["name"])
    cursor = await db.execute(
        "UPDATE colleges SET archived_at = NULL "
        "WHERE id = ? AND archived_at IS NOT NULL",
        (college_id,),
    )
    await db.commit()
    return cursor.rowcount > 0


async def count_users_in_college(college_id: int) -> int:
    db = await get_db()
    cursor = await db.execute(
        "SELECT COUNT(*) AS cnt FROM users WHERE college_id = ?", (college_id,)
    )
    row = await cursor.fetchone()
    return row["cnt"]


async def purge_college(college_id: int) -> bool:
    if await count_users_in_college(college_id) > 0:
        raise CollegeInUseError(college_id)
    db = await get_db()
    cursor = await db.execute("DELETE FROM colleges WHERE id = ?", (college_id,))
    await db.commit()
    return cursor.rowcount > 0
```

**Step 4: Update existing `register_user` and `update_user_profile`**

Replace the current `register_user` (lines ~416-436) with:

```python
async def register_user(
    user_id: int,
    *,
    full_name: str,
    email: str,
    major: str,
    college_id: int,
    graduation_year: str,
) -> None:
    """Save signup profile and mark user as registered."""
    db = await get_db()
    await db.execute(
        """
        UPDATE users
        SET full_name = ?, email = ?, major = ?, college_id = ?,
            graduation_year = ?, registered = 1
        WHERE id = ?
        """,
        (full_name, email, major, college_id, graduation_year, user_id),
    )
    await db.commit()
```

Same swap (`college` → `college_id`) on `update_user_profile` immediately below.

**Step 5: Run tests to verify they pass**

Run: `pytest tests/test_colleges_db.py tests/test_db.py -v`

Expected: All PASS.

**Step 6: Commit**

```bash
git add db/models.py tests/test_colleges_db.py
git commit -m "feat(db): add college CRUD helpers; register_user takes college_id

- create/list_active/list_all/get/update/archive/restore/purge_college
- count_users_in_college guards purge
- DuplicateCollegeError + CollegeInUseError raised by helpers
- register_user/update_user_profile signatures swap college:str -> college_id:int"
```

---

## Task 3: API — `colleges` router

**Files:**
- Create: `api/routes/colleges.py`
- Modify: `api/main.py` (mount router)
- Test: `tests/test_colleges_api.py` (new)

**Step 1: Write the failing tests**

Create `tests/test_colleges_api.py` mirroring `tests/test_machines_admin.py`:

```python
"""HTTP-layer tests for /api/colleges."""
import pytest


def auth_headers_admin(client):
    """Helper: log in as the seeded admin and return Bearer headers."""
    res = client.post("/api/auth/login", json={"username": "admin", "password": "changeme"})
    return {"Authorization": f"Bearer {res.json()['token']}"}


def test_public_get_returns_active_only(client):
    res = client.get("/api/colleges/")
    assert res.status_code == 200
    body = res.json()
    assert any(c["name"] == "Grainger College of Engineering" for c in body)
    # public response strips metadata
    assert "archived_at" not in body[0]


def test_admin_get_with_archived_includes_archived(client):
    h = auth_headers_admin(client)
    create = client.post("/api/colleges/", json={"name": "Temp"}, headers=h)
    cid = create.json()["id"]
    client.delete(f"/api/colleges/{cid}", headers=h)  # archive

    res = client.get("/api/colleges/?include_archived=true", headers=h)
    assert res.status_code == 200
    names = {c["name"] for c in res.json()}
    assert "Temp" in names


def test_post_requires_admin(client):
    res = client.post("/api/colleges/", json={"name": "NoAuth"})
    assert res.status_code == 401


def test_post_dup_returns_409(client):
    h = auth_headers_admin(client)
    client.post("/api/colleges/", json={"name": "Dupe"}, headers=h)
    res = client.post("/api/colleges/", json={"name": "Dupe"}, headers=h)
    assert res.status_code == 409


def test_patch_renames(client):
    h = auth_headers_admin(client)
    create = client.post("/api/colleges/", json={"name": "OldNm"}, headers=h)
    cid = create.json()["id"]
    res = client.patch(f"/api/colleges/{cid}", json={"name": "NewNm"}, headers=h)
    assert res.status_code == 200
    assert res.json()["name"] == "NewNm"


def test_archive_and_restore_roundtrip(client):
    h = auth_headers_admin(client)
    create = client.post("/api/colleges/", json={"name": "RoundTrip"}, headers=h)
    cid = create.json()["id"]

    arch = client.delete(f"/api/colleges/{cid}", headers=h)
    assert arch.status_code == 204

    restore = client.post(f"/api/colleges/{cid}/restore", headers=h)
    assert restore.status_code == 200
    assert restore.json()["archived_at"] is None


def test_purge_blocked_when_users_reference(client, registered_user_in_college):
    """`registered_user_in_college` is a fixture that registers a user against
    a college named 'Has Users' and yields its id."""
    h = auth_headers_admin(client)
    cid = registered_user_in_college
    res = client.delete(
        f"/api/colleges/{cid}?purge=true",
        json={"confirm_name": "Has Users"},
        headers=h,
    )
    assert res.status_code == 409


def test_purge_requires_confirm_name(client):
    h = auth_headers_admin(client)
    create = client.post("/api/colleges/", json={"name": "Purgeable"}, headers=h)
    cid = create.json()["id"]
    client.delete(f"/api/colleges/{cid}", headers=h)  # archive first

    res = client.delete(
        f"/api/colleges/{cid}?purge=true",
        json={"confirm_name": "Wrong"},
        headers=h,
    )
    assert res.status_code == 400


def test_purge_succeeds_when_clear(client):
    h = auth_headers_admin(client)
    create = client.post("/api/colleges/", json={"name": "PurgeOK"}, headers=h)
    cid = create.json()["id"]
    client.delete(f"/api/colleges/{cid}", headers=h)
    res = client.delete(
        f"/api/colleges/{cid}?purge=true",
        json={"confirm_name": "PurgeOK"},
        headers=h,
    )
    assert res.status_code == 204
```

Add a fixture to `tests/conftest.py` (extend the existing one):

```python
@pytest.fixture
async def registered_user_in_college(client):
    """Create a college named 'Has Users' and register one user against it."""
    from db import models
    college = await models.create_college("Has Users")
    user = await models.get_or_create_user(discord_id="9000", discord_name="x")
    await models.register_user(
        user_id=user["id"],
        full_name="X",
        email="x@illinois.edu",
        major="CS",
        college_id=college["id"],
        graduation_year="2027",
    )
    return college["id"]
```

**Step 2: Run tests to verify they fail**

Run: `pytest tests/test_colleges_api.py -v`

Expected: 9 FAILs (404 on every route — router not mounted yet).

**Step 3: Create `api/routes/colleges.py`**

```python
"""College CRUD routes — admin-managed UIUC college list."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel

from api.auth import require_admin, require_staff
from db import models

router = APIRouter(prefix="/api/colleges", tags=["colleges"])


class CollegePublic(BaseModel):
    id: int
    name: str


class CollegeAdmin(BaseModel):
    id: int
    name: str
    archived_at: str | None


class CollegeCreate(BaseModel):
    name: str


class CollegeUpdate(BaseModel):
    name: str


class CollegePurgeBody(BaseModel):
    confirm_name: str


@router.get("/", response_model=list[CollegeAdmin] | list[CollegePublic])
async def list_endpoint(
    include_archived: bool = Query(False),
    request_user=Depends(lambda: None),  # noqa
):
    """Public if include_archived=False; staff-gated otherwise."""
    if include_archived:
        # staff-gated branch
        await require_staff()  # raises 401 if no token
        rows = await models.list_all_colleges()
        return [CollegeAdmin(**r) for r in rows]
    rows = await models.list_active_colleges()
    return [CollegePublic(id=r["id"], name=r["name"]) for r in rows]


@router.post(
    "/", status_code=status.HTTP_201_CREATED, response_model=CollegeAdmin,
    dependencies=[Depends(require_admin)],
)
async def create_endpoint(body: CollegeCreate):
    try:
        row = await models.create_college(body.name)
    except models.DuplicateCollegeError:
        raise HTTPException(409, detail="College already exists")
    return CollegeAdmin(**row)


@router.patch(
    "/{college_id}", response_model=CollegeAdmin,
    dependencies=[Depends(require_admin)],
)
async def update_endpoint(college_id: int, body: CollegeUpdate):
    try:
        row = await models.update_college(college_id, name=body.name)
    except models.DuplicateCollegeError:
        raise HTTPException(409, detail="College already exists")
    if row is None:
        raise HTTPException(404)
    return CollegeAdmin(**row)


@router.delete(
    "/{college_id}", status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_admin)],
)
async def archive_or_purge_endpoint(
    college_id: int,
    purge: bool = Query(False),
    body: CollegePurgeBody | None = Body(None),
):
    if not purge:
        ok = await models.archive_college(college_id)
        if not ok:
            raise HTTPException(404)
        return
    # purge path
    target = await models.get_college(college_id)
    if target is None:
        raise HTTPException(404)
    if body is None or body.confirm_name != target["name"]:
        raise HTTPException(400, detail="confirm_name does not match")
    try:
        await models.purge_college(college_id)
    except models.CollegeInUseError:
        n = await models.count_users_in_college(college_id)
        raise HTTPException(409, detail=f"{n} users reference this college")


@router.post(
    "/{college_id}/restore", response_model=CollegeAdmin,
    dependencies=[Depends(require_admin)],
)
async def restore_endpoint(college_id: int):
    try:
        ok = await models.restore_college(college_id)
    except models.DuplicateCollegeError:
        raise HTTPException(409, detail="Active college with this name already exists")
    if not ok:
        raise HTTPException(404)
    return CollegeAdmin(**await models.get_college(college_id))
```

The `include_archived` branch above calls `require_staff()` directly, which is the existing pattern in `api/auth.py` (verify by reading `api/routes/machines.py` for the exact form — adjust to use a `Depends` if the project uses dependency-style auth there). Update accordingly during execution.

**Step 4: Mount router in `api/main.py`**

Find the router-include block and add:

```python
from api.routes import colleges as colleges_routes
app.include_router(colleges_routes.router)
```

**Step 5: Run tests to verify they pass**

Run: `pytest tests/test_colleges_api.py -v`

Expected: All 9 PASS.

**Step 6: Commit**

```bash
git add api/routes/colleges.py api/main.py tests/test_colleges_api.py tests/conftest.py
git commit -m "feat(api): /api/colleges CRUD with public/staff/admin gates

- Public GET active colleges
- Staff GET include_archived
- Admin POST/PATCH/DELETE/restore
- Admin DELETE ?purge=true requires confirm_name body, 409 if users reference"
```

---

## Task 4: Discord — `CollegeSelectView` + revised `SignupModal`

**Files:**
- Modify: `bot/cogs/queue.py:19-118` (`SignupModal` and `_handle_join`)
- Test: `tests/test_signup_flow.py` (new)

**Step 1: Write the failing tests**

Create `tests/test_signup_flow.py`:

```python
"""Discord signup flow — picker view -> modal."""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from bot.cogs.queue import CollegeSelectView, SignupModal, QueueCog
from db import models


@pytest.fixture
def fake_bot():
    bot = MagicMock()
    bot.update_queue_embeds = AsyncMock()
    return bot


@pytest.fixture
def fake_interaction():
    inter = MagicMock()
    inter.user.id = 12345
    inter.user.display_name = "tester"
    inter.user.send = AsyncMock()
    inter.response.send_message = AsyncMock()
    inter.response.send_modal = AsyncMock()
    inter.type = MagicMock()
    return inter


@pytest.mark.asyncio
async def test_unregistered_user_sees_select_view_not_modal(
    memory_db, fake_bot, fake_interaction
):
    """First-time Join Queue should send the CollegeSelectView, NOT the modal."""
    cog = QueueCog(fake_bot)
    machine = await models.create_machine(name="X", slug="x")
    fake_interaction.data = {"custom_id": f"join_queue:{machine['id']}"}
    fake_interaction.type.name = "component"
    from discord import InteractionType
    fake_interaction.type = InteractionType.component
    await cog._handle_join(fake_interaction, machine["id"])

    fake_interaction.response.send_message.assert_awaited_once()
    args, kwargs = fake_interaction.response.send_message.call_args
    assert isinstance(kwargs["view"], CollegeSelectView)
    fake_interaction.response.send_modal.assert_not_called()


@pytest.mark.asyncio
async def test_select_callback_opens_modal_with_college_id(
    memory_db, fake_bot, fake_interaction
):
    college = await models.create_college("Test Sel")
    machine = await models.create_machine(name="X2", slug="x2")
    user = await models.get_or_create_user(discord_id="555", discord_name="u")

    view = CollegeSelectView(
        bot=fake_bot, user_id=user["id"], machine_id=machine["id"], prefill=None
    )
    select = view.children[0]
    select.values = [str(college["id"])]
    await view.on_select(fake_interaction, select)

    fake_interaction.response.send_modal.assert_awaited_once()
    modal = fake_interaction.response.send_modal.call_args.args[0]
    assert isinstance(modal, SignupModal)
    assert modal._college_id == college["id"]


@pytest.mark.asyncio
async def test_modal_submit_calls_register_user_with_college_id(
    memory_db, fake_bot, fake_interaction
):
    college = await models.create_college("Submit College")
    machine = await models.create_machine(name="Y", slug="y")
    user = await models.get_or_create_user(discord_id="556", discord_name="u")

    modal = SignupModal(
        bot=fake_bot, user_id=user["id"], machine_id=machine["id"],
        college_id=college["id"], prefill=None,
    )
    modal.full_name = MagicMock(value="Sub User")
    modal.email = MagicMock(value="sub@illinois.edu")
    modal.major = MagicMock(value="CS")
    modal.graduation_year = MagicMock(value="2027")

    await modal.on_submit(fake_interaction)
    fetched = await models.get_user_by_discord_id("556")
    assert fetched["college_id"] == college["id"]
    assert fetched["registered"] == 1


@pytest.mark.asyncio
async def test_resignup_prefills_existing_values(
    memory_db, fake_bot, fake_interaction
):
    """User who is registered=0 but has prior values should see them as defaults."""
    college = await models.create_college("Prefill College")
    machine = await models.create_machine(name="Z", slug="z")
    user = await models.get_or_create_user(discord_id="557", discord_name="u")
    db = await models.get_db()
    await db.execute(
        "UPDATE users SET full_name=?, email=?, major=?, graduation_year=?, registered=0 "
        "WHERE id=?",
        ("Prior Name", "prior@illinois.edu", "ECE", "2026", user["id"]),
    )
    await db.commit()

    cog = QueueCog(fake_bot)
    fake_interaction.data = {"custom_id": f"join_queue:{machine['id']}"}
    await cog._handle_join(fake_interaction, machine["id"])

    args, kwargs = fake_interaction.response.send_message.call_args
    view = kwargs["view"]
    assert view._prefill["full_name"] == "Prior Name"
    assert view._prefill["email"] == "prior@illinois.edu"


@pytest.mark.asyncio
async def test_empty_colleges_list_shows_unavailable_message(
    memory_db, fake_bot, fake_interaction
):
    machine = await models.create_machine(name="Q", slug="q")
    db = await models.get_db()
    await db.execute("UPDATE colleges SET archived_at = datetime('now')")
    await db.commit()

    cog = QueueCog(fake_bot)
    fake_interaction.data = {"custom_id": f"join_queue:{machine['id']}"}
    await cog._handle_join(fake_interaction, machine["id"])

    args, kwargs = fake_interaction.response.send_message.call_args
    msg = args[0] if args else kwargs.get("content", "")
    assert "temporarily unavailable" in msg.lower()
```

**Step 2: Run tests to verify they fail**

Run: `pytest tests/test_signup_flow.py -v`

Expected: All FAIL — `CollegeSelectView` doesn't exist; `SignupModal` doesn't accept `college_id`/`prefill`.

**Step 3: Replace `SignupModal` and add `CollegeSelectView` in `bot/cogs/queue.py`**

```python
import discord
from discord.ui import Select, View

class CollegeSelectView(View):
    """Ephemeral view shown before the signup modal — picks a UIUC college."""

    def __init__(
        self,
        *,
        bot: "ReservBot",
        user_id: int,
        machine_id: int,
        prefill: dict | None,
    ) -> None:
        super().__init__(timeout=120)
        self._bot = bot
        self._user_id = user_id
        self._machine_id = machine_id
        self._prefill = prefill
        # Options resolved synchronously by callers via build_async classmethod.

    @classmethod
    async def build(cls, *, bot, user_id, machine_id, prefill):
        from db import models
        colleges = await models.list_active_colleges()
        view = cls(bot=bot, user_id=user_id, machine_id=machine_id, prefill=prefill)
        # Discord caps options at 25
        options = [
            discord.SelectOption(label=c["name"][:100], value=str(c["id"]))
            for c in colleges[:25]
        ]
        select = Select(
            custom_id=f"signup_college:{user_id}:{machine_id}",
            placeholder="Select your college",
            min_values=1,
            max_values=1,
            options=options,
        )
        select.callback = lambda inter, s=select: view.on_select(inter, s)
        view.add_item(select)
        return view

    async def on_select(self, interaction: discord.Interaction, select: Select) -> None:
        college_id = int(select.values[0])
        modal = SignupModal(
            bot=self._bot,
            user_id=self._user_id,
            machine_id=self._machine_id,
            college_id=college_id,
            prefill=self._prefill,
        )
        await interaction.response.send_modal(modal)


class SignupModal(discord.ui.Modal, title="SCD Queue — Sign Up"):
    full_name = discord.ui.TextInput(
        label="Full Name", placeholder="e.g. Alex Chen",
        min_length=2, max_length=100,
    )
    email = discord.ui.TextInput(
        label="Email", placeholder="e.g. achen2@illinois.edu",
        min_length=5, max_length=100,
    )
    major = discord.ui.TextInput(
        label="Major", placeholder="e.g. Computer Science",
        min_length=2, max_length=100,
    )
    graduation_year = discord.ui.TextInput(
        label="Expected Graduation Year", placeholder="e.g. 2027",
        min_length=4, max_length=4,
    )

    def __init__(
        self, *, bot, user_id: int, machine_id: int, college_id: int,
        prefill: dict | None,
    ) -> None:
        super().__init__()
        self._bot = bot
        self._user_id = user_id
        self._machine_id = machine_id
        self._college_id = college_id
        if prefill:
            self.full_name.default = prefill.get("full_name") or ""
            self.email.default = prefill.get("email") or ""
            self.major.default = prefill.get("major") or ""
            self.graduation_year.default = prefill.get("graduation_year") or ""

    async def on_submit(self, interaction: discord.Interaction) -> None:
        # existing email + grad_year validation unchanged
        ...
        await models.register_user(
            user_id=self._user_id,
            full_name=self.full_name.value.strip(),
            email=email_val,
            major=self.major.value.strip(),
            college_id=self._college_id,
            graduation_year=year_val,
        )
        # rest of on_submit identical to the current implementation
```

(Preserve the existing email + graduation_year validation and the post-registration queue-join + DM logic — only the constructor signature and `register_user` call are changing.)

**Step 4: Update `_handle_join` registration gate**

In `QueueCog._handle_join`, replace:

```python
if not user.get("registered"):
    await interaction.response.send_modal(
        SignupModal(self.bot, user["id"], machine_id)
    )
    return
```

with:

```python
if not user.get("registered"):
    prefill = {
        "full_name": user.get("full_name"),
        "email": user.get("email"),
        "major": user.get("major"),
        "graduation_year": user.get("graduation_year"),
    }
    has_any_prefill = any(prefill.values())
    prefill_dict = prefill if has_any_prefill else None
    view = await CollegeSelectView.build(
        bot=self.bot,
        user_id=user["id"],
        machine_id=machine_id,
        prefill=prefill_dict,
    )
    if not view.children or not view.children[0].options:
        await interaction.response.send_message(
            "Sign-ups are temporarily unavailable — please contact staff.",
            ephemeral=True,
        )
        return
    await interaction.response.send_message(
        "Pick your UIUC college:", view=view, ephemeral=True,
    )
    return
```

**Step 5: Run tests to verify they pass**

Run: `pytest tests/test_signup_flow.py -v`

Expected: All 5 PASS.

Run the full bot-side suite for regressions:
`pytest tests/test_signup_flow.py tests/test_db.py tests/test_colleges_db.py tests/test_colleges_api.py -v`

**Step 6: Commit**

```bash
git add bot/cogs/queue.py tests/test_signup_flow.py
git commit -m "feat(bot): two-step signup with UIUC college picker

- New CollegeSelectView (ephemeral, timeout=120) shown before modal
- SignupModal drops college TextInput; takes college_id + prefill kwargs
- Re-signup users see modal pre-filled with prior name/email/major/grad_year
- Empty colleges list -> 'temporarily unavailable' fallback"
```

---

## Task 5: Frontend — types + API client

**Files:**
- Modify: `web/src/api/types.ts`
- Modify: `web/src/api/admin.ts`
- Modify: `web/src/api/client.ts` (public list)

**Step 1: Add types**

Append to `web/src/api/types.ts`:

```typescript
export interface CollegeSummary {
  id: number;
  name: string;
}

export interface AdminCollege {
  id: number;
  name: string;
  archived_at: string | null;
}
```

**Step 2: Add admin client functions**

Append to `web/src/api/admin.ts` (mirror the machines functions):

```typescript
import type { AdminCollege } from "./types";

export async function listAllColleges(): Promise<AdminCollege[]> {
  return await authedFetch<AdminCollege[]>("/api/colleges/?include_archived=true");
}

export async function createCollege(name: string): Promise<AdminCollege> {
  return await authedFetch<AdminCollege>("/api/colleges/", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function updateCollege(id: number, name: string): Promise<AdminCollege> {
  return await authedFetch<AdminCollege>(`/api/colleges/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function archiveCollege(id: number): Promise<void> {
  await authedFetch<void>(`/api/colleges/${id}`, { method: "DELETE" });
}

export async function restoreCollege(id: number): Promise<AdminCollege> {
  return await authedFetch<AdminCollege>(`/api/colleges/${id}/restore`, {
    method: "POST",
  });
}

export async function purgeCollege(
  id: number, confirmName: string,
): Promise<void> {
  await authedFetch<void>(`/api/colleges/${id}?purge=true`, {
    method: "DELETE",
    body: JSON.stringify({ confirm_name: confirmName }),
  });
}
```

**Step 3: Add public list to `client.ts`**

Append to `web/src/api/client.ts`:

```typescript
import type { CollegeSummary } from "./types";

export async function listColleges(): Promise<CollegeSummary[]> {
  const res = await fetch(`${API_BASE}/api/colleges/`);
  if (!res.ok) throw new Error(`Failed to load colleges: ${res.status}`);
  return await res.json();
}
```

**Step 4: Verify the frontend compiles**

Run: `cd web && pnpm tsc --noEmit`

Expected: 0 errors.

**Step 5: Commit**

```bash
git add web/src/api/types.ts web/src/api/admin.ts web/src/api/client.ts
git commit -m "feat(web): typed API client for colleges (public + admin)"
```

---

## Task 6: Frontend — `/admin/colleges` page

**Files:**
- Create: `web/src/pages/admin/Colleges.tsx`
- Modify: `web/src/App.tsx` (add route)
- Modify: nav component (where Machines/Staff/Settings tabs live — locate via grep)

**Step 1: Locate the admin nav source**

Run: `grep -rn "admin/machines" web/src --include "*.tsx"` to find the admin sub-tab strip. Add the "Colleges" tab in the same component.

**Step 2: Create `web/src/pages/admin/Colleges.tsx`**

Mirror the structure of `web/src/pages/admin/Machines.tsx`. Key elements:
- `useState` for `colleges: AdminCollege[]`, `newName: string`, `showArchived: boolean`, `purgeTarget: AdminCollege | null`.
- `useEffect` calls `listAllColleges()` on mount and after every mutation.
- Add form: `<input>` + `<button>` calling `createCollege(newName)`.
- Table rows: name (click to edit inline), archive button, restore button (when archived), purge button (when archived) opening the confirm modal.
- Purge modal: shows "Type the college name to confirm: <name>" + input + cancel/destructive purge buttons. On submit calls `purgeCollege(id, typedName)` and shows the 409 error inline if returned.

Use Tailwind classes consistent with `Machines.tsx`. Reuse existing toast component if present, else just inline `<p className="text-red-600">`.

**Step 3: Add route to `App.tsx`**

```tsx
import Colleges from "./pages/admin/Colleges";
...
<Route element={<RequireAdmin />}>
  <Route path="/admin/colleges" element={<Colleges />} />
</Route>
```

**Step 4: Add nav tab**

In the admin sub-tab strip component, add:

```tsx
<NavLink to="/admin/colleges" className={tabClass}>Colleges</NavLink>
```

(matching the NavLinks for Machines/Staff/Settings)

**Step 5: Manual smoke test**

```bash
cd web && pnpm dev
# In another terminal:
python -m main
```

In a browser:
- Log in as admin
- Visit `/admin/colleges`
- Add a college "Test", verify it appears
- Rename it, verify update
- Archive it, toggle "Show archived", restore it
- Archive again, click Purge, type wrong name → 400 message; type correct → row disappears

**Step 6: Commit**

```bash
git add web/src/pages/admin/Colleges.tsx web/src/App.tsx web/src/components/<NavComponent>.tsx
git commit -m "feat(web): /admin/colleges page (CRUD + archive/restore/purge)"
```

---

## Task 7: API — Analytics by-college dimension

**Files:**
- Modify: `api/routes/analytics.py` (`AnalyticsResponse`, `compute_analytics_response`)
- Test: `tests/test_analytics_api.py` (extend)

**Step 1: Write the failing tests**

Append to `tests/test_analytics_api.py`:

```python
def test_analytics_response_includes_colleges_block(client, seeded_completed_jobs):
    h = auth_headers_admin(client)
    res = client.get("/api/analytics/summary?period=week", headers=h)
    body = res.json()
    assert "colleges" in body
    assert isinstance(body["colleges"], list)


def test_analytics_filter_by_college_id_narrows_results(
    client, seeded_completed_jobs, college_a_id,
):
    """`college_a_id` is a fixture: a college with N jobs; total jobs is M > N."""
    h = auth_headers_admin(client)
    full = client.get("/api/analytics/summary?period=week", headers=h).json()
    filtered = client.get(
        f"/api/analytics/summary?period=week&college_id={college_a_id}",
        headers=h,
    ).json()
    assert filtered["summary"]["total_jobs"] < full["summary"]["total_jobs"]


def test_unspecified_bucket_aggregates_null_college_id(
    client, user_with_null_college, seeded_completed_jobs,
):
    h = auth_headers_admin(client)
    body = client.get("/api/analytics/summary?period=week", headers=h).json()
    unspec = next(
        (c for c in body["colleges"] if c["college_name"] == "Unspecified"), None
    )
    assert unspec is not None
    assert unspec["total_jobs"] >= 1
```

(Add the supporting fixtures in `tests/conftest.py`. Patterns mirror existing analytics fixtures.)

**Step 2: Run tests to verify they fail**

Run: `pytest tests/test_analytics_api.py -v -k college`

Expected: FAILs (`colleges` key missing, `college_id` filter ignored).

**Step 3: Update `api/routes/analytics.py`**

Add models:

```python
class CollegeStat(BaseModel):
    college_id: int
    college_name: str
    total_jobs: int
    completed_jobs: int
    unique_users: int
    avg_wait_mins: float | None
    avg_serve_mins: float | None
```

Add to `AnalyticsResponse`:

```python
colleges: list[CollegeStat]
```

Update `compute_analytics_response`:

```python
async def compute_analytics_response(
    period: str,
    start: str,
    end: str,
    *,
    machine_id: int | None = None,
    college_id: int | None = None,
) -> AnalyticsResponse:
    ...
    # Filter clause: when college_id is set, narrow to matching users.
    extra_user_filter = ""
    extra_params: list = []
    if college_id is not None:
        extra_user_filter = (
            "AND queue_entries.user_id IN "
            "(SELECT id FROM users WHERE college_id = ?)"
        )
        extra_params.append(college_id)

    # ... existing summary/machines computation, augment SQL with extra_user_filter

    # Build colleges block (always present, even when filtered).
    colleges_rows = await db.execute_fetchall(
        """
        SELECT
          COALESCE(u.college_id, 0)              AS college_id,
          COALESCE(c.name, 'Unspecified')        AS college_name,
          COUNT(qe.id)                            AS total_jobs,
          SUM(CASE WHEN qe.status='completed' THEN 1 ELSE 0 END) AS completed_jobs,
          COUNT(DISTINCT u.id)                    AS unique_users,
          AVG(<wait calc>)                        AS avg_wait_mins,
          AVG(<serve calc>)                       AS avg_serve_mins
        FROM queue_entries qe
        JOIN users u ON u.id = qe.user_id
        LEFT JOIN colleges c ON c.id = u.college_id
        WHERE qe.joined_at BETWEEN ? AND ?
        GROUP BY COALESCE(u.college_id, 0)
        ORDER BY total_jobs DESC
        """,
        (start, end),
    )
    return AnalyticsResponse(
        ...,
        colleges=[CollegeStat(**dict(r)) for r in colleges_rows],
    )
```

(Adjust `<wait calc>` / `<serve calc>` to match the existing analytics SQL — copy from the `machines` aggregation block.)

Add `college_id` query param to the `/summary` endpoint signature so it forwards to the helper.

**Step 4: Run tests to verify they pass**

Run: `pytest tests/test_analytics_api.py -v`

Expected: All PASS.

**Step 5: Commit**

```bash
git add api/routes/analytics.py tests/test_analytics_api.py
git commit -m "feat(api): analytics by-college dimension + college_id filter

- AnalyticsResponse.colleges block (always returned)
- compute_analytics_response accepts college_id filter
- 'Unspecified' bucket aggregates users with college_id IS NULL"
```

---

## Task 8: Frontend — Analytics by-college card + filter

**Files:**
- Modify: `web/src/pages/Analytics.tsx`
- Modify: `web/src/api/types.ts` (add `CollegeStat`, extend `AnalyticsResponse`)
- Modify: `web/src/api/client.ts` (forward `college_id` query param)

**Step 1: Extend types**

In `web/src/api/types.ts`:

```typescript
export interface CollegeStat {
  college_id: number;
  college_name: string;
  total_jobs: number;
  completed_jobs: number;
  unique_users: number;
  avg_wait_mins: number | null;
  avg_serve_mins: number | null;
}

export interface AnalyticsResponse {
  // ... existing fields
  colleges: CollegeStat[];
}
```

**Step 2: Forward `college_id` in the analytics fetcher**

Update the existing `getAnalyticsSummary(period, machineId?)` signature to accept an optional `collegeId?: number` and append `&college_id=` when set.

**Step 3: Add the by-college card and filter to `Analytics.tsx`**

- Import `listColleges` (public).
- Add `useState<number | null>(null)` for `selectedCollegeId`.
- Add a filter dropdown above the existing machine filter, populated from `listColleges()`.
- Add a "By college" card next to "By machine" — bar chart of `colleges[].total_jobs` (reuse the existing chart component used by machines).
- Clicking a college bar sets `selectedCollegeId` and re-fetches.
- Active filter chips at the top: "Filter: <Name> ✕" calls `setSelectedCollegeId(null)`.

**Step 4: Manual smoke test**

```bash
cd web && pnpm dev
# bot+api running in another terminal
```

- Visit `/admin/analytics`
- Confirm "By college" card renders
- Pick a college from the dropdown → numbers + machine card update
- Click clear chip → returns to all-college view

**Step 5: Verify the chatbot picks up the new dimension**

Open the analytics chatbot panel, ask "Which college uses the laser cutter the most?" — the JSON blob now includes `colleges[]` so the model can answer. No code change in `chat.py` needed; verify by manual test.

**Step 6: Commit**

```bash
git add web/src/pages/Analytics.tsx web/src/api/types.ts web/src/api/client.ts
git commit -m "feat(web): analytics by-college card + filter dropdown"
```

---

## Task 9: Chat test extension + final verification

**Files:**
- Modify: `tests/test_chat_api.py` (one new test)

**Step 1: Add the test**

Append to `tests/test_chat_api.py`:

```python
def test_chat_system_prompt_contains_colleges(
    client, mock_openai, seeded_completed_jobs,
):
    """Sanity check that the analytics blob fed to the model includes
    the colleges dimension so the chatbot can answer college questions."""
    h = auth_headers_admin(client)
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
    assert "\"colleges\"" in system_prompt
```

**Step 2: Run full suite**

```bash
pytest tests -v
```

Expected: ~205 PASS, 0 FAIL.

```bash
cd web && pnpm tsc --noEmit && pnpm lint
```

Expected: 0 errors.

**Step 3: Manual end-to-end smoke**

Wipe `reserv.db`, restart the bot, run through the full path:

1. Discord: press Join Queue → ephemeral select appears.
2. Pick Grainger → modal opens (empty for new user, prefilled for re-signup).
3. Submit valid email + grad year → joins queue, embed updates, DM received.
4. `/admin/colleges`: add "Custom College", rename it, archive, restore, purge with confirm.
5. Re-signup: pick the renamed college, observe FK propagation in DB.
6. Analytics: pick a college from filter dropdown → bars update; click "By college" bar → drills down further with machine filter composed.
7. Chatbot: "What college submitted the most jobs this week?" → reasonable answer using the new `colleges` JSON block.

**Step 4: Commit**

```bash
git add tests/test_chat_api.py
git commit -m "test(chat): assert system prompt includes colleges block"
```

---

## Task 10: Update memory + learnings

**Files:**
- Modify: `short_term_memory.md`
- Modify: `learnings.md` (if new gotchas surfaced during execution)
- Modify: `CLAUDE.md` "Completed Work" section

**Step 1: Append to `short_term_memory.md`**

```markdown
## 2026-04-26 — College Signup + Analytics-by-College
Shipped on `feat/customizable-admin`. ~205 tests passing, tsc clean.

**Backend:**
- New `colleges` table (id, name, archived_at) + partial unique index `idx_colleges_name_active` on `(name) WHERE archived_at IS NULL` (created in `_migrate` post-CREATE TABLE).
- `users.college_id INTEGER REFERENCES colleges(id)` replaces freeform `users.college` (DROPped via SQLite >= 3.35 ALTER).
- `_seed_colleges` idempotently inserts the 15 standard UIUC colleges; called from `init_db` after `_seed_machines`.
- Re-signup migration: `UPDATE users SET registered=0 WHERE registered=1` runs once in `_migrate` so existing users re-pick a college on next Join Queue press. `full_name`/`email`/`major`/`graduation_year` preserved for prefill.
- `db/models.py`: create/list_active/list_all/get/update/archive/restore/purge_college, count_users_in_college; `DuplicateCollegeError` + `CollegeInUseError`.
- `api/routes/colleges.py`: public GET active, staff GET include_archived, admin POST/PATCH/DELETE/restore/purge with `confirm_name`.
- `compute_analytics_response` gains `college_id` filter and a `colleges: list[CollegeStat]` block ("Unspecified" bucket aggregates `college_id IS NULL`).

**Discord:**
- New `CollegeSelectView` (ephemeral, `timeout=120`) shown before the modal. Picks a UIUC college from `list_active_colleges`, capped at 25 options.
- `SignupModal` drops the `college` `TextInput`; takes `college_id` + `prefill` kwargs. Prefill populates `TextInput.default` for re-signup.
- Empty colleges list → "Sign-ups temporarily unavailable" ephemeral message.

**Frontend:**
- `/admin/colleges` page (admin-only) mirrors `/admin/machines` — table, add form, archive/restore, purge with `confirm_name` modal.
- Analytics dashboard: "By college" card + college filter dropdown; chips for active filters; chatbot picks up the new dimension automatically via the shared analytics blob.

**Docs:**
- Design: `docs/plans/2026-04-26-college-signup-design.md`.
- Plan: `docs/plans/2026-04-26-college-signup.md`.
```

**Step 2: Update CLAUDE.md "Completed Work"**

Append a `### 2026-04-26 — College Signup` entry summarising the build (3-5 bullets, per the project convention).

**Step 3: Commit**

```bash
git add short_term_memory.md learnings.md CLAUDE.md
git commit -m "docs: capture college-signup shipped state in memory + completed work"
```

---

## Done

Implementation is complete when:
- All ~205 tests pass.
- `tsc --noEmit` and `pnpm lint` are clean.
- Manual smoke checklist (Task 9 Step 3) passes end-to-end.
- `short_term_memory.md` and `CLAUDE.md` are updated.
- Branch `feat/customizable-admin` is ready for `/gitpush`.
