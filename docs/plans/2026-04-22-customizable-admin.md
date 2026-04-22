# Customizable Admin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let staff add/archive/purge machines, manage staff accounts with admin vs. staff roles, and edit runtime settings from the web panel — with Discord embeds kept in sync automatically.

**Architecture:** Additive DB migration (one column each on `machines` and `staff_users`, new `settings` table). New `require_admin` dependency on top of the existing `require_staff`. Settings read through a cached `get_setting()` helper so the agent/bot stay cheap. Web `/admin` section (three pages) gated by role. Discord embed lifecycle extended with create/delete bridges mirroring the existing `notify_embed_update`.

**Tech Stack:** Python (aiosqlite, FastAPI, discord.py), React 19, React Router v7, Tailwind CSS v4, pytest + httpx.

**Design doc:** `docs/plans/2026-04-22-customizable-admin-design.md`

**Rollout order (each step independently deployable):**

1. Migration (schema + settings seed)
2. Settings-backed config reads (`get_setting` helper + cache)
3. Staff CRUD + `require_admin`
4. Machine CRUD + Discord embed lifecycle
5. Frontend `/admin` section

---

## Phase 1 — Schema Migration

### Task 1: Add `archived_at` column to `machines`

**Files:**
- Modify: `db/database.py` — the `_migrate` function around line 102

**Step 1: Write the failing test**

Append to `tests/test_db.py`:

```python
async def test_machines_have_archived_at_column(db):
    cursor = await db.execute("PRAGMA table_info(machines)")
    columns = {row[1] for row in await cursor.fetchall()}
    assert "archived_at" in columns


async def test_fresh_machines_are_not_archived(db):
    row = await (await db.execute(
        "SELECT archived_at FROM machines LIMIT 1"
    )).fetchone()
    assert row["archived_at"] is None
```

**Step 2: Run and confirm it fails**

```bash
pytest tests/test_db.py::test_machines_have_archived_at_column -v
```
Expected: FAIL — "archived_at" not in columns.

**Step 3: Add migration**

In `db/database.py::_migrate`, add after the existing `machines` block:

```python
    if "archived_at" not in columns:
        await db.execute("ALTER TABLE machines ADD COLUMN archived_at TEXT")
```

**Step 4: Confirm pass**

```bash
pytest tests/test_db.py -v -k archived
```

**Step 5: Commit**

```bash
git add db/database.py tests/test_db.py
git commit -m "feat(db): add archived_at column to machines"
```

---

### Task 2: Add `role` column to `staff_users` + backfill first admin

**Files:**
- Modify: `db/database.py::_migrate`

**Step 1: Write failing tests**

Append to `tests/test_db.py`:

```python
async def test_staff_users_have_role_column(db):
    cursor = await db.execute("PRAGMA table_info(staff_users)")
    columns = {row[1] for row in await cursor.fetchall()}
    assert "role" in columns


async def test_first_seeded_staff_becomes_admin(db):
    # Seed with a default staff user the same way the app does
    from api.auth import hash_password
    await db.execute(
        "INSERT INTO staff_users (username, password_hash) VALUES (?, ?)",
        ("testadmin", hash_password("pw")),
    )
    await db.commit()
    # Simulate re-running the migration
    import db.database as dbm
    await dbm._migrate(db)
    row = await (await db.execute(
        "SELECT role FROM staff_users WHERE username = 'testadmin'"
    )).fetchone()
    assert row["role"] == "admin"
```

**Step 2: Confirm failure**

```bash
pytest tests/test_db.py -v -k "role or admin"
```

**Step 3: Add migration**

In `db/database.py::_migrate`, add a new block:

```python
    cursor = await db.execute("PRAGMA table_info(staff_users)")
    staff_columns = {row[1] for row in await cursor.fetchall()}
    if "role" not in staff_columns:
        await db.execute(
            "ALTER TABLE staff_users ADD COLUMN role TEXT NOT NULL DEFAULT 'staff'"
        )
        await db.execute(
            "UPDATE staff_users SET role = 'admin' "
            "WHERE id = (SELECT MIN(id) FROM staff_users)"
        )
```

Also update `_seed_staff` so the seeded default user is inserted as `admin`:

```python
    await db.execute(
        "INSERT INTO staff_users (username, password_hash, role) VALUES (?, ?, ?)",
        (username, hash_password(password), "admin"),
    )
```

And update the `staff_users` `CREATE TABLE` in `_create_tables` to include `role TEXT NOT NULL DEFAULT 'staff'` so fresh installs don't need the migration.

**Step 4: Confirm pass**

```bash
pytest tests/test_db.py -v
```

**Step 5: Commit**

```bash
git add db/database.py tests/test_db.py
git commit -m "feat(db): add role column to staff_users; backfill first admin"
```

---

### Task 3: Create `settings` table + seed defaults

**Files:**
- Modify: `db/database.py` — `_create_tables`, add new `_seed_settings`, call from `init_db`

**Step 1: Write failing test**

Append to `tests/test_db.py`:

```python
async def test_settings_table_exists_and_seeded(db):
    cursor = await db.execute(
        "SELECT key, value FROM settings ORDER BY key"
    )
    rows = {r["key"]: r["value"] for r in await cursor.fetchall()}
    for k in (
        "reminder_minutes",
        "grace_minutes",
        "queue_reset_hour",
        "agent_tick_seconds",
        "public_mode",
        "maintenance_banner",
    ):
        assert k in rows, f"missing setting: {k}"
```

**Step 2: Confirm failure**

```bash
pytest tests/test_db.py::test_settings_table_exists_and_seeded -v
```

**Step 3: Implement**

Add to `_create_tables` the new table (before the indexes):

```sql
        CREATE TABLE IF NOT EXISTS settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
```

Add `_seed_settings`:

```python
async def _seed_settings(db: aiosqlite.Connection) -> None:
    """Insert default runtime settings from config if missing."""
    defaults = {
        "reminder_minutes":   str(settings.reminder_minutes),
        "grace_minutes":      str(settings.grace_minutes),
        "queue_reset_hour":   str(settings.queue_reset_hour),
        "agent_tick_seconds": str(settings.agent_tick_seconds),
        "public_mode":        "false",
        "maintenance_banner": "",
    }
    for key, value in defaults.items():
        await db.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            (key, value),
        )
```

Call it in `init_db` after `_seed_staff`:

```python
    await _seed_settings(_db)
```

**Step 4: Confirm pass**

```bash
pytest tests/test_db.py -v
```

**Step 5: Commit**

```bash
git add db/database.py tests/test_db.py
git commit -m "feat(db): add settings table with seeded runtime defaults"
```

---

## Phase 2 — Settings-Backed Reads

### Task 4: `get_setting()` helper with TTL cache

**Files:**
- Create: `api/settings_store.py`
- Test: `tests/test_settings_store.py`

**Step 1: Write failing test**

```python
"""Tests for the settings store helper."""

from __future__ import annotations

import pytest

from api.settings_store import (
    get_setting,
    set_setting,
    invalidate_settings_cache,
)

pytestmark = pytest.mark.asyncio


async def test_get_setting_returns_seeded_default(db):
    val = await get_setting("reminder_minutes")
    assert val == "30"


async def test_set_setting_persists_and_invalidates(db):
    await set_setting("reminder_minutes", "45")
    val = await get_setting("reminder_minutes")
    assert val == "45"


async def test_get_setting_typed(db):
    from api.settings_store import get_setting_int, get_setting_bool
    await set_setting("reminder_minutes", "42")
    assert await get_setting_int("reminder_minutes") == 42
    await set_setting("public_mode", "true")
    assert await get_setting_bool("public_mode") is True
    await set_setting("public_mode", "false")
    assert await get_setting_bool("public_mode") is False


async def test_get_setting_unknown_returns_none(db):
    assert await get_setting("does_not_exist") is None
```

**Step 2: Confirm failure**

```bash
pytest tests/test_settings_store.py -v
```

**Step 3: Implement**

```python
"""Runtime settings store with a short-lived TTL cache.

Reads go through the cache; writes invalidate it. Agent/bot can call
``get_setting_int`` on every tick without hammering SQLite.
"""

from __future__ import annotations

import time
from typing import Any

from db.database import get_db

_TTL_SECONDS = 10.0
_cache: dict[str, tuple[float, str]] = {}


async def get_setting(key: str) -> str | None:
    now = time.monotonic()
    entry = _cache.get(key)
    if entry and now - entry[0] < _TTL_SECONDS:
        return entry[1]
    db = await get_db()
    cursor = await db.execute("SELECT value FROM settings WHERE key = ?", (key,))
    row = await cursor.fetchone()
    if row is None:
        return None
    _cache[key] = (now, row["value"])
    return row["value"]


async def get_setting_int(key: str, default: int = 0) -> int:
    val = await get_setting(key)
    if val is None:
        return default
    try:
        return int(val)
    except ValueError:
        return default


async def get_setting_bool(key: str, default: bool = False) -> bool:
    val = await get_setting(key)
    if val is None:
        return default
    return val.strip().lower() in ("true", "1", "yes", "on")


async def set_setting(key: str, value: str) -> None:
    db = await get_db()
    await db.execute(
        "INSERT INTO settings (key, value, updated_at) "
        "VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET "
        "  value = excluded.value, updated_at = datetime('now')",
        (key, value),
    )
    await db.commit()
    _cache.pop(key, None)


def invalidate_settings_cache() -> None:
    _cache.clear()


async def get_all_settings() -> dict[str, str]:
    db = await get_db()
    cursor = await db.execute("SELECT key, value FROM settings")
    return {r["key"]: r["value"] for r in await cursor.fetchall()}
```

**Step 4: Confirm pass**

```bash
pytest tests/test_settings_store.py -v
```

**Step 5: Commit**

```bash
git add api/settings_store.py tests/test_settings_store.py
git commit -m "feat(settings): add settings store with TTL cache"
```

---

### Task 5: Route agent + bot through `get_setting_int`

**Files:**
- Modify: `agent/loop.py` (replace direct `settings.reminder_minutes` / `grace_minutes` / `agent_tick_seconds` reads at the tick boundary)
- Modify: any reference in `bot/bot.py` that reads those values

**Step 1: Find references**

```bash
grep -rn "settings.reminder_minutes\|settings.grace_minutes\|settings.agent_tick_seconds" agent/ bot/ api/
```

**Step 2: Write a smoke test**

Append to `tests/test_agent.py`:

```python
async def test_agent_respects_runtime_reminder_setting(db, monkeypatch):
    """Setting overrides should be visible to the agent without restart."""
    from api.settings_store import set_setting, get_setting_int
    await set_setting("reminder_minutes", "1")
    assert await get_setting_int("reminder_minutes") == 1
```

**Step 3: Refactor the agent**

Replace `settings.reminder_minutes` with `await get_setting_int("reminder_minutes", settings.reminder_minutes)` at each tick (and same pattern for `grace_minutes`, `agent_tick_seconds`). Use `config.py` value as the fallback so the first run still works if the table seeding hasn't completed yet.

**Step 4: Run full test suite**

```bash
pytest -v
```
Expected: all previously-passing tests still pass.

**Step 5: Commit**

```bash
git add agent/loop.py bot/bot.py tests/test_agent.py
git commit -m "refactor: agent + bot read runtime knobs from settings store"
```

---

## Phase 3 — Staff CRUD + `require_admin`

### Task 6: Add `require_admin` dependency + surface role in `/me`

**Files:**
- Modify: `api/auth.py` (add `require_admin` and include `role` in token payload)
- Modify: `api/routes/auth.py` (include `role` in `MeResponse`)
- Test: `tests/test_auth.py` (new)

**Step 1: Write failing tests**

```python
"""Tests for staff auth (login + role gating)."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from api.auth import hash_password
from api.main import app

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def client(db) -> AsyncClient:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


async def _make_staff(db, username: str, password: str, role: str) -> int:
    cursor = await db.execute(
        "INSERT INTO staff_users (username, password_hash, role) "
        "VALUES (?, ?, ?) RETURNING id",
        (username, hash_password(password), role),
    )
    row = await cursor.fetchone()
    await db.commit()
    return row["id"]


async def _login(client: AsyncClient, username: str, password: str) -> str:
    r = await client.post(
        "/api/auth/login", json={"username": username, "password": password}
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def test_me_includes_role(client, db):
    await _make_staff(db, "alice", "pw", "admin")
    token = await _login(client, "alice", "pw")
    r = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["role"] == "admin"


async def test_require_admin_rejects_staff(client, db):
    """We'll hit /api/staff/ (admin-only) later. Stand up a placeholder now."""
    await _make_staff(db, "bob", "pw", "staff")
    token = await _login(client, "bob", "pw")
    r = await client.get(
        "/api/staff/", headers={"Authorization": f"Bearer {token}"}
    )
    # Expected 403 (forbidden, not 401)
    assert r.status_code == 403
```

**Step 2: Confirm first test fails**

```bash
pytest tests/test_auth.py::test_me_includes_role -v
```

**Step 3: Update token payload and `require_admin`**

In `api/auth.py`:

```python
def issue_token(staff_id: int, username: str, role: str) -> str:
    payload = {
        "sub": staff_id,
        "usr": username,
        "rol": role,
        "exp": int(time.time()) + settings.auth_token_ttl_hours * 3600,
    }
    ...  # unchanged below


async def require_admin(payload: dict = Depends(require_staff)) -> dict[str, Any]:
    if payload.get("rol") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required",
        )
    return payload
```

Update `api/routes/auth.py`:

```python
class MeResponse(BaseModel):
    username: str
    staff_id: int
    role: str


@router.get("/me", response_model=MeResponse)
async def me(payload: dict = Depends(require_staff)) -> MeResponse:
    return MeResponse(
        username=payload["usr"],
        staff_id=payload["sub"],
        role=payload.get("rol", "staff"),
    )


@router.post("/login", response_model=LoginResponse)
async def login(body: LoginRequest) -> LoginResponse:
    staff = await get_staff_by_username(body.username)
    if staff is None or not verify_password(body.password, staff["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )
    token = issue_token(staff["id"], staff["username"], staff.get("role", "staff"))
    return LoginResponse(token=token, username=staff["username"])
```

**Step 4: Confirm `/me` test passes**

```bash
pytest tests/test_auth.py::test_me_includes_role -v
```

(The `test_require_admin_rejects_staff` test will still fail because the `/api/staff/` endpoint doesn't exist — that's Task 7. Leave it xfail-marked or skip until Task 7.)

**Step 5: Commit**

```bash
git add api/auth.py api/routes/auth.py tests/test_auth.py
git commit -m "feat(auth): add role to token + require_admin dependency"
```

---

### Task 7: Staff CRUD endpoints (admin-only)

**Files:**
- Create: `api/routes/staff.py`
- Modify: `api/main.py` (register router)
- Modify: `db/models.py` (helpers)
- Test: `tests/test_staff_admin.py`

**Step 1: Write failing tests**

```python
"""Tests for admin-only staff management endpoints."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from api.auth import hash_password
from api.main import app

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def client(db) -> AsyncClient:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


async def _seed(db, username, password, role):
    cursor = await db.execute(
        "INSERT INTO staff_users (username, password_hash, role) "
        "VALUES (?, ?, ?) RETURNING id",
        (username, hash_password(password), role),
    )
    row = await cursor.fetchone()
    await db.commit()
    return row["id"]


async def _login(client, username, password):
    r = await client.post(
        "/api/auth/login", json={"username": username, "password": password}
    )
    return r.json()["token"]


async def _admin_headers(client, db):
    await _seed(db, "root", "rootpw", "admin")
    token = await _login(client, "root", "rootpw")
    return {"Authorization": f"Bearer {token}"}


async def test_list_staff(client, db):
    headers = await _admin_headers(client, db)
    r = await client.get("/api/staff/", headers=headers)
    assert r.status_code == 200
    assert [s["username"] for s in r.json()] == ["root"]


async def test_create_staff(client, db):
    headers = await _admin_headers(client, db)
    r = await client.post(
        "/api/staff/",
        headers=headers,
        json={"username": "carol", "password": "carolpw", "role": "staff"},
    )
    assert r.status_code == 201
    assert r.json()["username"] == "carol"


async def test_create_staff_duplicate_username(client, db):
    headers = await _admin_headers(client, db)
    await client.post(
        "/api/staff/", headers=headers,
        json={"username": "carol", "password": "pw", "role": "staff"},
    )
    r = await client.post(
        "/api/staff/", headers=headers,
        json={"username": "carol", "password": "pw", "role": "staff"},
    )
    assert r.status_code == 409


async def test_last_admin_cannot_be_deleted(client, db):
    headers = await _admin_headers(client, db)
    r = await client.get("/api/staff/", headers=headers)
    root_id = r.json()[0]["id"]
    r = await client.delete(f"/api/staff/{root_id}", headers=headers)
    assert r.status_code == 409
    assert "last admin" in r.json()["detail"].lower()


async def test_last_admin_cannot_be_demoted(client, db):
    headers = await _admin_headers(client, db)
    root_id = (await client.get("/api/staff/", headers=headers)).json()[0]["id"]
    r = await client.patch(
        f"/api/staff/{root_id}", headers=headers, json={"role": "staff"}
    )
    assert r.status_code == 409


async def test_reset_password(client, db):
    headers = await _admin_headers(client, db)
    create = await client.post(
        "/api/staff/", headers=headers,
        json={"username": "dave", "password": "old", "role": "staff"},
    )
    dave_id = create.json()["id"]
    r = await client.patch(
        f"/api/staff/{dave_id}", headers=headers, json={"password": "new"}
    )
    assert r.status_code == 200
    # Can log in with new password
    login = await client.post(
        "/api/auth/login", json={"username": "dave", "password": "new"}
    )
    assert login.status_code == 200


async def test_staff_role_cannot_hit_admin_endpoints(client, db):
    await _seed(db, "eve", "evepw", "staff")
    token = await _login(client, "eve", "evepw")
    r = await client.get(
        "/api/staff/", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 403
```

**Step 2: Confirm failure**

```bash
pytest tests/test_staff_admin.py -v
```

**Step 3: Implement helpers in `db/models.py`**

```python
async def list_staff() -> list[dict[str, Any]]:
    db = await get_db()
    cursor = await db.execute(
        "SELECT id, username, role, created_at FROM staff_users ORDER BY id"
    )
    return _rows_to_dicts(await cursor.fetchall())


async def get_staff(staff_id: int) -> dict[str, Any] | None:
    db = await get_db()
    cursor = await db.execute(
        "SELECT id, username, role, created_at FROM staff_users WHERE id = ?",
        (staff_id,),
    )
    return _row_to_dict(await cursor.fetchone())


async def create_staff(username: str, password_hash: str, role: str) -> dict:
    db = await get_db()
    cursor = await db.execute(
        "INSERT INTO staff_users (username, password_hash, role) "
        "VALUES (?, ?, ?) "
        "RETURNING id, username, role, created_at",
        (username, password_hash, role),
    )
    row = dict(await cursor.fetchone())
    await db.commit()
    return row


async def update_staff(
    staff_id: int, *, role: str | None = None, password_hash: str | None = None
) -> None:
    db = await get_db()
    sets, params = [], []
    if role is not None:
        sets.append("role = ?"); params.append(role)
    if password_hash is not None:
        sets.append("password_hash = ?"); params.append(password_hash)
    if not sets:
        return
    params.append(staff_id)
    await db.execute(
        f"UPDATE staff_users SET {', '.join(sets)} WHERE id = ?", params
    )
    await db.commit()


async def delete_staff(staff_id: int) -> None:
    db = await get_db()
    await db.execute("DELETE FROM staff_users WHERE id = ?", (staff_id,))
    await db.commit()


async def count_admins() -> int:
    db = await get_db()
    cursor = await db.execute(
        "SELECT COUNT(*) AS cnt FROM staff_users WHERE role = 'admin'"
    )
    row = await cursor.fetchone()
    return row["cnt"]
```

**Step 4: Implement routes in `api/routes/staff.py`**

```python
"""Staff account management — admin-only."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from api.auth import hash_password, require_admin
from db import models

router = APIRouter(
    prefix="/api/staff",
    tags=["staff"],
    dependencies=[Depends(require_admin)],
)

Role = Literal["admin", "staff"]


class StaffOut(BaseModel):
    id: int
    username: str
    role: Role
    created_at: str


class StaffCreate(BaseModel):
    username: str = Field(min_length=3, max_length=40)
    password: str = Field(min_length=6)
    role: Role = "staff"


class StaffUpdate(BaseModel):
    role: Role | None = None
    password: str | None = Field(default=None, min_length=6)


@router.get("/", response_model=list[StaffOut])
async def list_all() -> list[dict]:
    return await models.list_staff()


@router.post(
    "/", response_model=StaffOut, status_code=status.HTTP_201_CREATED
)
async def create(body: StaffCreate) -> dict:
    existing = await models.get_staff_by_username(body.username) \
        if hasattr(models, "get_staff_by_username") else None
    if existing is None:
        from api.auth import get_staff_by_username
        existing = await get_staff_by_username(body.username)
    if existing is not None:
        raise HTTPException(status_code=409, detail="Username already exists")
    return await models.create_staff(
        body.username, hash_password(body.password), body.role
    )


@router.patch("/{staff_id}", response_model=StaffOut)
async def update(staff_id: int, body: StaffUpdate) -> dict:
    target = await models.get_staff(staff_id)
    if target is None:
        raise HTTPException(status_code=404, detail="Staff not found")
    # Last-admin demotion guard
    if body.role == "staff" and target["role"] == "admin":
        if await models.count_admins() <= 1:
            raise HTTPException(
                status_code=409, detail="Cannot demote the last admin"
            )
    await models.update_staff(
        staff_id,
        role=body.role,
        password_hash=hash_password(body.password) if body.password else None,
    )
    updated = await models.get_staff(staff_id)
    assert updated is not None
    return updated


@router.delete("/{staff_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete(staff_id: int) -> None:
    target = await models.get_staff(staff_id)
    if target is None:
        raise HTTPException(status_code=404, detail="Staff not found")
    if target["role"] == "admin" and await models.count_admins() <= 1:
        raise HTTPException(
            status_code=409, detail="Cannot delete the last admin"
        )
    await models.delete_staff(staff_id)
```

**Step 5: Register the router in `api/main.py`**

```python
from api.routes.staff import router as staff_router
...
app.include_router(staff_router)
```

**Step 6: Run tests**

```bash
pytest tests/test_staff_admin.py -v
pytest tests/test_auth.py -v   # test_require_admin_rejects_staff should now pass
```

**Step 7: Commit**

```bash
git add api/routes/staff.py api/main.py db/models.py tests/test_staff_admin.py
git commit -m "feat(staff): CRUD + last-admin protection"
```

---

### Task 8: Settings endpoints (admin-only)

**Files:**
- Create: `api/routes/settings.py`
- Modify: `api/main.py`
- Test: `tests/test_settings_api.py`

**Step 1: Write failing tests**

```python
"""Tests for /api/settings (admin-only)."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from api.auth import hash_password
from api.main import app

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def client(db) -> AsyncClient:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


async def _admin_headers(client, db):
    await db.execute(
        "INSERT INTO staff_users (username, password_hash, role) VALUES (?, ?, ?)",
        ("root", hash_password("pw"), "admin"),
    )
    await db.commit()
    r = await client.post(
        "/api/auth/login", json={"username": "root", "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['token']}"}


async def test_get_settings_returns_defaults(client, db):
    headers = await _admin_headers(client, db)
    r = await client.get("/api/settings/", headers=headers)
    assert r.status_code == 200
    data = r.json()
    assert data["reminder_minutes"] == "30"
    assert data["public_mode"] == "false"


async def test_patch_settings_updates(client, db):
    headers = await _admin_headers(client, db)
    r = await client.patch(
        "/api/settings/", headers=headers,
        json={"reminder_minutes": "45", "public_mode": "true"},
    )
    assert r.status_code == 200
    follow = await client.get("/api/settings/", headers=headers)
    assert follow.json()["reminder_minutes"] == "45"
    assert follow.json()["public_mode"] == "true"


async def test_patch_rejects_unknown_key(client, db):
    headers = await _admin_headers(client, db)
    r = await client.patch(
        "/api/settings/", headers=headers, json={"wat": "no"}
    )
    assert r.status_code == 400
```

**Step 2: Confirm failure**

```bash
pytest tests/test_settings_api.py -v
```

**Step 3: Implement**

```python
"""Admin settings endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from api.auth import require_admin
from api.settings_store import get_all_settings, set_setting

router = APIRouter(
    prefix="/api/settings",
    tags=["settings"],
    dependencies=[Depends(require_admin)],
)

ALLOWED_KEYS = {
    "reminder_minutes",
    "grace_minutes",
    "queue_reset_hour",
    "agent_tick_seconds",
    "public_mode",
    "maintenance_banner",
}


@router.get("/")
async def list_settings() -> dict[str, str]:
    return await get_all_settings()


@router.patch("/")
async def patch_settings(updates: dict[str, str]) -> dict[str, str]:
    bad = set(updates.keys()) - ALLOWED_KEYS
    if bad:
        raise HTTPException(
            status_code=400, detail=f"Unknown setting keys: {sorted(bad)}"
        )
    for key, value in updates.items():
        await set_setting(key, str(value))
    return await get_all_settings()
```

Register in `api/main.py`:

```python
from api.routes.settings import router as settings_router
...
app.include_router(settings_router)
```

**Step 4: Run tests**

```bash
pytest tests/test_settings_api.py -v
```

**Step 5: Commit**

```bash
git add api/routes/settings.py api/main.py tests/test_settings_api.py
git commit -m "feat(settings): admin-only GET/PATCH endpoints"
```

---

## Phase 4 — Machine CRUD + Discord Embed Lifecycle

### Task 9: Slug validation + `archived_at` aware queries

**Files:**
- Modify: `db/models.py` — add `create_machine`, `update_machine`, `archive_machine`, `restore_machine`, `purge_machine`, `list_machines(include_archived)`
- Test: `tests/test_machines_db.py`

**Step 1: Write failing tests**

```python
"""Tests for machine DB helpers (archive/restore/purge)."""

from __future__ import annotations

import pytest
from db import models

pytestmark = pytest.mark.asyncio


async def test_create_machine(db):
    m = await models.create_machine(name="New Tool", slug="new-tool")
    assert m["name"] == "New Tool"
    assert m["archived_at"] is None


async def test_create_machine_rejects_duplicate_active_slug(db):
    await models.create_machine(name="Dup", slug="dup")
    with pytest.raises(ValueError):
        await models.create_machine(name="Dup 2", slug="dup")


async def test_archive_then_restore(db):
    m = await models.create_machine(name="X", slug="x-tool")
    await models.archive_machine(m["id"])
    listed = await models.list_machines()
    assert all(row["slug"] != "x-tool" for row in listed)
    all_rows = await models.list_machines(include_archived=True)
    assert any(row["slug"] == "x-tool" for row in all_rows)
    await models.restore_machine(m["id"])
    listed = await models.list_machines()
    assert any(row["slug"] == "x-tool" for row in listed)


async def test_restore_blocked_if_slug_taken(db):
    a = await models.create_machine(name="A", slug="shared")
    await models.archive_machine(a["id"])
    await models.create_machine(name="B", slug="shared")
    with pytest.raises(ValueError):
        await models.restore_machine(a["id"])


async def test_purge_removes_rows(db):
    m = await models.create_machine(name="Doomed", slug="doomed")
    await models.purge_machine(m["id"])
    assert await models.get_machine(m["id"]) is None
```

**Step 2: Confirm failure**

```bash
pytest tests/test_machines_db.py -v
```

**Step 3: Implement helpers in `db/models.py`**

Key pieces (fill in based on existing patterns):

```python
import re

_SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


async def list_machines(include_archived: bool = False) -> list[dict]:
    db = await get_db()
    sql = "SELECT * FROM machines"
    if not include_archived:
        sql += " WHERE archived_at IS NULL"
    sql += " ORDER BY id"
    cursor = await db.execute(sql)
    return _rows_to_dicts(await cursor.fetchall())


async def create_machine(*, name: str, slug: str) -> dict:
    if not _SLUG_RE.match(slug):
        raise ValueError(f"Invalid slug: {slug!r}")
    db = await get_db()
    # Unique among active
    cursor = await db.execute(
        "SELECT 1 FROM machines WHERE slug = ? AND archived_at IS NULL",
        (slug,),
    )
    if await cursor.fetchone():
        raise ValueError(f"Slug already in use: {slug!r}")
    cursor = await db.execute(
        "INSERT INTO machines (name, slug) VALUES (?, ?) RETURNING *",
        (name, slug),
    )
    row = dict(await cursor.fetchone())
    await db.commit()
    return row


async def archive_machine(machine_id: int) -> None:
    db = await get_db()
    await db.execute(
        "UPDATE machines SET archived_at = datetime('now'), embed_message_id = NULL "
        "WHERE id = ?",
        (machine_id,),
    )
    await db.commit()


async def restore_machine(machine_id: int) -> None:
    db = await get_db()
    cursor = await db.execute(
        "SELECT slug FROM machines WHERE id = ?", (machine_id,)
    )
    row = await cursor.fetchone()
    if row is None:
        raise ValueError("Machine not found")
    cursor = await db.execute(
        "SELECT 1 FROM machines WHERE slug = ? AND archived_at IS NULL AND id != ?",
        (row["slug"], machine_id),
    )
    if await cursor.fetchone():
        raise ValueError(f"Slug already taken: {row['slug']!r}")
    await db.execute(
        "UPDATE machines SET archived_at = NULL WHERE id = ?", (machine_id,)
    )
    await db.commit()


async def purge_machine(machine_id: int) -> dict[str, int]:
    """Hard-delete machine + cascade queue_entries + analytics_snapshots."""
    db = await get_db()
    qe_cursor = await db.execute(
        "DELETE FROM queue_entries WHERE machine_id = ?", (machine_id,)
    )
    qe_count = qe_cursor.rowcount
    snap_cursor = await db.execute(
        "DELETE FROM analytics_snapshots WHERE machine_id = ?", (machine_id,)
    )
    snap_count = snap_cursor.rowcount
    await db.execute("DELETE FROM machines WHERE id = ?", (machine_id,))
    await db.commit()
    return {"queue_entries": qe_count, "analytics_snapshots": snap_count}


async def count_active_queue_entries(machine_id: int) -> int:
    db = await get_db()
    cursor = await db.execute(
        "SELECT COUNT(*) AS cnt FROM queue_entries "
        "WHERE machine_id = ? AND status IN ('waiting', 'serving')",
        (machine_id,),
    )
    return (await cursor.fetchone())["cnt"]


async def update_machine(machine_id: int, *, name: str | None = None,
                         slug: str | None = None, status: str | None = None) -> None:
    sets, params = [], []
    if name is not None:
        sets.append("name = ?"); params.append(name)
    if slug is not None:
        if not _SLUG_RE.match(slug):
            raise ValueError(f"Invalid slug: {slug!r}")
        # uniqueness check
        db = await get_db()
        cur = await db.execute(
            "SELECT 1 FROM machines WHERE slug = ? AND archived_at IS NULL AND id != ?",
            (slug, machine_id),
        )
        if await cur.fetchone():
            raise ValueError(f"Slug already in use: {slug!r}")
        sets.append("slug = ?"); params.append(slug)
    if status is not None:
        sets.append("status = ?"); params.append(status)
    if not sets:
        return
    params.append(machine_id)
    db = await get_db()
    await db.execute(
        f"UPDATE machines SET {', '.join(sets)} WHERE id = ?", params
    )
    await db.commit()
```

Update the existing `get_machines()` to filter `archived_at IS NULL` by default (or leave it and add `list_machines` as the new canonical reader — pick one, update call sites).

**Step 4: Confirm pass**

```bash
pytest tests/test_machines_db.py -v
```

**Step 5: Commit**

```bash
git add db/models.py tests/test_machines_db.py
git commit -m "feat(db): machine create/update/archive/restore/purge helpers"
```

---

### Task 10: Discord embed create/delete bridges

**Files:**
- Modify: `api/deps.py` — add `notify_embed_create`, `notify_embed_delete`
- Modify: `bot/bot.py` — add `create_queue_embed`, `delete_queue_embed`; extend `on_ready` reconciliation

**Step 1: Define the bridges in `api/deps.py`**

```python
def notify_embed_create(machine_id: int) -> None:
    if bot is None or bot.loop is None:
        return
    try:
        asyncio.run_coroutine_threadsafe(
            bot.create_queue_embed(machine_id), bot.loop
        )
    except Exception:
        log.warning("Failed to schedule embed create for machine %d", machine_id)


def notify_embed_delete(machine_id: int, message_id: str | None) -> None:
    if bot is None or bot.loop is None or not message_id:
        return
    try:
        asyncio.run_coroutine_threadsafe(
            bot.delete_queue_embed(int(message_id)), bot.loop
        )
    except Exception:
        log.warning("Failed to schedule embed delete for machine %d", machine_id)
```

**Step 2: Implement in `bot/bot.py`**

Mirror the existing embed-publish path. Sketch (adapt to actual method names in the codebase):

```python
async def create_queue_embed(self, machine_id: int) -> None:
    channel = self.get_channel(settings.queue_channel_id)
    machine = await models.get_machine(machine_id)
    if machine is None or machine.get("archived_at") is not None:
        return
    if machine["embed_message_id"]:
        # Already exists — update in place instead
        await self.update_queue_embeds(machine_id)
        return
    embed, view = build_machine_embed(machine)
    msg = await channel.send(embed=embed, view=view)
    await models.update_machine_embed_message_id(machine_id, msg.id)

async def delete_queue_embed(self, message_id: int) -> None:
    channel = self.get_channel(settings.queue_channel_id)
    try:
        msg = await channel.fetch_message(message_id)
        await msg.delete()
    except discord.NotFound:
        pass
```

**Step 3: Extend `on_ready` reconciliation**

After the existing "Reused embed for X" loop:

- For every active machine without an `embed_message_id`: call `create_queue_embed`.
- For every row with `archived_at IS NOT NULL` but a lingering `embed_message_id`: call `delete_queue_embed` + null the column.

**Step 4: Smoke test manually**

```bash
# Restart bot + API
pkill -f "python main.py"; python main.py &
# Archive a seed machine via sqlite3, restart, confirm embed is gone
```

(Full integration test is in Task 11 with mocked `bot`.)

**Step 5: Commit**

```bash
git add api/deps.py bot/bot.py
git commit -m "feat(bot): embed create/delete bridges + on_ready reconciliation"
```

---

### Task 11: Machine CRUD endpoints

**Files:**
- Modify: `api/routes/machines.py` — add POST, richer PATCH, DELETE (archive), `?purge=true`, `/restore`
- Test: `tests/test_machines_admin.py`

**Step 1: Write failing tests**

```python
"""Tests for admin-gated machine CRUD."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from api.auth import hash_password
from api.main import app
from db import models

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def client(db) -> AsyncClient:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


async def _admin_headers(client, db):
    await db.execute(
        "INSERT INTO staff_users (username, password_hash, role) VALUES (?, ?, ?)",
        ("root", hash_password("pw"), "admin"),
    )
    await db.commit()
    r = await client.post(
        "/api/auth/login", json={"username": "root", "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['token']}"}


async def test_create_machine(client, db):
    h = await _admin_headers(client, db)
    r = await client.post(
        "/api/machines/", headers=h,
        json={"name": "New", "slug": "new"},
    )
    assert r.status_code == 201
    assert r.json()["slug"] == "new"


async def test_create_rejects_bad_slug(client, db):
    h = await _admin_headers(client, db)
    r = await client.post(
        "/api/machines/", headers=h,
        json={"name": "Bad", "slug": "Bad Slug"},
    )
    assert r.status_code == 400


async def test_archive_blocks_with_active_queue(client, db):
    h = await _admin_headers(client, db)
    machines = (await client.get("/api/machines/", headers=h)).json()
    mid = machines[0]["id"]
    # Create a waiting entry
    await models.get_or_create_user("u1", "userA")
    user = await models.get_user_by_discord_id("u1")
    await models.join_queue(user["id"], mid)
    r = await client.delete(f"/api/machines/{mid}", headers=h)
    assert r.status_code == 409


async def test_archive_then_include_archived(client, db):
    h = await _admin_headers(client, db)
    new = await client.post(
        "/api/machines/", headers=h, json={"name": "Z", "slug": "z-tool"}
    )
    mid = new.json()["id"]
    r = await client.delete(f"/api/machines/{mid}", headers=h)
    assert r.status_code == 204
    default = await client.get("/api/machines/", headers=h)
    assert all(m["id"] != mid for m in default.json())
    with_archived = await client.get(
        "/api/machines/?include_archived=true", headers=h
    )
    assert any(m["id"] == mid for m in with_archived.json())


async def test_purge_requires_confirm_slug(client, db):
    h = await _admin_headers(client, db)
    m = (await client.post(
        "/api/machines/", headers=h, json={"name": "Purge", "slug": "purge-me"}
    )).json()
    r = await client.request(
        "DELETE", f"/api/machines/{m['id']}?purge=true",
        headers=h, json={"confirm_slug": "wrong"},
    )
    assert r.status_code == 400
    r = await client.request(
        "DELETE", f"/api/machines/{m['id']}?purge=true",
        headers=h, json={"confirm_slug": "purge-me"},
    )
    assert r.status_code == 204


async def test_restore(client, db):
    h = await _admin_headers(client, db)
    m = (await client.post(
        "/api/machines/", headers=h, json={"name": "R", "slug": "r"}
    )).json()
    await client.delete(f"/api/machines/{m['id']}", headers=h)
    r = await client.post(f"/api/machines/{m['id']}/restore", headers=h)
    assert r.status_code == 200
```

**Step 2: Confirm failure**

```bash
pytest tests/test_machines_admin.py -v
```

**Step 3: Implement**

In `api/routes/machines.py`:

```python
from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from api.auth import require_admin, require_staff
from api.deps import (
    notify_embed_create,
    notify_embed_delete,
    notify_embed_update,
)
from db import models

router = APIRouter(
    prefix="/api/machines",
    tags=["machines"],
    dependencies=[Depends(require_staff)],
)


class MachineOut(BaseModel):
    id: int
    name: str
    slug: str
    status: str
    archived_at: str | None = None
    created_at: str


class MachineCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    slug: str = Field(min_length=1, max_length=60)


class MachineUpdate(BaseModel):
    name: str | None = None
    slug: str | None = None
    status: Literal["active", "maintenance", "offline"] | None = None


class PurgeConfirm(BaseModel):
    confirm_slug: str


@router.get("/", response_model=list[MachineOut])
async def list_all(include_archived: bool = Query(False)) -> list[dict]:
    return await models.list_machines(include_archived=include_archived)


@router.post("/", response_model=MachineOut, status_code=201)
async def create(body: MachineCreate) -> dict:
    try:
        m = await models.create_machine(name=body.name, slug=body.slug)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    notify_embed_create(m["id"])
    return m


@router.patch("/{machine_id}", response_model=MachineOut)
async def patch(machine_id: int, body: MachineUpdate) -> dict:
    if await models.get_machine(machine_id) is None:
        raise HTTPException(status_code=404, detail="Machine not found")
    try:
        await models.update_machine(
            machine_id,
            name=body.name, slug=body.slug, status=body.status,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    notify_embed_update(machine_id)
    updated = await models.get_machine(machine_id)
    assert updated is not None
    return updated


@router.delete(
    "/{machine_id}",
    status_code=204,
    dependencies=[Depends(require_admin)],
)
async def delete(
    machine_id: int,
    purge: bool = Query(False),
    body: PurgeConfirm | None = Body(default=None),
) -> None:
    m = await models.get_machine(machine_id)
    if m is None:
        raise HTTPException(status_code=404, detail="Machine not found")
    active = await models.count_active_queue_entries(machine_id)
    if active > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Clear the queue first. {active} users still waiting.",
        )
    msg_id = m.get("embed_message_id")
    if purge:
        if body is None or body.confirm_slug != m["slug"]:
            raise HTTPException(
                status_code=400,
                detail="confirm_slug must equal the machine slug",
            )
        counts = await models.purge_machine(machine_id)
        notify_embed_delete(machine_id, msg_id)
        import logging
        logging.getLogger(__name__).warning(
            "Purged machine slug=%s counts=%s", m["slug"], counts
        )
    else:
        await models.archive_machine(machine_id)
        notify_embed_delete(machine_id, msg_id)


@router.post(
    "/{machine_id}/restore",
    response_model=MachineOut,
    dependencies=[Depends(require_admin)],
)
async def restore(machine_id: int) -> dict:
    try:
        await models.restore_machine(machine_id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    notify_embed_create(machine_id)
    restored = await models.get_machine(machine_id)
    assert restored is not None
    return restored
```

**Step 4: Run tests**

```bash
pytest tests/test_machines_admin.py -v
pytest -v  # full suite regression
```

**Step 5: Commit**

```bash
git add api/routes/machines.py tests/test_machines_admin.py
git commit -m "feat(machines): CRUD + archive/restore/purge with embed bridges"
```

---

## Phase 5 — Frontend `/admin`

### Task 12: Extend AuthContext with role + RequireAdmin

**Files:**
- Modify: `web/src/auth/AuthContext.tsx` — add `role` to context
- Modify: `web/src/api/client.ts` — `fetchMe` response type includes `role`
- Modify: `web/src/App.tsx` — add `RequireAdmin`

**Step 1: Update types**

```ts
// client.ts
export const fetchMe = () =>
  request<{ username: string; staff_id: number; role: "admin" | "staff" }>(
    "/auth/me"
  );
```

**Step 2: Extend AuthContext**

```ts
type AuthState = {
  username: string | null;
  role: "admin" | "staff" | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
};
```

Track `role` alongside `username`. Login now also stores the role returned by `/me` (fetch it right after login succeeds to populate).

**Step 3: Add `RequireAdmin`**

```tsx
function RequireAdmin({ children }: { children: React.ReactElement }) {
  const { role, loading } = useAuth();
  if (loading) return <div className="py-12 text-center">Loading…</div>;
  if (role !== "admin") return <Navigate to="/admin/machines" replace />;
  return children;
}
```

**Step 4: Manual verification**

Load `/` signed out, sign in as admin, confirm `role` surfaces; try as non-admin (create one via `/api/staff/`) and confirm admin tabs are hidden.

**Step 5: Commit**

```bash
git add web/src/auth/AuthContext.tsx web/src/api/client.ts web/src/App.tsx
git commit -m "feat(web): surface role in auth context + RequireAdmin wrapper"
```

---

### Task 13: `/admin/machines` page

**Files:**
- Create: `web/src/pages/admin/Machines.tsx`
- Create: `web/src/api/admin.ts` (shared admin API helpers)
- Modify: `web/src/App.tsx` — route
- Modify: `web/src/components/NavBar.tsx` — Admin link

**Step 1: API helpers**

```ts
// admin.ts
export const createMachine = (name: string, slug: string) =>
  request("/machines/", { method: "POST", body: JSON.stringify({ name, slug }) });
export const patchMachine = (id: number, body: Partial<{ name: string; slug: string; status: string }>) =>
  request(`/machines/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const archiveMachine = (id: number) =>
  request(`/machines/${id}`, { method: "DELETE" });
export const purgeMachine = (id: number, confirm_slug: string) =>
  request(`/machines/${id}?purge=true`, { method: "DELETE", body: JSON.stringify({ confirm_slug }) });
export const restoreMachine = (id: number) =>
  request(`/machines/${id}/restore`, { method: "POST" });
export const listMachines = (includeArchived = false) =>
  request(`/machines/${includeArchived ? "?include_archived=true" : ""}`);
```

**Step 2: Machines page UI**

- Active table (Name, Slug, Status, Queue count, Actions).
- "Add machine" opens modal.
- Row actions: Edit, Status picker, Archive (admin — with confirmation), "…" menu → Delete permanently (admin — red modal requiring slug retype, shows row counts).
- Archived section below with Restore action (admin).
- Surface API errors verbatim (e.g. "Clear the queue first…").

**Step 3: Route + NavBar**

In `App.tsx`:

```tsx
<Route
  path="/admin/machines"
  element={<RequireStaff><AdminMachines /></RequireStaff>}
/>
```

NavBar: add "Admin" dropdown with Machines link when signed in.

**Step 4: Browser-verify end-to-end**

Spin up the system, sign in as admin, add a machine, check the Discord queue channel for the new embed. Archive it, confirm embed disappears. Restore it; confirm it comes back.

**Step 5: Commit**

```bash
git add web/src/pages/admin/Machines.tsx web/src/api/admin.ts \
        web/src/App.tsx web/src/components/NavBar.tsx
git commit -m "feat(web): /admin/machines page with archive/restore/purge"
```

---

### Task 14: `/admin/staff` page

**Files:**
- Create: `web/src/pages/admin/Staff.tsx`
- Modify: `web/src/api/admin.ts` — staff helpers
- Modify: `web/src/App.tsx` — route gated by `RequireAdmin`

**Step 1: API helpers**

```ts
export const listStaff = () => request<StaffRow[]>("/staff/");
export const createStaff = (body: { username: string; password: string; role: string }) =>
  request("/staff/", { method: "POST", body: JSON.stringify(body) });
export const patchStaff = (id: number, body: { role?: string; password?: string }) =>
  request(`/staff/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteStaff = (id: number) =>
  request(`/staff/${id}`, { method: "DELETE" });
```

**Step 2: UI**

Table with Username, Role, Created. Toolbar: Add staff modal (username + password + role). Row actions: Change role, Reset password, Delete. Surface 409 messages (last-admin guards).

**Step 3: Route**

```tsx
<Route
  path="/admin/staff"
  element={<RequireStaff><RequireAdmin><AdminStaff /></RequireAdmin></RequireStaff>}
/>
```

NavBar: include "Staff" under Admin only if `role === "admin"`.

**Step 4: Browser-verify**

Create a regular staff, log in as them, confirm the admin tab is hidden and direct URL 403s.

**Step 5: Commit**

```bash
git add web/src/pages/admin/Staff.tsx web/src/api/admin.ts \
        web/src/App.tsx web/src/components/NavBar.tsx
git commit -m "feat(web): /admin/staff page (admin-only)"
```

---

### Task 15: `/admin/settings` page + maintenance banner

**Files:**
- Create: `web/src/pages/admin/Settings.tsx`
- Create: `web/src/components/MaintenanceBanner.tsx`
- Modify: `web/src/App.tsx` — route, mount banner at top of layout

**Step 1: API helpers**

```ts
export const getSettings = () => request<Record<string, string>>("/settings/");
export const patchSettings = (updates: Record<string, string>) =>
  request("/settings/", { method: "PATCH", body: JSON.stringify(updates) });
```

**Step 2: Settings UI**

Two grouped cards:
- **Queue behavior** — number inputs for `reminder_minutes`, `grace_minutes`, `queue_reset_hour`, `agent_tick_seconds`.
- **Feature toggles** — checkbox for `public_mode`, textarea for `maintenance_banner`.

One "Save changes" button enabled only when dirty; on success, toast + reload.

**Step 3: Maintenance banner**

A small component that polls `/api/settings/` every 60s (public endpoint for this one key? — see note below). Renders a yellow strip with the banner text if non-empty.

> **Note:** `/api/settings/` is admin-gated, but the maintenance banner should be visible to everyone. Add a small public endpoint `GET /api/public-settings/` that returns only the banner text + `public_mode` flag. Non-sensitive; no auth needed.

Add that endpoint in Task 8 (or as a small addendum) — mention in the commit.

**Step 4: Browser-verify**

- Change `reminder_minutes` from UI, confirm GET reflects new value.
- Set `maintenance_banner = "Server maintenance 5-6pm"`, confirm the yellow strip shows on every page (signed in or not).

**Step 5: Commit**

```bash
git add web/src/pages/admin/Settings.tsx \
        web/src/components/MaintenanceBanner.tsx \
        web/src/App.tsx api/routes/settings.py
git commit -m "feat(web): /admin/settings page + maintenance banner"
```

---

### Task 16: Full regression pass + capture learnings

**Step 1: Run full test suite**

```bash
pytest -v
```
Expected: all tests pass (original suite + all new tests from Tasks 1-11).

**Step 2: TypeScript check**

```bash
cd web && npx tsc -b
```
Expected: no errors.

**Step 3: Manual smoke test checklist**

- Sign in as admin → add machine → embed appears in Discord.
- Join queue on the new machine, confirm entry visible on `/`.
- Archive while queue is active → 409 surfaced.
- Clear queue → archive → embed disappears, machine hidden from `/`.
- Restore → embed returns.
- Hard-delete a throwaway machine → confirm modal requires slug retype, row counts shown, purge succeeds.
- Add a `staff` user, log in as them → admin tabs hidden, `/admin/settings` redirects.
- Edit `reminder_minutes` in settings → agent uses new value within 10s (watch logs).
- Set `maintenance_banner` → visible on every page.

**Step 4: Update memory and learnings**

Append a section to `short_term_memory.md` describing what shipped. Add a `learnings.md` entry covering any gotchas encountered during implementation (slug collision on restore, FK cascade order, cache invalidation timing, etc.).

**Step 5: Commit**

```bash
git add short_term_memory.md learnings.md
git commit -m "docs: capture customizable-admin shipping notes"
```

---

## Summary

16 tasks across 5 phases. Every phase leaves the system in a working state. Each task follows TDD with a failing test, minimal implementation, passing test, commit. No new runtime dependencies. Stdlib-only Python additions; web additions reuse existing Tailwind/React patterns.

**Critical guardrails (enforced in code, not convention):**
- Last-admin cannot be deleted or demoted.
- Machines with active queue entries cannot be archived or purged.
- Hard-delete requires typed slug confirmation.
- Slug reuse blocked among active machines; freed once archived.
- Secrets and `AUTH_SECRET` remain in `.env`; never UI-editable.
