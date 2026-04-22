"""Staff account management — admin-only."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from api.auth import hash_password, require_admin
from db import models

router = APIRouter(
    prefix="/api/staff",
    tags=["staff"],
    dependencies=[Depends(require_admin)],
)

Role = Literal["admin", "staff"]


class StaffOut(BaseModel):
    id: int
    username: str
    role: Role
    created_at: str


class StaffCreate(BaseModel):
    username: str = Field(min_length=3, max_length=40)
    password: str = Field(min_length=6)
    role: Role = "staff"


class StaffUpdate(BaseModel):
    role: Role | None = None
    password: str | None = Field(default=None, min_length=6)


@router.get("/", response_model=list[StaffOut])
async def list_all() -> list[dict]:
    return await models.list_staff()


@router.post(
    "/", response_model=StaffOut, status_code=status.HTTP_201_CREATED
)
async def create(body: StaffCreate) -> dict:
    existing = await models.get_staff_by_username(body.username)
    if existing is not None:
        raise HTTPException(status_code=409, detail="Username already exists")
    return await models.create_staff(
        body.username, hash_password(body.password), body.role
    )


@router.patch("/{staff_id}", response_model=StaffOut)
async def update(staff_id: int, body: StaffUpdate) -> dict:
    target = await models.get_staff(staff_id)
    if target is None:
        raise HTTPException(status_code=404, detail="Staff not found")
    if body.role == "staff" and target["role"] == "admin":
        if await models.count_admins() <= 1:
            raise HTTPException(
                status_code=409, detail="Cannot demote the last admin"
            )
    await models.update_staff(
        staff_id,
        role=body.role,
        password_hash=hash_password(body.password) if body.password else None,
    )
    updated = await models.get_staff(staff_id)
    assert updated is not None
    return updated


@router.delete("/{staff_id}")
async def delete(staff_id: int) -> dict[str, str]:
    target = await models.get_staff(staff_id)
    if target is None:
        raise HTTPException(status_code=404, detail="Staff not found")
    if target["role"] == "admin" and await models.count_admins() <= 1:
        raise HTTPException(
            status_code=409, detail="Cannot delete the last admin"
        )
    await models.delete_staff(staff_id)
    return {"status": "deleted"}
