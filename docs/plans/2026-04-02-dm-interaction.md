# DM Bot Interaction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users DM the bot with natural language to manage their queue status (done, more time, check position, leave), using OpenAI to classify intent.

**Architecture:** New `bot/cogs/dm.py` cog listens for DMs via `on_message`, sends the message to OpenAI `gpt-4o-mini` for intent classification, then executes the matching action against the database and updates Discord embeds.

**Tech Stack:** openai Python SDK, gpt-4o-mini, discord.py on_message listener

---

### Task 1: Add OpenAI config and dependency

**Files:**
- Modify: `config.py:4-26`
- Modify: `requirements.txt`
- Modify: `.env` (user action — not committed)

**Step 1: Add `openai_api_key` to Settings**

In `config.py`, add to the Settings class after the `admin_channel_id` line:

```python
    # OpenAI (for DM intent classification)
    openai_api_key: str = ""
```

**Step 2: Add openai to requirements.txt**

Append to `requirements.txt`:

```
# AI (intent classification)
openai>=1.30,<2.0
```

**Step 3: Install the dependency**

Run: `pip install openai>=1.30,<2.0`

**Step 4: Commit**

```bash
git add config.py requirements.txt
git commit -m "feat: add OpenAI config and dependency for DM intent classification"
```

---

### Task 2: Add `reset_reminder` and `get_user_active_entries` to db/models.py

**Files:**
- Modify: `db/models.py`
- Test: `tests/test_db.py`

**Step 1: Write the failing tests**

Append to `tests/test_db.py`:

```python
@pytest.mark.asyncio
async def test_reset_reminder(db):
    user = await models.get_or_create_user("reset1", "ResetUser")
    entry = await models.join_queue(user["id"], 1)
    await models.update_entry_status(entry["id"], "serving")
    await models.mark_reminded(entry["id"])

    # Verify reminded is 1
    updated = await _get_entry(db, entry["id"])
    assert updated["reminded"] == 1

    # Reset it
    await models.reset_reminder(entry["id"])
    updated = await _get_entry(db, entry["id"])
    assert updated["reminded"] == 0


@pytest.mark.asyncio
async def test_get_user_active_entries(db):
    user = await models.get_or_create_user("multi1", "MultiUser")
    await models.join_queue(user["id"], 1)
    await models.join_queue(user["id"], 2)

    entries = await models.get_user_active_entries(user["id"])
    assert len(entries) == 2
    machine_ids = {e["machine_id"] for e in entries}
    assert machine_ids == {1, 2}


@pytest.mark.asyncio
async def test_get_user_active_entries_empty(db):
    user = await models.get_or_create_user("empty1", "EmptyUser")
    entries = await models.get_user_active_entries(user["id"])
    assert entries == []
```

Also add a helper at the top of `tests/test_db.py` (if not present):

```python
async def _get_entry(db, entry_id):
    cursor = await db.execute("SELECT * FROM queue_entries WHERE id = ?", (entry_id,))
    row = await cursor.fetchone()
    return dict(row)
```

**Step 2: Run tests to verify they fail**

Run: `pytest tests/test_db.py -v -k "test_reset_reminder or test_get_user_active_entries"`
Expected: FAIL — `models.reset_reminder` and `models.get_user_active_entries` don't exist

**Step 3: Implement `reset_reminder` and `get_user_active_entries` in `db/models.py`**

Add after the existing `mark_reminded` function:

```python
async def reset_reminder(entry_id: int) -> None:
    """Reset the reminded flag so the timer restarts."""
    db = await get_db()
    await db.execute(
        "UPDATE queue_entries SET reminded = 0 WHERE id = ?", (entry_id,)
    )
    await db.commit()
```

Add after the existing `get_user_active_entry` function:

```python
async def get_user_active_entries(user_id: int) -> list[dict[str, Any]]:
    """Get ALL active entries for a user across all machines today."""
    db = await get_db()
    cursor = await db.execute(
        """
        SELECT qe.*, u.discord_id, u.discord_name, m.name as machine_name, m.slug as machine_slug
        FROM queue_entries qe
        JOIN users u ON u.id = qe.user_id
        JOIN machines m ON m.id = qe.machine_id
        WHERE qe.user_id = ?
          AND qe.status IN ('waiting', 'serving')
          AND date(qe.joined_at) = date('now')
        ORDER BY qe.position ASC
        """,
        (user_id,),
    )
    return _rows_to_dicts(await cursor.fetchall())
```

**Step 4: Run tests to verify they pass**

Run: `pytest tests/test_db.py -v -k "test_reset_reminder or test_get_user_active_entries"`
Expected: PASS

**Step 5: Commit**

```bash
git add db/models.py tests/test_db.py
git commit -m "feat: add reset_reminder and get_user_active_entries model helpers"
```

---

### Task 3: Create the DM cog with OpenAI intent classifier

**Files:**
- Create: `bot/cogs/dm.py`

**Step 1: Create the DM cog**

Create `bot/cogs/dm.py`:

```python
"""DM cog -- natural language queue management via direct messages."""

from __future__ import annotations

import logging
import time
from typing import Any, TYPE_CHECKING

import discord
from discord.ext import commands
from openai import AsyncOpenAI

from config import settings
from db import models

if TYPE_CHECKING:
    from bot.bot import ReservBot

log = logging.getLogger(__name__)

CLASSIFY_SYSTEM_PROMPT = """\
You are a queue management bot assistant. Classify the user's message into one of these intents:

- "done" — user is finished with their machine session (e.g. "I'm done", "finished", "all done")
- "more_time" — user needs more time on the machine (e.g. "need more time", "not done yet", "extend")
- "check_position" — user wants to know their queue position (e.g. "where am I", "check my spot", "what's my position")
- "leave" — user wants to leave/cancel their queue entry (e.g. "remove me", "leave queue", "cancel")
- "unknown" — message doesn't match any intent

Also extract the machine name if mentioned. The available machines are:
- Large Format Printer (slug: large-format-printer)
- Laser Cutter (slug: laser-cutter)
- CNC Router (slug: cnc-router)
- Water Jet (slug: water-jet)

Respond with ONLY valid JSON, no markdown:
{"intent": "done|more_time|check_position|leave|unknown", "machine": "machine-slug-here or null"}
"""

# Buttons for ambiguity resolution and fallback
class MachinePicker(discord.ui.View):
    """Buttons to pick a machine when the user has multiple active entries."""

    def __init__(self, entries: list[dict[str, Any]], action: str) -> None:
        super().__init__(timeout=60)
        self.selected_entry: dict[str, Any] | None = None
        for entry in entries:
            btn = discord.ui.Button(
                label=entry["machine_name"],
                custom_id=f"dm_pick:{action}:{entry['id']}",
                style=discord.ButtonStyle.blurple,
            )
            self.add_item(btn)


class FallbackActions(discord.ui.View):
    """Fallback buttons when OpenAI can't classify the message."""

    def __init__(self) -> None:
        super().__init__(timeout=60)
        for label, action in [
            ("I'm Done", "done"),
            ("More Time", "more_time"),
            ("Check Position", "check_position"),
            ("Leave Queue", "leave"),
        ]:
            self.add_item(
                discord.ui.Button(
                    label=label,
                    custom_id=f"dm_fallback:{action}",
                    style=discord.ButtonStyle.grey,
                )
            )


class DMCog(commands.Cog):
    """Handle DMs with natural language intent classification."""

    def __init__(self, bot: ReservBot) -> None:
        self.bot = bot
        self._cooldowns: dict[int, float] = {}
        if settings.openai_api_key:
            self._openai = AsyncOpenAI(api_key=settings.openai_api_key)
        else:
            self._openai = None

    # ------------------------------------------------------------------ #
    # DM listener
    # ------------------------------------------------------------------ #

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        # Ignore bots and guild messages — only handle DMs
        if message.author.bot:
            return
        if message.guild is not None:
            return

        # Rate limit: 5-second cooldown per user
        now = time.monotonic()
        last = self._cooldowns.get(message.author.id, 0)
        if now - last < 5:
            return
        self._cooldowns[message.author.id] = now

        # Classify intent
        intent, machine_slug = await self._classify(message.content)

        if intent == "unknown":
            view = FallbackActions()
            await message.reply(
                "I didn't quite catch that. What would you like to do?",
                view=view,
            )
            return

        await self._execute_intent(message, intent, machine_slug)

    # ------------------------------------------------------------------ #
    # Button interaction handler (for machine picker and fallback)
    # ------------------------------------------------------------------ #

    @commands.Cog.listener()
    async def on_interaction(self, interaction: discord.Interaction) -> None:
        if interaction.type != discord.InteractionType.component:
            return

        custom_id: str = interaction.data.get("custom_id", "")  # type: ignore[union-attr]

        # Handle machine picker: dm_pick:<action>:<entry_id>
        if custom_id.startswith("dm_pick:"):
            parts = custom_id.split(":")
            if len(parts) != 3:
                return
            action, entry_id_str = parts[1], parts[2]
            try:
                entry_id = int(entry_id_str)
            except ValueError:
                return
            await self._execute_by_entry_id(interaction, action, entry_id)
            return

        # Handle fallback buttons: dm_fallback:<action>
        if custom_id.startswith("dm_fallback:"):
            action = custom_id.removeprefix("dm_fallback:")
            # Convert interaction to a pseudo-message flow
            user = await models.get_user_by_discord_id(str(interaction.user.id))
            if user is None:
                await interaction.response.send_message(
                    "You're not in any queue right now. Head to the queue channel to join!"
                )
                return
            entries = await models.get_user_active_entries(user["id"])
            if not entries:
                await interaction.response.send_message(
                    "You're not in any queue right now. Head to the queue channel to join!"
                )
                return
            if len(entries) == 1:
                await self._execute_by_entry_id(interaction, action, entries[0]["id"])
            else:
                view = MachinePicker(entries, action)
                await interaction.response.send_message(
                    "Which machine?", view=view
                )

    # ------------------------------------------------------------------ #
    # OpenAI classifier
    # ------------------------------------------------------------------ #

    async def _classify(self, text: str) -> tuple[str, str | None]:
        """Classify a DM into (intent, machine_slug|None)."""
        if self._openai is None:
            return ("unknown", None)

        try:
            import json
            response = await self._openai.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": CLASSIFY_SYSTEM_PROMPT},
                    {"role": "user", "content": text},
                ],
                temperature=0,
                max_tokens=100,
            )
            raw = response.choices[0].message.content or ""
            data = json.loads(raw)
            intent = data.get("intent", "unknown")
            machine = data.get("machine")
            if intent not in ("done", "more_time", "check_position", "leave"):
                intent = "unknown"
            return (intent, machine)
        except Exception:
            log.exception("OpenAI classification failed")
            return ("unknown", None)

    # ------------------------------------------------------------------ #
    # Intent execution
    # ------------------------------------------------------------------ #

    async def _execute_intent(
        self, message: discord.Message, intent: str, machine_slug: str | None
    ) -> None:
        """Resolve user + entries, handle ambiguity, then execute."""
        user = await models.get_user_by_discord_id(str(message.author.id))
        if user is None:
            await message.reply(
                "You're not in any queue right now. Head to the queue channel to join!"
            )
            return

        entries = await models.get_user_active_entries(user["id"])
        if not entries:
            await message.reply(
                "You're not in any queue right now. Head to the queue channel to join!"
            )
            return

        # If machine was specified, filter to that entry
        if machine_slug:
            matched = [e for e in entries if e.get("machine_slug") == machine_slug]
            if matched:
                entries = matched

        # If still ambiguous, ask
        if len(entries) > 1:
            view = MachinePicker(entries, intent)
            await message.reply("Which machine?", view=view)
            return

        entry = entries[0]
        reply = await self._do_action(intent, entry)
        await message.reply(reply)
        await self.bot.update_queue_embeds(entry["machine_id"])

    async def _execute_by_entry_id(
        self, interaction: discord.Interaction, action: str, entry_id: int
    ) -> None:
        """Execute an action on a specific entry (from button press)."""
        from db.database import get_db
        db = await get_db()
        cursor = await db.execute(
            """
            SELECT qe.*, m.name as machine_name, m.slug as machine_slug
            FROM queue_entries qe
            JOIN machines m ON m.id = qe.machine_id
            WHERE qe.id = ?
            """,
            (entry_id,),
        )
        row = await cursor.fetchone()
        if row is None:
            await interaction.response.send_message("That queue entry no longer exists.")
            return
        entry = dict(row)
        reply = await self._do_action(action, entry)
        await interaction.response.send_message(reply)
        await self.bot.update_queue_embeds(entry["machine_id"])

    async def _do_action(self, intent: str, entry: dict[str, Any]) -> str:
        """Execute the intent and return a confirmation message."""
        machine_name = entry.get("machine_name", "the machine")
        status = entry["status"]

        if intent == "done":
            if status == "serving":
                await models.update_entry_status(
                    entry["id"], "completed", job_successful=1
                )
                return f"Marked as done on **{machine_name}**. Thanks!"
            else:
                # Waiting, not serving — treat as leave
                await models.leave_queue(entry["id"])
                return (
                    f"You weren't being served yet, so I've removed you from "
                    f"the **{machine_name}** queue."
                )

        elif intent == "more_time":
            if status == "serving":
                await models.reset_reminder(entry["id"])
                return (
                    f"Got it! Timer reset on **{machine_name}**. "
                    f"I'll remind you again in {settings.reminder_minutes} minutes."
                )
            else:
                queue = await models.get_queue_for_machine(entry["machine_id"])
                waiting = [e for e in queue if e["status"] == "waiting"]
                pos = next(
                    (i for i, e in enumerate(waiting, 1) if e["id"] == entry["id"]),
                    None,
                )
                return (
                    f"You're not being served on **{machine_name}** yet — "
                    f"no timer to extend. You're #{pos} in line."
                )

        elif intent == "check_position":
            if status == "serving":
                return f"You're currently being **served** at **{machine_name}**!"
            queue = await models.get_queue_for_machine(entry["machine_id"])
            waiting = [e for e in queue if e["status"] == "waiting"]
            pos = next(
                (i for i, e in enumerate(waiting, 1) if e["id"] == entry["id"]),
                None,
            )
            total = len(waiting)
            return (
                f"You're **#{pos}** in the queue for **{machine_name}** "
                f"({total} waiting)."
            )

        elif intent == "leave":
            await models.leave_queue(entry["id"])
            return f"You've been removed from the **{machine_name}** queue."

        return "Something went wrong. Please try again."


async def setup(bot: ReservBot) -> None:
    await bot.add_cog(DMCog(bot))
```

**Step 2: Verify syntax**

Run: `python -c "import ast; ast.parse(open('bot/cogs/dm.py').read()); print('OK')"`
Expected: OK

**Step 3: Commit**

```bash
git add bot/cogs/dm.py
git commit -m "feat: add DM cog with OpenAI intent classifier and action handlers"
```

---

### Task 4: Wire the DM cog into the bot

**Files:**
- Modify: `bot/bot.py:32-33` (intents)
- Modify: `bot/bot.py:63` (cog loading)

**Step 1: Enable `message_content` intent**

In `bot/bot.py`, change the intents block:

```python
        intents = discord.Intents.default()
        intents.guilds = True
```

to:

```python
        intents = discord.Intents.default()
        intents.guilds = True
        intents.message_content = True  # needed to read DM content
```

**Important:** This requires the Message Content privileged intent to be enabled in the Discord Developer Portal (Bot > Privileged Gateway Intents > Message Content Intent). The user was told to enable this earlier.

**Step 2: Load the DM cog in `setup_hook`**

After the existing cog loading lines, add:

```python
        await self.load_extension("bot.cogs.dm")
```

So the cog loading block becomes:

```python
        # 2. Cogs
        await self.load_extension("bot.cogs.queue")
        await self.load_extension("bot.cogs.admin")
        await self.load_extension("bot.cogs.dm")
        log.info("Cogs loaded")
```

**Step 3: Run full test suite**

Run: `pytest tests/ -v`
Expected: All tests pass (existing + new)

**Step 4: Commit**

```bash
git add bot/bot.py
git commit -m "feat: wire DM cog into bot with message_content intent"
```

---

### Task 5: Write integration tests for the DM cog

**Files:**
- Create: `tests/test_dm.py`

**Step 1: Write tests**

Create `tests/test_dm.py`:

```python
"""Tests for DM intent classification and action execution."""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, patch

from db import models
from db.database import init_db, close_db


@pytest.fixture
async def db():
    conn = await init_db()
    yield conn
    await close_db()


@pytest.mark.asyncio
async def test_done_while_serving(db):
    """'done' intent on a serving entry marks it completed."""
    user = await models.get_or_create_user("dm1", "DMUser1")
    entry = await models.join_queue(user["id"], 1)
    await models.update_entry_status(entry["id"], "serving")

    # Simulate the action directly
    from bot.cogs.dm import DMCog
    cog = DMCog.__new__(DMCog)
    result = await cog._do_action("done", {
        **entry, "machine_name": "Laser Cutter", "machine_slug": "laser-cutter", "status": "serving"
    })

    assert "done" in result.lower() or "Marked" in result

    # Verify DB state
    from db.database import get_db
    d = await get_db()
    cursor = await d.execute("SELECT status FROM queue_entries WHERE id = ?", (entry["id"],))
    row = await cursor.fetchone()
    assert row["status"] == "completed"


@pytest.mark.asyncio
async def test_done_while_waiting(db):
    """'done' intent on a waiting entry treats it as leave."""
    user = await models.get_or_create_user("dm2", "DMUser2")
    entry = await models.join_queue(user["id"], 1)

    from bot.cogs.dm import DMCog
    cog = DMCog.__new__(DMCog)
    result = await cog._do_action("done", {
        **entry, "machine_name": "Laser Cutter", "machine_slug": "laser-cutter", "status": "waiting"
    })

    assert "removed" in result.lower()

    from db.database import get_db
    d = await get_db()
    cursor = await d.execute("SELECT status FROM queue_entries WHERE id = ?", (entry["id"],))
    row = await cursor.fetchone()
    assert row["status"] == "cancelled"


@pytest.mark.asyncio
async def test_more_time_resets_reminder(db):
    """'more_time' intent resets the reminded flag."""
    user = await models.get_or_create_user("dm3", "DMUser3")
    entry = await models.join_queue(user["id"], 1)
    await models.update_entry_status(entry["id"], "serving")
    await models.mark_reminded(entry["id"])

    from bot.cogs.dm import DMCog
    cog = DMCog.__new__(DMCog)
    result = await cog._do_action("more_time", {
        **entry, "machine_name": "Laser Cutter", "machine_slug": "laser-cutter", "status": "serving"
    })

    assert "reset" in result.lower() or "Timer" in result

    from db.database import get_db
    d = await get_db()
    cursor = await d.execute("SELECT reminded FROM queue_entries WHERE id = ?", (entry["id"],))
    row = await cursor.fetchone()
    assert row["reminded"] == 0


@pytest.mark.asyncio
async def test_leave_cancels_entry(db):
    """'leave' intent cancels the queue entry."""
    user = await models.get_or_create_user("dm4", "DMUser4")
    entry = await models.join_queue(user["id"], 1)

    from bot.cogs.dm import DMCog
    cog = DMCog.__new__(DMCog)
    result = await cog._do_action("leave", {
        **entry, "machine_name": "CNC Router", "machine_slug": "cnc-router", "status": "waiting"
    })

    assert "removed" in result.lower()

    from db.database import get_db
    d = await get_db()
    cursor = await d.execute("SELECT status FROM queue_entries WHERE id = ?", (entry["id"],))
    row = await cursor.fetchone()
    assert row["status"] == "cancelled"


@pytest.mark.asyncio
async def test_check_position_while_waiting(db):
    """'check_position' intent returns queue position."""
    user = await models.get_or_create_user("dm5", "DMUser5")
    entry = await models.join_queue(user["id"], 1)

    from bot.cogs.dm import DMCog
    cog = DMCog.__new__(DMCog)
    result = await cog._do_action("check_position", {
        **entry, "machine_name": "Water Jet", "machine_slug": "water-jet", "status": "waiting"
    })

    assert "#1" in result


@pytest.mark.asyncio
async def test_check_position_while_serving(db):
    """'check_position' while serving says so."""
    user = await models.get_or_create_user("dm6", "DMUser6")
    entry = await models.join_queue(user["id"], 1)
    await models.update_entry_status(entry["id"], "serving")

    from bot.cogs.dm import DMCog
    cog = DMCog.__new__(DMCog)
    result = await cog._do_action("check_position", {
        **entry, "machine_name": "Water Jet", "machine_slug": "water-jet", "status": "serving"
    })

    assert "served" in result.lower()
```

**Step 2: Run the new tests**

Run: `pytest tests/test_dm.py -v`
Expected: All 6 tests pass

**Step 3: Run full test suite**

Run: `pytest tests/ -v`
Expected: All tests pass

**Step 4: Commit**

```bash
git add tests/test_dm.py
git commit -m "test: add integration tests for DM cog intent handlers"
```

---

### Task 6: Add OPENAI_API_KEY to .env and test end-to-end

**Files:**
- Modify: `.env` (user action)

**Step 1: Add the API key to .env**

User must add to `.env`:
```
OPENAI_API_KEY=sk-...
```

**Step 2: Enable Message Content Intent in Discord Developer Portal**

Go to https://discord.com/developers/applications/ > Bot > Privileged Gateway Intents > toggle **Message Content Intent** ON.

**Step 3: Restart the bot**

Run: kill existing bot, then `python main.py`

**Step 4: Manual test**

DM the bot with:
- "I'm done with the laser cutter" → should mark as complete
- "where am I in line?" → should report position
- "I need more time" → should reset timer
- "remove me" → should leave queue
- "asdfghjkl" → should show fallback buttons

**Step 5: Final commit (all remaining changes)**

```bash
git add -A
git commit -m "feat: DM-based natural language queue management complete"
```
