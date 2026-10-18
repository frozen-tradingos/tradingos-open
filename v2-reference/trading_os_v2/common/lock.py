from __future__ import annotations

import errno
import json
import os
from datetime import UTC, datetime
from pathlib import Path


class AlreadyRunning(RuntimeError):
    pass


class ProcessLock:
    """A crash-safe, non-blocking process lock backed by the operating system."""

    def __init__(self, path: Path):
        self.path = path
        self.acquired = False
        self._descriptor: int | None = None

    def __enter__(self) -> "ProcessLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            _ensure_lock_byte(descriptor)
            _acquire_descriptor(descriptor)
        except OSError as exc:
            os.close(descriptor)
            if _is_lock_contention(exc):
                pid = _read_pid(self.path)
                owner = f"Process {pid}" if pid else "Another process"
                raise AlreadyRunning(
                    f"{owner} already owns {self.path.name}"
                ) from exc
            raise

        try:
            _write_record(
                descriptor,
                {
                    "pid": os.getpid(),
                    "started_at": datetime.now(UTC).isoformat(),
                },
            )
        except BaseException:
            try:
                _release_descriptor(descriptor)
            finally:
                os.close(descriptor)
            raise

        self._descriptor = descriptor
        self.acquired = True
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        descriptor = self._descriptor
        self._descriptor = None
        self.acquired = False
        if descriptor is None:
            return
        try:
            _release_descriptor(descriptor)
        finally:
            os.close(descriptor)


def lock_status(path: Path) -> dict[str, object]:
    if not path.exists():
        return {"exists": False, "pid": 0, "alive": False}
    pid = _read_pid(path)
    try:
        descriptor = os.open(path, os.O_RDWR)
    except OSError:
        return {"exists": True, "pid": pid, "alive": True}
    try:
        _ensure_lock_byte(descriptor)
        try:
            _acquire_descriptor(descriptor)
        except OSError as exc:
            if _is_lock_contention(exc):
                return {"exists": True, "pid": pid, "alive": True}
            return {"exists": True, "pid": pid, "alive": True}
        _release_descriptor(descriptor)
        return {"exists": True, "pid": pid, "alive": False}
    finally:
        os.close(descriptor)


def _ensure_lock_byte(descriptor: int) -> None:
    if os.fstat(descriptor).st_size:
        return
    os.lseek(descriptor, 0, os.SEEK_SET)
    os.write(descriptor, b"\0")
    os.fsync(descriptor)


def _write_record(descriptor: int, record: dict[str, object]) -> None:
    payload = b"\0" + json.dumps(
        record,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    os.lseek(descriptor, 0, os.SEEK_SET)
    os.write(descriptor, payload)
    os.ftruncate(descriptor, len(payload))
    os.fsync(descriptor)


def _read_pid(path: Path) -> int:
    try:
        with path.open("rb") as stream:
            stream.seek(1)
            payload = stream.read()
        return int(json.loads(payload.decode("utf-8")).get("pid", 0))
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
        try:
            return int(json.loads(path.read_text(encoding="utf-8")).get("pid", 0))
        except (OSError, ValueError, json.JSONDecodeError):
            return 0


def _acquire_descriptor(descriptor: int) -> None:
    os.lseek(descriptor, 0, os.SEEK_SET)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        return

    import fcntl

    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)


def _release_descriptor(descriptor: int) -> None:
    os.lseek(descriptor, 0, os.SEEK_SET)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        return

    import fcntl

    fcntl.flock(descriptor, fcntl.LOCK_UN)


def _is_lock_contention(exc: OSError) -> bool:
    return exc.errno in {
        errno.EACCES,
        errno.EAGAIN,
        errno.EDEADLK,
    }
