"""Machine unit endpoints, nested under /api/machines/{mid}/units/."""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from api.auth import require_admin, require_staff
from api.deps import notify_embed_update
from db import models

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/machines/{machine_id}/units",
    tags=["units"],
)


# ── Schemas ──────────────────────────────────────────────────────────────

class UnitOut(BaseModel):
    id: int
    machine_id: int
    label: str
    status: str
    archived_at: str | None = None
    created_at: str


class UnitCreate(BaseModel):
    label: str = Field(min_length=1, max_length=64)


class UnitUpdate(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=64)
    status: Literal["active", "maintenance"] | None = None


class UnitPurgeConfirm(BaseModel):
    confirm_label: str


async def _require_machine(machine_id: int) -> dict:
    m = await models.get_machine(machine_id)
    if m is None:
        raise HTTPException(status_code=404, detail="Machine not found")
    return m


async def _require_unit(machine_id: int, unit_id: int) -> dict:
    u = await models.get_unit(unit_id)
    if u is None or u["machine_id"] != machine_id:
        raise HTTPException(status_code=404, detail="Unit not found")
    return u


# ── Routes ───────────────────────────────────────────────────────────────

@router.get("/", response_model=list[UnitOut])
async def list_all(
    machine_id: int, include_archived: bool = Query(False)
) -> list[dict]:
    await _require_machine(machine_id)
    return await models.list_units(machine_id, include_archived=include_archived)


@router.post(
    "/",
    response_model=UnitOut,
    status_code=201,
    dependencies=[Depends(require_staff)],
)
async def create(machine_id: int, body: UnitCreate) -> dict:
    await _require_machine(machine_id)
    try:
        u = await models.create_unit(machine_id=machine_id, label=body.label)
    except ValueError as e:
        msg = str(e)
        code = 409 if "already in use" in msg else 400
        raise HTTPException(status_code=code, detail=msg)
    notify_embed_update(machine_id)
    return u


@router.patch(
    "/{unit_id}",
    response_model=UnitOut,
    dependencies=[Depends(require_staff)],
)
async def patch(machine_id: int, unit_id: int, body: UnitUpdate) -> dict:
    await _require_unit(machine_id, unit_id)
    try:
        await models.update_unit(unit_id, label=body.label, status=body.status)
    except ValueError as e:
        msg = str(e)
        code = 409 if "already in use" in msg else 400
        raise HTTPException(status_code=code, detail=msg)
    notify_embed_update(machine_id)
    after = await models.get_unit(unit_id)
    assert after is not None
    return after


@router.delete("/{unit_id}", dependencies=[Depends(require_admin)])
async def delete(
    machine_id: int,
    unit_id: int,
    purge: bool = Query(False),
    body: UnitPurgeConfirm | None = Body(default=None),
) -> dict:
    u = await _require_unit(machine_id, unit_id)
    try:
        if purge:
            if body is None or body.confirm_label != u["label"]:
                raise HTTPException(
                    status_code=400,
                    detail="confirm_label must equal the unit label",
                )
            await models.purge_unit(unit_id)
            notify_embed_update(machine_id)
            return {"status": "purged"}
        await models.archive_unit(unit_id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    notify_embed_update(machine_id)
    return {"status": "archived"}


@router.post(
    "/{unit_id}/restore",
    response_model=UnitOut,
    dependencies=[Depends(require_admin)],
)
async def restore(machine_id: int, unit_id: int) -> dict:
    await _require_unit(machine_id, unit_id)
    try:
        await models.restore_unit(unit_id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    notify_embed_update(machine_id)
    after = await models.get_unit(unit_id)
    assert after is not None
    return after
