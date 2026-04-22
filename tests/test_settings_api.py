"""Tests for /api/settings (admin-only) and /api/public-settings (public)."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from api.auth import hash_password
from api.main import app
from config import settings as cfg

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def client(db) -> AsyncClient:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


async def _admin_headers(client):
    r = await client.post(
        "/api/auth/login",
        json={"username": cfg.staff_username, "password": cfg.staff_password},
    )
    return {"Authorization": f"Bearer {r.json()['token']}"}


async def test_get_settings_returns_defaults(client, db):
    headers = await _admin_headers(client)
    r = await client.get("/api/settings/", headers=headers)
    assert r.status_code == 200
    data = r.json()
    assert data["reminder_minutes"] == "30"
    assert data["public_mode"] == "false"


async def test_patch_settings_updates(client, db):
    headers = await _admin_headers(client)
    r = await client.patch(
        "/api/settings/",
        headers=headers,
        json={"reminder_minutes": "45", "public_mode": "true"},
    )
    assert r.status_code == 200
    follow = await client.get("/api/settings/", headers=headers)
    assert follow.json()["reminder_minutes"] == "45"
    assert follow.json()["public_mode"] == "true"


async def test_patch_rejects_unknown_key(client, db):
    headers = await _admin_headers(client)
    r = await client.patch(
        "/api/settings/", headers=headers, json={"wat": "no"}
    )
    assert r.status_code == 400


async def test_settings_requires_admin(client, db):
    # Seed a non-admin
    await db.execute(
        "INSERT INTO staff_users (username, password_hash, role) "
        "VALUES (?, ?, ?)",
        ("eve", hash_password("evepw"), "staff"),
    )
    await db.commit()
    login = await client.post(
        "/api/auth/login", json={"username": "eve", "password": "evepw"}
    )
    token = login.json()["token"]
    r = await client.get(
        "/api/settings/", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 403


async def test_public_settings_no_auth(client, db):
    r = await client.get("/api/public-settings/")
    assert r.status_code == 200
    data = r.json()
    assert "public_mode" in data
    assert "maintenance_banner" in data
    assert set(data.keys()) == {"public_mode", "maintenance_banner"}
