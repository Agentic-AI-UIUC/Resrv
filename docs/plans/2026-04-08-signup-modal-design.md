# User Signup Modal — Design

**Date:** 2026-04-08
**Status:** Approved

## Summary

Add a Discord Modal-based signup form that collects user profile information (Full Name, Email, Major, College, Graduation Year) before allowing queue access. The modal appears inline when an unregistered user clicks "Join Queue" and auto-joins them after submission. A `/profile` slash command lets users edit their info later.

## Data Model

Extend the `users` table with new columns:

| Column | Type | New? | Notes |
|--------|------|------|-------|
| `full_name` | TEXT | Yes | User's real name |
| `email` | TEXT UNIQUE | Exists | illinois.edu, no verification |
| `major` | TEXT | Exists | Free text |
| `college` | TEXT | Exists | Free text |
| `graduation_year` | TEXT | Yes | e.g. "2027" |
| `registered` | INTEGER DEFAULT 0 | Yes | Has the user completed the signup form? |

The existing `verified` column is unused (email verification removed). The new `registered` column gates queue access.

## Flow

1. User clicks **Join Queue** on any machine embed
2. `QueueCog._handle_join` calls `get_or_create_user` (creates stub if first time)
3. Check `user["registered"]` — if falsy, show `SignupModal` instead of joining
4. User fills out 5 fields: Full Name, Email, Major, College, Graduation Year
5. On submit: validate inputs, save to DB, then auto-join the queue they originally clicked
6. Returning users (already registered) skip straight to joining

## Modal Layout

```
┌─────────────────────────────────┐
│  SCD Queue - Sign Up            │
├─────────────────────────────────┤
│  Full Name                      │
│  [e.g. Alex Chen              ] │
│  Email                          │
│  [e.g. achen2@illinois.edu    ] │
│  Major                          │
│  [e.g. Computer Science       ] │
│  College                        │
│  [e.g. Grainger Engineering   ] │
│  Expected Graduation Year       │
│  [e.g. 2027                   ] │
│                       [Submit]  │
└─────────────────────────────────┘
```

## `/profile` Command

- Any user can run `/profile` to re-open the same modal, pre-filled with current data
- On submit, updates the DB with same validation rules
- Works for both registered and unregistered users

## Validation

- **Full Name**: Required, 2-100 chars
- **Email**: Required, must match `*@illinois.edu` pattern
- **Major**: Required, 2-100 chars
- **College**: Required, 2-100 chars
- **Graduation Year**: Required, 4 digits, range 2024-2035

Invalid submissions return an ephemeral error message listing issues.

## Approach

Single Modal (Approach A) chosen over two-step or hybrid because:
- 5 fields fit exactly within Discord's 5-TextInput modal limit
- Zero friction for returning users
- One interaction for new users (modal submit auto-joins queue)
- `/profile` reuses the same modal class

## Files to Change

- `db/database.py` — migration to add `full_name`, `graduation_year`, `registered` columns
- `db/models.py` — `register_user()` and `update_user_profile()` helpers
- `bot/cogs/queue.py` — registration gate + `SignupModal` class, auto-join after submit
- `bot/cogs/admin.py` — `/profile` slash command
- `tests/test_db.py` — tests for new model helpers
