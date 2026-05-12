"""
RoofIQ Depth Pipeline — FastAPI entry point.
POST /analyze  → image file  → depth map + 3D plane segmentation + measurements
GET  /health   → liveness check
"""

import logging
import os
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from pipeline import run_depth_pipeline

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="RoofIQ Depth Pipeline", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)

REPLICATE_TOKEN = os.environ.get("REPLICATE_API_TOKEN", "")
MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20 MB


@app.get("/health")
def health():
    return {"status": "ok", "replicate_configured": bool(REPLICATE_TOKEN)}


@app.post("/analyze")
async def analyze_roof(file: UploadFile = File(...)):
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Must upload an image file")

    image_bytes = await file.read()
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="Image too large (max 20 MB)")
    if len(image_bytes) < 1024:
        raise HTTPException(status_code=400, detail="Image too small or corrupt")

    if not REPLICATE_TOKEN:
        raise HTTPException(
            status_code=503,
            detail="REPLICATE_API_TOKEN not configured. Add it to Railway environment variables.",
        )

    logger.info("Starting depth pipeline for %s (%d bytes)", file.filename, len(image_bytes))
    try:
        result = run_depth_pipeline(image_bytes, REPLICATE_TOKEN)
        logger.info("Pipeline complete — %d planes detected", len(result.get("planes", [])))
        return result
    except Exception as exc:
        logger.exception("Pipeline failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
