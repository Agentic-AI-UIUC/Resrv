"""Tests for machine DB helpers (create/update/archive/restore/purge)."""

from __future__ import annotations

import pytest

from db import models

pytestmark = pytest.mark.asyncio


async def test_create_machine(db):
    m = await models.create_machine(name="New Tool", slug="new-tool")
    assert m["name"] == "New Tool"
    assert m["archived_at"] is None


async def test_create_machine_rejects_bad_slug(db):
    with pytest.raises(ValueError):
        await models.create_machine(name="Bad", slug="Bad Slug")


async def test_create_machine_rejects_duplicate_active_slug(db):
    await models.create_machine(name="Dup", slug="dup-tool")
    with pytest.raises(ValueError):
        await models.create_machine(name="Dup 2", slug="dup-tool")


async def test_archive_hides_from_list(db):
    m = await models.create_machine(name="X", slug="x-tool")
    await models.archive_machine(m["id"])
    listed = await models.list_machines()
    assert all(row["slug"] != "x-tool" for row in listed)
    all_rows = await models.list_machines(include_archived=True)
    assert any(row["slug"] == "x-tool" for row in all_rows)


async def test_restore_brings_it_back(db):
    m = await models.create_machine(name="R", slug="r-tool")
    await models.archive_machine(m["id"])
    await models.restore_machine(m["id"])
    assert any(
        row["slug"] == "r-tool" for row in await models.list_machines()
    )


async def test_restore_blocked_if_slug_taken(db):
    a = await models.create_machine(name="A", slug="shared")
    await models.archive_machine(a["id"])
    await models.create_machine(name="B", slug="shared")
    with pytest.raises(ValueError):
        await models.restore_machine(a["id"])


async def test_purge_removes_row(db):
    m = await models.create_machine(name="Doomed", slug="doomed")
    await models.purge_machine(m["id"])
    assert await models.get_machine(m["id"]) is None


async def test_update_machine_slug_uniqueness(db):
    a = await models.create_machine(name="A", slug="alpha")
    b = await models.create_machine(name="B", slug="beta")
    with pytest.raises(ValueError):
        await models.update_machine(b["id"], slug="alpha")
    await models.update_machine(b["id"], slug="gamma")


async def test_count_active_queue_entries(db):
    m = (await models.list_machines())[0]
    assert await models.count_active_queue_entries(m["id"]) == 0
    user = await models.get_or_create_user("u1", "U1")
    await models.join_queue(user["id"], m["id"])
    assert await models.count_active_queue_entries(m["id"]) == 1
