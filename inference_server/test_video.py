from __future__ import annotations

import argparse
from pathlib import Path

import cv2
from ultralytics import YOLO

from fall_detector import FallDetector


def main() -> int:
    parser = argparse.ArgumentParser(description="Uji FaceGuard pada fail video")
    parser.add_argument("video", type=Path)
    parser.add_argument("--model", default="yolo26n-pose.pt")
    parser.add_argument("--sample-fps", type=float, default=1.0)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--crop-top", type=float, default=1.0, help="Bahagian atas frame untuk diuji, 0-1")
    parser.add_argument("--qvga", action="store_true", help="Uji pada resolusi ESP32 320x240")
    parser.add_argument("--cif", action="store_true", help="Uji pada resolusi ESP32 400x296")
    args = parser.parse_args()

    capture = cv2.VideoCapture(str(args.video))
    if not capture.isOpened():
        raise SystemExit(f"Video tidak dapat dibuka: {args.video}")

    source_fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    sample_every = max(round(source_fps / args.sample_fps), 1)
    detector = FallDetector(YOLO(args.model))
    frame_index = 0
    processed = 0
    confirmed = 0
    previous_state = ""

    writer = None
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)

    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if frame_index % sample_every != 0:
            frame_index += 1
            continue

        if 0 < args.crop_top < 1:
            frame = frame[: max(int(frame.shape[0] * args.crop_top), 1), :]
        if args.qvga:
            frame = cv2.resize(frame, (320, 240))
        elif args.cif:
            frame = cv2.resize(frame, (400, 296))

        video_time = frame_index / source_fps
        status, annotated = detector.analyse("video-test", frame, now=video_time)
        processed += 1
        if args.verbose or status["fall_state"] != previous_state:
            print(
                f"{video_time:5.2f}s  {status['fall_state']:<16} "
                f"ratio={status['aspect_ratio']:.2f} angle={status['torso_angle']:.1f} "
                f"height={status['height_ratio']:.2f} centerY={status['center_y_ratio']:.2f}"
            )
            previous_state = status["fall_state"]
        if status["fall_confirmed"]:
            confirmed += 1

        if args.output:
            if writer is None:
                height, width = annotated.shape[:2]
                writer = cv2.VideoWriter(
                    str(args.output),
                    cv2.VideoWriter_fourcc(*"mp4v"),
                    args.sample_fps,
                    (width, height),
                )
            writer.write(annotated)
        frame_index += 1

    capture.release()
    if writer:
        writer.release()
    print(f"frames={processed} fall_events={confirmed}")
    return 0 if confirmed else 2


if __name__ == "__main__":
    raise SystemExit(main())
