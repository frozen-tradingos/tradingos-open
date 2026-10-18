from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "scope_guard",
    ROOT / "tools" / "scope_guard.py",
)
assert SPEC and SPEC.loader
SCOPE_GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCOPE_GUARD)


class ScopeGuardTests(unittest.TestCase):
    def test_change_in_b_cannot_hide_inside_a_scope(self) -> None:
        changed = [
            "trading_os_v2/a1/service.py",
            "trading_os_v2/a2/service.py",
        ]
        self.assertEqual(
            SCOPE_GUARD.out_of_scope(changed, ["trading_os_v2/a1/"]),
            ["trading_os_v2/a2/service.py"],
        )

    def test_isolation_scope_cannot_modify_runtime_module(self) -> None:
        changed = [
            "tools/scope_guard.py",
            "trading_os_v2/a1/service.py",
        ]
        self.assertEqual(
            SCOPE_GUARD.out_of_scope(
                changed,
                [
                    "tools/scope_guard.py",
                    ".githooks/",
                ],
            ),
            ["trading_os_v2/a1/service.py"],
        )


if __name__ == "__main__":
    unittest.main()
