"""Discord-side feedback flow."""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from bot.cogs.dm import RatingView, FeedbackModal, send_rating_dm
from db import models

pytestmark = pytest.mark.asyncio


@pytest.fixture
def fake_user():
    u = MagicMock()
    u.id = 999
    u.send = AsyncMock()
    return u


@pytest.fixture
def fake_interaction():
    inter = MagicMock()
    inter.response.send_modal = AsyncMock()
    inter.response.send_message = AsyncMock()
    inter.response.edit_message = AsyncMock()
    inter.message.edit = AsyncMock()
    return inter


async def _make_completed_entry(discord_id: str):
    user = await models.get_or_create_user(
        discord_id=discord_id, discord_name="u",
    )
    machines = await models.get_machines()
    entry = await models.join_queue(user["id"], machines[0]["id"])
    await models.update_entry_status(entry["id"], "serving")
    await models.update_entry_status(
        entry["id"], "completed", job_successful=1,
    )
    return entry, machines[0]


async def test_send_rating_dm_sends_view(db, fake_user):
    entry, machine = await _make_completed_entry("rate-dm")
    await send_rating_dm(
        fake_user,
        queue_entry_id=entry["id"],
        machine_name=machine["name"],
    )
    fake_user.send.assert_awaited_once()
    args, kwargs = fake_user.send.call_args
    assert isinstance(kwargs["view"], RatingView)
    assert machine["name"] in kwargs.get("content", "")


async def test_star_button_opens_modal(db, fake_interaction):
    entry, machine = await _make_completed_entry("rate-star")
    view = RatingView(
        queue_entry_id=entry["id"], machine_name=machine["name"],
    )
    star4 = next(
        b for b in view.children if getattr(b, "_rating", None) == 4
    )
    await star4.callback(fake_interaction)
    fake_interaction.response.send_modal.assert_awaited_once()
    modal = fake_interaction.response.send_modal.call_args.args[0]
    assert isinstance(modal, FeedbackModal)
    assert modal._rating == 4
    assert modal._queue_entry_id == entry["id"]


async def test_modal_submit_writes_row_and_acks(db, fake_interaction):
    entry, machine = await _make_completed_entry("rate-submit")
    modal = FeedbackModal(
        queue_entry_id=entry["id"], rating=5, machine_name=machine["name"],
    )
    modal.comment = MagicMock(value="great")
    await modal.on_submit(fake_interaction)
    saved = await models.get_feedback_by_entry(entry["id"])
    assert saved["rating"] == 5
    assert saved["comment"] == "great"
    fake_interaction.response.send_message.assert_awaited_once()


async def test_modal_submit_blank_comment_writes_null(db, fake_interaction):
    entry, machine = await _make_completed_entry("rate-blank")
    modal = FeedbackModal(
        queue_entry_id=entry["id"], rating=3, machine_name=machine["name"],
    )
    modal.comment = MagicMock(value="")
    await modal.on_submit(fake_interaction)
    saved = await models.get_feedback_by_entry(entry["id"])
    assert saved["comment"] is None


async def test_modal_submit_duplicate_shows_friendly_error(db, fake_interaction):
    entry, machine = await _make_completed_entry("rate-dup")
    await models.create_feedback(
        queue_entry_id=entry["id"], rating=2, comment=None,
    )
    modal = FeedbackModal(
        queue_entry_id=entry["id"], rating=4, machine_name=machine["name"],
    )
    modal.comment = MagicMock(value="late")
    await modal.on_submit(fake_interaction)
    fake_interaction.response.send_message.assert_awaited_once()
    args, kwargs = fake_interaction.response.send_message.call_args
    msg = args[0] if args else kwargs.get("content", "")
    assert "already" in msg.lower()


async def test_skip_button_writes_nothing(db, fake_interaction):
    entry, machine = await _make_completed_entry("rate-skip")
    view = RatingView(
        queue_entry_id=entry["id"], machine_name=machine["name"],
    )
    skip = next(
        b for b in view.children if getattr(b, "_rating", None) is None
    )
    await skip.callback(fake_interaction)
    assert await models.get_feedback_by_entry(entry["id"]) is None
