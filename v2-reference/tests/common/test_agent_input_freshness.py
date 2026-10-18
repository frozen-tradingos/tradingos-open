from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime, timedelta
import unittest
from zoneinfo import ZoneInfo

from trading_os_v2.common.agent_input_freshness import (
    AgentInputFreshnessError,
    build_agent_input_freshness,
    validate_agent_input_freshness,
)
from trading_os_v2.common.io import sha256_json


def packet(*, state: str = "open") -> dict:
    created = datetime.fromisoformat("2026-07-30T14:00:00+00:00")
    collected = created - timedelta(seconds=15)
    quote_at = created - timedelta(seconds=5)
    market_day = quote_at.astimezone(
        ZoneInfo("America/New_York")
    ).date()
    expiration = market_day + timedelta(days=2)
    value = {
        "contract_version": "v1",
        "created_at": created.isoformat(),
        "a1": {
            "providers": {"tradier": {"status": "HEALTHY"}},
            "market_clock": {
                "state": state,
                "date": market_day.isoformat(),
                "timestamp": int(quote_at.timestamp()),
            },
        },
        "a2": {
            "structure": {
                symbol: {
                    "symbol": symbol,
                    "price": 500.0,
                    "quote_trade_date": int(
                        quote_at.timestamp() * 1000
                    ),
                }
                for symbol in ("SPY", "QQQ")
            },
            "options": {
                symbol: {
                    "symbol": symbol,
                    "collected_at": collected.isoformat(),
                    "contract_quote_dates": [market_day.isoformat()],
                    "contract_quote_status": (
                        "CURRENT_DATE"
                        if state == "open"
                        else "MARKET_CLOSED"
                    ),
                    "underlying": 500.0,
                    "expiration_count": 1,
                    "expirations": [
                        {
                            "expiration": expiration.isoformat(),
                            "dte": 2,
                            "contract_count": 3,
                            "near_atm_candidates": [
                                {
                                    "symbol": f"{symbol}CALL",
                                    "side": "call",
                                    "expiration": expiration.isoformat(),
                                    "dte": 2,
                                    "strike": 500.0,
                                    "bid": 2.4,
                                    "ask": 2.5,
                                    "bid_at": quote_at.isoformat(),
                                    "ask_at": quote_at.isoformat(),
                                    "trade_date": market_day.isoformat(),
                                },
                                {
                                    "symbol": f"{symbol}PUT",
                                    "side": "put",
                                    "expiration": expiration.isoformat(),
                                    "dte": 2,
                                    "strike": 500.0,
                                    "bid": 2.4,
                                    "ask": 2.5,
                                    "bid_at": quote_at.isoformat(),
                                    "ask_at": quote_at.isoformat(),
                                    "trade_date": market_day.isoformat(),
                                },
                                {
                                    "symbol": f"{symbol}CROSSED",
                                    "side": "call",
                                    "expiration": expiration.isoformat(),
                                    "dte": 2,
                                    "strike": 501.0,
                                    "bid": 2.6,
                                    "ask": 2.5,
                                    "bid_at": quote_at.isoformat(),
                                    "ask_at": quote_at.isoformat(),
                                    "trade_date": market_day.isoformat(),
                                },
                            ],
                        }
                    ],
                }
                for symbol in ("SPY", "QQQ")
            },
        },
    }
    payload_hash = sha256_json(value)
    run_id = (
        f"{created.strftime('%Y%m%dT%H%M%SZ')}-"
        f"{payload_hash[:10]}"
    )
    return {
        "run_id": run_id,
        "packet_hash": payload_hash,
        **value,
    }


class AgentInputFreshnessTests(unittest.TestCase):
    def test_builds_exact_open_proof_and_ignores_one_crossed_quote(
        self,
    ) -> None:
        value = packet()
        proof = build_agent_input_freshness(value)

        self.assertEqual(proof["status"], "HEALTHY")
        self.assertEqual(proof["session_mode"], "OPEN")
        self.assertEqual(
            proof["symbols"]["SPY"]["expirations"][0][
                "usable_call_count"
            ],
            1,
        )
        self.assertEqual(
            validate_agent_input_freshness(proof, value),
            proof,
        )

    def test_accepts_all_three_non_open_states(self) -> None:
        for state in ("closed", "premarket", "postmarket"):
            with self.subTest(state=state):
                proof = build_agent_input_freshness(
                    packet(state=state)
                )
                self.assertEqual(proof["session_mode"], "NON_OPEN")
                self.assertEqual(
                    proof["symbols"]["QQQ"]["contract_quote_status"],
                    "MARKET_CLOSED",
                )

    def test_rejects_unknown_state_and_old_quote_date_shape(self) -> None:
        unknown = packet()
        unknown["a1"]["market_clock"]["state"] = "mystery"
        unknown = self._rehash(unknown)
        with self.assertRaisesRegex(
            AgentInputFreshnessError,
            "状态未知",
        ):
            build_agent_input_freshness(unknown)

        legacy = packet()
        candidate = legacy["a2"]["options"]["SPY"]["expirations"][0][
            "near_atm_candidates"
        ][0]
        candidate["quote_date"] = int(
            datetime.now(UTC).timestamp() * 1000
        )
        legacy = self._rehash(legacy)
        with self.assertRaisesRegex(
            AgentInputFreshnessError,
            "旧字段",
        ):
            build_agent_input_freshness(legacy)

    def test_rejects_tampering_stale_times_and_missing_side(self) -> None:
        tampered = packet()
        proof = build_agent_input_freshness(tampered)
        proof["symbols"]["SPY"]["expiration_count"] = 2
        with self.assertRaisesRegex(
            AgentInputFreshnessError,
            "证明缺失",
        ):
            validate_agent_input_freshness(proof, tampered)

        stale = packet()
        old = (
            datetime.fromisoformat(stale["created_at"])
            - timedelta(minutes=21)
        )
        stale["a2"]["options"]["SPY"]["expirations"][0][
            "near_atm_candidates"
        ][0]["bid_at"] = old.isoformat()
        stale = self._rehash(stale)
        with self.assertRaisesRegex(
            AgentInputFreshnessError,
            "新鲜度窗口",
        ):
            build_agent_input_freshness(stale)

        no_put = packet()
        for symbol in ("SPY", "QQQ"):
            candidates = no_put["a2"]["options"][symbol][
                "expirations"
            ][0]["near_atm_candidates"]
            no_put["a2"]["options"][symbol]["expirations"][0][
                "near_atm_candidates"
            ] = [
                candidate
                for candidate in candidates
                if candidate["side"] == "call"
            ]
        no_put = self._rehash(no_put)
        with self.assertRaisesRegex(
            AgentInputFreshnessError,
            "缺少可用call或put",
        ):
            build_agent_input_freshness(no_put)

    @staticmethod
    def _rehash(value: dict) -> dict:
        payload = {
            key: item
            for key, item in value.items()
            if key not in {"run_id", "packet_hash"}
        }
        packet_hash = sha256_json(payload)
        created = datetime.fromisoformat(payload["created_at"])
        return {
            "run_id": (
                f"{created.strftime('%Y%m%dT%H%M%SZ')}-"
                f"{packet_hash[:10]}"
            ),
            "packet_hash": packet_hash,
            **payload,
        }


if __name__ == "__main__":
    unittest.main()
