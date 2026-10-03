from fastapi import APIRouter, Depends

from app.core.deps import get_current_user
from app.core.engines import engine_catalog

router = APIRouter(tags=["engines"])


@router.get("/engines", dependencies=[Depends(get_current_user)])
async def list_engines():
    return [{key: value for key, value in entry.items() if key != "cache_key"}
            for entry in await engine_catalog()]
