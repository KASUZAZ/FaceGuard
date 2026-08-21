from __future__ import annotations

import asyncio
import hmac
import json
import os
import re
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic
from urllib import error, parse as urlparse, request as urlrequest

import cv2
import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import ClientDisconnect
from ultralytics import YOLO

from fall_detector import FallDetector


load_dotenv(Path(__file__).with_name(".env"))


MAX_FRAME_BYTES = 1_500_000
DEVICE_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{3,64}$")


class ViewerConnection:
    """One non-blocking WebSocket writer that drops stale video frames."""

    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self.queue: asyncio.Queue[tuple[str, object]] = asyncio.Queue(maxsize=3)
        self.writer = asyncio.create_task(self._write_loop())

    def enqueue(self, kind: str, payload: object) -> None:
        if self.writer.done():
            return
        if self.queue.full():
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        self.queue.put_nowait((kind, payload))

    def close(self) -> None:
        self.writer.cancel()

    async def _write_loop(self) -> None:
        try:
            while True:
                kind, payload = await self.queue.get()
                if kind == "frame":
                    await self.websocket.send_bytes(payload)  # type: ignore[arg-type]
                else:
                    await self.websocket.send_json(payload)
        except (asyncio.CancelledError, RuntimeError):
            return


class LiveHub:
    def __init__(self) -> None:
        self.clients: dict[str, set[ViewerConnection]] = {}
        self.latest_frame: dict[str, bytes] = {}
        self.latest_metadata: dict[str, dict] = {}

    async def connect(
        self,
        device_id: str,
        websocket: WebSocket,
        *,
        accepted: bool = False,
        subprotocol: str | None = None,
    ) -> ViewerConnection:
        if not accepted:
            await websocket.accept(subprotocol=subprotocol)
        connection = ViewerConnection(websocket)
        self.clients.setdefault(device_id, set()).add(connection)
        if device_id in self.latest_metadata:
            connection.enqueue("metadata", self.latest_metadata[device_id])
        if device_id in self.latest_frame:
            connection.enqueue("frame", self.latest_frame[device_id])
        return connection

    def disconnect(self, device_id: str, connection: ViewerConnection) -> None:
        connection.close()
        viewers = self.clients.get(device_id)
        if viewers:
            viewers.discard(connection)

    def publish_frame(self, device_id: str, frame: bytes) -> None:
        self.latest_frame[device_id] = frame
        for connection in self.clients.get(device_id, set()).copy():
            connection.enqueue("frame", frame)

    def publish_metadata(self, device_id: str, metadata: dict) -> None:
        self.latest_metadata[device_id] = metadata
        for connection in self.clients.get(device_id, set()).copy():
            connection.enqueue("metadata", metadata)


class StreamRate:
    def __init__(self) -> None:
        self.samples: dict[str, deque[float]] = {}

    def record(self, device_id: str) -> float:
        now = monotonic()
        values = self.samples.setdefault(device_id, deque())
        values.append(now)
        while values and now - values[0] > 2.0:
            values.popleft()
        if len(values) < 2:
            return 0.0
        return (len(values) - 1) / max(values[-1] - values[0], 0.001)

    def fps(self, device_id: str) -> float:
        values = self.samples.get(device_id)
        if not values or monotonic() - values[-1] > 3.0 or len(values) < 2:
            return 0.0
        return (len(values) - 1) / max(values[-1] - values[0], 0.001)


class InferencePipeline:
    """Process only the newest frame so AI never back-pressures 25 FPS CCTV."""

    def __init__(self, model: FallDetector, inference_fps: float) -> None:
        self.model = model
        self.interval = 1.0 / max(inference_fps, 0.2)
        self.queues: dict[str, asyncio.Queue[tuple[bytes, str]]] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.online_devices: set[str] = set()
        self.lock = asyncio.Lock()
        self.settings: dict[str, dict] = {}

    def configure(self, device_id: str, settings: dict) -> None:
        self.settings[device_id] = settings

    def submit(self, device_id: str, jpeg: bytes, captured_at: str) -> None:
        self.online_devices.add(device_id)
        queue = self.queues.setdefault(device_id, asyncio.Queue(maxsize=1))
        if queue.full():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        queue.put_nowait((jpeg, captured_at))
        if device_id not in self.tasks or self.tasks[device_id].done():
            self.tasks[device_id] = asyncio.create_task(self._worker(device_id, queue))

    def set_offline(self, device_id: str) -> None:
        self.online_devices.discard(device_id)
        queue = self.queues.get(device_id)
        if queue:
            while not queue.empty():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    break

    async def close(self) -> None:
        for task in self.tasks.values():
            task.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)

    async def _worker(
        self, device_id: str, queue: asyncio.Queue[tuple[bytes, str]]
    ) -> None:
        while True:
            jpeg, captured_at = await queue.get()
            started = monotonic()
            settings = self.settings.get(device_id, {})
            configured_fps = float(settings.get("inference_fps") or (1.0 / self.interval))
            interval = 1.0 / max(configured_fps, 0.2)
            frame = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
            if frame is not None:
                if settings.get("detection_enabled") is False:
                    hub.publish_metadata(
                        device_id,
                        {
                            "type": "status",
                            "fall_state": "dimatikan",
                            "fall_confirmed": False,
                            "device_id": device_id,
                            "captured_at": captured_at,
                            "stream_fps": round(stream_rate.fps(device_id), 1),
                            "stream_online": True,
                        },
                    )
                    await asyncio.sleep(max(0.0, interval - (monotonic() - started)))
                    continue
                async with self.lock:
                    status, annotated = await asyncio.to_thread(
                        self.model.analyse,
                        device_id,
                        frame,
                        None,
                        settings.get("fall_confirm_seconds"),
                    )
                metadata = {
                    **status,
                    "device_id": device_id,
                    "captured_at": captured_at,
                    "stream_fps": round(stream_rate.fps(device_id), 1),
                    "stream_online": device_id in self.online_devices,
                }
                hub.publish_metadata(device_id, metadata)
                if status["fall_confirmed"]:
                    encoded, buffer = cv2.imencode(
                        ".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 82]
                    )
                    if encoded:
                        try:
                            await asyncio.to_thread(
                                publish_fall_event,
                                device_id,
                                buffer.tobytes(),
                                status,
                            )
                        except Exception as exc:
                            print(f"Event jatuh gagal diterbitkan: {exc}")
            await asyncio.sleep(max(0.0, interval - (monotonic() - started)))


hub = LiveHub()
stream_rate = StreamRate()
detector: FallDetector | None = None
pipeline: InferencePipeline | None = None


def env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def allowed_origins() -> list[str]:
    value = env("ALLOWED_ORIGINS", "*")
    configured = [item.strip() for item in value.split(",") if item.strip()]
    if configured == ["*"]:
        return configured
    return list(
        dict.fromkeys(
            configured
            + ["https://localhost", "http://localhost", "capacitor://localhost"]
        )
    )


def validate_device(device_id: str, token: str) -> None:
    expected_token = env("FACEGUARD_DEVICE_TOKEN")
    if not expected_token:
        raise HTTPException(503, "FACEGUARD_DEVICE_TOKEN belum ditetapkan pada server")
    if not hmac.compare_digest(token, expected_token):
        raise HTTPException(401, "Token peranti tidak sah")
    if not DEVICE_ID_PATTERN.fullmatch(device_id):
        raise HTTPException(400, "Device ID tidak sah")


@asynccontextmanager
async def lifespan(_: FastAPI):
    global detector, pipeline
    model_name = env("POSE_MODEL", "yolo26n-pose.pt")
    detector = FallDetector(
        YOLO(model_name),
        confirmation_seconds=float(env("FALL_CONFIRM_SECONDS", "1.5")),
        transition_window_seconds=float(env("FALL_TRANSITION_SECONDS", "8")),
        event_cooldown_seconds=float(env("FALL_COOLDOWN_SECONDS", "30")),
    )
    pipeline = InferencePipeline(
        detector, inference_fps=float(env("INFERENCE_FPS", "5"))
    )
    yield
    await pipeline.close()


app = FastAPI(title="FaceGuard Fall Detection", version="2.1.3", lifespan=lifespan)
origins = allowed_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Device-ID", "X-Device-Token"],
)


@app.get("/")
async def root() -> dict:
    return {
        "ok": detector is not None and pipeline is not None,
        "service": "FaceGuard Fall Detection",
        "message": "Server aktif. Paparan CCTV tersedia dalam aplikasi FaceGuard.",
        "app": "https://dazzling-valkyrie-40ada0.netlify.app",
        "health": "/health",
    }


@app.get("/health")
async def health() -> dict:
    return {
        "ok": detector is not None and pipeline is not None,
        "model": env("POSE_MODEL", "yolo26n-pose.pt"),
        "inference_fps": float(env("INFERENCE_FPS", "5")),
        "active_camera_streams": len(pipeline.online_devices) if pipeline else 0,
    }


@app.websocket("/ws/device/{device_id}")
async def device_stream(websocket: WebSocket, device_id: str) -> None:
    """Receive JPEG frames from ESP32-CAM without HTTP request buffering."""
    expected_token = env("FACEGUARD_DEVICE_TOKEN")
    supplied_token = websocket.headers.get("x-device-token", "")
    if not expected_token:
        await websocket.close(code=1011, reason="Token server belum ditetapkan")
        return
    if (
        not DEVICE_ID_PATTERN.fullmatch(device_id)
        or not hmac.compare_digest(supplied_token, expected_token)
    ):
        await websocket.close(code=4401, reason="Peranti tidak sah")
        return
    if pipeline is None:
        await websocket.close(code=1013, reason="Model belum sedia")
        return

    requested_protocols = {
        item.strip()
        for item in websocket.headers.get("sec-websocket-protocol", "").split(",")
        if item.strip()
    }
    selected_protocol = (
        "faceguard-device" if "faceguard-device" in requested_protocols else None
    )
    await websocket.accept(subprotocol=selected_protocol)
    pipeline.configure(
        device_id, await asyncio.to_thread(fetch_device_settings, device_id)
    )

    last_cloud_sync = 0.0
    try:
        while True:
            jpeg = await websocket.receive_bytes()
            if (
                not jpeg
                or len(jpeg) > MAX_FRAME_BYTES
                or not jpeg.startswith(b"\xff\xd8")
                or not jpeg.endswith(b"\xff\xd9")
            ):
                continue

            stream_rate.record(device_id)
            captured_at = datetime.now(timezone.utc).isoformat()
            hub.publish_frame(device_id, jpeg)
            pipeline.submit(device_id, jpeg, captured_at)
            now = monotonic()
            if now - last_cloud_sync >= 5.0:
                last_cloud_sync = now
                asyncio.create_task(
                    asyncio.to_thread(
                        update_device_status,
                        device_id,
                        True,
                        round(stream_rate.fps(device_id), 2),
                    )
                )
    except WebSocketDisconnect as exc:
        print(f"ESP32 WebSocket disconnected: device={device_id} code={exc.code}")
    except Exception as exc:
        print(
            f"ESP32 WebSocket error: device={device_id} "
            f"type={type(exc).__name__} detail={exc}"
        )
    finally:
        pipeline.set_offline(device_id)
        await asyncio.to_thread(update_device_status, device_id, False, 0.0)
        previous = hub.latest_metadata.get(device_id, {})
        hub.publish_metadata(
            device_id,
            {
                **previous,
                "type": "status",
                "device_id": device_id,
                "stream_online": False,
                "stream_fps": 0.0,
                "captured_at": datetime.now(timezone.utc).isoformat(),
            },
        )


@app.post("/api/v1/camera/stream")
async def camera_stream(
    incoming: Request,
    x_device_id: str = Header(default=""),
    x_device_token: str = Header(default=""),
) -> dict:
    """Read a length-prefixed JPEG stream from one persistent HTTP request."""
    validate_device(x_device_id, x_device_token)
    if incoming.headers.get("content-type", "").split(";")[0] != "application/x-faceguard-jpeg":
        raise HTTPException(415, "Stream mestilah application/x-faceguard-jpeg")
    if pipeline is None:
        raise HTTPException(503, "Model belum sedia")

    pipeline.configure(
        x_device_id, await asyncio.to_thread(fetch_device_settings, x_device_id)
    )

    buffer = bytearray()
    expected_length: int | None = None
    frames = 0
    last_cloud_sync = 0.0
    try:
        async for chunk in incoming.stream():
            if not chunk:
                continue
            buffer.extend(chunk)
            while True:
                if expected_length is None:
                    if len(buffer) < 4:
                        break
                    expected_length = int.from_bytes(buffer[:4], "big")
                    del buffer[:4]
                    if expected_length <= 0 or expected_length > MAX_FRAME_BYTES:
                        raise HTTPException(413, "Saiz frame stream tidak sah")
                if len(buffer) < expected_length:
                    break

                jpeg = bytes(buffer[:expected_length])
                del buffer[:expected_length]
                expected_length = None
                if not (jpeg.startswith(b"\xff\xd8") and jpeg.endswith(b"\xff\xd9")):
                    continue

                frames += 1
                stream_rate.record(x_device_id)
                captured_at = datetime.now(timezone.utc).isoformat()
                hub.publish_frame(x_device_id, jpeg)
                pipeline.submit(x_device_id, jpeg, captured_at)
                now = monotonic()
                if now - last_cloud_sync >= 5.0:
                    last_cloud_sync = now
                    asyncio.create_task(
                        asyncio.to_thread(
                            update_device_status,
                            x_device_id,
                            True,
                            round(stream_rate.fps(x_device_id), 2),
                        )
                    )
    except ClientDisconnect:
        pass
    finally:
        pipeline.set_offline(x_device_id)
        await asyncio.to_thread(update_device_status, x_device_id, False, 0.0)
        previous = hub.latest_metadata.get(x_device_id, {})
        hub.publish_metadata(
            x_device_id,
            {
                **previous,
                "type": "status",
                "device_id": x_device_id,
                "stream_online": False,
                "stream_fps": 0.0,
                "captured_at": datetime.now(timezone.utc).isoformat(),
            },
        )
    return {"ok": True, "frames": frames}


@app.post("/api/v1/camera/frame")
async def camera_frame(
    incoming: Request,
    x_device_id: str = Header(default=""),
    x_device_token: str = Header(default=""),
) -> dict:
    """Single-frame fallback used for diagnostics and compatibility."""
    validate_device(x_device_id, x_device_token)
    if incoming.headers.get("content-type", "").split(";")[0] != "image/jpeg":
        raise HTTPException(415, "Frame mestilah image/jpeg")
    body = await incoming.body()
    if not body or len(body) > MAX_FRAME_BYTES:
        raise HTTPException(413, "Saiz frame tidak sah")
    frame = cv2.imdecode(np.frombuffer(body, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None or detector is None or pipeline is None:
        raise HTTPException(400, "JPEG tidak dapat dibaca atau model belum sedia")

    async with pipeline.lock:
        status, annotated = await asyncio.to_thread(detector.analyse, x_device_id, frame)
    metadata = {
        **status,
        "device_id": x_device_id,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "stream_fps": 1.0,
        "stream_online": True,
    }
    hub.publish_frame(x_device_id, body)
    hub.publish_metadata(x_device_id, metadata)
    if status["fall_confirmed"]:
        encoded, evidence = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 82])
        if encoded:
            try:
                await asyncio.to_thread(
                    publish_fall_event, x_device_id, evidence.tobytes(), status
                )
            except Exception as exc:
                print(f"Event jatuh gagal diterbitkan: {exc}")
    return metadata


@app.websocket("/ws/live/{device_id}")
async def live_stream(websocket: WebSocket, device_id: str) -> None:
    if not DEVICE_ID_PATTERN.fullmatch(device_id):
        await websocket.close(code=4400)
        return
    origin = websocket.headers.get("origin", "")
    if origins != ["*"] and origin not in origins:
        await websocket.close(code=4403)
        return

    requested_protocols = {
        item.strip()
        for item in websocket.headers.get("sec-websocket-protocol", "").split(",")
        if item.strip()
    }
    selected_protocol = "faceguard" if "faceguard" in requested_protocols else None
    await websocket.accept(subprotocol=selected_protocol)

    access_token = next(
        (
            item.removeprefix("supabase-access-token.")
            for item in requested_protocols
            if item.startswith("supabase-access-token.")
        ),
        "",
    )
    user_can_view = await asyncio.to_thread(
        validate_supabase_viewer, device_id, access_token
    )
    if not user_can_view:
        await websocket.close(code=4401, reason="Log masuk FaceGuard diperlukan")
        return

    connection = await hub.connect(device_id, websocket, accepted=True)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(device_id, connection)


def validate_supabase_viewer(device_id: str, access_token: str) -> bool:
    """Validate a Supabase session and confirm the user owns this device."""
    if not access_token or len(access_token) > 4096:
        return False
    supabase_url = env("SUPABASE_URL").rstrip("/")
    publishable_key = env(
        "SUPABASE_PUBLISHABLE_KEY",
        "sb_publishable_GFljHorRTltHpWAEfz_PMg_oNa0YmF5",
    )
    if not supabase_url or not publishable_key:
        return False
    headers = {
        "apikey": publishable_key,
        "Authorization": f"Bearer {access_token}",
        "User-Agent": "FaceGuard-Inference/2.1.3",
    }
    try:
        user_request = urlrequest.Request(
            f"{supabase_url}/auth/v1/user", headers=headers, method="GET"
        )
        with urlrequest.urlopen(user_request, timeout=12) as response:
            user = json.loads(response.read().decode())
        user_id = str(user.get("id") or "")
        if not user_id:
            return False
        device_filter = urlparse.quote(device_id, safe="")
        owner_filter = urlparse.quote(user_id, safe="")
        device_url = (
            f"{supabase_url}/rest/v1/devices"
            f"?id=eq.{device_filter}&owner_id=eq.{owner_filter}&select=id&limit=1"
        )
        device_request = urlrequest.Request(device_url, headers=headers, method="GET")
        with urlrequest.urlopen(device_request, timeout=12) as response:
            rows = json.loads(response.read().decode())
        return bool(rows)
    except (error.HTTPError, error.URLError, TimeoutError, ValueError):
        return False


def publish_fall_event(device_id: str, jpeg: bytes, status: dict) -> None:
    supabase_url = env("SUPABASE_URL").rstrip("/")
    service_key = env("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        print("Fall dikesan tetapi Supabase server credentials belum ditetapkan.")
        return

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    object_path = f"{device_id}/falls/{timestamp}.jpg"
    upload_url = f"{supabase_url}/storage/v1/object/faceguard-storage/{object_path}"
    headers = {**supabase_server_headers(service_key), "Content-Type": "image/jpeg"}
    _url_request(upload_url, jpeg, headers)

    payload = json.dumps(
        {
            "device_id": device_id,
            "status": "orang_jatuh",
            "confidence": status.get("confidence"),
            "image_path": object_path,
            "video_path": None,
            "metadata": status,
        }
    ).encode()
    _url_request(
        f"{supabase_url}/rest/v1/aktiviti_log",
        payload,
        {**headers, "Content-Type": "application/json", "Prefer": "return=minimal"},
    )
    print(
        f"Event orang_jatuh disimpan untuk {device_id}; confidence={status['confidence']}."
    )


def fetch_device_settings(device_id: str) -> dict:
    supabase_url = env("SUPABASE_URL").rstrip("/")
    service_key = env("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        return {}
    headers = supabase_server_headers(service_key)
    url = (
        f"{supabase_url}/rest/v1/devices?id=eq.{device_id}"
        "&select=detection_enabled,inference_fps,fall_confirm_seconds"
    )
    outgoing = urlrequest.Request(url, headers=headers, method="GET")
    try:
        with urlrequest.urlopen(outgoing, timeout=10) as response:
            rows = json.loads(response.read().decode())
            return rows[0] if rows else {}
    except Exception as exc:
        print(f"Tetapan Supabase gagal dimuatkan untuk {device_id}: {exc}")
        return {}


def update_device_status(device_id: str, online: bool, fps: float) -> None:
    supabase_url = env("SUPABASE_URL").rstrip("/")
    service_key = env("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        return
    payload = json.dumps(
        {
            "online": online,
            "stream_fps": fps,
            "last_seen": datetime.now(timezone.utc).isoformat(),
        }
    ).encode()
    headers = {
        **supabase_server_headers(service_key),
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    try:
        _url_request(
            f"{supabase_url}/rest/v1/devices?id=eq.{device_id}",
            payload,
            headers,
            method="PATCH",
        )
    except Exception as exc:
        print(f"Status Supabase gagal dikemas kini untuk {device_id}: {exc}")


def supabase_server_headers(service_key: str) -> dict[str, str]:
    """Use new sb_secret keys as API keys, not as non-JWT bearer tokens."""
    headers = {
        "apikey": service_key,
        "User-Agent": "FaceGuard-Inference/2.1",
    }
    if not service_key.startswith("sb_secret_"):
        headers["Authorization"] = f"Bearer {service_key}"
    return headers


def _url_request(
    url: str, data: bytes, headers: dict[str, str], method: str = "POST"
) -> None:
    outgoing = urlrequest.Request(url, data=data, headers=headers, method=method)
    try:
        with urlrequest.urlopen(outgoing, timeout=25) as response:
            if not 200 <= response.status < 300:
                raise RuntimeError(f"HTTP {response.status} daripada Supabase")
    except error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise RuntimeError(f"Supabase HTTP {exc.code}: {detail}") from exc
