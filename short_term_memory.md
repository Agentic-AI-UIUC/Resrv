# Short-term Memory

## 2026-04-22 — Multi-Unit Machines
Shipped on `feat/customizable-admin`. 138 tests passing, tsc clean.

**Backend:**
- New `machine_units` table (`id, machine_id, label, status, created_at, archived_at`). Partial unique index `idx_machine_units_label_active` on `(machine_id, label) WHERE archived_at IS NULL` — created in `_migrate` post-ALTER per the partial-index rule.
- `queue_entries.unit_id INTEGER REFERENCES machine_units(id)` (nullable; populated only when `status='serving'`).
- Every existing/seeded machine backfilled with one "Main" unit via `_backfill_main_units` (called from `_migrate` for upgrades and from `init_db` after `_seed_machines` for fresh DBs). `create_machine` also seeds a "Main" unit in the same transaction; `purge_machine` now cascades `machine_units` rows too.
- `db/models.py`: `list_units`, `get_unit`, `create_unit`, `update_unit`, `archive_unit`, `restore_unit`, `purge_unit`, plus capacity helpers `count_active_units`, `count_serving_on_machine`, `first_available_unit`. Archive/purge blocked when a unit has an active serving entry.
- `agent/loop.py::_process_machines`: promotes up to `count_active_units(mid)` simultaneously, auto-assigning the first free active unit. DM copy includes unit label unless it's "Main".
- `api/routes/units.py`: nested CRUD under `/api/machines/{mid}/units/` — public GET, staff POST/PATCH, admin DELETE/restore/purge. `/api/machines/` + `/api/queue/` responses now embed a `units` summary array; `QueueEntryOut` exposes `unit_id`.

**Frontend:**
- `AdminUnit` / `UnitSummary` types + full unit admin API client in `web/src/api/admin.ts`.
- `/admin/machines`: expandable chevron per row reveals a nested units section (add, rename, toggle active↔maintenance, archive, purge with label-retype modal). Unit section hidden on archived machines.
- Public queue: each `MachineColumn` renders a chip strip above the pause button — green = available, blue = in-use (with display name), gray = maintenance. Chip strip hidden for single-"Main" machines (back-compat).

**Docs:**
- Design: `docs/plans/2026-04-22-multi-unit-machines-design.md`.
- Plan: `docs/plans/2026-04-22-multi-unit-machines.md` (11 tasks, all done).

## 2026-04-22 — Customizable Admin (machines, staff, settings)
Shipped on `feat/customizable-admin` (14 commits ahead of `main`). All 109 tests pass, tsc clean, backend/Vite restarted and smoke-tested.

**Backend:**
- Migration: `archived_at` on `machines`, `role` on `staff_users` (with "last admin backfill" invariant), new `settings` table with 6 seeded keys. Partial unique index `idx_machines_slug_active` enforces slug uniqueness only among non-archived rows (created in `_migrate`, not `_create_tables`).
- `api/settings_store.py`: PBKDF2-free `get_setting[_int|_bool]` + `set_setting` with 10-second TTL cache. Agent reads `reminder_minutes` / `grace_minutes` through it so admin edits take effect within 10s without restart.
- Routes:
  - `POST/PATCH /api/machines/{id}` (staff), `DELETE` + `POST .../restore` (admin). Hard-delete = `DELETE ?purge=true` with `{confirm_slug}` body; cascades queue_entries + analytics_snapshots.
  - `GET/POST/PATCH/DELETE /api/staff/` (admin). Last-admin guard on DELETE and role-change PATCH.
  - `GET/PATCH /api/settings/` (admin) + `GET /api/public-settings/` (public, returns only `public_mode` + `maintenance_banner`).
- Bot: new `create_queue_embed` / `delete_queue_embed` methods; `on_ready` reconciles archived machines by deleting lingering embeds. API bridges `notify_embed_create` / `notify_embed_delete` added to `api/deps.py`.

**Frontend:**
- `AuthContext` now tracks `role`. `RequireAdmin` wraps `/admin/staff` and `/admin/settings`.
- New pages: `/admin/machines` (table + add form + archive + restore + red destructive purge modal with slug retype), `/admin/staff` (CRUD + reset-password modal), `/admin/settings` (grouped form with dirty-state Save button).
- `MaintenanceBanner` polls `/api/public-settings/` every 60s and renders a yellow strip when non-empty.
- NavBar shows Admin link only when signed in; sub-tabs (Machines / Staff / Settings) surface when in `/admin/*`; admin-only tabs hidden for regular staff.

**Defaults & conventions:**
- Seeded admin: `admin` / `changeme` (override via `STAFF_USERNAME` / `STAFF_PASSWORD` / `AUTH_SECRET`).
- Slug validation regex: `^[a-z0-9]+(-[a-z0-9]+)*$`.
- Archive blocked while active queue entries exist (409 with message).
- Purge requires typed slug confirmation (400 on mismatch).

**Docs:**
- Design: `docs/plans/2026-04-22-customizable-admin-design.md`.
- Plan: `docs/plans/2026-04-22-customizable-admin.md` (16 tasks, all done).
