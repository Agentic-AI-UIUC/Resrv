"""College CRUD routes — admin-managed UIUC college list."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from api.auth import require_admin, require_staff, verify_token
from db import models

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/colleges", tags=["colleges"])


# ── Schemas ──────────────────────────────────────────────────────────────


class CollegePublic(BaseModel):
    id: int
    name: str


class CollegeAdmin(BaseModel):
    id: int
    name: str
    archived_at: str | None = None


class CollegeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class CollegeUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class CollegePurgeBody(BaseModel):
    confirm_name: str


def _to_admin(row: dict) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "archived_at": row.get("archived_at"),
    }


def _to_public(row: dict) -> dict:
    return {"id": row["id"], "name": row["name"]}


def _require_staff_token(authorization: str | None) -> None:
    """Manual staff-token check used by routes that conditionally gate on auth."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    if verify_token(token) is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


# ── Public / staff endpoints ─────────────────────────────────────────────


@router.get("/")
async def list_all(
    include_archived: bool = Query(False),
    authorization: str | None = Header(default=None),
) -> list[dict]:
    """List colleges.

    Public callers get active rows only with ``archived_at`` stripped.
    Staff callers passing ``include_archived=true`` get full rows.
    """
    if include_archived:
        _require_staff_token(authorization)
        rows = await models.list_all_colleges()
        return [_to_admin(r) for r in rows]

    rows = await models.list_active_colleges()
    return [_to_public(r) for r in rows]


# ── Admin-only endpoints ─────────────────────────────────────────────────


@router.post(
    "/",
    response_model=CollegeAdmin,
    status_code=201,
    dependencies=[Depends(require_admin)],
)
async def create(body: CollegeCreate) -> dict:
    try:
        row = await models.create_college(body.name)
    except models.DuplicateCollegeError:
        raise HTTPException(status_code=409, detail="College already exists")
    return _to_admin(row)


@router.patch(
    "/{college_id}",
    response_model=CollegeAdmin,
    dependencies=[Depends(require_admin)],
)
async def patch(college_id: int, body: CollegeUpdate) -> dict:
    if await models.get_college(college_id) is None:
        raise HTTPException(status_code=404, detail="College not found")
    try:
        updated = await models.update_college(college_id, name=body.name)
    except models.DuplicateCollegeError:
        raise HTTPException(status_code=409, detail="College name already exists")
    assert updated is not None
    return _to_admin(updated)


@router.delete(
    "/{college_id}",
    status_code=204,
    dependencies=[Depends(require_admin)],
)
async def delete(
    college_id: int,
    purge: bool = Query(False),
    body: CollegePurgeBody | None = Body(default=None),
) -> Response:
    college = await models.get_college(college_id)
    if college is None:
        raise HTTPException(status_code=404, detail="College not found")

    if purge:
        if body is None or body.confirm_name != college["name"]:
            raise HTTPException(
                status_code=400,
                detail="confirm_name must equal the college name",
            )
        try:
            await models.purge_college(college_id)
        except models.CollegeInUseError:
            raise HTTPException(
                status_code=409,
                detail="College has registered users; reassign or remove them first.",
            )
        log.warning("Purged college id=%s name=%s", college_id, college["name"])
        return Response(status_code=204)

    await models.archive_college(college_id)
    return Response(status_code=204)


@router.post(
    "/{college_id}/restore",
    response_model=CollegeAdmin,
    dependencies=[Depends(require_admin)],
)
async def restore(college_id: int) -> dict:
    if await models.get_college(college_id) is None:
        raise HTTPException(status_code=404, detail="College not found")
    try:
        await models.restore_college(college_id)
    except models.DuplicateCollegeError:
        raise HTTPException(
            status_code=409,
            detail="An active college with this name already exists",
        )
    restored = await models.get_college(college_id)
    assert restored is not None
    return _to_admin(restored)
