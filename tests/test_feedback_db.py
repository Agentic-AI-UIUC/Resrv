"""DB-layer tests for the feedback table."""
import pytest
from db import models

pytestmark = pytest.mark.asyncio


async def _make_completed_entry(*, discord_id: str, college_name: str | None = None):
    user = await models.get_or_create_user(discord_id=discord_id, discord_name="u")
    if college_name:
        college = await models.create_college(college_name)
        await models.register_user(
            user_id=user["id"], full_name="X", email=f"{discord_id}@illinois.edu",
            major="CS", college_id=college["id"], graduation_year="2027",
        )
    machines = await models.get_machines()
    entry = await models.join_queue(user["id"], machines[0]["id"])
    await models.update_entry_status(entry["id"], "serving")
    await models.update_entry_status(entry["id"], "completed", job_successful=1)
    return entry, user, machines[0]


async def test_create_feedback(db):
    entry, _, _ = await _make_completed_entry(discord_id="fb-create")
    row = await models.create_feedback(
        queue_entry_id=entry["id"], rating=5, comment="great",
    )
    assert row["id"] > 0
    assert row["rating"] == 5
    assert row["comment"] == "great"


async def test_create_feedback_with_null_comment(db):
    entry, _, _ = await _make_completed_entry(discord_id="fb-null")
    row = await models.create_feedback(
        queue_entry_id=entry["id"], rating=3, comment=None,
    )
    assert row["comment"] is None


async def test_create_feedback_dup_raises(db):
    entry, _, _ = await _make_completed_entry(discord_id="fb-dup")
    await models.create_feedback(queue_entry_id=entry["id"], rating=4, comment=None)
    with pytest.raises(models.FeedbackAlreadyExistsError):
        await models.create_feedback(queue_entry_id=entry["id"], rating=2, comment=None)


async def test_get_feedback_by_entry_returns_none_when_absent(db):
    entry, _, _ = await _make_completed_entry(discord_id="fb-none")
    assert await models.get_feedback_by_entry(entry["id"]) is None


async def test_list_feedback_ordered_desc(db):
    e1, _, _ = await _make_completed_entry(discord_id="fb-1")
    e2, _, _ = await _make_completed_entry(discord_id="fb-2")
    await models.create_feedback(queue_entry_id=e1["id"], rating=1, comment="bad")
    await models.create_feedback(queue_entry_id=e2["id"], rating=5, comment="ok")
    rows = await models.list_feedback()
    assert rows[0]["queue_entry_id"] == e2["id"]
    assert rows[1]["queue_entry_id"] == e1["id"]


async def test_list_feedback_filters_by_min_max_rating(db):
    e1, _, _ = await _make_completed_entry(discord_id="fb-r1")
    e2, _, _ = await _make_completed_entry(discord_id="fb-r2")
    e3, _, _ = await _make_completed_entry(discord_id="fb-r3")
    await models.create_feedback(queue_entry_id=e1["id"], rating=2, comment=None)
    await models.create_feedback(queue_entry_id=e2["id"], rating=4, comment=None)
    await models.create_feedback(queue_entry_id=e3["id"], rating=5, comment=None)
    rows = await models.list_feedback(min_rating=3)
    assert {r["queue_entry_id"] for r in rows} == {e2["id"], e3["id"]}
    rows = await models.list_feedback(max_rating=4)
    assert {r["queue_entry_id"] for r in rows} == {e1["id"], e2["id"]}


async def test_list_feedback_includes_joined_fields(db):
    entry, user, machine = await _make_completed_entry(
        discord_id="fb-joined", college_name="JoinedCollege",
    )
    await models.create_feedback(
        queue_entry_id=entry["id"], rating=4, comment="nice",
    )
    rows = await models.list_feedback()
    row = next(r for r in rows if r["queue_entry_id"] == entry["id"])
    assert row["machine_name"] == machine["name"]
    assert row["college_name"] == "JoinedCollege"
    assert row["full_name"] == "X"
    assert row["user_id"] == user["id"]


async def test_feedback_aggregates_overall_handles_empty(db):
    agg = await models.feedback_aggregates_overall("2000-01-01", "2099-01-01")
    assert agg["rating_count"] == 0
    assert agg["avg_rating"] is None


async def test_feedback_aggregates_overall_computes(db):
    e1, _, _ = await _make_completed_entry(discord_id="agg-1")
    e2, _, _ = await _make_completed_entry(discord_id="agg-2")
    await models.create_feedback(queue_entry_id=e1["id"], rating=3, comment=None)
    await models.create_feedback(queue_entry_id=e2["id"], rating=5, comment=None)
    agg = await models.feedback_aggregates_overall("2000-01-01", "2099-01-01")
    assert agg["rating_count"] == 2
    assert agg["avg_rating"] == 4.0
