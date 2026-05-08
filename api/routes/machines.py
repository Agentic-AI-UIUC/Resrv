"""Machine management endpoints."""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from api.auth import require_admin, require_staff
from api.deps import notify_embed_create, notify_embed_delete, notify_embed_update
from db import models

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/machines",
    tags=["machines"],
)


# ── Schemas ──────────────────────────────────────────────────────────────

class UnitSummary(BaseModel):
    id: int
    label: str
    status: str


class MachineOut(BaseModel):
    id: int
    name: str
    slug: str
    status: str
    time_limit_minutes: int | None = None
    archived_at: str | None = None
    created_at: str
    units: list[UnitSummary] = []


async def _attach_units(machine: dict) -> dict:
    units = await models.list_units(machine["id"])
    machine["units"] = [
        {"id": u["id"], "label": u["label"], "status": u["status"]}
        for u in units
    ]
    return machine


class MachineCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    slug: str = Field(min_length=1, max_length=60)


class MachineUpdate(BaseModel):
    name: str | None = None
    slug: str | None = None
    status: Literal["active", "maintenance", "offline"] | None = None
    time_limit_minutes: int | None = None


class MachineStatusUpdate(BaseModel):
    status: Literal["active", "maintenance", "offline"]


class PurgeConfirm(BaseModel):
    confirm_slug: str


# ── Public / staff endpoints ─────────────────────────────────────────────

@router.get("/", response_model=list[MachineOut])
async def list_all(include_archived: bool = Query(False)) -> list[dict]:
    """List machines. Public; admin UI may request archived too."""
    rows = await models.list_machines(include_archived=include_archived)
    for m in rows:
        await _attach_units(m)
    return rows


@router.get("/{machine_id}", response_model=MachineOut)
async def get_single(machine_id: int) -> dict:
    machine = await models.get_machine(machine_id)
    if machine is None:
        raise HTTPException(status_code=404, detail="Machine not found")
    return await _attach_units(machine)


# ── Staff endpoints (write) ──────────────────────────────────────────────

@router.post(
    "/",
    response_model=MachineOut,
    status_code=201,
    dependencies=[Depends(require_staff)],
)
async def create(body: MachineCreate) -> dict:
    try:
        m = await models.create_machine(name=body.name, slug=body.slug)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    notify_embed_create(m["id"])
    return await _attach_units(m)


@router.patch(
    "/{machine_id}",
    response_model=MachineOut,
    dependencies=[Depends(require_staff)],
)
async def patch(machine_id: int, body: MachineUpdate) -> dict:
    if await models.get_machine(machine_id) is None:
        raise HTTPException(status_code=404, detail="Machine not found")
    kwargs: dict = dict(name=body.name, slug=body.slug, status=body.status)
    if "time_limit_minutes" in body.model_fields_set:
        kwargs["time_limit_minutes"] = body.time_limit_minutes
    try:
        await models.update_machine(machine_id, **kwargs)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    notify_embed_update(machine_id)
    updated = await models.get_machine(machine_id)
    assert updated is not None
    return await _attach_units(updated)


@router.get(
    "/{machine_id}/suggested-time-limit",
    dependencies=[Depends(require_staff)],
)
async def suggested_time_limit(machine_id: int) -> dict:
    machine = await models.get_machine(machine_id)
    if machine is None:
        raise HTTPException(status_code=404, detail="Machine not found")
    avg = await models.get_avg_serve_minutes(machine_id, days=14)
    if avg is None:
        return {"suggested_minutes": None, "sample_days": 14}
    rounded = round(avg / 5) * 5 or 5
    return {"suggested_minutes": int(rounded), "sample_days": 14}


# ── Admin-only endpoints ─────────────────────────────────────────────────

@router.delete("/{machine_id}", dependencies=[Depends(require_admin)])
async def delete(
    machine_id: int,
    purge: bool = Query(False),
    body: PurgeConfirm | None = Body(default=None),
) -> dict:
    m = await models.get_machine(machine_id)
    if m is None:
        raise HTTPException(status_code=404, detail="Machine not found")
    active = await models.count_active_queue_entries(machine_id)
    if active > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Clear the queue first. {active} users still waiting.",
        )
    msg_id = m.get("embed_message_id")
    if purge:
        if body is None or body.confirm_slug != m["slug"]:
            raise HTTPException(
                status_code=400,
                detail="confirm_slug must equal the machine slug",
            )
        counts = await models.purge_machine(machine_id)
        notify_embed_delete(machine_id, msg_id)
        log.warning(
            "Purged machine slug=%s counts=%s", m["slug"], counts
        )
        return {"status": "purged", **counts}
    await models.archive_machine(machine_id)
    notify_embed_delete(machine_id, msg_id)
    return {"status": "archived"}


@router.post(
    "/{machine_id}/restore",
    response_model=MachineOut,
    dependencies=[Depends(require_admin)],
)
async def restore(machine_id: int) -> dict:
    try:
        await models.restore_machine(machine_id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    notify_embed_create(machine_id)
    restored = await models.get_machine(machine_id)
    assert restored is not None
    return await _attach_units(restored)
