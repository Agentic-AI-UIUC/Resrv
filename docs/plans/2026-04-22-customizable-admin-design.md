# Customizable Admin (Machines, Staff, Settings) — Design

**Date:** 2026-04-22
**Author:** ashleyn4
**Status:** Approved (brainstorm), pending implementation plan

## Goal

Let staff fully customize the system from the web panel — add/archive/purge machines, manage staff accounts with role-based access, and tune runtime settings — without editing code or restarting the process.

## Scope

In scope:

- **Machines** — add, edit, soft-archive, restore, hard-delete with confirmation
- **Staff users** — two-tier roles (`admin`, `staff`); admin-only management
- **System settings** — runtime knobs (`reminder_minutes`, `grace_minutes`, `queue_reset_hour`, `agent_tick_seconds`) and feature toggles (`public_mode`, `maintenance_banner`)
- **Discord embed lifecycle** — automatic create/update/delete as machines change

Out of scope (explicitly):

- Per-machine access control (public/private at machine level — the user-level split already covers this)
- Editing secrets (Discord token, OpenAI key, Resend key) or channel IDs from the UI — these stay in `.env`
- Full RBAC beyond two tiers
- Hard-delete of staff users' historical actions

## Non-goals / Constraints

- Maintain the working state at each rollout step — no big-bang migration.
- Protect analytics history by default; hard-delete is an opt-in escape hatch.
- Prevent admin lockout — the last admin can't be deleted or demoted.
- Keep stdlib-only for auth; no new Python deps unless strictly required.

## Data Model Changes

### `machines` — add one column

```sql
ALTER TABLE machines ADD COLUMN archived_at TEXT;
```

`archived_at IS NULL` means active. Unique constraint on `slug` remains; a new active machine may reuse the slug of an archived one (archived rows act as history only).

### `staff_users` — add one column

```sql
ALTER TABLE staff_users ADD COLUMN role TEXT NOT NULL DEFAULT 'staff';
UPDATE staff_users SET role = 'admin' WHERE id = (SELECT MIN(id) FROM staff_users);
```

First seeded account becomes the initial admin. Role is `'admin'` or `'staff'`. Last-admin guard enforced in code, not schema.

### `settings` — new table

```sql
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Seeded on first run from current `config.py` defaults. At startup, runtime knobs read from this table; `.env` values only apply when a row is missing. Secrets and bootstrap credentials (`DISCORD_TOKEN`, `AUTH_SECRET`, etc.) stay in `.env`.

## API Surface

All new endpoints are staff-gated. Admin-only endpoints additionally require `role == 'admin'` via a new `require_admin` dependency.

### Machines (staff; admin for destructive ops)

| Method | Path | Role | Notes |
|---|---|---|---|
| `GET` | `/api/machines/` | staff | `?include_archived=true` returns archived too |
| `POST` | `/api/machines/` | staff | `{name, slug}`; slug must be lowercase alnum + hyphens, unique among active |
| `PATCH` | `/api/machines/{id}` | staff | `{name?, slug?, status?}` |
| `DELETE` | `/api/machines/{id}` | admin | Soft-archive; 409 if active queue entries exist |
| `DELETE` | `/api/machines/{id}?purge=true` | admin | Hard-delete; requires `{confirm_slug}` in body |
| `POST` | `/api/machines/{id}/restore` | admin | Clears `archived_at`; 409 if slug now conflicts |

### Staff accounts (admin-only)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/staff/` | List all |
| `POST` | `/api/staff/` | `{username, password, role}` |
| `PATCH` | `/api/staff/{id}` | `{role?, password?}`; last-admin guard |
| `DELETE` | `/api/staff/{id}` | Last-admin guard |

### Settings (admin-only)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/settings/` | Returns flat object of all settings |
| `PATCH` | `/api/settings/` | Partial update; unknown keys rejected |

## Archive & Hard-Delete Semantics

### Soft-archive (default)

- Sets `archived_at = datetime('now')`.
- Deletes Discord embed via bridge; nulls out `embed_message_id`.
- Hides machine from default queue views, join buttons, and analytics filter default.
- Preserves all `queue_entries` and `analytics_snapshots`.

### Hard-delete (admin escape hatch)

- `DELETE /api/machines/{id}?purge=true` with `{"confirm_slug": "<exact-slug>"}` in body.
- Cascade-deletes `queue_entries` and `analytics_snapshots` for the machine, then the machine row.
- Deletes Discord embed.
- Structured warning log with username + machine name + purged row counts.
- UI requires retyping the slug inside a red destructive-styled modal; modal displays the count of history rows about to be destroyed.

### Blocks (both archive and purge)

- Active (`waiting` | `serving`) queue entries → 409 "Clear the queue first. N users still waiting."

### Last-admin protection

- Cannot delete the only admin.
- Cannot demote the only admin to `staff`.

## Discord Embed Lifecycle

### `api/deps.py` additions

Mirror the existing `notify_embed_update` pattern:

- `notify_embed_create(machine_id)` — schedules `bot.create_queue_embed(machine_id)` on the bot loop via `run_coroutine_threadsafe`.
- `notify_embed_delete(machine_id, message_id)` — schedules `bot.delete_queue_embed(message_id)`.

### Bot methods (new, `bot/bot.py`)

- `create_queue_embed(machine_id)` — posts button-embed to the queue channel, saves `embed_message_id` to DB, registers the persistent view. Idempotent: if an embed already exists, update in place.
- `delete_queue_embed(message_id)` — fetch and delete; tolerate 404.
- Reconciliation pass (on `on_ready`) ensures every active machine has an embed and no archived machine does. Extends the existing "Reused embed" logic.

### Wiring

- `POST /api/machines/` → insert → `notify_embed_create`.
- `PATCH /api/machines/{id}` → update → `notify_embed_update` (existing).
- `DELETE /api/machines/{id}` → archive → `notify_embed_delete` → null `embed_message_id`.
- `DELETE ...?purge=true` → purge → `notify_embed_delete`.
- `POST /api/machines/{id}/restore` → clear `archived_at` → `notify_embed_create`.

### Bot-down tolerance

DB change succeeds regardless; reconciliation on next `on_ready` brings Discord back into sync.

## Frontend `/admin` Section

### Routing

- `/admin` → redirect to `/admin/machines`.
- `/admin/machines` — any staff (view + edit machines).
- `/admin/staff` — admin-only.
- `/admin/settings` — admin-only.

`AuthContext` extended so `/api/auth/me` returns `role`. Add `RequireAdmin` wrapper alongside `RequireStaff`. UI hides nav links staff can't use; server is the source of truth (returns 403).

### NavBar

"Admin" dropdown visible when signed in:
- Machines (all staff)
- Staff (admin-only)
- Settings (admin-only)

### Pages

- **Machines** — single table (Name, Slug, Status, Queue count, Actions). Toolbar: "Add machine". Row actions: Edit, Set status, Archive (admin, with confirmation + 409 surface), "…" menu with "Delete permanently" (admin, destructive red modal, slug retype required). Archived machines shown below with Restore action (admin).
- **Staff** — table (Username, Role, Created). Toolbar: "Add staff" (username + password + role). Row actions: Change role, Reset password, Delete. Server enforces last-admin rule; UI surfaces 409.
- **Settings** — grouped form: *Queue behavior* (four numeric knobs), *Feature toggles* (`public_mode` checkbox, `maintenance_banner` text). "Save changes" with dirty-state tracking.

Styling: reuse existing Tailwind patterns. No new deps.

### Maintenance banner

When `maintenance_banner` is non-empty, yellow strip appears at the top of every page for all users.

## Settings Resolution

Order (for runtime knobs):

1. `settings` table row (authoritative when present).
2. `config.py` / `.env` fallback (fresh-install only).

Secrets (`DISCORD_TOKEN`, `OPENAI_API_KEY`, `RESEND_API_KEY`) and bootstrap (`STAFF_USERNAME`, `STAFF_PASSWORD`, `AUTH_SECRET`) — always `.env`.

### Cache

Agent and bot read via `get_setting(key)` helper with 10-second TTL to avoid hammering SQLite on every tick. `PATCH /api/settings/` updates `updated_at`; cache read-through checks the timestamp and reloads if newer.

## Testing

Extend existing suite (in-memory SQLite, per `test_db.py`):

- `test_machines_admin` — create/edit/archive/restore/purge; slug validation; archive-with-active-queue 409; slug-conflict-on-restore 409; purge confirmation mismatch 400.
- `test_staff_admin` — CRUD; last-admin protection; role-gated 403 for `staff` hitting admin endpoints.
- `test_settings` — GET/PATCH; unknown key rejection; cache invalidation.
- `test_embed_lifecycle` — create/delete bridges called in correct order on POST/DELETE/restore (mock the `bot` reference).

## Rollout Order

Each step independently deployable; system stays in a working state if any step breaks.

1. Migration: `archived_at`, `role` column, `settings` table.
2. Settings-backed reads at agent/bot boundaries (`get_setting` helper + cache).
3. Staff CRUD + `require_admin` dependency.
4. Machine CRUD + Discord embed lifecycle bridges.
5. Frontend `/admin` section + role surfaced in `/api/auth/me`.

## Open Questions

None at this stage — all resolved during brainstorm.
