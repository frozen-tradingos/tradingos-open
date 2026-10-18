from __future__ import annotations

import json
import os
import unittest
from unittest.mock import MagicMock, Mock, patch

from trading_os_v2.discord_gateway.service import (
    DiscordFailure,
    DiscordGateway,
)


def gateway() -> DiscordGateway:
    return DiscordGateway(
        {
            "discord": {
                "bot_token_env": "DISCORD_TEST_TOKEN",
                "channels": {"a1": "123456789"},
            }
        }
    )


def response(payload: object) -> Mock:
    value = Mock()
    value.read.return_value = json.dumps(payload).encode("utf-8")
    context = MagicMock()
    context.__enter__.return_value = value
    context.__exit__.return_value = False
    return context


def a1_message(length: int) -> str:
    title = "【员工：A1｜系统与数据】\n"
    return title + "x" * (length - len(title))


class DiscordGatewayWriteTests(unittest.TestCase):
    def test_send_rejects_content_over_discord_limit_before_request(self) -> None:
        with (
            patch.dict(os.environ, {"DISCORD_TEST_TOKEN": "token"}),
            patch(
                "trading_os_v2.discord_gateway.service.urllib.request.urlopen"
            ) as urlopen,
        ):
            with self.assertRaisesRegex(DiscordFailure, "超过2000"):
                gateway().send("a1", a1_message(2001))

        urlopen.assert_not_called()

    def test_send_preserves_content_at_discord_limit(self) -> None:
        content = a1_message(2000)
        with (
            patch.dict(os.environ, {"DISCORD_TEST_TOKEN": "token"}),
            patch(
                "trading_os_v2.discord_gateway.service.urllib.request.urlopen",
                return_value=response({"id": "987654321"}),
            ) as urlopen,
        ):
            message_id = gateway().send("a1", content)

        self.assertEqual(message_id, "987654321")
        request = urlopen.call_args.args[0]
        body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(body["content"], content)
        self.assertEqual(body["allowed_mentions"], {"parse": []})

    def test_edit_rejects_content_over_discord_limit_before_request(self) -> None:
        with (
            patch.dict(os.environ, {"DISCORD_TEST_TOKEN": "token"}),
            patch(
                "trading_os_v2.discord_gateway.service.urllib.request.urlopen"
            ) as urlopen,
        ):
            with self.assertRaisesRegex(DiscordFailure, "超过2000"):
                gateway().edit("a1", "987654321", a1_message(2001))

        urlopen.assert_not_called()


class DiscordGatewayReadTests(unittest.TestCase):
    def test_messages_supports_before_pagination(self) -> None:
        with (
            patch.dict(os.environ, {"DISCORD_TEST_TOKEN": "token"}),
            patch(
                "trading_os_v2.discord_gateway.service.urllib.request.urlopen",
                return_value=response([]),
            ) as urlopen,
        ):
            result = gateway().messages("a1", before="987654321", limit=100)

        self.assertEqual(result, [])
        request = urlopen.call_args.args[0]
        self.assertIn("before=987654321", request.full_url)

    def test_messages_rejects_conflicting_pagination(self) -> None:
        with patch.dict(os.environ, {"DISCORD_TEST_TOKEN": "token"}):
            with self.assertRaisesRegex(DiscordFailure, "不能同时"):
                gateway().messages("a1", after="1", before="2")

    def test_message_reads_exact_message_id(self) -> None:
        payload = {"id": "987654321", "content": "内容"}
        with (
            patch.dict(os.environ, {"DISCORD_TEST_TOKEN": "token"}),
            patch(
                "trading_os_v2.discord_gateway.service.urllib.request.urlopen",
                return_value=response(payload),
            ) as urlopen,
        ):
            result = gateway().message("a1", "987654321")

        self.assertEqual(result, payload)
        request = urlopen.call_args.args[0]
        self.assertTrue(request.full_url.endswith("/messages/987654321"))

    def test_message_rejects_non_numeric_id(self) -> None:
        with patch.dict(os.environ, {"DISCORD_TEST_TOKEN": "token"}):
            with self.assertRaisesRegex(DiscordFailure, "格式"):
                gateway().message("a1", "not-an-id")


if __name__ == "__main__":
    unittest.main()
