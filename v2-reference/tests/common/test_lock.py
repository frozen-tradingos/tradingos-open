from __future__ import annotations

import json
import multiprocessing
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from trading_os_v2.common.lock import (
    AlreadyRunning,
    ProcessLock,
    lock_status,
)


def _hold_process_lock(path: str, ready: object, release: object) -> None:
    with ProcessLock(Path(path)):
        ready.set()
        release.wait(10)


class ProcessLockTests(unittest.TestCase):
    def test_publishes_complete_lock_record_while_held(self) -> None:
        with TemporaryDirectory() as folder:
            path = Path(folder) / "worker.lock"
            with ProcessLock(path):
                status = lock_status(path)
                self.assertTrue(status["alive"])
                self.assertEqual(status["pid"], os.getpid())

            self.assertTrue(path.exists())
            self.assertFalse(lock_status(path)["alive"])
            payload = path.read_bytes()
            self.assertEqual(payload[:1], b"\0")
            stored = json.loads(payload[1:].decode("utf-8"))
            self.assertEqual(stored["pid"], os.getpid())

    def test_live_owner_is_not_replaced(self) -> None:
        with TemporaryDirectory() as folder:
            path = Path(folder) / "worker.lock"
            with ProcessLock(path):
                with self.assertRaises(AlreadyRunning):
                    with ProcessLock(path):
                        pass

    def test_unreadable_unlocked_record_is_replaced(self) -> None:
        with TemporaryDirectory() as folder:
            path = Path(folder) / "worker.lock"
            path.write_text("", encoding="utf-8")
            with ProcessLock(path):
                self.assertEqual(lock_status(path)["pid"], os.getpid())

    def test_stale_owner_record_is_replaced_without_deleting_lock_file(self) -> None:
        with TemporaryDirectory() as folder:
            path = Path(folder) / "worker.lock"
            path.write_text(
                json.dumps({"pid": 99999999, "started_at": "old"}),
                encoding="utf-8",
            )
            with ProcessLock(path):
                self.assertEqual(lock_status(path)["pid"], os.getpid())
            self.assertTrue(path.exists())

    def test_kernel_lock_is_released_after_owner_process_exits(self) -> None:
        with TemporaryDirectory() as folder:
            path = Path(folder) / "worker.lock"
            context = multiprocessing.get_context("spawn")
            ready = context.Event()
            release = context.Event()
            worker = context.Process(
                target=_hold_process_lock,
                args=(str(path), ready, release),
            )
            worker.start()
            try:
                self.assertTrue(ready.wait(5))
                self.assertTrue(lock_status(path)["alive"])
                with self.assertRaises(AlreadyRunning):
                    with ProcessLock(path):
                        pass
            finally:
                release.set()
                worker.join(10)
                if worker.is_alive():
                    worker.terminate()
                    worker.join(5)

            self.assertEqual(worker.exitcode, 0)
            with ProcessLock(path):
                self.assertTrue(lock_status(path)["alive"])


if __name__ == "__main__":
    unittest.main()
