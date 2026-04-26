"""HTTP-layer tests for /api/colleges."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

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


async def test_public_get_returns_active_only(client):
    res = await client.get("/api/colleges/")
    assert res.status_code == 200
    body = res.json()
    assert any(c["name"] == "Grainger College of Engineering" for c in body)
    # public response strips metadata
    assert "archived_at" not in body[0]


async def test_admin_get_with_archived_includes_archived(client):
    h = await _admin_headers(client)
    create = await client.post("/api/colleges/", json={"name": "Temp"}, headers=h)
    cid = create.json()["id"]
    await client.delete(f"/api/colleges/{cid}", headers=h)  # archive

    res = await client.get("/api/colleges/?include_archived=true", headers=h)
    assert res.status_code == 200
    names = {c["name"] for c in res.json()}
    assert "Temp" in names


async def test_post_requires_admin(client):
    res = await client.post("/api/colleges/", json={"name": "NoAuth"})
    assert res.status_code == 401


async def test_post_dup_returns_409(client):
    h = await _admin_headers(client)
    await client.post("/api/colleges/", json={"name": "Dupe"}, headers=h)
    res = await client.post("/api/colleges/", json={"name": "Dupe"}, headers=h)
    assert res.status_code == 409


async def test_patch_renames(client):
    h = await _admin_headers(client)
    create = await client.post("/api/colleges/", json={"name": "OldNm"}, headers=h)
    cid = create.json()["id"]
    res = await client.patch(
        f"/api/colleges/{cid}", json={"name": "NewNm"}, headers=h
    )
    assert res.status_code == 200
    assert res.json()["name"] == "NewNm"


async def test_archive_and_restore_roundtrip(client):
    h = await _admin_headers(client)
    create = await client.post(
        "/api/colleges/", json={"name": "RoundTrip"}, headers=h
    )
    cid = create.json()["id"]
    arch = await client.delete(f"/api/colleges/{cid}", headers=h)
    assert arch.status_code == 204
    restore = await client.post(f"/api/colleges/{cid}/restore", headers=h)
    assert restore.status_code == 200
    assert restore.json()["archived_at"] is None


async def test_purge_blocked_when_users_reference(
    client, registered_user_in_college
):
    h = await _admin_headers(client)
    cid = registered_user_in_college
    res = await client.request(
        "DELETE",
        f"/api/colleges/{cid}?purge=true",
        json={"confirm_name": "Has Users"},
        headers=h,
    )
    assert res.status_code == 409


async def test_purge_requires_confirm_name(client):
    h = await _admin_headers(client)
    create = await client.post(
        "/api/colleges/", json={"name": "Purgeable"}, headers=h
    )
    cid = create.json()["id"]
    await client.delete(f"/api/colleges/{cid}", headers=h)  # archive first
    res = await client.request(
        "DELETE",
        f"/api/colleges/{cid}?purge=true",
        json={"confirm_name": "Wrong"},
        headers=h,
    )
    assert res.status_code == 400


async def test_purge_succeeds_when_clear(client):
    h = await _admin_headers(client)
    create = await client.post(
        "/api/colleges/", json={"name": "PurgeOK"}, headers=h
    )
    cid = create.json()["id"]
    await client.delete(f"/api/colleges/{cid}", headers=h)
    res = await client.request(
        "DELETE",
        f"/api/colleges/{cid}?purge=true",
        json={"confirm_name": "PurgeOK"},
        headers=h,
    )
    assert res.status_code == 204
