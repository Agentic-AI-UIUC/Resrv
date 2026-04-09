"""Queue cog -- handles button interactions from the machine embeds."""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

import discord
from discord.ext import commands

from db import models

if TYPE_CHECKING:
    from bot.bot import ReservBot

log = logging.getLogger(__name__)

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

        await models.register_user(
            user_id=self._user_id,
            full_name=self.full_name.value.strip(),
            email=email_val,
            major=self.major.value.strip(),
            college=self.college.value.strip(),
            graduation_year=year_val,
        )

        machine = await models.get_machine(self._machine_id)
        if machine is None:
            await interaction.response.send_message(
                "Machine not found.", ephemeral=True
            )
            return

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

        try:
            await interaction.user.send(
                f"You're **#{position}** in the queue for **{machine['name']}**. "
                f"I'll DM you when it's your turn!"
            )
        except discord.Forbidden:
            pass


class QueueCog(commands.Cog):
    """Listener-based cog that routes button presses to queue actions."""

    def __init__(self, bot: ReservBot) -> None:
        self.bot = bot

    # --------------------------------------------------------------------- #
    # Interaction router
    # --------------------------------------------------------------------- #

    @commands.Cog.listener()
    async def on_interaction(self, interaction: discord.Interaction) -> None:
        """Dispatch button presses by custom_id prefix."""
        if interaction.type != discord.InteractionType.component:
            return

        custom_id: str = interaction.data.get("custom_id", "")  # type: ignore[union-attr]
        if ":" not in custom_id:
            return

        action, _, raw_machine_id = custom_id.partition(":")
        try:
            machine_id = int(raw_machine_id)
        except ValueError:
            return

        handler = {
            "join_queue": self._handle_join,
            "check_position": self._handle_check,
            "leave_queue": self._handle_leave,
        }.get(action)

        if handler is not None:
            await handler(interaction, machine_id)

    # --------------------------------------------------------------------- #
    # Join Queue
    # --------------------------------------------------------------------- #

    async def _handle_join(
        self, interaction: discord.Interaction, machine_id: int
    ) -> None:
        """Add the user to the specified machine's queue."""
        machine = await models.get_machine(machine_id)
        if machine is None:
            await interaction.response.send_message(
                "Machine not found.", ephemeral=True
            )
            return

        if machine["status"] != "active":
            await interaction.response.send_message(
                f"**{machine['name']}** is not currently accepting new entries "
                f"(status: {machine['status']}).",
                ephemeral=True,
            )
            return

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
        existing = await models.get_user_active_entry(user["id"], machine_id)
        if existing is not None:
            await interaction.response.send_message(
                f"You are already in the queue for **{machine['name']}**.",
                ephemeral=True,
            )
            return

        # Join the queue
        entry = await models.join_queue(user["id"], machine_id)
        position = entry["position"]
        waiting_count = await models.get_waiting_count(machine_id)

        await interaction.response.send_message(
            f"You joined the queue for **{machine['name']}**!\n"
            f"Your position: **#{position}** ({waiting_count} waiting)",
            ephemeral=True,
        )

        # Update the pinned embed
        await self.bot.update_queue_embeds(machine_id)

        # DM confirmation
        try:
            await interaction.user.send(
                f"You're **#{position}** in the queue for **{machine['name']}**. "
                f"I'll DM you when it's your turn!"
            )
        except discord.Forbidden:
            log.warning(
                "Cannot DM user %s (%s) -- DMs disabled",
                interaction.user.display_name,
                interaction.user.id,
            )

    # --------------------------------------------------------------------- #
    # Check Position
    # --------------------------------------------------------------------- #

    async def _handle_check(
        self, interaction: discord.Interaction, machine_id: int
    ) -> None:
        """Tell the user their current position (or that they're not in queue)."""
        machine = await models.get_machine(machine_id)
        if machine is None:
            await interaction.response.send_message(
                "Machine not found.", ephemeral=True
            )
            return

        user = await models.get_user_by_discord_id(str(interaction.user.id))
        if user is None:
            await interaction.response.send_message(
                f"You are not in the queue for **{machine['name']}**.",
                ephemeral=True,
            )
            return

        entry = await models.get_user_active_entry(user["id"], machine_id)
        if entry is None:
            await interaction.response.send_message(
                f"You are not in the queue for **{machine['name']}**.",
                ephemeral=True,
            )
            return

        if entry["status"] == "serving":
            await interaction.response.send_message(
                f"You are currently being **served** at **{machine['name']}**!",
                ephemeral=True,
            )
        else:
            # Count how many people are ahead
            queue = await models.get_queue_for_machine(machine_id)
            waiting = [e for e in queue if e["status"] == "waiting"]
            pos = next(
                (
                    idx
                    for idx, e in enumerate(waiting, start=1)
                    if e["user_id"] == user["id"]
                ),
                None,
            )
            if pos is not None:
                await interaction.response.send_message(
                    f"You are **#{pos}** in the queue for **{machine['name']}** "
                    f"({len(waiting)} waiting).",
                    ephemeral=True,
                )
            else:
                await interaction.response.send_message(
                    f"You are not in the queue for **{machine['name']}**.",
                    ephemeral=True,
                )

    # --------------------------------------------------------------------- #
    # Leave Queue
    # --------------------------------------------------------------------- #

    async def _handle_leave(
        self, interaction: discord.Interaction, machine_id: int
    ) -> None:
        """Remove the user from the queue."""
        machine = await models.get_machine(machine_id)
        if machine is None:
            await interaction.response.send_message(
                "Machine not found.", ephemeral=True
            )
            return

        user = await models.get_user_by_discord_id(str(interaction.user.id))
        if user is None:
            await interaction.response.send_message(
                f"You are not in the queue for **{machine['name']}**.",
                ephemeral=True,
            )
            return

        entry = await models.get_user_active_entry(user["id"], machine_id)
        if entry is None:
            await interaction.response.send_message(
                f"You are not in the queue for **{machine['name']}**.",
                ephemeral=True,
            )
            return

        await models.leave_queue(entry["id"])

        await interaction.response.send_message(
            f"You have left the queue for **{machine['name']}**.",
            ephemeral=True,
        )

        # Update the pinned embed
        await self.bot.update_queue_embeds(machine_id)

        # DM confirmation
        try:
            await interaction.user.send(
                f"You've been removed from the **{machine['name']}** queue."
            )
        except discord.Forbidden:
            log.warning(
                "Cannot DM user %s (%s) -- DMs disabled",
                interaction.user.display_name,
                interaction.user.id,
            )


async def setup(bot: ReservBot) -> None:
    await bot.add_cog(QueueCog(bot))
