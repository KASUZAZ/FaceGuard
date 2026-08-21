from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from time import monotonic

import cv2
import httpx
import websockets


async def main() -> int:
    parser = argparse.ArgumentParser(description="Uji relay FaceGuard pada FPS sasaran")
    parser.add_argument("image", type=Path)
    parser.add_argument("--server", default="http://127.0.0.1:8765")
    parser.add_argument("--device-id", default="kamera-hadapan")
    parser.add_argument("--device-token", default="local-test-device-token")
    parser.add_argument("--viewer-token", default="local-test-viewer-token")
    parser.add_argument("--fps", type=float, default=25.0)
    parser.add_argument("--seconds", type=float, default=4.0)
    parser.add_argument("--width", type=int, default=400)
    parser.add_argument("--height", type=int, default=296)
    args = parser.parse_args()

    source = cv2.imread(str(args.image))
    if source is None:
        raise SystemExit(f"Imej tidak dapat dibaca: {args.image}")
    source = cv2.resize(source, (args.width, args.height))
    ok, encoded = cv2.imencode(".jpg", source, [cv2.IMWRITE_JPEG_QUALITY, 68])
    if not ok:
        raise SystemExit("JPEG ujian gagal dikodkan")
    jpeg = encoded.tobytes()
    record = len(jpeg).to_bytes(4, "big") + jpeg
    total_frames = round(args.fps * args.seconds)

    async def body():
        started = monotonic()
        for index in range(total_frames):
            target = started + index / args.fps
            await asyncio.sleep(max(0.0, target - monotonic()))
            yield record

    async def upload():
        headers = {
            "Content-Type": "application/x-faceguard-jpeg",
            "X-Device-ID": args.device_id,
            "X-Device-Token": args.device_token,
        }
        async with httpx.AsyncClient(timeout=args.seconds + 30) as client:
            response = await client.post(
                f"{args.server}/api/v1/camera/stream", headers=headers, content=body()
            )
            response.raise_for_status()
            return response.json()

    ws_base = args.server.replace("https://", "wss://").replace("http://", "ws://")
    ws_url = f"{ws_base}/ws/live/{args.device_id}?token={args.viewer_token}"
    received = 0
    reported_fps = 0.0
    first_frame_at = 0.0
    last_frame_at = 0.0
    async with websockets.connect(
        ws_url, origin="http://localhost:4173", max_size=2_000_000
    ) as socket:
        upload_task = asyncio.create_task(upload())
        started = monotonic()
        while not upload_task.done() or monotonic() - started < args.seconds:
            try:
                message = await asyncio.wait_for(socket.recv(), timeout=1.0)
            except asyncio.TimeoutError:
                if upload_task.done():
                    break
                continue
            if isinstance(message, bytes):
                received_at = monotonic()
                if not first_frame_at:
                    first_frame_at = received_at
                last_frame_at = received_at
                received += 1
            else:
                metadata = json.loads(message)
                reported_fps = max(reported_fps, float(metadata.get("stream_fps", 0)))
        result = await upload_task

    relay_fps = (received - 1) / max(last_frame_at - first_frame_at, 0.001)
    print(
        json.dumps(
            {
                "sent": result["frames"],
                "received": received,
                "relay_fps": round(relay_fps, 1),
                "server_fps": round(reported_fps, 1),
                "jpeg_bytes": len(jpeg),
            }
        )
    )
    return 0 if received >= total_frames * 0.9 and relay_fps >= args.fps * 0.9 else 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
