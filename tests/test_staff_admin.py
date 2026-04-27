"""Tests for admin-only staff management endpoints."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from api.auth import hash_password
from api.main import app

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def client(db) -> AsyncClient:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


async def _seed(db, username, password, role):
    cursor = await db.execute(
        "INSERT INTO staff_users (username, password_hash, role) "
        "VALUES (?, ?, ?) RETURNING id",
        (username, hash_password(password), role),
    )
    row = await cursor.fetchone()
    await db.commit()
    return row["id"]


async def _login(client, username, password):
    r = await client.post(
        "/api/auth/login", json={"username": username, "password": password}
    )
    return r.json()["token"]


async def _admin_headers(client, db):
    # Login as the already-seeded default admin
    from config import settings
    token = await _login(client, settings.staff_username, settings.staff_password)
    return {"Authorization": f"Bearer {token}"}


async def test_list_staff(client, db):
    headers = await _admin_headers(client, db)
    r = await client.get("/api/staff/", headers=headers)
    assert r.status_code == 200
    usernames = [s["username"] for s in r.json()]
    assert "admin" in usernames


async def test_create_staff(client, db):
    headers = await _admin_headers(client, db)
    r = await client.post(
        "/api/staff/",
        headers=headers,
        json={"username": "carol", "password": "carolpw", "role": "staff"},
    )
    assert r.status_code == 201
    assert r.json()["username"] == "carol"


async def test_create_staff_duplicate_username(client, db):
    headers = await _admin_headers(client, db)
    await client.post(
        "/api/staff/",
        headers=headers,
        json={"username": "carol", "password": "carolpw1", "role": "staff"},
    )
    r = await client.post(
        "/api/staff/",
        headers=headers,
        json={"username": "carol", "password": "carolpw2", "role": "staff"},
    )
    assert r.status_code == 409


async def test_last_admin_cannot_be_deleted(client, db):
    headers = await _admin_headers(client, db)
    r = await client.get("/api/staff/", headers=headers)
    admin_row = next(s for s in r.json() if s["role"] == "admin")
    r = await client.delete(f"/api/staff/{admin_row['id']}", headers=headers)
    assert r.status_code == 409
    assert "last admin" in r.json()["detail"].lower()


async def test_last_admin_cannot_be_demoted(client, db):
    headers = await _admin_headers(client, db)
    admin_row = next(
        s for s in (await client.get("/api/staff/", headers=headers)).json()
        if s["role"] == "admin"
    )
    r = await client.patch(
        f"/api/staff/{admin_row['id']}", headers=headers, json={"role": "staff"}
    )
    assert r.status_code == 409


async def test_reset_password(client, db):
    headers = await _admin_headers(client, db)
    create = await client.post(
        "/api/staff/",
        headers=headers,
        json={"username": "dave", "password": "oldpw1", "role": "staff"},
    )
    dave_id = create.json()["id"]
    r = await client.patch(
        f"/api/staff/{dave_id}", headers=headers, json={"password": "newpw2"}
    )
    assert r.status_code == 200
    login = await client.post(
        "/api/auth/login", json={"username": "dave", "password": "newpw2"}
    )
    assert login.status_code == 200


async def test_staff_role_cannot_hit_admin_endpoints(client, db):
    await _seed(db, "eve", "evepw", "staff")
    token = await _login(client, "eve", "evepw")
    r = await client.get(
        "/api/staff/", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 403
