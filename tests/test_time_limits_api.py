"""Tests for machine time-limit API surface."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from api.main import app
from config import settings as cfg
from db import database as database_mod, models

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def client(db):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def _auth_headers(client):
    r = await client.post(
        "/api/auth/login",
        json={"username": cfg.staff_username, "password": cfg.staff_password},
    )
    return {"Authorization": f"Bearer {r.json()['token']}"}


async def test_patch_machine_time_limit(client):
    h = await _auth_headers(client)
    r = await client.get("/api/machines/")
    machines = r.json()
    mid = machines[0]["id"]
    r = await client.patch(
        f"/api/machines/{mid}",
        json={"time_limit_minutes": 45},
        headers=h,
    )
    assert r.status_code == 200
    assert r.json()["time_limit_minutes"] == 45


async def test_patch_machine_clear_time_limit(client):
    h = await _auth_headers(client)
    r = await client.get("/api/machines/")
    mid = r.json()[0]["id"]
    await client.patch(
        f"/api/machines/{mid}",
        json={"time_limit_minutes": 45},
        headers=h,
    )
    r = await client.patch(
        f"/api/machines/{mid}",
        json={"time_limit_minutes": 0},
        headers=h,
    )
    assert r.status_code == 200
    assert r.json()["time_limit_minutes"] is None


async def test_machine_list_includes_time_limit(client):
    h = await _auth_headers(client)
    r = await client.get("/api/machines/")
    mid = r.json()[0]["id"]
    await client.patch(
        f"/api/machines/{mid}",
        json={"time_limit_minutes": 30},
        headers=h,
    )
    r = await client.get("/api/machines/")
    assert r.status_code == 200
    machine = next(m for m in r.json() if m["id"] == mid)
    assert machine["time_limit_minutes"] == 30


async def test_suggested_time_limit_no_data(client):
    h = await _auth_headers(client)
    r = await client.get("/api/machines/")
    mid = r.json()[0]["id"]
    r = await client.get(
        f"/api/machines/{mid}/suggested-time-limit",
        headers=h,
    )
    assert r.status_code == 200
    assert r.json()["suggested_minutes"] is None
    assert r.json()["sample_days"] == 14
