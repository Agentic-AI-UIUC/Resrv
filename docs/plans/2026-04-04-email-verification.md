# Email Verification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Gate queue joins behind `@illinois.edu` email verification when `public_mode=False`. Users verify once via DM; status persists forever.

**Architecture:** Verification is a pre-check in the queue join handler. The DM cog intercepts email addresses and 6-digit codes before they reach the OpenAI conversational agent. Resend sends verification emails. All state lives in the existing `verification_codes` and `users` tables.

**Tech Stack:** Resend (email), existing aiosqlite DB, discord.py DM cog

---

### Task 1: Add Resend Dependency and Config

**Files:**
- Modify: `requirements.txt`
- Modify: `config.py:4-29`

**Step 1: Add resend to requirements.txt**

Add this line after the `httpx` entry in `requirements.txt`:

```
# Email verification
resend>=2.0,<3.0
```

**Step 2: Add config fields**

In `config.py`, add these fields to the `Settings` class after `openai_api_key`:

```python
    # Email verification (Resend)
    resend_api_key: str = ""
    verification_code_expiry_minutes: int = 10
```

**Step 3: Install dependency**

Run: `pip install resend`

**Step 4: Commit**

```bash
git add requirements.txt config.py
git commit -m "feat: add resend dependency and verification config"
```

---

### Task 2: Add Verification Model Helpers

**Files:**
- Modify: `db/models.py` (append to end)
- Test: `tests/test_db.py` (append new tests)

**Step 1: Write the failing tests**

Append to `tests/test_db.py`:

```python
async def test_create_verification_code(db):
    """create_verification_code stores a code and returns it."""
    result = await models.create_verification_code("disc123", "user@illinois.edu")
    assert result["discord_id"] == "disc123"
    assert result["email"] == "user@illinois.edu"
    assert len(result["code"]) == 6
    assert result["code"].isdigit()
    assert result["used"] == 0


async def test_verify_code_valid(db):
    """verify_code returns the row when code matches and is not expired/used."""
    created = await models.create_verification_code("disc456", "test@illinois.edu")
    result = await models.verify_code("disc456", created["code"])
    assert result is not None
    assert result["email"] == "test@illinois.edu"


async def test_verify_code_wrong_code(db):
    """verify_code returns None for wrong code."""
    await models.create_verification_code("disc789", "x@illinois.edu")
    result = await models.verify_code("disc789", "000000")
    assert result is None


async def test_verify_code_already_used(db):
    """verify_code returns None if code was already used."""
    created = await models.create_verification_code("discA", "a@illinois.edu")
    # Use it
    await models.verify_code("discA", created["code"])
    await models.mark_code_used(created["id"])
    # Try again
    result = await models.verify_code("discA", created["code"])
    assert result is None


async def test_mark_user_verified(db):
    """mark_user_verified sets email and verified=1 on the user."""
    user = await models.get_or_create_user("discV", "VerifyUser")
    await models.mark_user_verified(user["id"], "verified@illinois.edu")
    updated = await models.get_user_by_discord_id("discV")
    assert updated["verified"] == 1
    assert updated["email"] == "verified@illinois.edu"


async def test_invalidate_previous_codes(db):
    """Creating a new code marks all previous codes for that discord_id as used."""
    first = await models.create_verification_code("discI", "i@illinois.edu")
    _second = await models.create_verification_code("discI", "i@illinois.edu")
    # First code should now be invalid
    result = await models.verify_code("discI", first["code"])
    assert result is None
```

**Step 2: Run tests to verify they fail**

Run: `pytest tests/test_db.py -v -k "verification or verify or mark_user"`
Expected: FAIL — `models` has no `create_verification_code`, etc.

**Step 3: Write the model helpers**

Append to `db/models.py`:

```python
import random
import string


async def create_verification_code(discord_id: str, email: str) -> dict[str, Any]:
    """Generate a 6-digit code, invalidate previous codes, and store it."""
    db = await get_db()
    code = "".join(random.choices(string.digits, k=6))
    expiry_minutes = 10  # default; caller can override via config if needed

    # Invalidate any previous unused codes for this user
    await db.execute(
        "UPDATE verification_codes SET used = 1 WHERE discord_id = ? AND used = 0",
        (discord_id,),
    )

    cursor = await db.execute(
        """
        INSERT INTO verification_codes (discord_id, email, code, expires_at)
        VALUES (?, ?, ?, datetime('now', '+' || ? || ' minutes'))
        RETURNING *
        """,
        (discord_id, email, code, expiry_minutes),
    )
    row = dict(await cursor.fetchone())
    await db.commit()
    return row


async def verify_code(discord_id: str, code: str) -> dict[str, Any] | None:
    """Check if a valid (not expired, not used) code exists for this user."""
    db = await get_db()
    cursor = await db.execute(
        """
        SELECT * FROM verification_codes
        WHERE discord_id = ? AND code = ? AND used = 0
          AND datetime(expires_at) > datetime('now')
        ORDER BY id DESC LIMIT 1
        """,
        (discord_id, code),
    )
    return _row_to_dict(await cursor.fetchone())


async def mark_code_used(code_id: int) -> None:
    """Mark a verification code as used."""
    db = await get_db()
    await db.execute(
        "UPDATE verification_codes SET used = 1 WHERE id = ?", (code_id,)
    )
    await db.commit()


async def mark_user_verified(user_id: int, email: str) -> None:
    """Set user as verified with the given email."""
    db = await get_db()
    await db.execute(
        "UPDATE users SET email = ?, verified = 1 WHERE id = ?",
        (email, user_id),
    )
    await db.commit()
```

**Step 4: Run tests to verify they pass**

Run: `pytest tests/test_db.py -v -k "verification or verify or mark_user"`
Expected: All 7 new tests PASS

**Step 5: Run full test suite**

Run: `pytest -v`
Expected: All existing + new tests PASS

**Step 6: Commit**

```bash
git add db/models.py tests/test_db.py
git commit -m "feat: add verification code model helpers with tests"
```

---

### Task 3: Add Email Service

**Files:**
- Create: `email_service.py`
- Test: `tests/test_email.py`

**Step 1: Write the failing test**

Create `tests/test_email.py`:

```python
"""Tests for the email service — Resend is mocked."""

from __future__ import annotations

from unittest.mock import patch, MagicMock
import pytest

from email_service import send_verification_email

pytestmark = pytest.mark.asyncio


async def test_send_verification_email_calls_resend():
    """send_verification_email calls resend.Emails.send with correct params."""
    mock_resend = MagicMock()
    mock_resend.Emails.send.return_value = {"id": "fake-id"}

    with patch("email_service.resend", mock_resend):
        result = await send_verification_email("user@illinois.edu", "123456")

    assert result is True
    mock_resend.Emails.send.assert_called_once()
    call_args = mock_resend.Emails.send.call_args[0][0]
    assert call_args["to"] == ["user@illinois.edu"]
    assert "123456" in call_args["html"]


async def test_send_verification_email_handles_failure():
    """send_verification_email returns False on exception."""
    mock_resend = MagicMock()
    mock_resend.Emails.send.side_effect = Exception("API error")

    with patch("email_service.resend", mock_resend):
        result = await send_verification_email("user@illinois.edu", "123456")

    assert result is False
```

**Step 2: Run tests to verify they fail**

Run: `pytest tests/test_email.py -v`
Expected: FAIL — `email_service` module not found

**Step 3: Write the email service**

Create `email_service.py`:

```python
"""Email service — sends verification codes via Resend."""

from __future__ import annotations

import logging

import resend

from config import settings

log = logging.getLogger(__name__)


async def send_verification_email(to: str, code: str) -> bool:
    """Send a verification code email. Returns True on success, False on failure."""
    if not settings.resend_api_key:
        log.error("RESEND_API_KEY not configured — cannot send verification email")
        return False

    resend.api_key = settings.resend_api_key

    try:
        resend.Emails.send({
            "from": "SCD Queue <verify@scd.illinois.edu>",
            "to": [to],
            "subject": "Your SCD Queue Verification Code",
            "html": (
                f"<h2>Your verification code</h2>"
                f"<p style='font-size:32px; font-weight:bold; letter-spacing:8px;'>{code}</p>"
                f"<p>Enter this code in your Discord DM with SCD Bot to verify your email.</p>"
                f"<p>This code expires in {settings.verification_code_expiry_minutes} minutes.</p>"
            ),
        })
        log.info("Verification email sent to %s", to)
        return True
    except Exception:
        log.exception("Failed to send verification email to %s", to)
        return False
```

**Step 4: Run tests to verify they pass**

Run: `pytest tests/test_email.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add email_service.py tests/test_email.py
git commit -m "feat: add email service for verification codes via Resend"
```

---

### Task 4: Add Verification Flow to DM Cog

**Files:**
- Modify: `bot/cogs/dm.py:146-171` (the `on_message` listener)
- Test: `tests/test_verification_flow.py`

**Step 1: Write the failing tests**

Create `tests/test_verification_flow.py`:

```python
"""Tests for the DM verification flow."""

from __future__ import annotations

import re
import pytest

from db import models
from db.database import init_db, close_db

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def db():
    conn = await init_db()
    yield conn
    await close_db()


async def test_is_email_detects_illinois_edu(db):
    """Email regex matches @illinois.edu addresses."""
    from bot.cogs.dm import _is_illinois_email
    assert _is_illinois_email("netid@illinois.edu") is True
    assert _is_illinois_email("NETID@ILLINOIS.EDU") is True
    assert _is_illinois_email("user@gmail.com") is False
    assert _is_illinois_email("hello world") is False
    assert _is_illinois_email("user@uillinois.edu") is False


async def test_is_verification_code_format(db):
    """6-digit string detection."""
    from bot.cogs.dm import _is_verification_code
    assert _is_verification_code("123456") is True
    assert _is_verification_code("12345") is False
    assert _is_verification_code("1234567") is False
    assert _is_verification_code("abcdef") is False
    assert _is_verification_code("  123456  ") is True


async def test_start_verification_creates_code(db):
    """Providing an email creates a verification code in the DB."""
    user = await models.get_or_create_user("vtest1", "VTest1")
    code_row = await models.create_verification_code("vtest1", "test@illinois.edu")
    assert len(code_row["code"]) == 6

    # Verify it can be looked up
    found = await models.verify_code("vtest1", code_row["code"])
    assert found is not None


async def test_complete_verification_marks_user(db):
    """Submitting correct code marks user as verified."""
    user = await models.get_or_create_user("vtest2", "VTest2")
    code_row = await models.create_verification_code("vtest2", "v@illinois.edu")

    found = await models.verify_code("vtest2", code_row["code"])
    assert found is not None
    await models.mark_code_used(found["id"])
    await models.mark_user_verified(user["id"], found["email"])

    updated = await models.get_user_by_discord_id("vtest2")
    assert updated["verified"] == 1
    assert updated["email"] == "v@illinois.edu"


async def test_wrong_code_rejected(db):
    """Wrong code does not verify the user."""
    user = await models.get_or_create_user("vtest3", "VTest3")
    await models.create_verification_code("vtest3", "w@illinois.edu")

    found = await models.verify_code("vtest3", "000000")
    assert found is None

    updated = await models.get_user_by_discord_id("vtest3")
    assert updated["verified"] == 0
```

**Step 2: Run tests to verify they fail**

Run: `pytest tests/test_verification_flow.py -v`
Expected: FAIL — `_is_illinois_email` and `_is_verification_code` not found

**Step 3: Add verification helpers and intercept to DM cog**

In `bot/cogs/dm.py`, add these module-level helpers after the `_SYSTEM_PROMPT` block (around line 63):

```python
import re

_ILLINOIS_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+-]+@illinois\.edu$", re.IGNORECASE)


def _is_illinois_email(text: str) -> bool:
    """Check if text is a valid @illinois.edu email."""
    return bool(_ILLINOIS_EMAIL_RE.match(text.strip()))


def _is_verification_code(text: str) -> bool:
    """Check if text is a 6-digit verification code."""
    return text.strip().isdigit() and len(text.strip()) == 6
```

Then modify the `on_message` method in `DMCog` to intercept verification before OpenAI. Replace the body of `on_message` (after cooldown check) with:

```python
        # Show typing indicator while processing
        async with message.channel.typing():
            text = message.content.strip()

            # --- Verification intercept (before OpenAI) ---
            if _is_illinois_email(text):
                await self._handle_email_submission(message, text.lower())
                return

            if _is_verification_code(text):
                await self._handle_code_submission(message, text.strip())
                return

            # --- Normal conversational flow ---
            reply, action, machine_slug = await self._converse(message.content)

            if action == "none":
                await message.reply(reply)
                return

            await self._execute_intent(message, action, machine_slug, reply)
```

Add these two new methods to `DMCog`:

```python
    async def _handle_email_submission(
        self, message: discord.Message, email: str
    ) -> None:
        """User sent an @illinois.edu email — start verification flow."""
        from email_service import send_verification_email

        discord_id = str(message.author.id)

        # Check if already verified
        user = await models.get_user_by_discord_id(discord_id)
        if user and user["verified"]:
            await message.reply("You're already verified! You can join any queue.")
            return

        # Create code and send email
        code_row = await models.create_verification_code(discord_id, email)
        sent = await send_verification_email(email, code_row["code"])

        if sent:
            await message.reply(
                f"Sent a verification code to **{email}**! "
                f"Check your inbox and type the 6-digit code here."
            )
        else:
            await message.reply(
                "I couldn't send the verification email right now. Please try again later."
            )

    async def _handle_code_submission(
        self, message: discord.Message, code: str
    ) -> None:
        """User sent a 6-digit code — attempt verification."""
        discord_id = str(message.author.id)

        result = await models.verify_code(discord_id, code)
        if result is None:
            await message.reply(
                "That code is invalid or expired. "
                "Send your @illinois.edu email again to get a new one."
            )
            return

        # Mark code as used and verify user
        await models.mark_code_used(result["id"])

        user = await models.get_or_create_user(
            discord_id, message.author.display_name
        )
        await models.mark_user_verified(user["id"], result["email"])

        await message.reply(
            "You're verified! You can now join machine queues. Head to the queue channel and hit **Join Queue**."
        )
```

**Step 4: Run tests to verify they pass**

Run: `pytest tests/test_verification_flow.py -v`
Expected: All 6 tests PASS

**Step 5: Run full test suite**

Run: `pytest -v`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add bot/cogs/dm.py tests/test_verification_flow.py
git commit -m "feat: add email verification flow to DM cog"
```

---

### Task 5: Gate Queue Join Behind Verification

**Files:**
- Modify: `bot/cogs/queue.py:58-104` (`_handle_join` method)
- Test: `tests/test_verification_flow.py` (append)

**Step 1: Write the failing test**

Append to `tests/test_verification_flow.py`:

```python
from config import settings


async def test_unverified_user_blocked_when_public_mode_off(db, monkeypatch):
    """Unverified user cannot join queue when public_mode=False."""
    monkeypatch.setattr(settings, "public_mode", False)
    user = await models.get_or_create_user("block1", "BlockUser")

    # User is unverified (default)
    assert (await models.get_user_by_discord_id("block1"))["verified"] == 0

    # The check that queue.py will perform:
    from bot.cogs.queue import _requires_verification
    assert _requires_verification(user) is True


async def test_verified_user_allowed_when_public_mode_off(db, monkeypatch):
    """Verified user can join queue when public_mode=False."""
    monkeypatch.setattr(settings, "public_mode", False)
    user = await models.get_or_create_user("allow1", "AllowUser")
    await models.mark_user_verified(user["id"], "allow@illinois.edu")
    user = await models.get_user_by_discord_id("allow1")

    from bot.cogs.queue import _requires_verification
    assert _requires_verification(user) is False


async def test_unverified_user_allowed_when_public_mode_on(db, monkeypatch):
    """Unverified user can join queue when public_mode=True."""
    monkeypatch.setattr(settings, "public_mode", True)
    user = await models.get_or_create_user("pub1", "PubUser")

    from bot.cogs.queue import _requires_verification
    assert _requires_verification(user) is False
```

**Step 2: Run tests to verify they fail**

Run: `pytest tests/test_verification_flow.py -v -k "requires_verification or blocked or allowed"`
Expected: FAIL — `_requires_verification` not found

**Step 3: Add verification gate to queue cog**

In `bot/cogs/queue.py`, add this module-level helper after the imports:

```python
from config import settings


def _requires_verification(user: dict) -> bool:
    """Check if the user needs to verify before joining a queue."""
    if settings.public_mode:
        return False
    return not user.get("verified", False)
```

Then in `_handle_join`, add this check after `get_or_create_user` (after line 81) and before the duplicate entry check:

```python
        # Verification gate
        if _requires_verification(user):
            await interaction.response.send_message(
                "You need to verify your **@illinois.edu** email before joining a queue.\n"
                "DM me your email address to get started!",
                ephemeral=True,
            )
            # Also DM them
            try:
                await interaction.user.send(
                    "To join a queue, I need to verify your Illinois email first.\n"
                    "Just send me your **@illinois.edu** email address right here!"
                )
            except discord.Forbidden:
                pass
            return
```

**Step 4: Run tests to verify they pass**

Run: `pytest tests/test_verification_flow.py -v`
Expected: All tests PASS

**Step 5: Run full test suite**

Run: `pytest -v`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add bot/cogs/queue.py tests/test_verification_flow.py
git commit -m "feat: gate queue join behind email verification when public_mode is off"
```

---

### Task 6: Add RESEND_API_KEY to .env and Test End-to-End

**Files:**
- Modify: `.env`

**Step 1: Add the Resend API key to .env**

```
RESEND_API_KEY=re_your_key_here
```

**Step 2: Set public_mode to False for testing**

In `.env`, set:
```
PUBLIC_MODE=false
```

**Step 3: Run the full test suite one final time**

Run: `pytest -v`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: complete email verification system with Resend integration"
```
