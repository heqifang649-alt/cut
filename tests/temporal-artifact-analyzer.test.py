"""Unit tests for temporal identity and conservative episode rules.

Run with the isolated analyzer dependencies on PYTHONPATH:
  $env:PYTHONPATH='D:\\codex\\cache\\temporal-artifact-analyzer\\python-packages'
  D:\\codex\\cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe tests/temporal-artifact-analyzer.test.py
"""

import importlib.util
import pathlib
import sys
import unittest


MODULE = pathlib.Path(__file__).parents[1] / "worker" / "temporal-artifact-analyzer.py"
SPEC = importlib.util.spec_from_file_location("temporal_artifact_analyzer", MODULE)
ANALYZER = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = ANALYZER
SPEC.loader.exec_module(ANALYZER)


def box(x, y, width=0.1, height=0.2):
    return {"x": x, "y": y, "width": width, "height": height}


def frame(index, time, scene=0, motion=0.0):
    return {"frameIndex": index, "time": time, "sceneId": scene, "shotBoundaryBefore": False, "cameraMotion": motion, "objects": [], "relations": []}


class TemporalAnalyzerTests(unittest.TestCase):
    def test_tracker_keeps_one_object_identity_in_contiguous_frames(self):
        tracker = ANALYZER.Tracker()
        first = ANALYZER.Observation(0, 0.0, 0, "cell phone", box(0.4, 0.4), 0.9)
        second = ANALYZER.Observation(1, 1 / 6, 0, "cell phone", box(0.41, 0.4), 0.9)
        tracker.add_frame([first])
        tracker.add_frame([second])
        self.assertEqual(first.track_id, second.track_id)

    def test_disappearance_requires_same_track_and_following_frames(self):
        track = ANALYZER.Track(id="cell phone-1", type="cell phone", scene_id=0)
        for index in range(3):
            track.add(ANALYZER.Observation(index, index / 6, 0, "cell phone", box(0.4, 0.4), 0.95))
        frames = [frame(index, index / 6) for index in range(6)]
        episodes = ANALYZER.detect_episodes({track.id: track}, frames, 6)
        disappearance = [episode for episode in episodes if episode["type"] == "object_disappearance"]
        self.assertEqual(len(disappearance), 1)
        self.assertEqual(disappearance[0]["trackId"], "cell phone-1")
        self.assertGreaterEqual(disappearance[0]["consecutiveFrames"], 3)

    def test_cut_or_fast_motion_is_not_a_reject_candidate(self):
        track = ANALYZER.Track(id="cup-1", type="cup", scene_id=0)
        for index in range(3):
            track.add(ANALYZER.Observation(index, index / 6, 0, "cup", box(0.4, 0.4), 0.95))
        frames = [frame(index, index / 6, motion=0.6) for index in range(6)]
        episodes = ANALYZER.detect_episodes({track.id: track}, frames, 6)
        self.assertTrue(episodes)
        self.assertTrue(all(episode["decisionHint"] == "review" for episode in episodes))
        self.assertTrue(all("fast_camera_motion" in episode["suppressionReasons"] for episode in episodes if episode["type"] == "object_disappearance"))


if __name__ == "__main__":
    unittest.main()
