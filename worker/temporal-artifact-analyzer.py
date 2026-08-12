#!/usr/bin/env python3
"""Offline temporal Artifact Analyzer.

This program deliberately does not use language-model prompts.  It decodes a
real video, detects people / COCO objects / hands / poses on contiguous frames,
associates detections into tracks, and emits time-localised, conservative
artifact candidates.  It is evaluation-only by default: a candidate is evidence
for REVIEW until a Golden Dataset validates an automatic reject policy.

It writes only beneath --evidence-dir.  The input video is never opened for
writing, which makes it safe to run against read-only NAS paths.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

try:
    import cv2
    import mediapipe as mp
    import numpy as np
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision
except ImportError as error:  # clear JSON-compatible failure for the Gate
    raise SystemExit(
        f"Temporal Analyzer dependencies unavailable: {error}. "
        "Install worker/temporal-artifact-requirements.txt into an isolated Python environment."
    )


ANALYZER_VERSION = "temporal-artifact-analyzer/0.1.0"
SUPPORTED_OBJECTS = {"person", "cup", "cell phone"}
TARGET_OBJECTS = {"cup", "cell phone"}
FRAME_GAP_SECONDS = 0.70
TRACK_IOU = 0.20
MIN_TRACK_FRAMES = 3
MIN_EPISODE_FRAMES = 3


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def rounded(value: float) -> float:
    return round(float(value), 5)


def bbox_iou(left: dict[str, float], right: dict[str, float]) -> float:
    x1 = max(left["x"], right["x"])
    y1 = max(left["y"], right["y"])
    x2 = min(left["x"] + left["width"], right["x"] + right["width"])
    y2 = min(left["y"] + left["height"], right["y"] + right["height"])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = left["width"] * left["height"] + right["width"] * right["height"] - inter
    return inter / union if union > 0 else 0.0


def center(box: dict[str, float]) -> tuple[float, float]:
    return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2


def distance(left: dict[str, float], right: dict[str, float]) -> float:
    lx, ly = center(left)
    rx, ry = center(right)
    return math.hypot(lx - rx, ly - ry)


def overlaps_or_near(left: dict[str, float], right: dict[str, float], padding: float = 0.035) -> bool:
    expanded = {
        "x": left["x"] - padding,
        "y": left["y"] - padding,
        "width": left["width"] + padding * 2,
        "height": left["height"] + padding * 2,
    }
    return bbox_iou(expanded, right) > 0 or distance(left, right) <= padding + min(left["width"], left["height"])


def inside_frame(box: dict[str, float], margin: float = 0.07) -> bool:
    return (
        box["x"] >= margin
        and box["y"] >= margin
        and box["x"] + box["width"] <= 1 - margin
        and box["y"] + box["height"] <= 1 - margin
    )


def nearby_target(frame: dict[str, Any], object_type: str, reference_box: dict[str, float]) -> bool:
    """True when a same-type detector observation plausibly continues a track."""
    for item in frame.get("objects", []):
        if item.get("type") != object_type or item.get("source") != "object":
            continue
        box = item.get("bbox")
        if box and distance(box, reference_box) <= 0.14:
            return True
    return False


def context_suppression(context: list[dict[str, Any]], reference_box: dict[str, float]) -> list[str]:
    """Reasons a temporal discontinuity may be normal rather than an artifact."""
    reasons: list[str] = []
    if any(frame.get("shotBoundaryBefore") for frame in context):
        reasons.append("shot_boundary")
    if any(float(frame.get("cameraMotion", 0)) >= 0.35 for frame in context):
        reasons.append("fast_camera_motion")
    # A detected hand over the last known object position makes disappearance
    # ambiguous: it may be real occlusion. Preserve this only as REVIEW data.
    if any(
        item.get("type") == "hand" and item.get("bbox") and overlaps_or_near(item["bbox"], reference_box)
        for frame in context
        for item in frame.get("objects", [])
    ):
        reasons.append("possible_hand_occlusion")
    return reasons


def union_box(boxes: Iterable[dict[str, float]]) -> dict[str, float] | None:
    boxes = list(boxes)
    if not boxes:
        return None
    left = min(box["x"] for box in boxes)
    top = min(box["y"] for box in boxes)
    right = max(box["x"] + box["width"] for box in boxes)
    bottom = max(box["y"] + box["height"] for box in boxes)
    return {"x": rounded(left), "y": rounded(top), "width": rounded(right - left), "height": rounded(bottom - top)}


def frame_hash(frame: np.ndarray) -> str:
    return hashlib.sha256(frame.tobytes()).hexdigest()[:16]


def file_sha256(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def as_box(rect: Any, frame_width: int, frame_height: int) -> dict[str, float]:
    """Convert MediaPipe ObjectDetector's pixel rect into normalized coords.

    Hand and pose landmarks already use normalized coordinates. Tracking and
    hand/object relationships compare all sources, so retaining pixel values
    here would silently make every cross-source overlap test fail.
    """
    return {
        "x": rounded(float(rect.origin_x) / max(1, frame_width)),
        "y": rounded(float(rect.origin_y) / max(1, frame_height)),
        "width": rounded(float(rect.width) / max(1, frame_width)),
        "height": rounded(float(rect.height) / max(1, frame_height)),
    }


def landmarks_box(landmarks: list[Any]) -> dict[str, float] | None:
    if not landmarks:
        return None
    xs = [float(point.x) for point in landmarks]
    ys = [float(point.y) for point in landmarks]
    low_x, high_x = max(0.0, min(xs)), min(1.0, max(xs))
    low_y, high_y = max(0.0, min(ys)), min(1.0, max(ys))
    if high_x <= low_x or high_y <= low_y:
        return None
    return {"x": rounded(low_x), "y": rounded(low_y), "width": rounded(high_x - low_x), "height": rounded(high_y - low_y)}


@dataclass
class Observation:
    frame_index: int
    time: float
    scene_id: int
    type: str
    bbox: dict[str, float]
    confidence: float
    track_id: str | None = None
    source: str = "object"
    landmark_ratio: float | None = None


@dataclass
class Track:
    id: str
    type: str
    scene_id: int
    observations: list[Observation] = field(default_factory=list)

    @property
    def last(self) -> Observation:
        return self.observations[-1]

    def add(self, observation: Observation) -> None:
        observation.track_id = self.id
        self.observations.append(observation)


class Tracker:
    """Greedy, deterministic IoU tracker scoped to a detected shot."""

    def __init__(self) -> None:
        self.tracks: dict[str, Track] = {}
        self.counter = 0

    def add_frame(self, observations: list[Observation]) -> list[Observation]:
        assigned: set[str] = set()
        for observation in observations:
            candidates = [
                track
                for track in self.tracks.values()
                if track.type == observation.type
                and track.scene_id == observation.scene_id
                and track.id not in assigned
                and observation.time - track.last.time <= FRAME_GAP_SECONDS
            ]
            candidates.sort(key=lambda track: bbox_iou(track.last.bbox, observation.bbox), reverse=True)
            selected = candidates[0] if candidates and bbox_iou(candidates[0].last.bbox, observation.bbox) >= TRACK_IOU else None
            # Phone/cup may make a large non-physical jump.  A solitary target
            # in a shot is conservatively retained so a later motion rule can
            # inspect it; multiple same-class objects still require IoU.
            if not selected and observation.type in TARGET_OBJECTS and len(candidates) == 1:
                selected = candidates[0]
            if selected:
                selected.add(observation)
                assigned.add(selected.id)
                continue
            self.counter += 1
            track = Track(id=f"{observation.type}-{self.counter}", type=observation.type, scene_id=observation.scene_id)
            track.add(observation)
            self.tracks[track.id] = track
            assigned.add(track.id)
        return observations


class MediaPipeDetector:
    def __init__(self, model_dir: Path) -> None:
        required = {
            "efficientdet_lite0.tflite": model_dir / "efficientdet_lite0.tflite",
            "hand_landmarker.task": model_dir / "hand_landmarker.task",
            "pose_landmarker_lite.task": model_dir / "pose_landmarker_lite.task",
        }
        missing = [name for name, path in required.items() if not path.is_file()]
        if missing:
            raise RuntimeError(f"Temporal Analyzer model assets missing in {model_dir}: {', '.join(missing)}")
        base = python.BaseOptions
        mode = vision.RunningMode.VIDEO
        self.object_detector = vision.ObjectDetector.create_from_options(
            vision.ObjectDetectorOptions(
                base_options=base(model_asset_path=str(required["efficientdet_lite0.tflite"])),
                running_mode=mode,
                max_results=12,
                score_threshold=0.15,
            )
        )
        self.hand_landmarker = vision.HandLandmarker.create_from_options(
            vision.HandLandmarkerOptions(
                base_options=base(model_asset_path=str(required["hand_landmarker.task"])),
                running_mode=mode,
                num_hands=4,
                min_hand_detection_confidence=0.20,
                min_hand_presence_confidence=0.20,
                min_tracking_confidence=0.20,
            )
        )
        self.pose_landmarker = vision.PoseLandmarker.create_from_options(
            vision.PoseLandmarkerOptions(
                base_options=base(model_asset_path=str(required["pose_landmarker_lite.task"])),
                running_mode=mode,
                num_poses=4,
                min_pose_detection_confidence=0.20,
                min_pose_presence_confidence=0.20,
                min_tracking_confidence=0.20,
            )
        )

    def close(self) -> None:
        self.object_detector.close()
        self.hand_landmarker.close()
        self.pose_landmarker.close()

    def detect(self, frame: np.ndarray, timestamp_ms: int, frame_index: int, seconds: float, scene_id: int) -> tuple[list[Observation], list[Observation], list[Observation]]:
        frame_height, frame_width = frame.shape[:2]
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        objects = self.object_detector.detect_for_video(image, timestamp_ms)
        hands = self.hand_landmarker.detect_for_video(image, timestamp_ms)
        poses = self.pose_landmarker.detect_for_video(image, timestamp_ms)
        object_values: list[Observation] = []
        hand_values: list[Observation] = []
        pose_values: list[Observation] = []
        for detection in objects.detections:
            if not detection.categories:
                continue
            category = detection.categories[0]
            category_name = str(category.category_name or "").lower()
            if category_name not in SUPPORTED_OBJECTS:
                continue
            object_values.append(Observation(frame_index, seconds, scene_id, category_name, as_box(detection.bounding_box, frame_width, frame_height), float(category.score), source="object"))
        for index, points in enumerate(hands.hand_landmarks):
            box = landmarks_box(points)
            if box:
                handed = hands.handedness[index][0] if index < len(hands.handedness) and hands.handedness[index] else None
                confidence = float(handed.score) if handed else 0.5
                hand_values.append(Observation(frame_index, seconds, scene_id, "hand", box, confidence, source="hand"))
        for points in poses.pose_landmarks:
            box = landmarks_box(points)
            if not box:
                continue
            # Ratio of two upper/lower arm bones.  This remains deliberately a
            # weak signal: visual anatomy needs several consistent frames.
            ratio = None
            if len(points) > 16:
                shoulder, elbow, wrist = points[12], points[14], points[16]
                upper = math.hypot(shoulder.x - elbow.x, shoulder.y - elbow.y)
                lower = math.hypot(elbow.x - wrist.x, elbow.y - wrist.y)
                if upper > 0.005:
                    ratio = lower / upper
            confidence = min((float(point.visibility or 0) for point in points), default=0.0)
            pose_values.append(Observation(frame_index, seconds, scene_id, "person", box, confidence, source="pose", landmark_ratio=ratio))
        return object_values, hand_values, pose_values


def histogram_cut(previous: np.ndarray | None, current: np.ndarray) -> float:
    if previous is None:
        return 0.0
    left = cv2.calcHist([previous], [0], None, [32], [0, 256])
    right = cv2.calcHist([current], [0], None, [32], [0, 256])
    cv2.normalize(left, left)
    cv2.normalize(right, right)
    return float(cv2.compareHist(left, right, cv2.HISTCMP_BHATTACHARYYA))


def camera_motion(previous: np.ndarray | None, current: np.ndarray) -> float:
    if previous is None:
        return 0.0
    flow = cv2.calcOpticalFlowFarneback(previous, current, None, 0.5, 2, 21, 3, 5, 1.2, 0)
    magnitude, _ = cv2.cartToPolar(flow[..., 0], flow[..., 1])
    diagonal = math.hypot(current.shape[0], current.shape[1])
    return float(clamp(float(np.median(magnitude)) / max(1.0, diagonal) * 30.0))


def episode_confidence(observations: list[Observation], suppression: list[str]) -> float:
    if not observations:
        return 0.0
    base = sum(item.confidence for item in observations) / len(observations)
    continuity = clamp((len(observations) - 1) / 4)
    penalty = 0.45 if suppression else 0.0
    return rounded(clamp(base * 0.65 + continuity * 0.35 - penalty))


def groups(items: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    output: list[list[dict[str, Any]]] = []
    for item in sorted(items, key=lambda entry: (entry["trackId"], entry["frameIndex"])):
        previous = output[-1][-1] if output else None
        if previous and previous["type"] == item["type"] and previous["trackId"] == item["trackId"] and item["frameIndex"] - previous["frameIndex"] <= 2:
            output[-1].append(item)
        else:
            output.append([item])
    return output


def detect_episodes(tracks: dict[str, Track], frames: list[dict[str, Any]], sample_fps: float) -> list[dict[str, Any]]:
    episodes: list[dict[str, Any]] = []
    by_scene: dict[int, list[dict[str, Any]]] = {}
    for frame in frames:
        by_scene.setdefault(frame["sceneId"], []).append(frame)
    for track in tracks.values():
        values = track.observations
        if track.type not in TARGET_OBJECTS or len(values) < MIN_TRACK_FRAMES:
            continue
        scene_frames = by_scene.get(track.scene_id, [])
        index_by_number = {frame["frameIndex"]: frame for frame in scene_frames}
        first, last = values[0], values[-1]
        before = [frame for frame in scene_frames if frame["frameIndex"] < first.frame_index]
        after = [frame for frame in scene_frames if frame["frameIndex"] > last.frame_index]
        stable = values[-MIN_TRACK_FRAMES:]
        leading = values[:MIN_TRACK_FRAMES]
        common = {
            "object": track.type,
            "trackId": track.id,
            "sceneId": track.scene_id,
            "bbox": last.bbox,
            "observations": stable,
        }
        if len(after) >= MIN_EPISODE_FRAMES and inside_frame(last.bbox):
            candidate_frames = after[:MIN_EPISODE_FRAMES]
            # Do not turn a tracker re-association failure into a disappearance.
            if not any(nearby_target(frame, track.type, last.bbox) for frame in candidate_frames):
                suppress = context_suppression(candidate_frames, last.bbox)
                episodes.append(make_episode("object_disappearance", stable, index_by_number[stable[0].frame_index], candidate_frames[-1], common, suppress, [item.frame_index for item in stable] + [frame["frameIndex"] for frame in candidate_frames]))
        if len(before) >= MIN_EPISODE_FRAMES and inside_frame(first.bbox):
            candidate_frames = before[-MIN_EPISODE_FRAMES:]
            if not any(nearby_target(frame, track.type, first.bbox) for frame in candidate_frames):
                suppress = context_suppression(candidate_frames, first.bbox)
                appearance_common = {**common, "bbox": first.bbox, "observations": leading}
                episodes.append(make_episode("object_appearance", leading, candidate_frames[0], index_by_number[leading[-1].frame_index], appearance_common, suppress, [frame["frameIndex"] for frame in candidate_frames] + [item.frame_index for item in leading]))
        for previous, current in zip(values, values[1:]):
            gap = current.frame_index - previous.frame_index
            if gap > 2:
                continue
            moved = distance(previous.bbox, current.bbox)
            source_frame = index_by_number.get(current.frame_index, {})
            if moved >= 0.30 and source_frame.get("cameraMotion", 1) < 0.20:
                suppress = context_suppression([source_frame], current.bbox)
                episodes.append(make_episode("non_physical_motion", [previous, current], source_frame, source_frame, common, suppress))
    # Hand-object detachment: only assert a candidate when the very same tracked
    # object transitions from near a tracked hand to separated while both remain.
    hands = [track for track in tracks.values() if track.type == "hand" and len(track.observations) >= MIN_TRACK_FRAMES]
    targets = [track for track in tracks.values() if track.type in TARGET_OBJECTS and len(track.observations) >= MIN_TRACK_FRAMES]
    for object_track in targets:
        for hand_track in hands:
            if hand_track.scene_id != object_track.scene_id:
                continue
            pairs = []
            for obj in object_track.observations:
                nearby = min(hand_track.observations, key=lambda hand: abs(hand.frame_index - obj.frame_index), default=None)
                if nearby and abs(nearby.frame_index - obj.frame_index) <= 1:
                    pairs.append((obj, nearby, overlaps_or_near(obj.bbox, nearby.bbox)))
            for transition in range(1, len(pairs)):
                history = pairs[max(0, transition - MIN_TRACK_FRAMES):transition]
                following = pairs[transition:transition + MIN_EPISODE_FRAMES]
                if len(history) < MIN_TRACK_FRAMES - 1 or len(following) < MIN_EPISODE_FRAMES:
                    continue
                if all(item[2] for item in history) and all(not item[2] for item in following):
                    evidence = [item[0] for item in following]
                    start_frame = next(frame for frame in frames if frame["frameIndex"] == following[0][0].frame_index)
                    end_frame = next(frame for frame in frames if frame["frameIndex"] == following[-1][0].frame_index)
                    common = {"object": object_track.type, "trackId": object_track.id, "relatedTrackId": hand_track.id, "sceneId": object_track.scene_id, "bbox": union_box([item[0].bbox for item in following] + [item[1].bbox for item in following]), "observations": evidence}
                    episodes.append(make_episode("hand_object_detachment", evidence, start_frame, end_frame, common, context_suppression([start_frame, end_frame], object_track.last.bbox), [item[0].frame_index for item in history + following]))
                    break
    # Pose landmarks are retained in the frame evidence, but deliberately do
    # not produce a human_anatomy_anomaly episode yet.  Real-video validation
    # found that 2-D arm-length ratios flag normal foreshortening and gestures.
    # Emitting no anatomy episode is safer than asserting a false defect; a
    # topology/anatomy model must earn this class on labelled positive footage.
    # Required temporal proof: never return a reject candidate with one frame.
    return [episode for episode in episodes if episode["consecutiveFrames"] >= 2]


def make_episode(kind: str, observations: list[Observation], start_frame: dict[str, Any], end_frame: dict[str, Any], common: dict[str, Any], suppression: list[str], evidence_frames: list[int] | None = None) -> dict[str, Any]:
    unique = {item.frame_index: item for item in observations}
    values = list(unique.values())
    return {
        "id": f"{kind}:{common['trackId']}:{values[0].frame_index}",
        "type": kind,
        "object": common["object"],
        "trackId": common["trackId"],
        **({"relatedTrackId": common["relatedTrackId"]} if common.get("relatedTrackId") else {}),
        "sceneId": common["sceneId"],
        "startTime": rounded(start_frame["time"]),
        "endTime": rounded(end_frame["time"]),
        "bbox": common["bbox"],
        "consecutiveFrames": len(values),
        "frames": sorted(set(evidence_frames or [item.frame_index for item in values])),
        "confidence": episode_confidence(values, suppression),
        "suppressionReasons": sorted(set(suppression)),
        "decisionHint": "review" if suppression or len(values) < MIN_EPISODE_FRAMES else "reject_candidate",
    }


def save_evidence(video_path: str, frames: list[dict[str, Any]], episodes: list[dict[str, Any]], evidence_dir: Path, fps: float) -> None:
    evidence_dir.mkdir(parents=True, exist_ok=True)
    index = {frame["frameIndex"]: frame for frame in frames}
    capture = cv2.VideoCapture(video_path)
    for episode in episodes:
        directory = evidence_dir / episode["id"].replace(":", "_")
        directory.mkdir(parents=True, exist_ok=True)
        episode_frames = sorted(set(episode["frames"]))
        focal = episode_frames[len(episode_frames) // 2]
        # These are temporal anchors, not merely adjacent decoder frames: a
        # reviewer sees the evidence before, during, and after the full
        # episode at the configured sampling cadence.
        selections = {"previous": episode_frames[0], "anomaly": focal, "next": episode_frames[-1]}
        assets: dict[str, str] = {}
        for label, frame_number in selections.items():
            capture.set(cv2.CAP_PROP_POS_FRAMES, frame_number)
            ok, image = capture.read()
            if not ok:
                continue
            full = directory / f"{label}.jpg"
            cv2.imwrite(str(full), image)
            assets[label] = str(full)
            box = episode.get("bbox")
            if box:
                height, width = image.shape[:2]
                x1 = max(0, int((box["x"] - 0.05) * width))
                y1 = max(0, int((box["y"] - 0.05) * height))
                x2 = min(width, int((box["x"] + box["width"] + 0.05) * width))
                y2 = min(height, int((box["y"] + box["height"] + 0.05) * height))
                if x2 > x1 and y2 > y1:
                    crop = directory / f"{label}-crop.jpg"
                    cv2.imwrite(str(crop), image[y1:y2, x1:x2])
                    assets[f"{label}Crop"] = str(crop)
        # A short source-derived clip lets a reviewer inspect motion rather
        # than infer it from three stills.  Failure to open a local mp4 writer
        # is non-fatal; the still evidence remains available.
        clip = directory / "context.mp4"
        capture.set(cv2.CAP_PROP_POS_FRAMES, max(0, focal - int(1.5 * fps)))
        okay, first = capture.read()
        if okay:
            height, width = first.shape[:2]
            writer = cv2.VideoWriter(str(clip), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
            if writer.isOpened():
                writer.write(first)
                for _ in range(max(0, int(3 * fps) - 1)):
                    next_ok, next_image = capture.read()
                    if not next_ok:
                        break
                    writer.write(next_image)
                writer.release()
                if clip.is_file() and clip.stat().st_size > 0:
                    assets["contextClip"] = str(clip)
            else:
                writer.release()
        episode["evidenceAssets"] = assets
    capture.release()


def to_gate_frames(frames: list[dict[str, Any]], episodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_frame: dict[int, list[dict[str, Any]]] = {}
    aliases = {
        "object_disappearance": "object_disappear",
        "object_appearance": "object_spawn",
        "non_physical_motion": "object_teleport",
        "hand_object_detachment": "hand_object_detachment",
        "human_anatomy_anomaly": "human_body_structure",
    }
    for episode in episodes:
        for frame_index in episode["frames"]:
            by_frame.setdefault(frame_index, []).append({
                "type": aliases[episode["type"]],
                "canonicalType": episode["type"],
                "trackId": episode["trackId"],
                "bbox": episode["bbox"],
                "confidence": episode["confidence"],
                "decisionHint": episode["decisionHint"],
                "suppressionReasons": episode["suppressionReasons"],
            })
    values = []
    for frame in frames:
        values.append({
            "time": frame["time"],
            "frameIndex": frame["frameIndex"],
            "sceneId": frame["sceneId"],
            "shotBoundaryBefore": frame["shotBoundaryBefore"],
            "fastMotion": frame["cameraMotion"] >= 0.35,
            "cameraMotion": frame["cameraMotion"],
            "objects": frame["objects"],
            "relations": frame["relations"],
            "anomalies": by_frame.get(frame["frameIndex"], []),
        })
    return values


def analyze(args: argparse.Namespace) -> dict[str, Any]:
    input_path = Path(args.input).resolve()
    if not input_path.is_file():
        raise RuntimeError(f"Input video is not readable: {input_path}")
    model_dir = Path(args.model_dir or os.environ.get("TEMPORAL_ARTIFACT_MODEL_DIR", r"D:\codex\cache\temporal-artifact-analyzer\models"))
    sample_fps = max(2.0, min(12.0, float(args.sample_fps)))
    evidence_dir = Path(args.evidence_dir).resolve() if args.evidence_dir else None
    detector = MediaPipeDetector(model_dir)
    capture = cv2.VideoCapture(str(input_path))
    if not capture.isOpened():
        detector.close()
        raise RuntimeError(f"OpenCV cannot decode video: {input_path}")
    input_fps = float(capture.get(cv2.CAP_PROP_FPS) or 30.0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    stride = max(1, int(round(input_fps / sample_fps)))
    scene_id = 0
    previous_gray: np.ndarray | None = None
    tracker = Tracker()
    frames: list[dict[str, Any]] = []
    started = time.perf_counter()
    decoded = 0
    try:
        while True:
            okay, frame = capture.read()
            if not okay:
                break
            frame_index = int(capture.get(cv2.CAP_PROP_POS_FRAMES)) - 1
            if frame_index % stride:
                continue
            decoded += 1
            seconds = frame_index / input_fps
            grayscale = cv2.cvtColor(cv2.resize(frame, (320, 180)), cv2.COLOR_BGR2GRAY)
            cut_score = histogram_cut(previous_gray, grayscale)
            motion = camera_motion(previous_gray, grayscale)
            boundary = cut_score >= 0.58
            if boundary:
                scene_id += 1
            timestamp_ms = int(round(seconds * 1000))
            object_values, hand_values, pose_values = detector.detect(frame, timestamp_ms, frame_index, seconds, scene_id)
            tracker.add_frame(object_values + hand_values + pose_values)
            # Relations are measured only from actual same-frame detections.
            relations = []
            for target in [item for item in object_values if item.type in TARGET_OBJECTS]:
                near_hands = [hand for hand in hand_values if overlaps_or_near(target.bbox, hand.bbox)]
                if near_hands:
                    relations.append({"type": "hand_object", "objectType": target.type, "objectTrackId": target.track_id, "relatedTrackIds": [hand.track_id for hand in near_hands], "state": "attached", "bbox": union_box([target.bbox] + [hand.bbox for hand in near_hands]), "confidence": min([target.confidence] + [hand.confidence for hand in near_hands])})
            frame_record = {
                "frameIndex": frame_index,
                "time": rounded(seconds),
                "sceneId": scene_id,
                "shotBoundaryBefore": boundary,
                "cutScore": rounded(cut_score),
                "cameraMotion": rounded(motion),
                "frameHash": frame_hash(cv2.resize(frame, (64, 64))),
                "objects": [{"type": item.type, "trackId": item.track_id, "bbox": item.bbox, "confidence": rounded(item.confidence), "source": item.source} for item in object_values + hand_values + pose_values],
                "relations": relations,
            }
            frames.append(frame_record)
            previous_gray = grayscale
    finally:
        capture.release()
        detector.close()
    episodes = detect_episodes(tracker.tracks, frames, sample_fps)
    if evidence_dir:
        save_evidence(str(input_path), frames, episodes, evidence_dir, input_fps)
    elapsed = time.perf_counter() - started
    model_assets = {
        name: {"sha256": file_sha256(model_dir / name), "bytes": (model_dir / name).stat().st_size}
        for name in ("efficientdet_lite0.tflite", "hand_landmarker.task", "pose_landmarker_lite.task")
    }
    raw = {
        "schemaVersion": 1,
        "analyzer": {
            "name": ANALYZER_VERSION,
            "mode": "evaluation",
            "runtime": {"name": "MediaPipe", "version": getattr(mp, "__version__", "unknown"), "license": "Apache-2.0"},
            "modelAssets": model_assets,
            "modelAssetLicense": "not independently verified; evaluation-only",
            "modelDir": str(model_dir),
        },
        "source": {"path": str(input_path), "sha256": file_sha256(input_path)},
        "sampleFps": sample_fps,
        "inputFps": input_fps,
        "frameCount": frame_count,
        "sampledFrames": len(frames),
        "metrics": {"elapsedSeconds": rounded(elapsed), "sampledFramesPerSecond": rounded(len(frames) / elapsed) if elapsed else None},
        "episodes": episodes,
        "frames": to_gate_frames(frames, episodes),
    }
    return raw


def main() -> int:
    parser = argparse.ArgumentParser(description="Temporal Artifact Analyzer (evaluation mode)")
    parser.add_argument("--input", required=True)
    parser.add_argument("--sample-fps", default=6, type=float)
    parser.add_argument("--format", choices=["json"], default="json")
    parser.add_argument("--evidence-dir")
    parser.add_argument("--model-dir")
    args = parser.parse_args()
    try:
        print(json.dumps(analyze(args), ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as error:
        print(json.dumps({"error": {"message": str(error), "analyzer": ANALYZER_VERSION}}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
