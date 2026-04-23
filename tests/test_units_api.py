"""Unit CRUD API tests — nested under /api/machines/{mid}/units/."""

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


async def _staff_headers(client, db):
    await db.execute(
        "INSERT OR IGNORE INTO staff_users (username, password_hash, role) "
        "VALUES (?, ?, ?)",
        ("stafftest", hash_password("pw"), "staff"),
    )
    await db.commit()
    r = await client.post(
        "/api/auth/login", json={"username": "stafftest", "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['token']}"}


async def _first_machine_id(client):
    machines = (await client.get("/api/machines/")).json()
    return machines[0]["id"]


async def test_list_units_public(client, db):
    mid = await _first_machine_id(client)
    r = await client.get(f"/api/machines/{mid}/units/")
    assert r.status_code == 200, r.text
    data = r.json()
    assert len(data) == 1
    assert data[0]["label"] == "Main"


async def test_create_unit_requires_auth(client, db):
    mid = await _first_machine_id(client)
    r = await client.post(
        f"/api/machines/{mid}/units/", json={"label": "Prusa"}
    )
    assert r.status_code == 401


async def test_create_unit_staff_ok(client, db):
    mid = await _first_machine_id(client)
    h = await _staff_headers(client, db)
    r = await client.post(
        f"/api/machines/{mid}/units/",
        json={"label": "Prusa MK4"}, headers=h,
    )
    assert r.status_code == 201, r.text
    assert r.json()["label"] == "Prusa MK4"


async def test_create_unit_duplicate_label_409(client, db):
    mid = await _first_machine_id(client)
    h = await _staff_headers(client, db)
    await client.post(
        f"/api/machines/{mid}/units/", json={"label": "Dup"}, headers=h,
    )
    r = await client.post(
        f"/api/machines/{mid}/units/", json={"label": "Dup"}, headers=h,
    )
    assert r.status_code == 409


async def test_patch_unit_status_staff_ok(client, db):
    mid = await _first_machine_id(client)
    h = await _staff_headers(client, db)
    created = (await client.post(
        f"/api/machines/{mid}/units/", json={"label": "X"}, headers=h,
    )).json()
    r = await client.patch(
        f"/api/machines/{mid}/units/{created['id']}",
        json={"status": "maintenance"}, headers=h,
    )
    assert r.status_code == 200
    assert r.json()["status"] == "maintenance"


async def test_delete_unit_requires_admin(client, db):
    mid = await _first_machine_id(client)
    staff_h = await _staff_headers(client, db)
    admin_h = await _admin_headers(client)

    created = (await client.post(
        f"/api/machines/{mid}/units/",
        json={"label": "ToDel"}, headers=staff_h,
    )).json()

    r = await client.delete(
        f"/api/machines/{mid}/units/{created['id']}", headers=staff_h,
    )
    assert r.status_code == 403

    r = await client.delete(
        f"/api/machines/{mid}/units/{created['id']}", headers=admin_h,
    )
    assert r.status_code == 200
    assert r.json()["status"] == "archived"


async def test_restore_unit_admin(client, db):
    mid = await _first_machine_id(client)
    staff_h = await _staff_headers(client, db)
    admin_h = await _admin_headers(client)

    created = (await client.post(
        f"/api/machines/{mid}/units/",
        json={"label": "Restorable"}, headers=staff_h,
    )).json()
    await client.delete(
        f"/api/machines/{mid}/units/{created['id']}", headers=admin_h,
    )
    r = await client.post(
        f"/api/machines/{mid}/units/{created['id']}/restore",
        headers=admin_h,
    )
    assert r.status_code == 200
    assert r.json()["archived_at"] is None


async def test_purge_unit_requires_confirm_label(client, db):
    mid = await _first_machine_id(client)
    staff_h = await _staff_headers(client, db)
    admin_h = await _admin_headers(client)

    created = (await client.post(
        f"/api/machines/{mid}/units/",
        json={"label": "Purgable"}, headers=staff_h,
    )).json()

    r = await client.request(
        "DELETE",
        f"/api/machines/{mid}/units/{created['id']}?purge=true",
        headers=admin_h,
        json={"confirm_label": "WRONG"},
    )
    assert r.status_code == 400

    r = await client.request(
        "DELETE",
        f"/api/machines/{mid}/units/{created['id']}?purge=true",
        headers=admin_h,
        json={"confirm_label": "Purgable"},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "purged"


async def test_units_on_missing_machine_404(client, db):
    r = await client.get("/api/machines/99999/units/")
    assert r.status_code == 404
