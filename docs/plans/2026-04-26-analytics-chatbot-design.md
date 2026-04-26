# Analytics Chatbot — Design

**Date:** 2026-04-26
**Status:** Design approved; implementation plan to follow.

## Problem

Staff want to ask questions of the analytics dashboard in natural language ("which machine had the most no-shows last week?", "summarize this period"). Today they have to read the cards and infer.

## Decisions (from brainstorm)

- **Scope:** Hybrid — narrative explainer first, parameterized tool calls layered on later. No free-form SQL ever.
- **Model:** OpenAI `gpt-4o-mini`, lazy-instantiated `AsyncOpenAI` (same factory pattern as `agent/loop.py::_generate_ai_summary` so a missing key degrades gracefully).
- **Persistence:** Multi-turn conversations stored in SQLite, scoped per `staff_user_id`. No cross-user visibility.
- **Context window:** the **last 8 messages** of a conversation reach the model on each turn. Older messages stay in the DB and remain visible in the UI but are dropped from the model's view. New conversations are how staff "reset" context.

## Data model

Two new tables added in `_migrate`:

```sql
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

CREATE INDEX IF NOT EXISTS idx_chat_msgs_conv
    ON chat_messages(conversation_id, id);
```

`tool_call_id` and `tool_calls_json` are scaffolding for the v2 tool-use phase so we don't need a second migration when we add tools.

## API

All routes under `/api/analytics/chat`, gated by the existing `Depends(require_staff)`:

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/chat` | `{conversation_id?, message, period?, start_date?, end_date?}` | `{conversation_id, message: AssistantMsg}` |
| GET | `/chat/conversations` | — | `[{id, title, updated_at}]` (own only) |
| GET | `/chat/conversations/{id}` | — | `{id, title, messages: [...]}` |
| DELETE | `/chat/conversations/{id}` | — | `{status: "deleted"}` |

POST flow:

1. If no `conversation_id`, insert a new `chat_conversations` row owned by the caller. Title = first 60 chars of the user message (trimmed).
2. Append the user message to `chat_messages`.
3. Load the **last 8 messages** for this conversation, oldest first.
4. Pull the analytics blob via the existing `_compute_analytics_response(period, start_date, end_date)` helper from `analytics.py` so chat answers cannot diverge from what the dashboard renders.
5. Build the OpenAI request: `[system_prompt + analytics_json] + history + [user_message]`. Call `gpt-4o-mini`.
6. Persist the assistant reply, bump `updated_at`, return.

Ownership: every read/delete filters `WHERE staff_user_id = current_user.id`. Mismatch → 404 (don't leak existence).

Errors:
- Missing `OPENAI_API_KEY` → 503 `"Chat is not configured"`.
- OpenAI API failure → 502 with sanitized message.
- Empty `message` after strip → 400.
- Oversized period (analytics blob alone > 12k tokens) → 413 `"This period is too large to chat about — narrow the range."`

## System prompt

```
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
```

Token budget: ~12k input cap. If the analytics JSON is too large, drop in this order:
1. `daily_breakdown`
2. per-machine `ai_summary` strings
3. last-resort: 413 to the client.

## Frontend

A floating chat panel rendered only on `/admin/analytics`:

- Bottom-right "Ask the data" pill button. Click to slide up a 380×560 panel; click again or X to dismiss. `Esc` closes, `Enter` sends.
- Top of panel: collapsible conversation list ("+ New", click row to open, hover to delete). List comes from `GET /chat/conversations`.
- Main thread: scrollable message log (user right, assistant left), `react-markdown` for assistant content. Composer at the bottom: textarea + Send. While in flight: composer disabled and a three-dot pulse where the assistant message will land.
- Header strip: `Scoped to: <period label>` so the user knows which range answers apply to. The panel reads `period`/`start_date`/`end_date` from the analytics page state and includes them in every POST.
- Empty state (no conversations): three suggested prompts as chips that pre-fill the composer.
- React state holds only `open`/`closed` and the in-flight composer text. The server owns messages; reload re-fetches.

## Auth + scope

- All four routes wrapped by `Depends(require_staff)`.
- Conversations and messages are scoped per `staff_user_id`. No admin override yet (YAGNI).
- The frontend panel is rendered only when `useAuth().role` is set (already true on `/admin/*`).

## Testing

Backend:
- Migration: both tables exist; `chat_messages` has the FK + index; rerun is idempotent.
- DB helpers: round-trip + ownership-mismatch returns None.
- POST /chat (mocked OpenAI): conversation row created, both messages persisted, title derived from first user message, response shape matches.
- Multi-turn: 9 messages — assert only the last 8 reach the model.
- Period passthrough: `period=week` — assert system prompt seen by mock contains the weekly range and JSON.
- Cross-user isolation: staff A's conversation 404s for staff B (not 403).
- Auth: 401 without token, 403 with non-staff.
- Missing key: 503 with the documented message.
- Oversized period: 413.

Frontend:
- `tsc --noEmit` clean.
- Manual smoke: open panel → ask "summarize this period" → switch period → ask follow-up → reload → list shows the conversation → delete → gone.

## Out of scope (explicit)

- Streaming responses.
- Tool/function calling (deferred to v2).
- Cross-user conversation visibility (admin override).
- Conversation export.
- Auto-summarizing dropped turns.
