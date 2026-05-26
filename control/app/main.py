"""Control service: coordinates phones and the operator dashboard.

Phones connect (armed) and wait. The operator manages the camera list (add /
rename / remove), assigns each phone to a camera, starts the preview (phones
begin publishing via WHIP), then starts/stops recording. Two WebSocket
endpoints, proxied same-origin by the dev-server so phones/browser only ever
see the trusted origin. Cameras are persisted to data/cameras.json.
"""
import asyncio
import json
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import asdict
from datetime import datetime, timezone

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse

from . import cameras as cameras_store
from . import switches as switches_store
from . import recordings as recordings_store
from .state import SessionState, Phone, Camera
from .mediamtx import MediaMTX


def _iso(ts: float | None) -> str | None:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts is not None else None

state = SessionState()
mtx = MediaMTX()

operators: set[WebSocket] = set()
phone_sockets: dict[str, WebSocket] = {}

# Auto-stop a recording this many seconds after the last publisher drops (e.g.
# the event ended). The grace window tolerates brief WiFi blips — a phone that
# reconnects within it resumes publishing and the timer resets.
AUTO_STOP_GRACE_S = 30
_empty_since: float | None = None


def persist_cameras() -> None:
    cameras_store.save(state.cameras)


async def broadcast_state() -> None:
    msg = json.dumps({"type": "state", **state.snapshot()})
    for ws in list(operators):
        try:
            await ws.send_text(msg)
        except Exception:
            operators.discard(ws)


async def send_phone(phone_id: str, payload: dict) -> None:
    ws = phone_sockets.get(phone_id)
    if ws:
        try:
            await ws.send_text(json.dumps(payload))
        except Exception:
            pass


async def assigned_msg(slot) -> dict:
    return {"type": "assigned", "slot": slot, "label": state.label_for(slot) if slot else None}


async def stop_recording() -> None:
    """Turn recording off for every path and finalize the switch-log session.

    Shared by the operator's Stop Recording and the reconcile loop's auto-clear.
    """
    for cam in state.camera_ids():
        await mtx.set_record(cam, False)
    if state.session_id:                        # finalize the editorial switch log
        stopped = time.time()
        switches_store.append_session({
            "sessionId": state.session_id,
            "startedAt": state.recording_started_at,
            "startedAtIso": _iso(state.recording_started_at),
            "stoppedAt": stopped,
            "stoppedAtIso": _iso(stopped),
            "durationSec": round(stopped - (state.recording_started_at or stopped), 3),
            "cameras": [
                {"id": cid, "label": state.label_for(cid) or cid,
                 "recordStartedAt": ts, "recordStartedAtIso": _iso(ts)}
                for cid, ts in state.camera_record_started.items()
            ],
            "switches": state.switches,
        })
    state.recording = False
    state.recording_started_at = None
    state.session_id = None
    state.camera_record_started = {}
    state.switches = []
    for pid in list(phone_sockets):
        await send_phone(pid, {"type": "recording", "on": False})
    await broadcast_state()


# ----- Phone endpoint -------------------------------------------------------
async def ws_phone(ws: WebSocket) -> None:
    await ws.accept()
    phone_id: str | None = None
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if msg.get("type") == "register" and phone_id is None:
                # The phone supplies its own persistent id (localStorage) so a
                # reconnect re-attaches to the same record — keeping its slot —
                # instead of appearing as a brand-new phone.
                phone_id = (msg.get("phoneId") or "").strip() or uuid.uuid4().hex[:8]
                old = phone_sockets.get(phone_id)
                if old is not None and old is not ws:    # a stale socket for this id
                    try:
                        await old.close()
                    except Exception:
                        pass
                phone_sockets[phone_id] = ws
                name = (msg.get("name") or "").strip()
                p = state.phones.get(phone_id)
                if p:                                    # reconnect: revive the existing record
                    p.connected = True
                    if name:
                        p.name = name
                else:
                    p = Phone(id=phone_id, name=name or f"Phone {phone_id}")
                    state.phones[phone_id] = p
                await ws.send_text(json.dumps({"type": "registered", "phoneId": phone_id, "recording": state.recording}))
                if p.slot:                               # restore the armed state on the phone
                    await ws.send_text(json.dumps(await assigned_msg(p.slot)))
                    if state.recording:                  # rejoin an in-progress recording
                        await ws.send_text(json.dumps({"type": "command", "action": "publish", "slot": p.slot}))
                await broadcast_state()
            elif phone_id is not None and msg.get("type") == "status":
                p = state.phones.get(phone_id)
                if p:
                    p.publishing = bool(msg.get("publishing"))
                    await broadcast_state()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        # Keep the phone in the roster (marked offline) so its slot is held for
        # when it reconnects. Guard against a newer socket having taken over.
        if phone_id is not None and phone_sockets.get(phone_id) is ws:
            phone_sockets.pop(phone_id, None)
            p = state.phones.get(phone_id)
            if p:
                p.connected = False
                p.publishing = False
            await broadcast_state()


# ----- Operator endpoint ----------------------------------------------------
async def handle_operator_message(msg: dict) -> None:
    t = msg.get("type")

    # ---- camera management ----
    if t == "addCamera":
        label = (msg.get("label") or "").strip() or f"Camera {len(state.cameras) + 1}"
        cam_id = state.next_camera_id()
        state.cameras.append(Camera(id=cam_id, label=label))
        await mtx.add_path(cam_id)
        persist_cameras()
        await broadcast_state()

    elif t == "renameCamera":
        cid, label = msg.get("id"), (msg.get("label") or "").strip()
        if label:
            for c in state.cameras:
                if c.id == cid:
                    c.label = label
            persist_cameras()
            # let an assigned phone update its displayed label
            owner = state.slot_owner(cid)
            if owner:
                await send_phone(owner, await assigned_msg(cid))
            await broadcast_state()

    elif t == "removeCamera":
        cid = msg.get("id")
        if cid in state.camera_ids():
            state.cameras = [c for c in state.cameras if c.id != cid]
            for p in state.phones.values():
                if p.slot == cid:
                    p.slot = None
                    await send_phone(p.id, await assigned_msg(None))
            if state.recording:
                await mtx.set_record(cid, False)
            await mtx.delete_path(cid)
            persist_cameras()
            await broadcast_state()

    # ---- slot assignment ----
    elif t == "assign":
        pid, slot = msg.get("phoneId"), msg.get("slot")
        if pid in state.phones and slot in state.camera_ids():
            for p in state.phones.values():       # one phone per slot: evict current holder
                if p.slot == slot and p.id != pid:
                    p.slot = None
                    await send_phone(p.id, await assigned_msg(None))
            state.phones[pid].slot = slot
            await send_phone(pid, await assigned_msg(slot))
            await broadcast_state()

    elif t == "unassign":
        pid = msg.get("phoneId")
        if pid in state.phones:
            state.phones[pid].slot = None
            await send_phone(pid, await assigned_msg(None))
            await broadcast_state()

    elif t == "removePhone":
        # Only an offline phone can be dropped from the roster; a connected phone
        # is managed via unassign so we don't strand its open socket.
        pid = msg.get("phoneId")
        p = state.phones.get(pid)
        if p and not p.connected:
            state.phones.pop(pid, None)
            await broadcast_state()

    # ---- preview / record ----
    elif t == "startPreview":
        scope = msg.get("phoneId")
        for p in state.phones.values():
            if p.slot and (scope is None or p.id == scope):
                await send_phone(p.id, {"type": "command", "action": "publish", "slot": p.slot})

    elif t == "stopPreview":
        scope = msg.get("phoneId")
        for p in state.phones.values():
            if scope is None or p.id == scope:
                await send_phone(p.id, {"type": "command", "action": "stop"})

    elif t == "startRecording":
        if state.recording:
            return                                  # already recording — don't reset the session
        ready = await mtx.ready_paths()
        cams = sorted({p.slot for p in state.phones.values() if p.slot and ready.get(p.slot)})
        if not cams:
            return
        state.camera_record_started = {}
        for cam in cams:
            await mtx.set_record(cam, True)
            state.camera_record_started[cam] = time.time()   # ~synchronized; per-cam for post alignment
        state.recording = True
        state.recording_started_at = min(state.camera_record_started.values())
        state.session_id = uuid.uuid4().hex[:8]
        state.switches = []
        for pid in list(phone_sockets):
            await send_phone(pid, {"type": "recording", "on": True})
        await broadcast_state()

    elif t == "switch":
        cam = msg.get("camId")
        if state.recording and cam in state.camera_ids():
            # ignore a repeat take of the camera already on program — keeps the log clean
            if not state.switches or state.switches[-1]["camId"] != cam:
                ts = time.time()
                state.switches.append({
                    "t": ts,
                    "offset": round(ts - (state.recording_started_at or ts), 3),
                    "camId": cam,
                    "label": state.label_for(cam),
                })
                await broadcast_state()

    elif t == "stopRecording":
        await stop_recording()


async def ws_operator(ws: WebSocket) -> None:
    await ws.accept()
    operators.add(ws)
    await ws.send_text(json.dumps({"type": "state", **state.snapshot()}))
    try:
        while True:
            await handle_operator_message(json.loads(await ws.receive_text()))
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        operators.discard(ws)


# ----- Reconcile with MediaMTX ----------------------------------------------
async def reconcile_once() -> None:
    global _empty_since
    ready = await mtx.ready_paths()
    for c in state.cameras:                        # survive a MediaMTX restart
        if c.id not in ready:
            await mtx.add_path(c.id)
    changed = False
    for p in state.phones.values():
        want = bool(p.slot and ready.get(p.slot))
        if p.publishing != want:
            p.publishing = want
            changed = True
    if changed:
        await broadcast_state()

    # Auto-clear a recording left running after every publisher has dropped.
    if state.recording and not any(p.publishing for p in state.phones.values()):
        if _empty_since is None:
            _empty_since = time.monotonic()
        elif time.monotonic() - _empty_since >= AUTO_STOP_GRACE_S:
            await stop_recording()
            _empty_since = None
    else:
        _empty_since = None


async def reconcile_loop() -> None:
    while True:
        await reconcile_once()
        await asyncio.sleep(2)


@asynccontextmanager
async def lifespan(app: FastAPI):
    state.cameras = cameras_store.load()
    for c in state.cameras:
        await mtx.add_path(c.id)
    task = asyncio.create_task(reconcile_loop())
    try:
        yield
    finally:
        task.cancel()
        await mtx.close()


app = FastAPI(lifespan=lifespan)
app.add_api_websocket_route("/ws/phone", ws_phone)
app.add_api_websocket_route("/ws/operator", ws_operator)


@app.get("/healthz")
async def healthz():
    return {"ok": True, "cameras": len(state.cameras), "phones": len(state.phones), "recording": state.recording}


# ----- Recordings (read-only; proxied to the dashboard under /api) ----------
@app.get("/api/recordings")
async def api_recordings():
    return {"cameras": recordings_store.list_recordings()}


@app.get("/api/sessions")
async def api_sessions():
    # The raw switch-log array — also what the dashboard offers as switches.json.
    return switches_store.load_sessions()


@app.get("/api/preflight")
async def api_preflight():
    return recordings_store.preflight()


@app.get("/api/recordings/download")
async def api_download(cam: str, name: str):
    path = recordings_store.resolve_recording(cam, name)
    if path is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(path, media_type="video/mp4", filename=f"{cam}_{name}")
