from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import Mock, patch

from trading_os_v2.discord_gateway.service import DiscordFailure, DiscordGateway, _reject_overlong_content


def gateway() -> DiscordGateway:
    # SYNTHETIC attempt to enable a non-distributed integration must still fail closed.
    return DiscordGateway({"discord": {"enabled": True, "bot_token_env": "DISCORD_TEST_TOKEN", "channels": {"a1": "123456789"}}})


def a1_message(length: int) -> str:
    title = "【员工：A1｜系统与数据】\n"
    return title + "x" * (length - len(title))


class PublicDiscordGatewayTests(unittest.TestCase):
    def assert_disabled_without_external_access(self, action) -> None:
        registry = Mock()
        with (
            patch.dict(os.environ, {"DISCORD_TEST_TOKEN": "SYNTHETIC-NOT-A-TOKEN"}),
            patch.dict(sys.modules, {"winreg": registry}),
            patch("trading_os_v2.discord_gateway.service.urllib.request.urlopen") as urlopen,
        ):
            with self.assertRaisesRegex(DiscordFailure, "disabled in the independent public package"):
                action()
        urlopen.assert_not_called()
        self.assertEqual(registry.mock_calls, [])

    def test_send_over_limit_is_disabled_without_a_request(self) -> None:
        with self.assertRaisesRegex(DiscordFailure, "超过2000"):
            _reject_overlong_content(a1_message(2001))
        self.assert_disabled_without_external_access(lambda: gateway().send("a1", a1_message(2001)))

    def test_send_at_limit_is_still_disabled(self) -> None:
        _reject_overlong_content(a1_message(2000))
        self.assert_disabled_without_external_access(lambda: gateway().send("a1", a1_message(2000)))

    def test_edit_is_disabled_without_a_request(self) -> None:
        with self.assertRaisesRegex(DiscordFailure, "超过2000"):
            _reject_overlong_content(a1_message(2001))
        self.assert_disabled_without_external_access(lambda: gateway().edit("a1", "987654321", a1_message(2001)))

    def test_paginated_read_is_disabled_without_a_request(self) -> None:
        self.assert_disabled_without_external_access(lambda: gateway().messages("a1", before="987654321", limit=100))

    def test_conflicting_pagination_does_not_bypass_disabled_gateway(self) -> None:
        self.assert_disabled_without_external_access(lambda: gateway().messages("a1", after="1", before="2"))

    def test_exact_message_read_is_disabled_without_a_request(self) -> None:
        self.assert_disabled_without_external_access(lambda: gateway().message("a1", "987654321"))

    def test_invalid_message_id_does_not_bypass_disabled_gateway(self) -> None:
        self.assert_disabled_without_external_access(lambda: gateway().message("a1", "not-an-id"))


if __name__ == "__main__":
    unittest.main()
