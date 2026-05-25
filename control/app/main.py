"""Control service: coordinates phones and the operator dashboard.

Phones connect (armed) and wait. The operator assigns each phone to a camera
slot, starts the preview (phones begin publishing via WHIP), then starts/stops
recording. Everything runs over two WebSocket endpoints, proxied same-origin by
the dev-server so the browser/phones only ever see the trusted :8443/:8444 origin.
"""
import asyncio
import json
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .state import SessionState, Phone, SLOTS
from .mediamtx import MediaMTX

state = SessionState()
mtx = MediaMTX()

operators: set[WebSocket] = set()
phone_sockets: dict[str, WebSocket] = {}


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


# ----- Phone endpoint -------------------------------------------------------
async def handle_phone_message(phone_id: str, msg: dict) -> None:
    t = msg.get("type")
    if t == "status":
        p = state.phones.get(phone_id)
        if p:
            p.publishing = bool(msg.get("publishing"))
            await broadcast_state()


async def ws_phone(ws: WebSocket) -> None:
    await ws.accept()
    phone_id: str | None = None
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if msg.get("type") == "register" and phone_id is None:
                phone_id = uuid.uuid4().hex[:8]
                phone_sockets[phone_id] = ws
                state.phones[phone_id] = Phone(id=phone_id, name=(msg.get("name") or f"Phone {phone_id}").strip())
                await ws.send_text(json.dumps({"type": "registered", "phoneId": phone_id, "recording": state.recording}))
                await broadcast_state()
            elif phone_id is not None:
                await handle_phone_message(phone_id, msg)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if phone_id is not None:
            phone_sockets.pop(phone_id, None)
            state.phones.pop(phone_id, None)
            await broadcast_state()


# ----- Operator endpoint ----------------------------------------------------
async def handle_operator_message(msg: dict) -> None:
    t = msg.get("type")

    if t == "assign":
        pid, slot = msg.get("phoneId"), msg.get("slot")
        if pid in state.phones and slot in SLOTS:
            # one phone per slot: evict whoever holds it
            for p in state.phones.values():
                if p.slot == slot and p.id != pid:
                    p.slot = None
                    await send_phone(p.id, {"type": "assigned", "slot": None})
            state.phones[pid].slot = slot
            await send_phone(pid, {"type": "assigned", "slot": slot})
            await broadcast_state()

    elif t == "unassign":
        pid = msg.get("phoneId")
        if pid in state.phones:
            state.phones[pid].slot = None
            await send_phone(pid, {"type": "assigned", "slot": None})
            await broadcast_state()

    elif t == "startPreview":
        scope = msg.get("phoneId")  # None => all assigned phones
        for p in state.phones.values():
            if p.slot and (scope is None or p.id == scope):
                await send_phone(p.id, {"type": "command", "action": "publish", "slot": p.slot})

    elif t == "stopPreview":
        scope = msg.get("phoneId")
        for p in state.phones.values():
            if scope is None or p.id == scope:
                await send_phone(p.id, {"type": "command", "action": "stop"})

    elif t == "startRecording":
        # Check MediaMTX's live state directly (the cached publishing flag can lag
        # the reconcile loop if Record is clicked right after Start Preview).
        ready = await mtx.ready_paths()
        cams = sorted({p.slot for p in state.phones.values() if p.slot and ready.get(p.slot)})
        for cam in cams:
            await mtx.set_record(cam, True)
        if cams:
            state.recording = True
            state.recording_started_at = time.time()
            for pid in list(phone_sockets):
                await send_phone(pid, {"type": "recording", "on": True})
            await broadcast_state()

    elif t == "stopRecording":
        for cam in SLOTS:
            await mtx.set_record(cam, False)
        state.recording = False
        state.recording_started_at = None
        for pid in list(phone_sockets):
            await send_phone(pid, {"type": "recording", "on": False})
        await broadcast_state()


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


# ----- Reconcile publishing state from MediaMTX -----------------------------
async def reconcile_loop() -> None:
    while True:
        ready = await mtx.ready_paths()
        changed = False
        for p in state.phones.values():
            want = bool(p.slot and ready.get(p.slot))
            if p.publishing != want:
                p.publishing = want
                changed = True
        if changed:
            await broadcast_state()
        await asyncio.sleep(2)


@asynccontextmanager
async def lifespan(app: FastAPI):
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
    return {"ok": True, "phones": len(state.phones), "recording": state.recording}
