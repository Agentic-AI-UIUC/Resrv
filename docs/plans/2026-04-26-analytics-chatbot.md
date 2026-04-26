# Analytics Chatbot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a multi-turn chat panel to `/admin/analytics` that lets staff ask natural-language questions about the analytics they're currently looking at, backed by `gpt-4o-mini` with persisted conversations scoped per staff user.

**Architecture:** Two new SQLite tables (`chat_conversations`, `chat_messages`); a FastAPI router under `/api/analytics/chat` gated by `require_staff`; reuse the existing `_compute_analytics_response`-style aggregation so chat answers can never diverge from what the dashboard renders. Last 8 messages of each thread reach the model; older messages stay in the DB and remain visible in the UI. OpenAI client is lazy-instantiated (mirrors the `agent/loop.py::_generate_ai_summary` pattern) so a missing key returns 503 instead of crashing.

**Tech Stack:** aiosqlite, FastAPI, OpenAI SDK (`AsyncOpenAI`, `gpt-4o-mini`), React + TypeScript, `react-markdown` (new dep, ~30KB), Pytest with monkeypatched OpenAI client.

**Design doc:** `docs/plans/2026-04-26-analytics-chatbot-design.md`

**Pre-flight notes (from learnings.md):**
- Lazy-instantiate OpenAI client (factory + try/except). Missing key → graceful 503, not import-time crash.
- Partial unique indexes go in `_migrate` post-ALTER (not relevant here — no partial indexes — but follow the same `_migrate` placement pattern for the two new tables and the index).
- `aiosqlite.Row` + `dict(row)` everywhere; reuse `_row_to_dict` / `_rows_to_dicts` helpers.
- New child tables that FK-reference an existing table never need to be added to a `purge_*` cascade because conversations don't reference machines or users — only `staff_users`, which has no purge path. `chat_messages` cascades on `chat_conversations` via `ON DELETE CASCADE` (foreign keys are already enabled with `PRAGMA foreign_keys=ON` in `init_db`).

---

## Task 1: DB migration — `chat_conversations` + `chat_messages`

**Files:**
- Modify: `db/database.py` (`_create_tables`, `_migrate`)
- Test: `tests/test_chat_db.py` (new file)

**Step 1: Write the failing tests**

Create `tests/test_chat_db.py`:

```python
"""Tests for chat schema + DB helpers."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio


async def test_migration_creates_chat_conversations_table(db):
    cursor = await db.execute(
        "SELECT name FROM sqlite_master "
        "WHERE type='table' AND name='chat_conversations'"
    )
    assert await cursor.fetchone() is not None


async def test_migration_creates_chat_messages_table(db):
    cursor = await db.execute(
        "SELECT name FROM sqlite_master "
        "WHERE type='table' AND name='chat_messages'"
    )
    assert await cursor.fetchone() is not None


async def test_chat_messages_index_exists(db):
    cursor = await db.execute(
        "SELECT name FROM sqlite_master "
        "WHERE type='index' AND name='idx_chat_msgs_conv'"
    )
    assert await cursor.fetchone() is not None


async def test_chat_messages_role_check_constraint(db):
    # Need a staff_user_id and conversation_id to insert
    cursor = await db.execute("SELECT id FROM staff_users LIMIT 1")
    staff_id = (await cursor.fetchone())["id"]
    cursor = await db.execute(
        "INSERT INTO chat_conversations (staff_user_id) VALUES (?) RETURNING id",
        (staff_id,),
    )
    conv_id = (await cursor.fetchone())["id"]
    import aiosqlite
    with pytest.raises(aiosqlite.IntegrityError):
        await db.execute(
            "INSERT INTO chat_messages (conversation_id, role, content) "
            "VALUES (?, ?, ?)",
            (conv_id, "garbage_role", "x"),
        )


async def test_messages_cascade_when_conversation_deleted(db):
    cursor = await db.execute("SELECT id FROM staff_users LIMIT 1")
    staff_id = (await cursor.fetchone())["id"]
    cursor = await db.execute(
        "INSERT INTO chat_conversations (staff_user_id) VALUES (?) RETURNING id",
        (staff_id,),
    )
    conv_id = (await cursor.fetchone())["id"]
    await db.execute(
        "INSERT INTO chat_messages (conversation_id, role, content) "
        "VALUES (?, 'user', 'hi')",
        (conv_id,),
    )
    await db.commit()

    await db.execute("DELETE FROM chat_conversations WHERE id = ?", (conv_id,))
    await db.commit()

    cursor = await db.execute(
        "SELECT COUNT(*) AS cnt FROM chat_messages WHERE conversation_id = ?",
        (conv_id,),
    )
    assert (await cursor.fetchone())["cnt"] == 0
```

**Step 2: Run — verify they fail**

```
pytest tests/test_chat_db.py -v
```
Expected: 5 FAIL (tables missing).

**Step 3: Implement migration**

In `db/database.py`, add to `_create_tables` so fresh DBs include the tables directly:

```python
CREATE TABLE IF NOT EXISTS chat_conversations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_user_id INTEGER NOT NULL REFERENCES staff_users(id),
    title         TEXT    NOT NULL DEFAULT 'New chat',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    role            TEXT    NOT NULL CHECK (role IN ('user','assistant','system','tool')),
    content         TEXT    NOT NULL,
    tool_call_id    TEXT,
    tool_calls_json TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

In `_migrate` (post-existing migration blocks, before staff role block), add idempotent CREATE-IF-NOT-EXISTS for upgrades:

```python
# Chat tables (analytics chatbot) — additive on upgrade.
await db.execute(
    """
    CREATE TABLE IF NOT EXISTS chat_conversations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        staff_user_id INTEGER NOT NULL REFERENCES staff_users(id),
        title         TEXT    NOT NULL DEFAULT 'New chat',
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    )
    """
)
await db.execute(
    """
    CREATE TABLE IF NOT EXISTS chat_messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        role            TEXT    NOT NULL CHECK (role IN ('user','assistant','system','tool')),
        content         TEXT    NOT NULL,
        tool_call_id    TEXT,
        tool_calls_json TEXT,
        created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    )
    """
)
await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_chat_msgs_conv "
    "ON chat_messages(conversation_id, id)"
)
```

**Step 4: Run — expect PASS**

```
pytest tests/test_chat_db.py -v
pytest -v
```
All 138 existing + 5 new = 143 PASS.

**Step 5: Commit**

```
git add db/database.py tests/test_chat_db.py
git commit -m "feat(db): add chat_conversations + chat_messages tables for analytics chat"
```

---

## Task 2: DB helpers in `db/models.py`

**Files:**
- Modify: `db/models.py` (append a new "Chat" section at end)
- Test: `tests/test_chat_db.py`

**Step 1: Write the failing tests**

Append to `tests/test_chat_db.py`:

```python
async def test_create_conversation_returns_row_with_id(db):
    from db import models
    staff = (await models.list_staff())[0]
    conv = await models.create_conversation(
        staff_user_id=staff["id"], first_message="What was the busiest day?"
    )
    assert conv["id"] > 0
    assert conv["staff_user_id"] == staff["id"]
    assert conv["title"] == "What was the busiest day?"


async def test_create_conversation_truncates_long_title(db):
    from db import models
    staff = (await models.list_staff())[0]
    long_msg = "x" * 200
    conv = await models.create_conversation(
        staff_user_id=staff["id"], first_message=long_msg
    )
    assert len(conv["title"]) <= 60


async def test_append_message_persists_in_order(db):
    from db import models
    staff = (await models.list_staff())[0]
    conv = await models.create_conversation(
        staff_user_id=staff["id"], first_message="hi"
    )
    await models.append_message(conv["id"], role="user", content="first")
    await models.append_message(conv["id"], role="assistant", content="second")
    msgs = await models.get_conversation_messages(
        conv["id"], staff_user_id=staff["id"]
    )
    assert [m["content"] for m in msgs] == ["first", "second"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]


async def test_list_conversations_scoped_to_staff(db):
    from db import models
    from api.auth import hash_password

    a = (await models.list_staff())[0]
    await db.execute(
        "INSERT INTO staff_users (username, password_hash, role) VALUES (?, ?, ?)",
        ("eve", hash_password("pw"), "staff"),
    )
    await db.commit()
    b = await models.get_staff_by_username("eve")

    await models.create_conversation(staff_user_id=a["id"], first_message="A1")
    await models.create_conversation(staff_user_id=b["id"], first_message="B1")

    a_list = await models.list_conversations(a["id"])
    b_list = await models.list_conversations(b["id"])
    assert all(c["title"].startswith("A") for c in a_list)
    assert all(c["title"].startswith("B") for c in b_list)


async def test_get_conversation_returns_none_for_other_owner(db):
    from db import models
    from api.auth import hash_password

    a = (await models.list_staff())[0]
    await db.execute(
        "INSERT INTO staff_users (username, password_hash, role) VALUES (?, ?, ?)",
        ("eve", hash_password("pw"), "staff"),
    )
    await db.commit()
    b = await models.get_staff_by_username("eve")

    conv = await models.create_conversation(
        staff_user_id=a["id"], first_message="secret"
    )
    assert (
        await models.get_conversation_messages(conv["id"], staff_user_id=b["id"])
    ) is None


async def test_delete_conversation_only_for_owner(db):
    from db import models
    from api.auth import hash_password

    a = (await models.list_staff())[0]
    await db.execute(
        "INSERT INTO staff_users (username, password_hash, role) VALUES (?, ?, ?)",
        ("eve", hash_password("pw"), "staff"),
    )
    await db.commit()
    b = await models.get_staff_by_username("eve")

    conv = await models.create_conversation(
        staff_user_id=a["id"], first_message="x"
    )
    assert await models.delete_conversation(conv["id"], staff_user_id=b["id"]) is False
    assert await models.delete_conversation(conv["id"], staff_user_id=a["id"]) is True


async def test_get_recent_messages_caps_at_limit(db):
    from db import models
    staff = (await models.list_staff())[0]
    conv = await models.create_conversation(
        staff_user_id=staff["id"], first_message="x"
    )
    for i in range(10):
        await models.append_message(conv["id"], role="user", content=f"m{i}")
    recent = await models.get_recent_messages(conv["id"], limit=8)
    assert len(recent) == 8
    assert recent[0]["content"] == "m2"  # oldest of the last 8
    assert recent[-1]["content"] == "m9"
```

**Step 2: Run — verify fail**

```
pytest tests/test_chat_db.py -v
```
Expected: FAIL (functions don't exist).

**Step 3: Implement helpers**

Append to `db/models.py`:

```python
# ── Chat ─────────────────────────────────────────────────────────────────


async def create_conversation(
    *, staff_user_id: int, first_message: str
) -> dict[str, Any]:
    title = (first_message or "New chat").strip()[:60] or "New chat"
    db = await get_db()
    cursor = await db.execute(
        "INSERT INTO chat_conversations (staff_user_id, title) "
        "VALUES (?, ?) RETURNING *",
        (staff_user_id, title),
    )
    row = dict(await cursor.fetchone())
    await db.commit()
    return row


async def list_conversations(staff_user_id: int) -> list[dict[str, Any]]:
    db = await get_db()
    cursor = await db.execute(
        "SELECT id, title, created_at, updated_at "
        "FROM chat_conversations "
        "WHERE staff_user_id = ? "
        "ORDER BY updated_at DESC",
        (staff_user_id,),
    )
    return _rows_to_dicts(await cursor.fetchall())


async def get_conversation(
    conversation_id: int, *, staff_user_id: int
) -> dict[str, Any] | None:
    db = await get_db()
    cursor = await db.execute(
        "SELECT * FROM chat_conversations WHERE id = ? AND staff_user_id = ?",
        (conversation_id, staff_user_id),
    )
    return _row_to_dict(await cursor.fetchone())


async def get_conversation_messages(
    conversation_id: int, *, staff_user_id: int
) -> list[dict[str, Any]] | None:
    """Return all messages for a conversation owned by this staff user.

    Returns None when the conversation doesn't exist or isn't owned by the
    caller — keep this distinct from "exists but empty" so the API can 404.
    """
    if await get_conversation(
        conversation_id, staff_user_id=staff_user_id
    ) is None:
        return None
    db = await get_db()
    cursor = await db.execute(
        "SELECT * FROM chat_messages "
        "WHERE conversation_id = ? "
        "ORDER BY id ASC",
        (conversation_id,),
    )
    return _rows_to_dicts(await cursor.fetchall())


async def get_recent_messages(
    conversation_id: int, *, limit: int = 8
) -> list[dict[str, Any]]:
    """Most-recent ``limit`` messages, returned oldest-first."""
    db = await get_db()
    cursor = await db.execute(
        "SELECT * FROM chat_messages "
        "WHERE conversation_id = ? "
        "ORDER BY id DESC LIMIT ?",
        (conversation_id, limit),
    )
    rows = _rows_to_dicts(await cursor.fetchall())
    return list(reversed(rows))


async def append_message(
    conversation_id: int,
    *,
    role: str,
    content: str,
    tool_call_id: str | None = None,
    tool_calls_json: str | None = None,
) -> dict[str, Any]:
    db = await get_db()
    cursor = await db.execute(
        "INSERT INTO chat_messages "
        "(conversation_id, role, content, tool_call_id, tool_calls_json) "
        "VALUES (?, ?, ?, ?, ?) RETURNING *",
        (conversation_id, role, content, tool_call_id, tool_calls_json),
    )
    row = dict(await cursor.fetchone())
    await db.execute(
        "UPDATE chat_conversations SET updated_at = datetime('now') WHERE id = ?",
        (conversation_id,),
    )
    await db.commit()
    return row


async def delete_conversation(
    conversation_id: int, *, staff_user_id: int
) -> bool:
    db = await get_db()
    cursor = await db.execute(
        "DELETE FROM chat_conversations WHERE id = ? AND staff_user_id = ?",
        (conversation_id, staff_user_id),
    )
    await db.commit()
    return cursor.rowcount > 0
```

**Step 4: Run — expect PASS**

```
pytest tests/test_chat_db.py -v
pytest -v
```

**Step 5: Commit**

```
git add db/models.py tests/test_chat_db.py
git commit -m "feat(db): chat conversation + message helpers (per-staff scoped)"
```

---

## Task 3: Refactor analytics aggregation into a reusable helper

**Why:** The chat endpoint needs the same `AnalyticsResponse` payload the dashboard renders. Today the aggregation logic is split between `_date_range`, `_aggregate`, and the GET handlers. Extract a single `compute_analytics_response(period, start_date, end_date, machine_id=None)` function so chat and the existing GET share one implementation.

**Files:**
- Modify: `api/routes/analytics.py`
- Test: existing tests should still pass; no new tests needed (this is a pure refactor).

**Step 1: Add the helper above the routes**

```python
async def compute_analytics_response(
    period: str | None,
    start_date: str | None,
    end_date: str | None,
    machine_id: int | None = None,
) -> dict[str, Any]:
    p, sd, ed = _date_range(period, start_date, end_date)
    rows = await models.get_analytics_snapshots(
        start_date=sd, end_date=ed, machine_id=machine_id
    )
    agg = _aggregate(rows)
    return {"period": p, "start_date": sd, "end_date": ed, **agg}
```

**Step 2: Replace handler bodies**

```python
@router.get("/{machine_id}", response_model=AnalyticsResponse)
async def get_machine_analytics(
    machine_id: int,
    period: str | None = "day",
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict:
    return await compute_analytics_response(period, start_date, end_date, machine_id)


@router.get("/", response_model=AnalyticsResponse)
async def get_analytics(
    period: str | None = "day",
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict:
    return await compute_analytics_response(period, start_date, end_date)
```

**Step 3: Run — expect PASS**

```
pytest -v
```
No regressions.

**Step 4: Commit**

```
git add api/routes/analytics.py
git commit -m "refactor(analytics): extract compute_analytics_response helper"
```

---

## Task 4: Chat router — POST /chat (mocked OpenAI)

**Files:**
- Create: `api/routes/chat.py`
- Modify: `api/main.py` (register router)
- Modify: `config.py` (add `openai_chat_model` and `openai_chat_history_limit` constants if you want them tunable; otherwise hard-code)
- Test: `tests/test_chat_api.py` (new)

**Step 1: Write failing tests**

Create `tests/test_chat_api.py`:

```python
"""POST /api/analytics/chat with a mocked OpenAI client."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from api.auth import hash_password
from api.main import app
from config import settings as cfg

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def client(db) -> AsyncClient:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


async def _admin_headers(client):
    r = await client.post(
        "/api/auth/login",
        json={"username": cfg.staff_username, "password": cfg.staff_password},
    )
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture
def mock_openai(monkeypatch):
    """Replace _make_openai_client with a stub returning a canned reply."""
    captured: dict = {}

    def _fake_client_factory():
        client_obj = MagicMock()
        async def _create(**kwargs):
            captured["call"] = kwargs
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(
                            content="Mock answer.", tool_calls=None,
                        )
                    )
                ]
            )
        client_obj.chat.completions.create = _create
        return client_obj

    from api.routes import chat as chat_mod
    monkeypatch.setattr(chat_mod, "_make_openai_client", _fake_client_factory)
    return captured


async def test_post_chat_creates_conversation_and_returns_reply(
    client, db, mock_openai
):
    h = await _admin_headers(client)
    r = await client.post(
        "/api/analytics/chat",
        headers=h,
        json={"message": "Summarize this period.", "period": "week"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["conversation_id"] > 0
    assert body["message"]["role"] == "assistant"
    assert body["message"]["content"] == "Mock answer."


async def test_post_chat_persists_user_and_assistant_messages(
    client, db, mock_openai
):
    h = await _admin_headers(client)
    r = await client.post(
        "/api/analytics/chat",
        headers=h,
        json={"message": "What was the busiest day?"},
    )
    cid = r.json()["conversation_id"]
    full = await client.get(
        f"/api/analytics/chat/conversations/{cid}", headers=h
    )
    msgs = full.json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    assert msgs[0]["content"] == "What was the busiest day?"
    assert msgs[1]["content"] == "Mock answer."


async def test_post_chat_appends_to_existing_conversation(
    client, db, mock_openai
):
    h = await _admin_headers(client)
    r = await client.post(
        "/api/analytics/chat", headers=h, json={"message": "first"}
    )
    cid = r.json()["conversation_id"]
    await client.post(
        "/api/analytics/chat",
        headers=h,
        json={"conversation_id": cid, "message": "second"},
    )
    full = await client.get(
        f"/api/analytics/chat/conversations/{cid}", headers=h
    )
    contents = [m["content"] for m in full.json()["messages"]]
    assert contents == ["first", "Mock answer.", "second", "Mock answer."]


async def test_post_chat_caps_history_at_8(client, db, mock_openai):
    h = await _admin_headers(client)
    r = await client.post(
        "/api/analytics/chat", headers=h, json={"message": "m1"}
    )
    cid = r.json()["conversation_id"]
    for i in range(2, 11):
        await client.post(
            "/api/analytics/chat",
            headers=h,
            json={"conversation_id": cid, "message": f"m{i}"},
        )
    sent_messages = mock_openai["call"]["messages"]
    # system + last 8 of (user, assistant) pairs + new user
    # We assert: at most 1 system + 8 history + 1 latest user = 10
    assert len(sent_messages) <= 10
    # And the OLDEST user content reaching the model is NOT "m1"
    user_contents = [
        m["content"] for m in sent_messages if m["role"] == "user"
    ]
    assert "m1" not in user_contents


async def test_post_chat_includes_analytics_in_system_prompt(
    client, db, mock_openai
):
    h = await _admin_headers(client)
    await client.post(
        "/api/analytics/chat",
        headers=h,
        json={"message": "anything", "period": "week"},
    )
    sys_msg = mock_openai["call"]["messages"][0]
    assert sys_msg["role"] == "system"
    assert "period: week" in sys_msg["content"]
    assert "data:" in sys_msg["content"]


async def test_post_chat_requires_staff(client, db):
    r = await client.post(
        "/api/analytics/chat", json={"message": "hi"}
    )
    assert r.status_code == 401


async def test_post_chat_rejects_empty_message(client, db, mock_openai):
    h = await _admin_headers(client)
    r = await client.post(
        "/api/analytics/chat", headers=h, json={"message": "   "}
    )
    assert r.status_code == 400


async def test_post_chat_503_when_openai_key_missing(client, db, monkeypatch):
    from api.routes import chat as chat_mod
    monkeypatch.setattr(chat_mod, "_make_openai_client", lambda: None)
    h = await _admin_headers(client)
    r = await client.post(
        "/api/analytics/chat", headers=h, json={"message": "hi"}
    )
    assert r.status_code == 503
```

**Step 2: Run — verify fail**

```
pytest tests/test_chat_api.py -v
```
Expected: FAIL (router doesn't exist).

**Step 3: Implement the router**

Create `api/routes/chat.py`:

```python
"""Analytics chatbot — multi-turn conversations grounded in analytics data."""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.auth import require_staff
from api.routes.analytics import compute_analytics_response
from db import models

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/analytics/chat",
    tags=["analytics-chat"],
    dependencies=[Depends(require_staff)],
)

CHAT_MODEL = "gpt-4o-mini"
HISTORY_LIMIT = 8

SYSTEM_PROMPT_TEMPLATE = """\
You are an analytics assistant for the SCD makerspace queue system at the
University of Illinois. Staff use this dashboard to monitor queue health.

GROUND RULES
- Answer ONLY using the analytics data shown below.
- If the user asks about a metric or time window the data doesn't cover,
  say so plainly and suggest changing the period or date range.
- Never invent numbers. Round to 1 decimal where helpful.
- Be terse. 1–3 sentences for short questions, a short list for comparisons.
- Refer to machines by name (e.g. "Laser Cutter"), not by id.

CURRENT DASHBOARD CONTEXT
period: {period}
range:  {start_date} → {end_date}
data:   {analytics_json}
"""


def _make_openai_client():
    """Lazy factory — returns None if the key is missing or the dep isn't installed."""
    try:
        from openai import AsyncOpenAI
        from config import settings
    except Exception:
        return None
    key = getattr(settings, "openai_api_key", None) or None
    if not key:
        return None
    return AsyncOpenAI(api_key=key)


# ── Schemas ──────────────────────────────────────────────────────────────


class ChatMessageOut(BaseModel):
    id: int
    conversation_id: int
    role: str
    content: str
    created_at: str


class ConversationSummaryOut(BaseModel):
    id: int
    title: str
    created_at: str
    updated_at: str


class ConversationDetailOut(BaseModel):
    id: int
    title: str
    messages: list[ChatMessageOut]


class ChatRequest(BaseModel):
    conversation_id: int | None = None
    message: str = Field(min_length=1, max_length=4000)
    period: str | None = None
    start_date: str | None = None
    end_date: str | None = None


class ChatResponse(BaseModel):
    conversation_id: int
    message: ChatMessageOut


# ── Helpers ──────────────────────────────────────────────────────────────


def _trim_analytics_for_tokens(blob: dict[str, Any]) -> dict[str, Any]:
    """Best-effort drop of optional fields if the blob is large.

    For now we serialize the full blob; if the encoded size exceeds ~12k chars
    we drop daily_breakdown, then per-machine ai_summary. We use a char budget
    instead of an exact tokenizer to avoid pulling tiktoken in.
    """
    LIMIT = 12_000  # ~3k tokens — generous for 12k input cap
    encoded = json.dumps(blob)
    if len(encoded) <= LIMIT:
        return blob
    trimmed = {**blob, "daily_breakdown": []}
    if len(json.dumps(trimmed)) <= LIMIT:
        return trimmed
    machines = [{**m, "ai_summary": None} for m in trimmed.get("machines", [])]
    trimmed["machines"] = machines
    if len(json.dumps(trimmed)) <= LIMIT:
        return trimmed
    raise HTTPException(
        status_code=413,
        detail="This period is too large to chat about — narrow the range.",
    )


# ── Routes ───────────────────────────────────────────────────────────────


@router.post("", response_model=ChatResponse)
async def chat(
    body: ChatRequest, payload: dict[str, Any] = Depends(require_staff)
) -> dict:
    user_message = body.message.strip()
    if not user_message:
        raise HTTPException(status_code=400, detail="message must be non-empty")

    client = _make_openai_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Chat is not configured")

    staff_id = payload["sub"]

    # Resolve / create conversation
    if body.conversation_id is not None:
        conv = await models.get_conversation(
            body.conversation_id, staff_user_id=staff_id
        )
        if conv is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        conversation_id = conv["id"]
    else:
        conv = await models.create_conversation(
            staff_user_id=staff_id, first_message=user_message
        )
        conversation_id = conv["id"]

    # Persist user message before calling the model so we don't lose it on failure
    await models.append_message(
        conversation_id, role="user", content=user_message
    )

    # Pull analytics + build prompt
    analytics_blob = await compute_analytics_response(
        body.period, body.start_date, body.end_date
    )
    analytics_blob = _trim_analytics_for_tokens(analytics_blob)
    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(
        period=analytics_blob["period"],
        start_date=analytics_blob["start_date"],
        end_date=analytics_blob["end_date"],
        analytics_json=json.dumps(analytics_blob),
    )

    history = await models.get_recent_messages(
        conversation_id, limit=HISTORY_LIMIT
    )
    openai_messages = [{"role": "system", "content": system_prompt}]
    for m in history:
        if m["role"] in {"user", "assistant"}:
            openai_messages.append({"role": m["role"], "content": m["content"]})

    # Call model
    try:
        response = await client.chat.completions.create(
            model=CHAT_MODEL,
            messages=openai_messages,
            max_tokens=600,
            temperature=0.2,
        )
    except Exception as e:
        log.exception("OpenAI chat failure")
        raise HTTPException(status_code=502, detail=f"Upstream model error: {e}")

    content = (response.choices[0].message.content or "").strip()
    if not content:
        content = "(no response)"
    saved = await models.append_message(
        conversation_id, role="assistant", content=content
    )
    return {
        "conversation_id": conversation_id,
        "message": {
            "id": saved["id"],
            "conversation_id": conversation_id,
            "role": saved["role"],
            "content": saved["content"],
            "created_at": saved["created_at"],
        },
    }


@router.get("/conversations", response_model=list[ConversationSummaryOut])
async def list_my_conversations(
    payload: dict[str, Any] = Depends(require_staff),
) -> list[dict]:
    return await models.list_conversations(payload["sub"])


@router.get(
    "/conversations/{conversation_id}", response_model=ConversationDetailOut
)
async def get_conversation_thread(
    conversation_id: int,
    payload: dict[str, Any] = Depends(require_staff),
) -> dict:
    conv = await models.get_conversation(
        conversation_id, staff_user_id=payload["sub"]
    )
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    msgs = await models.get_conversation_messages(
        conversation_id, staff_user_id=payload["sub"]
    )
    assert msgs is not None
    return {
        "id": conv["id"],
        "title": conv["title"],
        "messages": [
            {
                "id": m["id"],
                "conversation_id": m["conversation_id"],
                "role": m["role"],
                "content": m["content"],
                "created_at": m["created_at"],
            }
            for m in msgs
        ],
    }


@router.delete("/conversations/{conversation_id}")
async def delete_conversation_route(
    conversation_id: int,
    payload: dict[str, Any] = Depends(require_staff),
) -> dict:
    ok = await models.delete_conversation(
        conversation_id, staff_user_id=payload["sub"]
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"status": "deleted"}
```

In `api/main.py`:

```python
from api.routes.chat import router as chat_router
...
app.include_router(chat_router)
```

**Step 4: Run — expect PASS**

```
pytest tests/test_chat_api.py -v
pytest -v
```

**Step 5: Commit**

```
git add api/routes/chat.py api/main.py tests/test_chat_api.py
git commit -m "feat(api): /api/analytics/chat — multi-turn analytics chatbot"
```

---

## Task 5: Cross-user isolation + delete tests

**Files:**
- Modify: `tests/test_chat_api.py`

**Step 1: Add tests for the GET/DELETE routes**

```python
async def test_list_conversations_only_returns_own(client, db, mock_openai):
    h_admin = await _admin_headers(client)
    # admin posts a chat → creates a conversation
    await client.post(
        "/api/analytics/chat", headers=h_admin, json={"message": "admin q"}
    )

    # second staff user
    await db.execute(
        "INSERT INTO staff_users (username, password_hash, role) VALUES (?, ?, ?)",
        ("eve", hash_password("pw"), "staff"),
    )
    await db.commit()
    r = await client.post(
        "/api/auth/login", json={"username": "eve", "password": "pw"}
    )
    h_eve = {"Authorization": f"Bearer {r.json()['token']}"}

    eve_list = await client.get(
        "/api/analytics/chat/conversations", headers=h_eve
    )
    assert eve_list.status_code == 200
    assert eve_list.json() == []


async def test_get_conversation_404_for_other_owner(client, db, mock_openai):
    h_admin = await _admin_headers(client)
    r = await client.post(
        "/api/analytics/chat", headers=h_admin, json={"message": "secret"}
    )
    cid = r.json()["conversation_id"]

    await db.execute(
        "INSERT INTO staff_users (username, password_hash, role) VALUES (?, ?, ?)",
        ("eve", hash_password("pw"), "staff"),
    )
    await db.commit()
    login = await client.post(
        "/api/auth/login", json={"username": "eve", "password": "pw"}
    )
    h_eve = {"Authorization": f"Bearer {login.json()['token']}"}

    r = await client.get(
        f"/api/analytics/chat/conversations/{cid}", headers=h_eve
    )
    assert r.status_code == 404


async def test_delete_conversation_owner_succeeds(client, db, mock_openai):
    h = await _admin_headers(client)
    r = await client.post(
        "/api/analytics/chat", headers=h, json={"message": "delete me"}
    )
    cid = r.json()["conversation_id"]
    r = await client.delete(
        f"/api/analytics/chat/conversations/{cid}", headers=h
    )
    assert r.status_code == 200
    r = await client.get(
        f"/api/analytics/chat/conversations/{cid}", headers=h
    )
    assert r.status_code == 404


async def test_delete_conversation_404_for_other_owner(client, db, mock_openai):
    h_admin = await _admin_headers(client)
    r = await client.post(
        "/api/analytics/chat", headers=h_admin, json={"message": "x"}
    )
    cid = r.json()["conversation_id"]

    await db.execute(
        "INSERT INTO staff_users (username, password_hash, role) VALUES (?, ?, ?)",
        ("eve", hash_password("pw"), "staff"),
    )
    await db.commit()
    login = await client.post(
        "/api/auth/login", json={"username": "eve", "password": "pw"}
    )
    h_eve = {"Authorization": f"Bearer {login.json()['token']}"}

    r = await client.delete(
        f"/api/analytics/chat/conversations/{cid}", headers=h_eve
    )
    assert r.status_code == 404
```

**Step 2: Run — expect PASS**

```
pytest tests/test_chat_api.py -v
```

**Step 3: Commit**

```
git add tests/test_chat_api.py
git commit -m "test(chat): cross-user isolation + delete ownership"
```

---

## Task 6: Frontend — types + API client

**Files:**
- Modify: `web/src/api/types.ts`
- Modify: `web/src/api/client.ts`

**Step 1: Types**

Append to `web/src/api/types.ts`:

```ts
export interface ChatMessage {
  id: number;
  conversation_id: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  created_at: string;
}

export interface ChatConversationSummary {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChatConversationDetail {
  id: number;
  title: string;
  messages: ChatMessage[];
}

export interface ChatPostRequest {
  conversation_id?: number;
  message: string;
  period?: AnalyticsPeriod;
  start_date?: string;
  end_date?: string;
}

export interface ChatPostResponse {
  conversation_id: number;
  message: ChatMessage;
}
```

**Step 2: Client functions**

Append to `web/src/api/client.ts`:

```ts
import type {
  ChatConversationDetail,
  ChatConversationSummary,
  ChatPostRequest,
  ChatPostResponse,
} from "./types";

export const postChat = (body: ChatPostRequest) =>
  request<ChatPostResponse>("/analytics/chat", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const listChatConversations = () =>
  request<ChatConversationSummary[]>("/analytics/chat/conversations");

export const getChatConversation = (id: number) =>
  request<ChatConversationDetail>(`/analytics/chat/conversations/${id}`);

export const deleteChatConversation = (id: number) =>
  request<{ status: string }>(`/analytics/chat/conversations/${id}`, {
    method: "DELETE",
  });
```

**Step 3: Tsc**

```
cd web && npx tsc --noEmit
```

**Step 4: Commit**

```
git add web/src/api/types.ts web/src/api/client.ts
git commit -m "feat(web): chat types + analytics chat API client"
```

---

## Task 7: Frontend — `AnalyticsChat` panel

**Files:**
- Create: `web/src/components/analytics/AnalyticsChat.tsx`
- Modify: `web/src/pages/Analytics.tsx` (mount the panel; pass current `period`)
- Modify: `web/package.json` (add `react-markdown`)

**Step 1: Add the dependency**

```
cd web && npm install react-markdown
```

**Step 2: Implement the panel**

Create `web/src/components/analytics/AnalyticsChat.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  deleteChatConversation,
  getChatConversation,
  listChatConversations,
  postChat,
} from "../../api/client";
import type {
  AnalyticsPeriod,
  ChatConversationDetail,
  ChatConversationSummary,
  ChatMessage,
} from "../../api/types";

interface Props {
  period: AnalyticsPeriod;
}

const SUGGESTIONS = [
  "Summarize this period",
  "Which machine had the most no-shows?",
  "Compare the two busiest days",
];

export function AnalyticsChat({ period }: Props) {
  const [open, setOpen] = useState(false);
  const [convs, setConvs] = useState<ChatConversationSummary[]>([]);
  const [active, setActive] = useState<ChatConversationDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function refreshList() {
    try {
      setConvs(await listChatConversations());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (open) refreshList();
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [active?.messages.length]);

  async function openConv(id: number) {
    setActive(await getChatConversation(id));
    setShowList(false);
  }

  function newConv() {
    setActive({ id: 0, title: "New chat", messages: [] });
    setShowList(false);
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);

    // Optimistic user bubble
    const optimistic: ChatMessage = {
      id: -Date.now(),
      conversation_id: active?.id ?? 0,
      role: "user",
      content: message,
      created_at: new Date().toISOString(),
    };
    setActive((prev) =>
      prev
        ? { ...prev, messages: [...prev.messages, optimistic] }
        : { id: 0, title: message.slice(0, 60), messages: [optimistic] }
    );
    setDraft("");

    try {
      const res = await postChat({
        conversation_id: active?.id || undefined,
        message,
        period,
      });
      // Re-fetch the full thread so optimistic id is replaced
      const thread = await getChatConversation(res.conversation_id);
      setActive(thread);
      await refreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Roll back optimistic message
      setActive((prev) =>
        prev
          ? {
              ...prev,
              messages: prev.messages.filter((m) => m.id !== optimistic.id),
            }
          : null
      );
    } finally {
      setSending(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this conversation?")) return;
    await deleteChatConversation(id);
    if (active?.id === id) setActive(null);
    await refreshList();
  }

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-40 rounded-full bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-lg hover:bg-indigo-700"
        >
          💬 Ask the data
        </button>
      )}

      {open && (
        <div
          className="fixed bottom-6 right-6 z-40 flex h-[560px] w-[380px] flex-col rounded-2xl border border-gray-200 bg-white shadow-2xl"
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-gray-900">
                Analytics chat
              </div>
              <div className="text-xs text-gray-500">
                Scoped to: {period}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setShowList((v) => !v)}
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                title="Conversations"
              >
                ☰
              </button>
              <button
                onClick={newConv}
                className="rounded bg-indigo-600 px-2 py-1 text-xs text-white hover:bg-indigo-700"
              >
                + New
              </button>
              <button
                onClick={() => setOpen(false)}
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
              >
                ✕
              </button>
            </div>
          </div>

          {showList && (
            <div className="max-h-40 overflow-y-auto border-b border-gray-100 bg-gray-50 px-2 py-1">
              {convs.length === 0 && (
                <div className="px-2 py-2 text-xs text-gray-500">
                  No conversations yet.
                </div>
              )}
              {convs.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between rounded px-2 py-1 text-sm hover:bg-white"
                >
                  <button
                    className="flex-1 truncate text-left text-gray-800"
                    onClick={() => openConv(c.id)}
                  >
                    {c.title}
                  </button>
                  <button
                    onClick={() => handleDelete(c.id)}
                    className="ml-2 text-xs text-red-600 hover:underline"
                  >
                    delete
                  </button>
                </div>
              ))}
            </div>
          )}

          <div
            ref={scrollRef}
            className="flex-1 space-y-3 overflow-y-auto px-3 py-3"
          >
            {(!active || active.messages.length === 0) && (
              <div className="space-y-2">
                <p className="text-sm text-gray-600">
                  Ask anything about the analytics on this page.
                </p>
                <div className="flex flex-wrap gap-1">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => setDraft(s)}
                      className="rounded-full border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {active?.messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${
                  m.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    m.role === "user"
                      ? "bg-indigo-600 text-white"
                      : "bg-gray-100 text-gray-900"
                  }`}
                >
                  {m.role === "user" ? (
                    m.content
                  ) : (
                    <ReactMarkdown>{m.content}</ReactMarkdown>
                  )}
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-500">
                  ···
                </div>
              </div>
            )}
            {error && (
              <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </div>
            )}
          </div>

          <div className="border-t border-gray-100 p-2">
            <div className="flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(draft);
                  }
                }}
                placeholder="Ask a question…"
                disabled={sending}
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
              />
              <button
                onClick={() => send(draft)}
                disabled={sending || !draft.trim()}
                className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:bg-indigo-300"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
```

**Step 3: Mount in `Analytics.tsx`**

Add an import and render at the bottom of the page wrapper:

```tsx
import { AnalyticsChat } from "../components/analytics/AnalyticsChat";
...
return (
  <div className="space-y-6">
    {/* existing content */}
    <AnalyticsChat period={period} />
  </div>
);
```

**Step 4: Tsc + manual smoke**

```
cd web && npx tsc --noEmit
```

Then run frontend (`npm run dev`) and backend (`python main.py`) and:
1. Log in as admin.
2. Navigate to `/admin/analytics`.
3. Click "Ask the data" → ask "summarize this period".
4. Verify reply, switch period to Month, ask follow-up.
5. Reload, click ☰, verify both conversations appear, open one, verify history.
6. Delete a conversation, verify it disappears.

**Step 5: Commit**

```
git add web/src/components/analytics/AnalyticsChat.tsx web/src/pages/Analytics.tsx web/package.json web/package-lock.json
git commit -m "feat(web): floating analytics chat panel with persisted conversations"
```

---

## Task 8: Regression + docs

**Step 1: Full test sweep**

```
pytest -v
cd web && npx tsc --noEmit
```
Expect all green.

**Step 2: Update docs**

- Append a `### 2026-04-26 — Analytics Chatbot` block to **Completed Work** in `CLAUDE.md`.
- Append a section to `short_term_memory.md` summarizing what was built.
- Capture any new gotcha in `learnings.md` (e.g. anything tricky about FK + `ON DELETE CASCADE` requiring `PRAGMA foreign_keys=ON`, which is already set in `init_db`).

**Step 3: Commit**

```
git add CLAUDE.md short_term_memory.md learnings.md
git commit -m "docs: record analytics chatbot completion"
```

---

## Out of scope (explicit)

- Streaming responses.
- OpenAI tool/function calling — the schema scaffold is there (`tool_call_id`, `tool_calls_json`); v2 will populate it.
- Cross-user / admin override conversation visibility.
- Conversation export.
- Auto-summarizing turns that fall out of the 8-message window.

## Rollback

Each task is one commit. The two new tables + the index are additive and FK to `staff_users`, which has no purge path — reverting any chat commit leaves the rest of the app fully functional. The frontend panel is gated behind staff auth and only mounts on `/admin/analytics`, so reverting just hides the entry point.
