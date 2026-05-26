"""Persistence for switch-log sessions (data/switches.json).

Each completed recording session is appended as one object: when it started and
stopped, each camera's record-start timestamp, and the ordered list of operator
"takes" (which camera was the program feed and at what offset). The editor uses
this in post to cut the final edit from the per-angle recordings.

Offsets are seconds from the session start, so they map directly onto the
recording timeline. Absolute epochs are kept as the authoritative anchor.
"""
import json
from pathlib import Path

STORE = Path(__file__).resolve().parents[2] / "data" / "switches.json"


def append_session(session: dict) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    try:
        data = json.loads(STORE.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            data = []
    except Exception:
        data = []
    data.append(session)
    STORE.write_text(json.dumps(data, indent=2), encoding="utf-8")
