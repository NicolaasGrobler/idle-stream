"""In-memory session state for the control service.

A single live session: which phones are connected, which camera slot each is
assigned to, whether each is publishing, and whether we are recording.
"""
from dataclasses import dataclass, field, asdict
from typing import Optional

SLOTS = ["cam1", "cam2", "cam3"]
SLOT_LABELS = {"cam1": "Wide", "cam2": "Pulpit", "cam3": "Side"}


@dataclass
class Phone:
    id: str
    name: str
    slot: Optional[str] = None      # cam1 / cam2 / cam3, or None (unassigned)
    publishing: bool = False        # is its slot live in MediaMTX


@dataclass
class SessionState:
    phones: dict = field(default_factory=dict)   # id -> Phone
    recording: bool = False
    recording_started_at: Optional[float] = None

    def slot_owner(self, slot: str) -> Optional[str]:
        for p in self.phones.values():
            if p.slot == slot:
                return p.id
        return None

    def snapshot(self) -> dict:
        return {
            "phones": [asdict(p) for p in self.phones.values()],
            "slots": {s: self.slot_owner(s) for s in SLOTS},
            "slotLabels": SLOT_LABELS,
            "recording": self.recording,
            "recordingStartedAt": self.recording_started_at,
        }
