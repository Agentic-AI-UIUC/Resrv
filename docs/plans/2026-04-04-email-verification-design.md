# Email Verification Design

## Summary

When `public_mode=False`, users must verify an `@illinois.edu` email before joining any queue. Verification happens entirely in Discord DMs: user provides email, bot sends a 6-digit code via Resend, user types it back. Verified status persists in the `users` table — one-time only.

## Decisions

| Question | Decision | Alternatives Considered |
|----------|----------|------------------------|
| Code delivery | Email with typed 6-digit code | Discord-only, clickable link |
| Enforcement point | Gate at queue join | Gate at serve, soft nudge |
| Domain restriction | `@illinois.edu` only | Configurable domain list, any email |
| Verification channel | DM only | Slash command, hybrid |
| Email provider | Resend | SMTP direct, SendGrid |

## Flow

```
User clicks "Join Queue" button
  → public_mode=True? → Allow join (no verification)
  → user.verified=True? → Allow join
  → Otherwise → DM user: prompt to verify email

User DMs email (e.g. "netid@illinois.edu")
  → Validate @illinois.edu domain
  → Generate 6-digit code, store in verification_codes (expires 10 min)
  → Send code via Resend
  → Reply: "Sent a code to netid@illinois.edu! Type it here."

User DMs code (e.g. "482916")
  → Match against verification_codes (not expired, not used)
  → Mark code as used
  → Update users: email=..., verified=1
  → Reply: "You're verified! You can now join queues."
```

## Components

### Config (`config.py`)
- Add `resend_api_key: str`
- Add `verification_code_expiry_minutes: int = 10`

### Database
- No schema changes — `verification_codes` table and `users.email`/`users.verified` columns already exist
- Add model helpers: `create_verification_code()`, `verify_code()`, `mark_user_verified()`

### DM Cog (`bot/cogs/dm.py`)
- Before OpenAI classification, check if message is a verification flow:
  1. Message is an `@illinois.edu` email → start verification
  2. Message is a 6-digit number and user has pending code → attempt verify
  3. Otherwise → pass to existing conversational agent

### Queue Cog (`bot/cogs/queue.py`)
- In Join handler: if `public_mode=False` and `user.verified=0`, reject join and DM the user a prompt to verify

### Email Module (`email_service.py`)
- Thin wrapper: `send_verification_email(to, code)` using Resend SDK
- From address: configurable (e.g. `verify@scd.illinois.edu` or Resend default)

## What Stays the Same
- All existing queue, admin, and DM functionality unchanged
- `public_mode=True` bypasses verification entirely (current default)
- OpenAI conversational agent untouched — verification is handled before it reaches the AI
