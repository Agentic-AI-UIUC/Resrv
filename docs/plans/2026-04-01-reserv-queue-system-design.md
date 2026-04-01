# Reserv — Queue Management System Design

**Date:** 2026-04-01
**Status:** Approved
**Author:** Ashleyn

---

## Problem

The SCD (Student Creative Design) facility at the University of Illinois uses Waitwhile, a paid SaaS queue tool, to manage 4 machines: large format printer, laser cutter, CNC router, and water jet. The current system is:

- **Expensive** — charged per queue column; can't afford to add more machines
- **Paywalled** — analytics, branding, and customization progressively locked behind higher tiers
- **Manual** — staff must physically move users between queue stages while simultaneously training users and monitoring safety (high cognitive load)
- **No automation** — no rollover between days, no reminders, no feedback collection
- **Time-based reservations failed** — tried in semester 1, abandoned because users ran over or finished early

## Solution

Build a custom queue management system (~$15-20/month) with:

- **Discord bot** as the primary user interaction layer
- **Autonomous FIFO agent** that manages queue transitions automatically
- **React web dashboard** for staff monitoring, manual overrides, and analytics
- **Illinois email verification** for access control (toggleable for public events)
- **AI analytics** via OpenAI API for usage summaries

## Architecture

**Monolith:** Single Python process running discord.py + FastAPI + background agent loop on a small VPS.

```
┌─────────────────────────────────────────────────┐
│                Python Monolith                  │
│                                                 │
│  ┌──────────────┐       ┌────────────────────┐ │
│  │  Discord Bot  │       │  FastAPI Server     │ │
│  │  (discord.py) │       │  (JSON API + static)│ │
│  └──────┬───────┘       └────────┬───────────┘ │
│         │                        │              │
│  ┌──────┴────────────────────────┴───────────┐ │
│  │           Queue Agent (FIFO)               │ │
│  │      Background task loop (~10s tick)      │ │
│  └──────────────────┬────────────────────────┘ │
│                      │                          │
│  ┌──────────────────┴────────────────────────┐ │
│  │             SQLite (WAL mode)              │ │
│  └───────────────────────────────────────────┘ │
│                                                 │
│  ┌───────────────────────────────────────────┐ │
│  │    AI Analytics (scheduled daily/weekly)    │ │
│  │    OpenAI API for text summaries            │ │
│  └───────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

**Why monolith:** At the scale of 4 machines and ~50 users/day, a single process is the right call. Fastest to MVP, cheapest to run, easiest to debug. Can split later if needed.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Discord bot | discord.py |
| API server | FastAPI |
| Database | SQLite (WAL mode) |
| Frontend | React + Vite + Tailwind CSS |
| Charts | Recharts |
| Real-time | WebSocket (FastAPI) |
| AI analytics | OpenAI API |
| Email | Resend (free tier) or Gmail SMTP |
| Hosting | Small VPS (DigitalOcean/Hetzner, ~$5-6/month) |

## Data Model

### machines
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| name | TEXT NOT NULL | "Laser Cutter" |
| slug | TEXT UNIQUE | "laser-cutter" |
| status | TEXT DEFAULT 'active' | active / maintenance / offline |
| created_at | DATETIME | |

### users
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| discord_id | TEXT UNIQUE NOT NULL | |
| discord_name | TEXT | |
| email | TEXT UNIQUE | Illinois email |
| verified | BOOLEAN DEFAULT 0 | |
| college | TEXT | optional |
| major | TEXT | optional |
| created_at | DATETIME | |

### queue_entries
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| user_id | INTEGER FK → users | |
| machine_id | INTEGER FK → machines | |
| status | TEXT NOT NULL | waiting / serving / completed / cancelled / no_show |
| position | INTEGER | FIFO order within machine queue |
| joined_at | DATETIME | |
| serving_at | DATETIME | when agent moved to serving |
| completed_at | DATETIME | |
| reminded | BOOLEAN DEFAULT 0 | 30-min reminder sent? |
| job_successful | BOOLEAN | completion feedback |
| failure_notes | TEXT | if job failed |

### analytics_snapshots
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| date | DATE | |
| machine_id | INTEGER FK → machines | |
| total_jobs | INTEGER | |
| completed_jobs | INTEGER | |
| avg_wait_mins | REAL | |
| avg_serve_mins | REAL | |
| peak_hour | INTEGER | 0-23 |
| ai_summary | TEXT | OpenAI-generated |

### verification_codes
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| discord_id | TEXT NOT NULL | |
| email | TEXT NOT NULL | |
| code | TEXT NOT NULL | 6-digit |
| expires_at | DATETIME | 10 min expiry |
| used | BOOLEAN DEFAULT 0 | |

**Design decisions:**
- `queue_entries` is append-only for history; "today's queue" is filtered by date
- `position` field allows staff reordering; agent respects manual overrides
- No UIN or sensitive data — only name, email, optional college/major
- Illinois emails are publicly searchable in university directory, safe to store
- Analytics snapshots pre-computed daily to keep queries fast

## Queue Flow

### User Journey (Discord)

1. **See queue status** — pinned embed per machine in #queue channel showing count, wait estimate
2. **Join queue** — click [Join Queue] button on embed
3. **Verify (first time)** — bot DMs asking for @illinois.edu email → sends 6-digit code → user verifies → added to queue
4. **Wait** — bot DMs confirmation with position ("You're #4 for Laser Cutter")
5. **Get served** — agent auto-transitions next user; bot DMs "You're up! Head to the Laser Cutter now"
6. **Reminder** — after 30 min, bot asks "Still using it?" via reaction (checkmark/X)
7. **Complete** — bot asks "How'd it go?" with success/issue buttons; collects brief failure notes if needed

### Agent State Machine

```
  [Join Queue]
       │
       ▼
   ┌────────┐   staff override    ┌───────────┐
   │WAITING │──────────────────→  │ CANCELLED  │
   └────┬───┘                     └───────────┘
        │ next in FIFO
        ▼
   ┌────────┐   30min + no response  ┌──────────┐
   │SERVING │──────────────────────→ │ NO_SHOW  │
   └────┬───┘                        └──────────┘
        │ user confirms done
        ▼
   ┌──────────┐
   │COMPLETED │ (feedback collected)
   └──────────┘
```

### Agent Rules

- Ticks every 10 seconds
- Only one user per machine in `serving` state at a time
- FIFO ordering; respects manual position overrides by staff
- 30-minute reminder → 10-minute grace period → auto-complete as `no_show`
- Queue resets daily at configurable time (default: midnight)
- Historical entries preserved for analytics

## Discord Bot Design

### Channels
- **#queue** — public, pinned embeds per machine with [Join Queue] / [Check Position] buttons
- **#staff-admin** — private, admin slash commands + AI summary posts

### User Commands (via button interactions)
- [Join Queue] — join a specific machine's queue
- [Check Position] — see current position
- [Leave Queue] — remove self from queue

### Staff Commands (slash commands in admin channel)
- `/bump @user` — move user to top of queue
- `/remove @user` — remove from queue
- `/skip @user` — mark as no_show, advance queue
- `/pause <machine>` — pause a machine queue
- `/public on|off` — toggle public mode (skip email verification)

## Web Panel (React SPA)

### Pages

**1. Live Queue View (default)**
- Column per machine showing current queue
- Cards: user name, position, status, time waiting
- Drag-and-drop reordering
- Action buttons: [Move to Serving] [Remove] [Bump to Top]
- Real-time via WebSocket
- Color coding: green=serving, yellow=waiting, red=no_show

**2. Analytics Dashboard**
- Date range picker
- Charts (Recharts): jobs/day per machine, avg wait time, peak hours heatmap, completion rate
- AI summary section: latest daily/weekly text from OpenAI

**3. Settings**
- Manage machines (add/remove/rename, set maintenance)
- Toggle public mode
- Configure queue reset time
- Set reminder intervals

### Auth
- Password-based login (staff only, 1-2 accounts)
- JWT in httpOnly cookie
- Admin credentials from environment variables for MVP
- Upgrade to Discord OAuth later if needed

## Email Verification

1. User clicks [Join Queue] → bot checks if verified
2. If not verified → bot DMs: "Enter your @illinois.edu email"
3. Bot validates email format (`*@illinois.edu`)
4. Bot generates 6-digit code, stores with 10-min expiry
5. Bot sends code via Resend API (free tier: 3,000 emails/month)
6. User enters code → bot verifies → user marked verified
7. Future joins skip verification
8. Public mode: staff toggle skips all verification

## Project Structure

```
reserv/
├── bot/                    # Discord bot
│   ├── __init__.py
│   ├── bot.py              # Bot setup, event handlers
│   ├── cogs/
│   │   ├── queue.py        # Join, leave, check position
│   │   ├── verify.py       # Email verification flow
│   │   └── admin.py        # Staff slash commands
│   └── embeds.py           # Queue embed builders
├── api/                    # FastAPI backend
│   ├── __init__.py
│   ├── main.py             # FastAPI app, CORS, static files
│   ├── routes/
│   │   ├── queue.py        # Queue CRUD endpoints
│   │   ├── machines.py     # Machine management
│   │   ├── analytics.py    # Analytics data endpoints
│   │   ├── auth.py         # Login/JWT
│   │   └── ws.py           # WebSocket for live updates
│   └── deps.py             # Shared dependencies
├── agent/                  # Queue agent logic
│   ├── __init__.py
│   ├── loop.py             # Main agent tick loop
│   └── analytics.py        # OpenAI summary generation
├── db/
│   ├── models.py           # SQLAlchemy/SQLModel models
│   ├── database.py         # DB connection, WAL mode setup
│   └── migrations/         # Alembic migrations
├── web/                    # React frontend
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── QueueView.tsx
│   │   │   ├── Analytics.tsx
│   │   │   └── Settings.tsx
│   │   ├── components/
│   │   └── hooks/
│   │       └── useWebSocket.ts
│   ├── package.json
│   └── vite.config.ts
├── main.py                 # Entrypoint: starts bot + API
├── config.py               # Environment config
├── requirements.txt
└── .env                    # Secrets (not committed)
```

## Cost Estimate

| Item | Monthly Cost |
|------|-------------|
| VPS (DigitalOcean/Hetzner) | ~$5-6 |
| OpenAI API (daily summaries) | ~$5-10 |
| Resend email (free tier) | $0 |
| Domain (optional) | ~$1 (annualized) |
| **Total** | **~$12-17/month** |

## Key Design Decisions

1. **No time-based reservations** — tried and failed in semester 1; pure FIFO queue instead
2. **Daily queue reset** — entries from previous days preserved as history, not carried over
3. **Manual override always available** — staff can reorder, bump, remove at any time via Discord or web panel
4. **Discord as primary UX** — forces adoption (seen as benefit), free, students already use it, excellent bot ecosystem
5. **Monolith architecture** — right-sized for 4 machines, ~50 users/day; no premature optimization
6. **SQLite** — zero-config, single file, trivial backups, sufficient for this scale
7. **OpenAI for analytics only** — no AI in user-facing interactions; AI generates summaries for staff
8. **Non-sensitive data only** — no UIN, no IP; Illinois emails are publicly searchable
