"""In-memory session state for the control service.

Cameras are dynamic (operator can add/rename/remove); the canonical list is
persisted to disk by cameras.py. A "slot" is a camera id (e.g. cam1) — the
MediaMTX path a phone publishes to.
"""
from dataclasses import dataclass, field, asdict
from typing import Optional


@dataclass
class Camera:
    id: str        # MediaMTX path, e.g. "cam1"
    label: str     # display name, e.g. "Wide"


@dataclass
class Phone:
    id: str                         # persistent, supplied by the phone (localStorage)
    name: str
    slot: Optional[str] = None      # camera id, or None (unassigned)
    publishing: bool = False        # is its slot live in MediaMTX
    connected: bool = True          # WebSocket currently open (survives reconnects)
    battery: Optional[dict] = None  # {level: 0-1, charging: bool} where reported (not iOS)


@dataclass
class SessionState:
    cameras: list = field(default_factory=list)   # list[Camera]
    phones: dict = field(default_factory=dict)     # id -> Phone
    recording: bool = False
    recording_started_at: Optional[float] = None
    session_id: Optional[str] = None
    camera_record_started: dict = field(default_factory=dict)  # camId -> epoch (when record enabled)
    switches: list = field(default_factory=list)               # [{t, offset, camId, label}] for the live session

    def camera_ids(self) -> list:
        return [c.id for c in self.cameras]

    def slot_owner(self, slot: str) -> Optional[str]:
        for p in self.phones.values():
            if p.slot == slot:
                return p.id
        return None

    def label_for(self, slot: str) -> Optional[str]:
        for c in self.cameras:
            if c.id == slot:
                return c.label
        return None

    def next_camera_id(self) -> str:
        existing = set(self.camera_ids())
        n = 1
        while f"cam{n}" in existing:
            n += 1
        return f"cam{n}"

    def snapshot(self) -> dict:
        return {
            "cameras": [asdict(c) for c in self.cameras],
            "phones": [asdict(p) for p in self.phones.values()],
            "slots": {c.id: self.slot_owner(c.id) for c in self.cameras},
            "recording": self.recording,
            "recordingStartedAt": self.recording_started_at,
            "sessionId": self.session_id,
            "cameraRecordStartedAt": self.camera_record_started,
            "switches": self.switches,
        }
