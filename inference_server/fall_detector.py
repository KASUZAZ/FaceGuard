from __future__ import annotations

from dataclasses import dataclass, field
from math import atan2, degrees
from time import monotonic
from typing import Any

import cv2
import numpy as np


@dataclass
class DeviceFallState:
    last_upright_at: float = 0.0
    candidate_since: float | None = None
    event_latched: bool = False
    last_event_at: float | None = None
    clear_frames: int = 0
    upright_center_y: float | None = None
    upright_height_ratio: float | None = None
    upright_heights: list[tuple[float, float]] = field(default_factory=list)
    last_horizontal_at: float = 0.0


@dataclass
class FallDetector:
    model: Any
    confirmation_seconds: float = 1.5
    transition_window_seconds: float = 8.0
    event_cooldown_seconds: float = 30.0
    min_keypoint_confidence: float = 0.35
    candidate_grace_seconds: float = 1.2
    _states: dict[str, DeviceFallState] = field(default_factory=dict)

    def analyse(
        self,
        device_id: str,
        frame: np.ndarray,
        now: float | None = None,
        confirmation_seconds: float | None = None,
    ) -> tuple[dict[str, Any], np.ndarray]:
        """Run pose inference and update the temporal fall state for one camera."""
        result = self.model.predict(frame, verbose=False, imgsz=640)[0]
        annotated = result.plot()
        now = monotonic() if now is None else now
        state = self._states.setdefault(device_id, DeviceFallState())

        pose = self._largest_pose(result)
        if pose is None:
            if (
                state.candidate_since is not None
                and now - state.last_horizontal_at > self.candidate_grace_seconds
            ):
                state.candidate_since = None
            status = self._metadata("tiada_orang", False, 0, 0.0, 0.0)
            self._draw_status(annotated, status)
            return status, annotated

        box, keypoints = pose
        x1, y1, x2, y2 = box
        width = max(float(x2 - x1), 1.0)
        height = max(float(y2 - y1), 1.0)
        aspect_ratio = width / height
        height_ratio = height / max(float(frame.shape[0]), 1.0)
        center_y_ratio = ((float(y1) + float(y2)) / 2.0) / max(float(frame.shape[0]), 1.0)
        torso_angle, pose_confidence = self._torso_angle(keypoints)

        state.upright_heights = [
            sample for sample in state.upright_heights
            if now - sample[0] <= self.transition_window_seconds
        ]
        baseline_height = max((sample[1] for sample in state.upright_heights), default=0.0)
        collapsed = (
            baseline_height > 0
            and height_ratio <= baseline_height * 0.65
            and aspect_ratio >= 0.48
            and torso_angle >= 24.0
        )
        upright = aspect_ratio < 0.70 and torso_angle < 32.0 and not collapsed
        # ESP32-CAM views often make a fallen body appear only moderately wide.
        # Requiring both a wider box and a tilted torso is more stable than a
        # strict width > height rule for low-resolution frames.
        horizontal = (
            (aspect_ratio >= 0.84 and torso_angle >= 35.0)
            or aspect_ratio > 1.1
            or torso_angle > 62.0
            or collapsed
        )

        if upright:
            state.last_upright_at = now
            state.upright_center_y = center_y_ratio
            state.upright_height_ratio = height_ratio
            state.upright_heights.append((now, height_ratio))
            state.clear_frames += 1
            if state.clear_frames >= 3:
                state.candidate_since = None
                state.event_latched = False
            label = "berdiri"
        elif horizontal:
            state.clear_frames = 0
            state.last_horizontal_at = now
            recently_upright = now - state.last_upright_at <= self.transition_window_seconds
            if recently_upright and state.candidate_since is None:
                state.candidate_since = now
            label = "disyaki_jatuh" if state.candidate_since is not None else "baring"
        else:
            if (
                state.candidate_since is not None
                and now - state.last_horizontal_at > self.candidate_grace_seconds
            ):
                state.candidate_since = None
            state.clear_frames = 0
            label = "bergerak"

        candidate_duration = (
            now - state.candidate_since if state.candidate_since is not None else 0.0
        )
        required_confirmation = (
            self.confirmation_seconds
            if confirmation_seconds is None
            else max(0.5, min(float(confirmation_seconds), 10.0))
        )
        confirmed = (
            horizontal
            and state.candidate_since is not None
            and candidate_duration >= required_confirmation
            and not state.event_latched
            and (
                state.last_event_at is None
                or now - state.last_event_at >= self.event_cooldown_seconds
            )
        )
        if confirmed:
            state.event_latched = True
            state.last_event_at = now
            label = "orang_jatuh"
        elif horizontal and state.event_latched:
            label = "orang_jatuh"

        status = self._metadata(
            label,
            confirmed,
            1,
            pose_confidence,
            candidate_duration,
            aspect_ratio,
            torso_angle,
            height_ratio,
            center_y_ratio,
        )
        self._draw_status(annotated, status)
        return status, annotated

    def _largest_pose(self, result: Any) -> tuple[np.ndarray, np.ndarray] | None:
        if result.boxes is None or result.keypoints is None:
            return None
        boxes = result.boxes.xyxy.detach().cpu().numpy()
        keypoints = result.keypoints.data.detach().cpu().numpy()
        if len(boxes) == 0 or len(keypoints) == 0:
            return None
        areas = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
        index = int(np.argmax(areas))
        return boxes[index], keypoints[index]

    def _torso_angle(self, keypoints: np.ndarray) -> tuple[float, float]:
        # COCO pose: shoulders 5/6, hips 11/12.
        joints = keypoints[[5, 6, 11, 12]]
        confidences = joints[:, 2] if joints.shape[1] >= 3 else np.ones(4)
        confidence = float(np.mean(confidences))
        if confidence < self.min_keypoint_confidence:
            return 0.0, confidence

        shoulder = np.mean(joints[:2, :2], axis=0)
        hip = np.mean(joints[2:, :2], axis=0)
        dx = float(hip[0] - shoulder[0])
        dy = float(hip[1] - shoulder[1])
        # 0° means vertical; 90° means horizontal.
        return abs(degrees(atan2(dx, max(abs(dy), 1e-6)))), confidence

    @staticmethod
    def _metadata(
        state: str,
        confirmed: bool,
        people: int,
        confidence: float,
        duration: float,
        aspect_ratio: float = 0.0,
        torso_angle: float = 0.0,
        height_ratio: float = 0.0,
        center_y_ratio: float = 0.0,
    ) -> dict[str, Any]:
        return {
            "type": "status",
            "fall_state": state,
            "fall_confirmed": confirmed,
            "people": people,
            "confidence": round(confidence, 3),
            "candidate_seconds": round(duration, 2),
            "aspect_ratio": round(aspect_ratio, 2),
            "torso_angle": round(torso_angle, 1),
            "height_ratio": round(height_ratio, 2),
            "center_y_ratio": round(center_y_ratio, 2),
        }

    @staticmethod
    def _draw_status(frame: np.ndarray, status: dict[str, Any]) -> None:
        danger = status["fall_state"] == "orang_jatuh"
        colour = (30, 30, 220) if danger else (45, 170, 60)
        text = status["fall_state"].replace("_", " ").upper()
        cv2.rectangle(frame, (0, 0), (frame.shape[1], 42), (15, 20, 25), -1)
        cv2.putText(frame, text, (12, 29), cv2.FONT_HERSHEY_SIMPLEX, 0.72, colour, 2)
