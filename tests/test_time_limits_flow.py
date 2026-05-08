import pytest
from db import models
from db.database import get_db


@pytest.mark.asyncio
async def test_entries_past_time_limit_detected(db):
    """Entry on a machine with time_limit should show up when time has passed."""
    m = await models.create_machine(name="Fast", slug="fast")
    await models.update_machine(m["id"], time_limit_minutes=1)
    u = await models.get_or_create_user(discord_id="1", discord_name="a")
    entry = await models.join_queue(u["id"], m["id"])
    eid = entry["id"]

    db_conn = await get_db()
    await db_conn.execute(
        "UPDATE queue_entries SET status='serving', "
        "serving_at=datetime('now', '-2 minutes') WHERE id=?",
        (eid,),
    )
    await db_conn.commit()

    entries = await models.get_entries_past_time_limit()
    assert len(entries) == 1
    assert entries[0]["id"] == eid


@pytest.mark.asyncio
async def test_extend_resets_notification_cycle(db):
    """After extending, the entry should not appear in past-time-limit."""
    m = await models.create_machine(name="Test", slug="test")
    await models.update_machine(m["id"], time_limit_minutes=30)
    u = await models.get_or_create_user(discord_id="2", discord_name="b")
    entry = await models.join_queue(u["id"], m["id"])
    eid = entry["id"]
    await models.update_entry_status(eid, "serving")

    await models.mark_time_limit_notified(eid)
    await models.extend_entry_time(eid, 15)

    db_conn = await get_db()
    cur = await db_conn.execute(
        "SELECT time_limit_notified_at, extended_until FROM queue_entries WHERE id=?",
        (eid,),
    )
    row = await cur.fetchone()
    assert row["time_limit_notified_at"] is None
    assert row["extended_until"] is not None

    entries = await models.get_entries_past_time_limit()
    assert len(entries) == 0


@pytest.mark.asyncio
async def test_no_time_limit_machine_not_detected(db):
    """Machine without time_limit_minutes should never appear."""
    m = await models.create_machine(name="NoLimit", slug="nolimit")
    u = await models.get_or_create_user(discord_id="3", discord_name="c")
    entry = await models.join_queue(u["id"], m["id"])
    eid = entry["id"]

    db_conn = await get_db()
    await db_conn.execute(
        "UPDATE queue_entries SET status='serving', "
        "serving_at=datetime('now', '-999 minutes') WHERE id=?",
        (eid,),
    )
    await db_conn.commit()

    entries = await models.get_entries_past_time_limit()
    assert len(entries) == 0


@pytest.mark.asyncio
async def test_staff_notification_after_grace(db):
    """Notified entry past grace period should appear in no-response query."""
    m = await models.create_machine(name="Test", slug="test")
    await models.update_machine(m["id"], time_limit_minutes=30)
    u = await models.get_or_create_user(discord_id="4", discord_name="d")
    entry = await models.join_queue(u["id"], m["id"])
    eid = entry["id"]
    await models.update_entry_status(eid, "serving")

    db_conn = await get_db()
    await db_conn.execute(
        "UPDATE queue_entries SET time_limit_notified_at=datetime('now', '-15 minutes') "
        "WHERE id=?",
        (eid,),
    )
    await db_conn.commit()

    entries = await models.get_entries_time_limit_no_response(grace_minutes=10)
    assert len(entries) == 1
    assert entries[0]["id"] == eid


@pytest.mark.asyncio
async def test_already_notified_not_redetected(db):
    """Entry with time_limit_notified_at set should NOT appear in get_entries_past_time_limit."""
    m = await models.create_machine(name="Test2", slug="test2")
    await models.update_machine(m["id"], time_limit_minutes=1)
    u = await models.get_or_create_user(discord_id="5", discord_name="e")
    entry = await models.join_queue(u["id"], m["id"])
    eid = entry["id"]

    db_conn = await get_db()
    await db_conn.execute(
        "UPDATE queue_entries SET status='serving', "
        "serving_at=datetime('now', '-10 minutes'), "
        "time_limit_notified_at=datetime('now', '-5 minutes') WHERE id=?",
        (eid,),
    )
    await db_conn.commit()

    entries = await models.get_entries_past_time_limit()
    assert len(entries) == 0


@pytest.mark.asyncio
async def test_clear_notification_prevents_repeat_staff_alert(db):
    """After clearing notification, entry should not appear in no-response query."""
    m = await models.create_machine(name="Test3", slug="test3")
    await models.update_machine(m["id"], time_limit_minutes=30)
    u = await models.get_or_create_user(discord_id="6", discord_name="f")
    entry = await models.join_queue(u["id"], m["id"])
    eid = entry["id"]
    await models.update_entry_status(eid, "serving")

    db_conn = await get_db()
    await db_conn.execute(
        "UPDATE queue_entries SET time_limit_notified_at=datetime('now', '-15 minutes') "
        "WHERE id=?",
        (eid,),
    )
    await db_conn.commit()

    await models.clear_time_limit_notification(eid)
    entries = await models.get_entries_time_limit_no_response(grace_minutes=10)
    assert len(entries) == 0
