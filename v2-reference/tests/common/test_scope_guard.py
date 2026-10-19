from __future__ import annotations

import os
import unittest
from unittest.mock import patch


from trading_os_v2.common.config import DATA_ROOT, PACKAGE_ROOT, ROOT, package_data_path, runtime_path


class PublicPackageScopeTests(unittest.TestCase):
    def test_owner_repository_scope_tool_is_not_distributed(self) -> None:
        self.assertFalse((ROOT / "tools" / "scope_guard.py").exists())
        self.assertFalse((ROOT / ".githooks").exists())

    def test_actual_package_storage_guard_rejects_external_paths(self) -> None:
        self.assertEqual(package_data_path(DATA_ROOT / "SYNTHETIC.json"), DATA_ROOT / "SYNTHETIC.json")
        with self.assertRaisesRegex(RuntimeError, "inside this package"):
            package_data_path(PACKAGE_ROOT / "SYNTHETIC-outside-data")
        with patch.dict(os.environ, {"TRADING_OS_V2_RUNTIME_ROOT": str(PACKAGE_ROOT / "SYNTHETIC-external-runtime")}):
            with self.assertRaisesRegex(RuntimeError, "External V2 runtime"):
                runtime_path("SYNTHETIC.json")


if __name__ == "__main__":
    unittest.main()
