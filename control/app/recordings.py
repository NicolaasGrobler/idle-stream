"""Read-only access to the captured recordings on disk.

MediaMTX writes copy-only fMP4 to recordings/<cam>/<timestamp>.mp4. This lists
them for the dashboard and resolves a single file for download — by camera +
filename only (validated, joined under the recordings root) so a caller can
never traverse outside it.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RECORDINGS = ROOT / "recordings"
_SAFE = re.compile(r"^[A-Za-z0-9._-]+$")   # single path segment, no separators


def list_recordings() -> list[dict]:
    cams: list[dict] = []
    if not RECORDINGS.is_dir():
        return cams
    for cam_dir in sorted(RECORDINGS.iterdir()):
        if not cam_dir.is_dir():
            continue
        files = []
        for f in sorted(cam_dir.iterdir()):
            if f.is_file():
                st = f.stat()
                files.append({"name": f.name, "sizeBytes": st.st_size, "modified": st.st_mtime})
        cams.append({"cam": cam_dir.name, "files": files,
                     "totalBytes": sum(x["sizeBytes"] for x in files)})
    return cams


def resolve_recording(cam: str, name: str) -> Path | None:
    """Map (cam, name) to a file under the recordings root, or None if invalid."""
    if not (_SAFE.match(cam or "") and _SAFE.match(name or "")):
        return None
    if cam == ".." or name == "..":
        return None
    root = RECORDINGS.resolve()
    p = (root / cam / name).resolve()
    try:
        p.relative_to(root)            # reject anything resolving outside the root
    except ValueError:
        return None
    return p if p.is_file() else None
