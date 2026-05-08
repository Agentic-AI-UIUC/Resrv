import pytest


@pytest.mark.asyncio
async def test_machines_has_time_limit_minutes(db):
    cur = await db.execute("PRAGMA table_info(machines)")
    cols = {r[1] for r in await cur.fetchall()}
    assert "time_limit_minutes" in cols


@pytest.mark.asyncio
async def test_queue_entries_has_time_limit_columns(db):
    cur = await db.execute("PRAGMA table_info(queue_entries)")
    cols = {r[1] for r in await cur.fetchall()}
    assert "time_limit_notified_at" in cols
    assert "extended_until" in cols


from db import models


@pytest.mark.asyncio
async def test_update_machine_time_limit(db):
    m = await models.create_machine(name="Test", slug="test")
    await models.update_machine(m["id"], time_limit_minutes=60)
    updated = await models.get_machine(m["id"])
    assert updated["time_limit_minutes"] == 60


@pytest.mark.asyncio
async def test_update_machine_clear_time_limit(db):
    m = await models.create_machine(name="Test", slug="test")
    await models.update_machine(m["id"], time_limit_minutes=60)
    await models.update_machine(m["id"], time_limit_minutes=None)
    updated = await models.get_machine(m["id"])
    assert updated["time_limit_minutes"] is None


@pytest.mark.asyncio
async def test_update_machine_zero_clears_time_limit(db):
    m = await models.create_machine(name="Test", slug="test")
    await models.update_machine(m["id"], time_limit_minutes=0)
    updated = await models.get_machine(m["id"])
    assert updated["time_limit_minutes"] is None


@pytest.mark.asyncio
async def test_get_avg_serve_minutes_no_data(db):
    m = await models.create_machine(name="Test", slug="test")
    result = await models.get_avg_serve_minutes(m["id"])
    assert result is None


@pytest.mark.asyncio
async def test_extend_entry_time(db):
    m = await models.create_machine(name="Test", slug="test")
    u = await models.get_or_create_user(discord_id="1", discord_name="a")
    entry = await models.join_queue(u["id"], m["id"])
    eid = entry["id"]
    await models.update_entry_status(eid, "serving")
    await models.mark_time_limit_notified(eid)

    from db.database import get_db
    db_conn = await get_db()
    cur = await db_conn.execute("SELECT time_limit_notified_at FROM queue_entries WHERE id=?", (eid,))
    row = await cur.fetchone()
    assert row["time_limit_notified_at"] is not None

    await models.extend_entry_time(eid, 30)
    cur = await db_conn.execute("SELECT extended_until, time_limit_notified_at FROM queue_entries WHERE id=?", (eid,))
    row = await cur.fetchone()
    assert row["extended_until"] is not None
    assert row["time_limit_notified_at"] is None
