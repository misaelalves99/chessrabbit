"""The worker advertises configured UCI engines through Redis."""

import json

from fastapi import HTTPException

from app.core.redis_client import get_redis


async def engine_catalog() -> list[dict]:
    raw = await get_redis().get("engines:catalog")
    return json.loads(raw) if raw else []


async def resolve_engine(engine_id: str) -> dict:
    catalog = await engine_catalog()
    if not catalog:
        raise HTTPException(503, detail={"code": "engine_unavailable", "message": "Engine worker is starting or offline"})
    for entry in catalog:
        if entry["id"] == engine_id:
            if not entry["available"]:
                raise HTTPException(503, detail={"code": "engine_unavailable", "message": f"{entry['name']} is not configured. Check engine settings."})
            return entry
    raise HTTPException(400, detail={"code": "unknown_engine", "message": "Unknown engine profile"})
