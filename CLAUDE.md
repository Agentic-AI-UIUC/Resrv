# Reserv — Queue Management System

Custom queue management system for the SCD facility at the University of Illinois, replacing Waitwhile.

## Architecture

- **Monolith:** Single Python process (discord.py + FastAPI + background agent)
- **Database:** SQLite (WAL mode)
- **Frontend:** React + Vite + Tailwind CSS
- **Hosting:** Small VPS (DigitalOcean/Hetzner)
- **AI:** OpenAI API for analytics summaries

## Key Conventions

- Discord bot is user-facing; web panel is staff-facing
- Queue agent is FIFO, autonomous, with manual override capability
- No time-based reservations — pure queue
- Illinois email verification required (toggleable for public events)
- Non-sensitive data only (no UIN)

## Learnings

This project maintains a `learnings.md` file at the project root. Add entries whenever you:
- Fix a non-obvious bug (include root cause)
- Discover a library/API gotcha or version-specific quirk
- Make an architectural decision worth remembering
- Find a useful command, config, or file path that wasn't obvious

Use the `/capture-learnings` skill at the end of sessions to do this automatically.

## Memory

This project maintains a `memory.md` file at the project root. Use it to store persistent context that should survive across sessions:
- Current state of the codebase (what's built, what's in progress)
- Key architectural decisions and the reasoning behind them
- Patterns and conventions established for this project
- Gotchas, known issues, and workarounds

Update `memory.md` whenever something significant changes. Read it at the start of each session before doing anything else.

## Completed Work

### 2026-04-01 — MVP Core Queue System
- Built complete Discord bot + FastAPI API + autonomous queue agent + SQLite persistence
- 4 seeded machines (Large Format Printer, Laser Cutter, CNC Router, Water Jet)
- Bot: persistent button embeds, Join/Check/Leave interactions, staff slash commands (/bump, /remove, /skip, /pause, /status)
- Agent: 10s tick loop with FIFO advancement, 30-min reminders, grace period expiry, daily reset
- API: 7 queue endpoints + 3 machine endpoints + health check
- 51 tests passing across DB, API, and agent layers
- Deferred: email verification, AI analytics, React dashboard, WebSocket real-time

### 2026-04-26 — Analytics Chatbot
- New `chat_conversations` + `chat_messages` tables (FK + `ON DELETE CASCADE`, role CHECK constraint, scaffolding columns for future tool-use).
- Per-staff scoped multi-turn chat at `/api/analytics/chat` (POST + list/get/delete) gated by `require_staff`. OpenAI `gpt-4o-mini`, lazy-instantiated client (degrades to 503 if key missing).
- System prompt embeds the same `compute_analytics_response` payload the dashboard renders, so chat answers can never diverge from the visible data. Last 8 messages reach the model; the full thread persists.
- Floating "Ask the data" panel mounted on `/admin/analytics`: conversation list, suggested prompts, optimistic UI, markdown-rendered assistant replies via `react-markdown`.
- 12 chat tests added (DB + API + cross-user isolation).

### 2026-04-22 — Multi-Unit Machines
- New `machine_units` table; every existing machine backfilled with one "Main" unit. `queue_entries.unit_id` stamped on promotion.
- Agent now promotes up to `count_active_units(machine)` in parallel; auto-assigns the first active unit without a live serving entry. Maintenance units exclude themselves from capacity.
- Nested CRUD routes under `/api/machines/{id}/units/` (staff create/patch, admin archive/restore/purge). Duplicate labels return 409 via partial unique index `idx_machine_units_label_active`.
- Discord embed gains a Units block (icons for available / serving / maintenance); hidden when a machine has only a single "Main" unit to preserve the single-unit UX.
- Admin page has expandable per-machine units section (add/rename/toggle/archive/purge with label-retype modal); public queue shows a chip strip per machine.
