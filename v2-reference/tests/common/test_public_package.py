"""Independent package boundaries; no provider or model authorization is used."""
import copy
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from trading_os_v2.common.config import DATA_ROOT, PACKAGE_ROOT, ROOT, RUNTIME_ROOT, load_config, runtime_path
from trading_os_v2.agent_runtime.service import AgentFailure, _find_codex
from trading_os_v2.discord_gateway.service import DiscordFailure, DiscordGateway


class PublicPackageTests(unittest.TestCase):
    def test_all_imported_runtime_helpers_share_the_package_boundary(self):
        from trading_os_v2.a1 import state, position_monitor
        from trading_os_v2.ts import public
        from trading_os_v2.a2 import pattern_tracker
        for module in (state, position_monitor, public, pattern_tracker):
            with self.subTest(module=module.__name__):
                self.assertEqual(module.runtime_path("state", "example.json"), RUNTIME_ROOT / "state" / "example.json")
        self.assertEqual(Path(load_config()["data"]["storage_root"]), DATA_ROOT)
        self.assertFalse(load_config()["discord"]["enabled"])
        self.assertEqual(load_config()["discord"]["channels"], {})

    def test_runtime_rejects_external_environment_and_path_traversal(self):
        with patch.dict(os.environ, {"TRADING_OS_V2_RUNTIME_ROOT": str(PACKAGE_ROOT.parent / "unrelated-runtime")}):
            with self.assertRaisesRegex(RuntimeError, "External V2 runtime"):
                runtime_path("state")
        with self.assertRaisesRegex(RuntimeError, "inside this package"):
            runtime_path("..", "..", "..", "..", "outside")
        with self.assertRaisesRegex(RuntimeError, "runtime directory"):
            runtime_path("..", "..", "owner-access.json")

    def test_config_keeps_execution_and_external_storage_closed(self):
        template = load_config()
        for mutate in (
            lambda value: value["system"].update(execution_enabled=True),
            lambda value: value["data"].update(storage_root="../unrelated-data"),
            lambda value: value["discord"].update(enabled=True),
        ):
            with self.subTest(mutation=mutate):
                candidate = copy.deepcopy(template)
                mutate(candidate)
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "invalid.json"
                    path.write_text(json.dumps(candidate), encoding="utf-8")
                    with self.assertRaises(RuntimeError):
                        load_config(path)

    def test_discord_never_reads_user_environment(self):
        registry = SimpleNamespace(OpenKey=Mock(side_effect=AssertionError("Global credentials were consulted")))
        with patch.dict(sys.modules, {"winreg": registry}):
            with self.assertRaisesRegex(DiscordFailure, "disabled"):
                DiscordGateway(load_config())
        registry.OpenKey.assert_not_called()

    def test_a1_missing_credentials_never_consult_global_registry(self):
        from trading_os_v2.a1.service import A1Collector, ProviderError
        registry = SimpleNamespace(OpenKey=Mock(side_effect=AssertionError("Global credentials were consulted")))
        client = Mock()
        with patch.dict(os.environ, {}, clear=True), patch.dict(sys.modules, {"winreg": registry}):
            collector = A1Collector(load_config(), client=client)
            with self.assertRaisesRegex(ProviderError, "credential missing"):
                collector._tradier("/markets/clock", {}, "offline test")
            self.assertEqual(collector._collect_finnhub()["status"], "MISSING_CREDENTIAL")
        registry.OpenKey.assert_not_called()
        client.json.assert_not_called()

    def test_a1_uses_only_explicit_process_credentials(self):
        from trading_os_v2.a1.service import A1Collector
        client = Mock()
        client.json.side_effect = [{"test_only": True}, [], {"earningsCalendar": []}]
        config = load_config()
        environment = {config["providers"]["tradier"]["token_env"]: "SYNTHETIC_TRADIER", config["providers"]["finnhub"]["token_env"]: "SYNTHETIC_FINNHUB"}
        with patch.dict(os.environ, environment, clear=True):
            collector = A1Collector(config, client=client)
            self.assertEqual(collector._tradier("/markets/clock", {}, "offline test"), {"test_only": True})
            self.assertEqual(collector._collect_finnhub()["status"], "HEALTHY")
        self.assertEqual(client.json.call_args_list[0].kwargs["headers"]["Authorization"], "Bearer SYNTHETIC_TRADIER")
        for call in client.json.call_args_list[1:]:
            self.assertEqual(call.kwargs["params"]["token"], "SYNTHETIC_FINNHUB")

    def test_review_root_is_the_current_package_not_a_legacy_drive(self):
        from trading_os_v2.acceptance.service import _review_root
        self.assertEqual(_review_root(), PACKAGE_ROOT / "web/data/reviews")

    def test_model_rejects_global_credentials_and_cli_fallback(self):
        with patch.dict(os.environ, {"CODEX_CLI_PATH": sys.executable, "CODEX_HOME": ""}):
            with self.assertRaisesRegex(AgentFailure, "independent model account"):
                _find_codex()
        with patch.dict(os.environ, {"CODEX_CLI_PATH": sys.executable, "CODEX_HOME": str(PACKAGE_ROOT / "web/data/model-codex-home")}):
            with self.assertRaisesRegex(AgentFailure, "package-local Codex CLI"):
                _find_codex()

    def test_adapter_rejects_any_other_source_or_data_root(self):
        adapter = runpy.run_path(str(PACKAGE_ROOT / "web/scripts/live-shadow-v2.py"))
        with self.assertRaisesRegex(RuntimeError, "bundled V2"):
            adapter["configure"](PACKAGE_ROOT / "unrelated-source", PACKAGE_ROOT / "web/data/live-shadow")
        with self.assertRaisesRegex(RuntimeError, "inside this package"):
            adapter["configure"](ROOT, PACKAGE_ROOT.parent / "unrelated-data")

    def test_release_identity_uses_bundled_content_not_git_history(self):
        from trading_os_v2.orchestrator.service import _release_commit
        with patch("subprocess.run", side_effect=AssertionError("Git history must not be consulted")):
            identity = _release_commit()
            self.assertRegex(identity, r"^[0-9a-f]{64}$")
            self.assertEqual(_release_commit(), identity)
            original_read = Path.read_bytes
            with patch.object(Path, "read_bytes", lambda path: original_read(path) + (b" " if path == ROOT / "config/system.json" else b"")):
                self.assertNotEqual(_release_commit(), identity)
