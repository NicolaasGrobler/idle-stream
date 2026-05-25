"""Thin async client for the MediaMTX control API (localhost:9997).

Isolated here so the recording-control mechanism can be swapped without touching
the rest of the service. Currently recording is toggled per-path at runtime via
the config patch endpoint.
"""
import httpx

API = "http://127.0.0.1:9997"


class MediaMTX:
    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=5.0)

    async def set_record(self, path: str, on: bool) -> None:
        """Turn copy-only recording on/off for a path at runtime."""
        await self._client.patch(f"{API}/v3/config/paths/patch/{path}", json={"record": on})

    async def ready_paths(self) -> dict:
        """Map of path name -> whether a publisher is currently live."""
        try:
            r = await self._client.get(f"{API}/v3/paths/list")
            r.raise_for_status()
            return {i["name"]: bool(i.get("ready")) for i in r.json().get("items", [])}
        except Exception:
            return {}

    async def close(self) -> None:
        await self._client.aclose()
