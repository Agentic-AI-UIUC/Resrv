# User Signup Modal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Gate queue access behind a Discord Modal signup form that collects Full Name, Email, Major, College, and Graduation Year. Add a `/profile` command to edit profile info.

**Architecture:** Add 3 new columns to the `users` table (`full_name`, `graduation_year`, `registered`). Intercept "Join Queue" clicks — if user isn't registered, show a `SignupModal`. On submit, save profile and auto-join the queue. `/profile` reuses the same modal pre-filled.

**Tech Stack:** discord.py Modals (`discord.ui.Modal`, `discord.ui.TextInput`), aiosqlite, pytest

**Design doc:** `docs/plans/2026-04-08-signup-modal-design.md`

---

### Task 1: Database Migration — Add New Columns

**Files:**
- Modify: `db/database.py:102-108` (the `_migrate` function)

**Step 1: Add migration logic**

In `db/database.py`, extend the `_migrate` function to add three new columns to `users` if they don't exist:

```python
async def _migrate(db: aiosqlite.Connection) -> None:
    """Run lightweight migrations for schema changes."""
    # Add embed_message_id to machines if missing
    cursor = await db.execute("PRAGMA table_info(machines)")
    columns = {row[1] for row in await cursor.fetchall()}
    if "embed_message_id" not in columns:
        await db.execute("ALTER TABLE machines ADD COLUMN embed_message_id TEXT")

    # Add signup fields to users if missing
    cursor = await db.execute("PRAGMA table_info(users)")
    user_columns = {row[1] for row in await cursor.fetchall()}
    if "full_name" not in user_columns:
        await db.execute("ALTER TABLE users ADD COLUMN full_name TEXT")
    if "graduation_year" not in user_columns:
        await db.execute("ALTER TABLE users ADD COLUMN graduation_year TEXT")
    if "registered" not in user_columns:
        await db.execute("ALTER TABLE users ADD COLUMN registered INTEGER NOT NULL DEFAULT 0")
```

**Step 2: Verify migration runs**

Run: `python -c "import asyncio; from db.database import init_db; asyncio.run(init_db()); print('OK')"`
Expected: `OK` (no errors)

**Step 3: Commit**

```bash
git add db/database.py
git commit -m "feat: add full_name, graduation_year, registered columns to users"
```

---

### Task 2: Model Helpers — register_user and update_user_profile

**Files:**
- Modify: `db/models.py` (after the Users section, ~line 90)
- Test: `tests/test_db.py`

**Step 1: Write the failing tests**

Append to `tests/test_db.py`:

```python
# ── Registration helpers ────────────────────────────────────────────────


async def test_register_user(db):
    """register_user saves profile fields and sets registered=1."""
    user = await models.get_or_create_user("reg1", "RegUser")
    assert user.get("registered", 0) == 0

    await models.register_user(
        user_id=user["id"],
        full_name="Alex Chen",
        email="achen2@illinois.edu",
        major="Computer Science",
        college="Grainger Engineering",
        graduation_year="2027",
    )
    updated = await models.get_user_by_discord_id("reg1")
    assert updated["registered"] == 1
    assert updated["full_name"] == "Alex Chen"
    assert updated["email"] == "achen2@illinois.edu"
    assert updated["major"] == "Computer Science"
    assert updated["college"] == "Grainger Engineering"
    assert updated["graduation_year"] == "2027"


async def test_update_user_profile(db):
    """update_user_profile changes existing fields."""
    user = await models.get_or_create_user("upd1", "UpdUser")
    await models.register_user(
        user_id=user["id"],
        full_name="Old Name",
        email="old@illinois.edu",
        major="Math",
        college="LAS",
        graduation_year="2026",
    )
    await models.update_user_profile(
        user_id=user["id"],
        full_name="New Name",
        email="new@illinois.edu",
        major="Physics",
        college="Grainger Engineering",
        graduation_year="2028",
    )
    updated = await models.get_user_by_discord_id("upd1")
    assert updated["full_name"] == "New Name"
    assert updated["email"] == "new@illinois.edu"
    assert updated["major"] == "Physics"
    assert updated["college"] == "Grainger Engineering"
    assert updated["graduation_year"] == "2028"
    assert updated["registered"] == 1
```

**Step 2: Run tests to verify they fail**

Run: `pytest tests/test_db.py::test_register_user tests/test_db.py::test_update_user_profile -v`
Expected: FAIL with `AttributeError: module 'db.models' has no attribute 'register_user'`

**Step 3: Write the implementations**

Add to `db/models.py` after `get_user_by_discord_id`:

```python
async def register_user(
    user_id: int,
    *,
    full_name: str,
    email: str,
    major: str,
    college: str,
    graduation_year: str,
) -> None:
    """Save signup profile and mark user as registered."""
    db = await get_db()
    await db.execute(
        """
        UPDATE users
        SET full_name = ?, email = ?, major = ?, college = ?,
            graduation_year = ?, registered = 1
        WHERE id = ?
        """,
        (full_name, email, major, college, graduation_year, user_id),
    )
    await db.commit()


async def update_user_profile(
    user_id: int,
    *,
    full_name: str,
    email: str,
    major: str,
    college: str,
    graduation_year: str,
) -> None:
    """Update an existing user's profile fields."""
    db = await get_db()
    await db.execute(
        """
        UPDATE users
        SET full_name = ?, email = ?, major = ?, college = ?,
            graduation_year = ?
        WHERE id = ?
        """,
        (full_name, email, major, college, graduation_year, user_id),
    )
    await db.commit()
```

**Step 4: Run tests to verify they pass**

Run: `pytest tests/test_db.py -v`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add db/models.py tests/test_db.py
git commit -m "feat: add register_user and update_user_profile model helpers"
```

---

### Task 3: SignupModal + Registration Gate in Queue Cog

**Files:**
- Modify: `bot/cogs/queue.py:1-110`

**Step 1: Add the SignupModal class and validation**

Add at the top of `bot/cogs/queue.py`, after imports:

```python
import re

_ILLINOIS_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+-]+@illinois\.edu$", re.IGNORECASE)


class SignupModal(discord.ui.Modal, title="SCD Queue — Sign Up"):
    """Collects user profile info before first queue join."""

    full_name = discord.ui.TextInput(
        label="Full Name",
        placeholder="e.g. Alex Chen",
        min_length=2,
        max_length=100,
    )
    email = discord.ui.TextInput(
        label="Email",
        placeholder="e.g. achen2@illinois.edu",
        min_length=5,
        max_length=100,
    )
    major = discord.ui.TextInput(
        label="Major",
        placeholder="e.g. Computer Science",
        min_length=2,
        max_length=100,
    )
    college = discord.ui.TextInput(
        label="College",
        placeholder="e.g. Grainger Engineering",
        min_length=2,
        max_length=100,
    )
    graduation_year = discord.ui.TextInput(
        label="Expected Graduation Year",
        placeholder="e.g. 2027",
        min_length=4,
        max_length=4,
    )

    def __init__(self, bot: ReservBot, user_id: int, machine_id: int) -> None:
        super().__init__()
        self._bot = bot
        self._user_id = user_id
        self._machine_id = machine_id

    async def on_submit(self, interaction: discord.Interaction) -> None:
        # Validate email
        email_val = self.email.value.strip()
        if not _ILLINOIS_EMAIL_RE.match(email_val):
            await interaction.response.send_message(
                "Please enter a valid **@illinois.edu** email.", ephemeral=True
            )
            return

        # Validate graduation year
        year_val = self.graduation_year.value.strip()
        if not year_val.isdigit() or not (2024 <= int(year_val) <= 2035):
            await interaction.response.send_message(
                "Graduation year must be between 2024 and 2035.", ephemeral=True
            )
            return

        # Save profile
        await models.register_user(
            user_id=self._user_id,
            full_name=self.full_name.value.strip(),
            email=email_val,
            major=self.major.value.strip(),
            college=self.college.value.strip(),
            graduation_year=year_val,
        )

        # Auto-join the queue they originally clicked
        machine = await models.get_machine(self._machine_id)
        if machine is None:
            await interaction.response.send_message(
                "Machine not found.", ephemeral=True
            )
            return

        # Check for duplicate (in case they clicked twice)
        existing = await models.get_user_active_entry(self._user_id, self._machine_id)
        if existing is not None:
            await interaction.response.send_message(
                f"You're registered! You're already in the queue for **{machine['name']}**.",
                ephemeral=True,
            )
            return

        entry = await models.join_queue(self._user_id, self._machine_id)
        position = entry["position"]
        waiting_count = await models.get_waiting_count(self._machine_id)

        await interaction.response.send_message(
            f"Welcome! You're registered and joined the queue for **{machine['name']}**!\n"
            f"Your position: **#{position}** ({waiting_count} waiting)",
            ephemeral=True,
        )
        await self._bot.update_queue_embeds(self._machine_id)

        # DM confirmation
        try:
            await interaction.user.send(
                f"You're **#{position}** in the queue for **{machine['name']}**. "
                f"I'll DM you when it's your turn!"
            )
        except discord.Forbidden:
            pass
```

**Step 2: Add the registration gate in `_handle_join`**

Replace the section in `_handle_join` (lines 77-81) — after getting the user, before duplicate check:

```python
        # Get or create the user record
        user = await models.get_or_create_user(
            discord_id=str(interaction.user.id),
            discord_name=interaction.user.display_name,
        )

        # Registration gate — show signup modal if not registered
        if not user.get("registered"):
            await interaction.response.send_modal(
                SignupModal(self.bot, user["id"], machine_id)
            )
            return

        # Check for duplicate active entry
```

**Step 3: Manually test**

1. Start bot: `python main.py`
2. Click "Join Queue" as a user who hasn't filled out the form
3. Verify modal appears with 5 fields
4. Submit with valid data — verify auto-join works
5. Click "Join Queue" again — verify it skips modal and joins directly

**Step 4: Commit**

```bash
git add bot/cogs/queue.py
git commit -m "feat: add signup modal gate on queue join"
```

---

### Task 4: `/profile` Slash Command

**Files:**
- Modify: `bot/cogs/admin.py` (add `/profile` command — NOT admin-only)

Note: `/profile` should be usable by anyone, not restricted to admin channel. Add it to `AdminCog` but without the `_admin_channel_only()` decorator.

**Step 1: Add ProfileModal class**

Add to `bot/cogs/admin.py` before the `AdminCog` class:

```python
import re

_ILLINOIS_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+-]+@illinois\.edu$", re.IGNORECASE)


class ProfileModal(discord.ui.Modal, title="SCD Queue — Edit Profile"):
    """Edit profile modal, pre-filled with current data."""

    full_name = discord.ui.TextInput(
        label="Full Name",
        placeholder="e.g. Alex Chen",
        min_length=2,
        max_length=100,
    )
    email = discord.ui.TextInput(
        label="Email",
        placeholder="e.g. achen2@illinois.edu",
        min_length=5,
        max_length=100,
    )
    major = discord.ui.TextInput(
        label="Major",
        placeholder="e.g. Computer Science",
        min_length=2,
        max_length=100,
    )
    college = discord.ui.TextInput(
        label="College",
        placeholder="e.g. Grainger Engineering",
        min_length=2,
        max_length=100,
    )
    graduation_year = discord.ui.TextInput(
        label="Expected Graduation Year",
        placeholder="e.g. 2027",
        min_length=4,
        max_length=4,
    )

    def __init__(self, user_id: int) -> None:
        super().__init__()
        self._user_id = user_id

    async def on_submit(self, interaction: discord.Interaction) -> None:
        email_val = self.email.value.strip()
        if not _ILLINOIS_EMAIL_RE.match(email_val):
            await interaction.response.send_message(
                "Please enter a valid **@illinois.edu** email.", ephemeral=True
            )
            return

        year_val = self.graduation_year.value.strip()
        if not year_val.isdigit() or not (2024 <= int(year_val) <= 2035):
            await interaction.response.send_message(
                "Graduation year must be between 2024 and 2035.", ephemeral=True
            )
            return

        await models.update_user_profile(
            user_id=self._user_id,
            full_name=self.full_name.value.strip(),
            email=email_val,
            major=self.major.value.strip(),
            college=self.college.value.strip(),
            graduation_year=year_val,
        )
        await interaction.response.send_message(
            "Profile updated!", ephemeral=True
        )
```

**Step 2: Add `/profile` command to AdminCog**

Add inside `AdminCog`, after the `status` command:

```python
    # --------------------------------------------------------------------- #
    # /profile (available to everyone)
    # --------------------------------------------------------------------- #

    @app_commands.command(
        name="profile", description="View or edit your SCD profile"
    )
    async def profile(self, interaction: discord.Interaction) -> None:
        user = await models.get_user_by_discord_id(str(interaction.user.id))
        if user is None:
            user = await models.get_or_create_user(
                str(interaction.user.id), interaction.user.display_name
            )

        modal = ProfileModal(user["id"])
        # Pre-fill with existing data
        if user.get("full_name"):
            modal.full_name.default = user["full_name"]
        if user.get("email"):
            modal.email.default = user["email"]
        if user.get("major"):
            modal.major.default = user["major"]
        if user.get("college"):
            modal.college.default = user["college"]
        if user.get("graduation_year"):
            modal.graduation_year.default = user["graduation_year"]

        await interaction.response.send_modal(modal)
```

**Important:** If the user runs `/profile` before ever joining a queue (no user record), we create the stub first. The `ProfileModal.on_submit` calls `update_user_profile` which doesn't set `registered=1`, so running `/profile` alone doesn't register you — you still need to fill out the SignupModal via Join Queue. This is intentional: `/profile` is for edits, not initial registration.

**Actually, correction:** `/profile` should also register the user if they fill it out. Change `ProfileModal.on_submit` to call `register_user` if not already registered, and `update_user_profile` if already registered:

```python
    async def on_submit(self, interaction: discord.Interaction) -> None:
        email_val = self.email.value.strip()
        if not _ILLINOIS_EMAIL_RE.match(email_val):
            await interaction.response.send_message(
                "Please enter a valid **@illinois.edu** email.", ephemeral=True
            )
            return

        year_val = self.graduation_year.value.strip()
        if not year_val.isdigit() or not (2024 <= int(year_val) <= 2035):
            await interaction.response.send_message(
                "Graduation year must be between 2024 and 2035.", ephemeral=True
            )
            return

        # Use register_user (sets registered=1) regardless — idempotent for existing users
        await models.register_user(
            user_id=self._user_id,
            full_name=self.full_name.value.strip(),
            email=email_val,
            major=self.major.value.strip(),
            college=self.college.value.strip(),
            graduation_year=year_val,
        )
        await interaction.response.send_message(
            "Profile updated!", ephemeral=True
        )
```

**Step 3: Manually test**

1. Start bot: `python main.py`
2. Run `/profile` — verify modal appears (empty for new users)
3. Fill out and submit — verify "Profile updated!" response
4. Run `/profile` again — verify fields are pre-filled with saved data
5. Edit a field and submit — verify update persists

**Step 4: Commit**

```bash
git add bot/cogs/admin.py
git commit -m "feat: add /profile command with pre-filled edit modal"
```

---

### Task 5: Clean Up — Remove Unused verified Column References

**Files:**
- Modify: `db/database.py:49-54` (users table CREATE — keep column for backwards compat but note it's unused)

**Step 1: No schema change needed**

The `verified` column can stay in the schema (removing columns in SQLite requires table recreation). Just ensure no code references it. We already removed all verification code earlier in this session.

**Step 2: Run full test suite**

Run: `pytest tests/ -v`
Expected: ALL PASS

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat: user signup modal — complete implementation"
```
