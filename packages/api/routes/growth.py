"""Growth dashboard endpoint."""
from fastapi import APIRouter

router = APIRouter()


@router.get("/{user_id}")
async def growth(user_id: str):
    # TODO: aggregate sessions for user, build trajectory + concept_scores.
    return {
        "sessions": [],
        "concept_scores": {},
        "overall_trajectory": [],
        "total_checkpoints": 0,
        "skipped_count": 0,
        "override_count": 0,
        "devin_prs_reviewed": 0,
    }
