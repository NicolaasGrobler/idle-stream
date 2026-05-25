"""Persistence for the camera list (data/cameras.json).

Seeded with three sensible defaults on first run so a fresh setup still works.
"""
import json
from pathlib import Path

from .state import Camera

STORE = Path(__file__).resolve().parents[2] / "data" / "cameras.json"
DEFAULTS = [{"id": "cam1", "label": "Wide"}, {"id": "cam2", "label": "Pulpit"}, {"id": "cam3", "label": "Side"}]


def load() -> list:
    try:
        raw = json.loads(STORE.read_text(encoding="utf-8"))
        cams = [Camera(id=c["id"], label=c["label"]) for c in raw if c.get("id")]
        if cams:
            return cams
    except Exception:
        pass
    cams = [Camera(**c) for c in DEFAULTS]
    save(cams)
    return cams


def save(cameras: list) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    data = [{"id": c.id, "label": c.label} for c in cameras]
    STORE.write_text(json.dumps(data, indent=2), encoding="utf-8")
