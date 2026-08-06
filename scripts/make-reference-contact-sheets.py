from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np


VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".avi"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--videos", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    videos = sorted(path for path in args.videos.rglob("*") if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS)
    all_sheets = []
    for number, video in enumerate(videos, start=1):
        capture = cv2.VideoCapture(str(video))
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 30.0)
        frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        duration = frames / fps if fps > 0 else 0.0
        thumbs = []
        for ratio in np.linspace(0.04, 0.96, 9):
            capture.set(cv2.CAP_PROP_POS_MSEC, duration * ratio * 1000)
            ok, frame = capture.read()
            if not ok:
                continue
            thumb = cv2.resize(frame, (180, 320), interpolation=cv2.INTER_AREA)
            cv2.putText(thumb, f"{duration * ratio:.1f}s", (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2, cv2.LINE_AA)
            thumbs.append(thumb)
        capture.release()
        if not thumbs:
            continue
        rows = []
        for start in range(0, len(thumbs), 3):
            row = thumbs[start:start + 3]
            while len(row) < 3:
                row.append(np.zeros_like(thumbs[0]))
            rows.append(np.hstack(row))
        sheet = np.vstack(rows)
        cv2.putText(sheet, f"{number:02d} {video.name}", (8, sheet.shape[0] - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (255, 255, 255), 2, cv2.LINE_AA)
        output = args.output / f"{number:02d}-{video.stem}.jpg"
        encoded, buffer = cv2.imencode(".jpg", sheet)
        if encoded:
            buffer.tofile(str(output))
            all_sheets.append(cv2.resize(sheet, (270, 480), interpolation=cv2.INTER_AREA))
    rows = []
    for start in range(0, len(all_sheets), 4):
        row = all_sheets[start:start + 4]
        while len(row) < 4:
            row.append(np.zeros_like(all_sheets[0]))
        rows.append(np.hstack(row))
    if rows:
        encoded, buffer = cv2.imencode(".jpg", np.vstack(rows))
        if encoded:
            buffer.tofile(str(args.output / "all-reference-videos.jpg"))
    print(f"created={len(all_sheets)}")


if __name__ == "__main__":
    main()
