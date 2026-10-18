from __future__ import annotations

import unittest
from datetime import UTC, datetime, timedelta
from unittest.mock import patch
from zoneinfo import ZoneInfo

from trading_os_v2.a1.service import (
    A1Collector,
    BLS_RELEASE_CALENDAR_MAX_BYTES,
    BLS_RELEASE_CALENDAR_MAX_EVENTS,
    BLS_RELEASE_CALENDAR_URL,
    HttpClient,
    PT_ZONE,
    ProviderError,
    _bls_macro_calendar_projections,
    _canonical_official_raw_item_hash,
    _earnings_watch,
    _information_archive,
    _macro_watch,
    _macro_results,
    _match_market_event,
    _market_moving_news,
    _merge_news,
    _normalize_earnings,
    _parse_bls_macro_calendar,
    _parse_official_feed,
)
from trading_os_v2.common.config import load_config
from trading_os_v2.common.io import sha256_json


BLS_EMPLOYMENT_CALENDAR = """BEGIN:VCALENDAR
BEGIN:VEVENT
UID:employment-20260807
DTSTART;TZID=US-Eastern:20260807T083000
SUMMARY:Employment Situation for July 2026
END:VEVENT
BEGIN:VEVENT
UID:cpi-20260812
DTSTART;TZID=US-Eastern:20260812T083000
SUMMARY:Consumer Price Index for July 2026
END:VEVENT
END:VCALENDAR
"""

BLS_LATEST_NUMBERS_SUMMARY = """
<p>Consumer Price Index (CPI):<br>
  <strong><span class="data">-0.4% in Jun 2026</span></strong><br>
  <a href="https://www.bls.gov/news.release/cpi.toc.htm">News Release</a>
</p>
<p>Unemployment Rate:<br>
  <strong><span class="data">4.1% in Jul 2026</span></strong><br>
  <a href="https://www.bls.gov/news.release/empsit.toc.htm">News Release</a>
</p>
<p>Payroll Employment:<br>
  <strong><span class="data">-23,000(p) in Jul 2026</span></strong><br>
  <a href="https://www.bls.gov/news.release/empsit.toc.htm">News Release</a>
</p>
<p>Average Hourly Earnings:<br>
  <strong><span class="data">+$0.02(p) in Jul 2026</span></strong><br>
  <a href="https://www.bls.gov/news.release/empsit.toc.htm">News Release</a>
</p>
<p>Producer Price Index - Final Demand:<br>
  <strong><span class="data">-0.3%(p) in Jun 2026</span></strong><br>
  <a href="https://www.bls.gov/news.release/ppi.toc.htm">News Release</a>
</p>
"""


def _bls_latest_numbers_item(
    summary: str = BLS_LATEST_NUMBERS_SUMMARY,
) -> dict[str, object]:
    return {
        "id": "BLS:https://www.bls.gov/bls/",
        "headline": "Major Economic Indicators Latest Numbers",
        "summary": summary,
        "source": "BLS",
        "published_at": "2026-08-07T12:32:13+00:00",
        "url": "https://www.bls.gov/bls/",
        "provider": "BLS official",
        "confidence": "official",
    }


class _FinnhubClient:
    def __init__(self, news: object, calendar: object) -> None:
        self.news = news
        self.calendar = calendar
        self.calls: list[tuple[str, dict[str, object]]] = []

    def json(
        self,
        _base_url: str,
        path: str,
        **kwargs: object,
    ) -> object:
        self.calls.append((path, kwargs))
        return self.news if path == "/news" else self.calendar


class OfficialFeedTests(unittest.TestCase):
    def test_tradier_option_filter_includes_fifteen_and_excludes_sixteen_dte(
        self,
    ) -> None:
        market_day = datetime.now(ZoneInfo("America/New_York")).date()
        expirations = [
            (market_day + timedelta(days=days)).isoformat()
            for days in (0, 15, 16)
        ]

        class Collector(A1Collector):
            def _tradier(
                self,
                path: str,
                params: dict[str, object],
                label: str,
            ) -> dict[str, object]:
                del params, label
                if path == "/markets/clock":
                    return {"clock": {"state": "open"}}
                if path == "/markets/quotes":
                    return {"quotes": {"quote": []}}
                if path == "/markets/history":
                    return {"history": {"day": []}}
                if path == "/markets/timesales":
                    return {"series": {"data": []}}
                if path == "/markets/options/expirations":
                    return {"expirations": {"date": expirations}}
                if path == "/markets/options/chains":
                    return {"options": {"option": []}}
                raise AssertionError(path)

        result = Collector(load_config())._collect_tradier()

        expected = expirations[:2]
        for symbol in ("SPY", "QQQ"):
            self.assertEqual(result["options"][symbol]["expirations"], expected)

    def test_parses_rss_as_official_evidence(self) -> None:
        xml = """<?xml version="1.0"?>
        <rss><channel><item>
          <title>Policy decision</title>
          <link>https://example.gov/release</link>
          <guid>release-1</guid>
          <pubDate>Wed, 29 Jul 2026 18:00:00 GMT</pubDate>
          <description>Official release.</description>
        </item></channel></rss>
        """
        items = _parse_official_feed(xml, "Federal Reserve")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["confidence"], "official")
        self.assertEqual(items[0]["source"], "Federal Reserve")
        self.assertTrue(items[0]["published_at"].endswith("+00:00"))

    def test_recent_official_fomc_statement_is_verified(self) -> None:
        items = [
            {
                "headline": "Federal Reserve issues FOMC statement",
                "source": "Federal Reserve",
                "published_at": "2026-07-29T18:00:00+00:00",
                "confidence": "official",
            }
        ]
        result = _market_moving_news(
            items,
            now=datetime(2026, 7, 29, 19, 0, tzinfo=UTC),
        )
        self.assertTrue(result["verified"])
        evidence = result["evidence"][0]
        self.assertEqual(
            evidence["verification_rule"],
            "OFFICIAL_SINGLE_SOURCE",
        )
        self.assertEqual(evidence["category"], "central_bank")
        self.assertEqual(len(evidence["event_fingerprint"]), 64)

    def test_same_category_two_source_news_has_one_event_identity(self) -> None:
        items = [
            {
                "headline": "Consumer price index inflation report",
                "source": source,
                "published_at": "2026-07-29T15:00:00+00:00",
                "confidence": "primary_aggregator",
            }
            for source in ("Reuters", "Bloomberg")
        ]
        result = _market_moving_news(
            items,
            now=datetime(2026, 7, 29, 16, 0, tzinfo=UTC),
        )
        self.assertTrue(result["verified"])
        self.assertEqual(
            {
                item["event_fingerprint"]
                for item in result["evidence"]
            },
            {result["evidence"][0]["event_fingerprint"]},
        )
        self.assertTrue(
            all(
                item["verification_rule"] == "SAME_CATEGORY_TWO_SOURCE"
                for item in result["evidence"]
            )
        )

    def test_discovery_only_date_cannot_change_verified_event_identity(self) -> None:
        verified = [
            {
                "headline": "Consumer price index inflation report",
                "source": source,
                "published_at": "2026-07-29T15:00:00+00:00",
                "confidence": "primary_aggregator",
            }
            for source in ("Reuters", "Bloomberg")
        ]
        baseline = _market_moving_news(
            verified,
            now=datetime(2026, 7, 29, 16, 0, tzinfo=UTC),
        )
        with_discovery = _market_moving_news(
            [
                {
                    "headline": "Consumer price index inflation report",
                    "source": "Discovery feed",
                    "published_at": "2026-07-28T15:00:00+00:00",
                    "confidence": "discovery_only",
                },
                *verified,
            ],
            now=datetime(2026, 7, 29, 16, 0, tzinfo=UTC),
        )

        self.assertEqual(
            {item["event_fingerprint"] for item in with_discovery["evidence"]},
            {item["event_fingerprint"] for item in baseline["evidence"]},
        )

    def test_unemitted_official_item_cannot_change_event_identity(self) -> None:
        accepted = [
            {
                "headline": f"Federal Reserve issues FOMC statement {index}",
                "source": "Federal Reserve",
                "published_at": f"2026-07-30T0{index}:00:00+00:00",
                "confidence": "official",
            }
            for index in range(3)
        ]
        baseline = _market_moving_news(
            accepted,
            now=datetime(2026, 7, 30, 2, 30, tzinfo=UTC),
        )
        with_unemitted = _market_moving_news(
            [
                *accepted,
                {
                    "headline": "Federal Reserve issues FOMC statement old",
                    "source": "Federal Reserve",
                    "published_at": "2026-07-29T23:00:00+00:00",
                    "confidence": "official",
                },
            ],
            now=datetime(2026, 7, 30, 2, 30, tzinfo=UTC),
        )

        self.assertEqual(with_unemitted["evidence"], baseline["evidence"])

    def test_same_category_different_event_phrase_does_not_cross_confirm(
        self,
    ) -> None:
        items = [
            {
                "headline": "Consumer price index release",
                "source": "Reuters",
                "published_at": "2026-07-29T15:00:00+00:00",
                "confidence": "primary_aggregator",
            },
            {
                "headline": "Producer price index release",
                "source": "Bloomberg",
                "published_at": "2026-07-29T15:05:00+00:00",
                "confidence": "cross_check_candidate",
            },
        ]
        result = _market_moving_news(
            items,
            now=datetime(2026, 7, 29, 16, 0, tzinfo=UTC),
        )
        self.assertFalse(result["verified"])
        self.assertEqual(result["evidence"], [])

    def test_two_verified_events_are_both_preserved(self) -> None:
        items = [
            {
                "headline": headline,
                "source": source,
                "published_at": "2026-07-29T15:00:00+00:00",
                "confidence": "primary_aggregator",
            }
            for headline in (
                "Consumer price index release",
                "Producer price index release",
            )
            for source in ("Reuters", "Bloomberg")
        ]
        result = _market_moving_news(
            items,
            now=datetime(2026, 7, 29, 16, 0, tzinfo=UTC),
        )
        fingerprints = {
            item["event_fingerprint"] for item in result["evidence"]
        }
        self.assertEqual(len(fingerprints), 2)
        self.assertEqual(len(result["evidence"]), 4)

    def test_different_oil_catalysts_do_not_cross_confirm(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Oil prices rise after an OPEC supply cut",
                    "source": "Reuters",
                    "published_at": "2026-08-03T01:00:00+00:00",
                    "confidence": "primary_aggregator",
                },
                {
                    "headline": "Crude jumps after an inventory draw",
                    "source": "Bloomberg",
                    "published_at": "2026-08-03T01:05:00+00:00",
                    "confidence": "cross_check_candidate",
                },
            ],
            now=datetime(2026, 8, 3, 19, 0, tzinfo=UTC),
        )

        self.assertFalse(result["verified"])
        self.assertEqual(result["evidence"], [])

    def test_same_oil_catalyst_can_cross_confirm(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Oil prices rise after an OPEC supply cut",
                    "source": "Reuters",
                    "published_at": "2026-08-03T01:00:00+00:00",
                    "confidence": "primary_aggregator",
                },
                {
                    "headline": "Crude jumps after an OPEC output cut",
                    "source": "Bloomberg",
                    "published_at": "2026-08-03T01:05:00+00:00",
                    "confidence": "cross_check_candidate",
                },
            ],
            now=datetime(2026, 8, 3, 19, 0, tzinfo=UTC),
        )

        self.assertTrue(result["verified"])
        self.assertEqual(len(result["evidence"]), 2)
        self.assertEqual(
            len({item["event_fingerprint"] for item in result["evidence"]}),
            1,
        )

    def test_ambiguous_oil_catalyst_cannot_cross_confirm(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Oil rises after an OPEC supply cut",
                    "source": "Reuters",
                    "published_at": "2026-08-03T01:00:00+00:00",
                    "confidence": "primary_aggregator",
                },
                {
                    "headline": (
                        "Crude jumps after an inventory draw as OPEC meets"
                    ),
                    "source": "Bloomberg",
                    "published_at": "2026-08-03T01:05:00+00:00",
                    "confidence": "cross_check_candidate",
                },
            ],
            now=datetime(2026, 8, 3, 19, 0, tzinfo=UTC),
        )

        self.assertFalse(result["verified"])
        self.assertEqual(result["evidence"], [])

    def test_different_iran_incidents_do_not_cross_confirm(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Iran attack hits a US base in Iraq",
                    "source": "Reuters",
                    "published_at": "2026-08-03T01:00:00+00:00",
                    "confidence": "primary_aggregator",
                },
                {
                    "headline": "Iran strike hits an Israeli port",
                    "source": "Bloomberg",
                    "published_at": "2026-08-03T01:05:00+00:00",
                    "confidence": "cross_check_candidate",
                },
            ],
            now=datetime(2026, 8, 3, 19, 0, tzinfo=UTC),
        )

        self.assertFalse(result["verified"])
        self.assertEqual(result["evidence"], [])

    def test_same_iran_incident_can_cross_confirm(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Iran attack hits a US base in Iraq",
                    "source": "Reuters",
                    "published_at": "2026-08-03T01:00:00+00:00",
                    "confidence": "primary_aggregator",
                },
                {
                    "headline": "Iran strike targets American forces in Iraq",
                    "source": "Bloomberg",
                    "published_at": "2026-08-03T01:05:00+00:00",
                    "confidence": "cross_check_candidate",
                },
            ],
            now=datetime(2026, 8, 3, 19, 0, tzinfo=UTC),
        )

        self.assertTrue(result["verified"])
        self.assertEqual(len(result["evidence"]), 2)
        self.assertEqual(
            len({item["event_fingerprint"] for item in result["evidence"]}),
            1,
        )

    def test_same_counterpart_different_incident_locations_do_not_confirm(
        self,
    ) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Iran attack hits a US base in Iraq",
                    "source": "Reuters",
                    "published_at": "2026-08-03T01:00:00+00:00",
                    "confidence": "primary_aggregator",
                },
                {
                    "headline": "Iran strike targets American forces in Syria",
                    "source": "Bloomberg",
                    "published_at": "2026-08-03T01:05:00+00:00",
                    "confidence": "cross_check_candidate",
                },
            ],
            now=datetime(2026, 8, 3, 19, 0, tzinfo=UTC),
        )

        self.assertFalse(result["verified"])
        self.assertEqual(result["evidence"], [])

    def test_inverse_geopolitical_direction_is_rejected(self) -> None:
        for headline in (
            "Iran-Israel peace hopes fade",
            "Iran and Israel peace deal hopes collapse",
            "Iran-Israel peace deal ruled out",
            "Iran and Israel say peace deal is unlikely",
            "Iran-Israel peace deal rejected by Tehran",
            "Iran and Israel say peace deal is not expected",
            "Iran-Israel war fears ease",
            "Iran attack fears recede",
            "Iran violates ceasefire with Israel",
            "Iran breaches truce with Israel",
            "Iran-Israel ceasefire was broken overnight",
        ):
            with self.subTest(headline=headline):
                self.assertIsNone(_match_market_event(headline.lower()))

    def test_active_attacks_do_not_turn_ceasefire_talks_into_a_ceasefire(
        self,
    ) -> None:
        for headline in (
            "Iran and Israel resume attacks as ceasefire talks continue",
            "Ceasefire negotiations continue while Iran attacks Israel",
        ):
            with self.subTest(headline=headline):
                self.assertIsNone(_match_market_event(headline.lower()))

    def test_unrelated_cancellation_does_not_verify_an_iran_pause(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Airlines cancel flights as Iran attacks Israel",
                    "source": source,
                    "published_at": "2026-08-03T01:00:00+00:00",
                    "confidence": confidence,
                }
                for source, confidence in (
                    ("Reuters", "primary_aggregator"),
                    ("Bloomberg", "cross_check_candidate"),
                )
            ],
            now=datetime(2026, 8, 3, 2, 0, tzinfo=UTC),
        )

        self.assertFalse(result["verified"])
        self.assertEqual(result["evidence"], [])

    def test_unrelated_ceasefire_is_not_bound_to_iran_attack(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": headline,
                    "source": source,
                    "published_at": "2026-08-03T01:00:00+00:00",
                    "confidence": confidence,
                }
                for headline, source, confidence in (
                    (
                        "Gaza ceasefire holds as Iran attacks Israel",
                        "Reuters",
                        "primary_aggregator",
                    ),
                    (
                        "Gaza truce continues while Iran strikes Israel",
                        "Bloomberg",
                        "cross_check_candidate",
                    ),
                )
            ],
            now=datetime(2026, 8, 3, 2, 0, tzinfo=UTC),
        )

        self.assertFalse(result["verified"])
        self.assertEqual(result["evidence"], [])

    def test_compatible_iran_incident_attributes_can_cross_confirm(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Iran strikes the Israeli nuclear facility at Dimona",
                    "source": "Reuters",
                    "published_at": "2026-08-03T01:00:00+00:00",
                    "confidence": "primary_aggregator",
                },
                {
                    "headline": "Iran attack hits Israel nuclear site in Dimona",
                    "source": "Bloomberg",
                    "published_at": "2026-08-03T01:05:00+00:00",
                    "confidence": "cross_check_candidate",
                },
            ],
            now=datetime(2026, 8, 3, 19, 0, tzinfo=UTC),
        )

        self.assertTrue(result["verified"])
        self.assertEqual(len(result["evidence"]), 2)
        self.assertEqual(
            len({item["event_fingerprint"] for item in result["evidence"]}),
            1,
        )

    def test_different_israeli_nuclear_sites_do_not_cross_confirm(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Iran strikes the Israeli nuclear facility at Dimona",
                    "source": "Reuters",
                    "published_at": "2026-08-03T01:00:00+00:00",
                    "confidence": "primary_aggregator",
                },
                {
                    "headline": "Iran attack hits Israel nuclear site at Soreq",
                    "source": "Bloomberg",
                    "published_at": "2026-08-03T01:05:00+00:00",
                    "confidence": "cross_check_candidate",
                },
            ],
            now=datetime(2026, 8, 3, 19, 0, tzinfo=UTC),
        )

        self.assertFalse(result["verified"])
        self.assertEqual(result["evidence"], [])

    def test_current_oil_direction_wins_over_historical_move(self) -> None:
        for headline in (
            "Oil rises after falling earlier as OPEC cuts supply",
            "Crude rallies after prices fell overnight on OPEC output cuts",
            "Oil fell earlier but rises on OPEC output cuts",
            "Oil fell earlier but is now rising on OPEC output cuts",
        ):
            with self.subTest(headline=headline):
                self.assertEqual(
                    _match_market_event(headline.lower()),
                    ("energy", "oil_up", 30),
                )

        self.assertEqual(
            _match_market_event("oil rose overnight but has fallen on inventories"),
            ("energy", "oil_down", 30),
        )
        self.assertEqual(
            _match_market_event("oil rose overnight and has fallen on inventories"),
            ("energy", "oil_down", 30),
        )
        self.assertEqual(
            _match_market_event("oil rose overnight then fell on inventories"),
            ("energy", "oil_down", 30),
        )

        self.assertEqual(
            _match_market_event("oil falls while opec output rises"),
            ("energy", "oil_down", 30),
        )
        self.assertEqual(
            _match_market_event("oil falls but stocks rise on earnings"),
            ("energy", "oil_down", 30),
        )

    def test_iran_israel_participants_override_mediator_attribution(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Trump announces Iran-Israel ceasefire",
                    "source": "Reuters",
                    "published_at": "2026-08-03T01:00:00+00:00",
                    "confidence": "primary_aggregator",
                },
                {
                    "headline": "US confirms ceasefire between Iran and Israel",
                    "source": "Bloomberg",
                    "published_at": "2026-08-03T01:05:00+00:00",
                    "confidence": "cross_check_candidate",
                },
            ],
            now=datetime(2026, 8, 3, 19, 0, tzinfo=UTC),
        )

        self.assertTrue(result["verified"])
        self.assertEqual(len(result["evidence"]), 2)
        self.assertEqual(
            len({item["event_fingerprint"] for item in result["evidence"]}),
            1,
        )

    def test_different_iran_deescalation_incidents_do_not_confirm(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Iran and Israel agree to a ceasefire",
                    "source": "Reuters",
                    "published_at": "2026-08-03T01:00:00+00:00",
                    "confidence": "primary_aggregator",
                },
                {
                    "headline": "US-Iran nuclear talks optimism lifts stocks",
                    "source": "Bloomberg",
                    "published_at": "2026-08-03T01:05:00+00:00",
                    "confidence": "cross_check_candidate",
                },
            ],
            now=datetime(2026, 8, 3, 19, 0, tzinfo=UTC),
        )

        self.assertFalse(result["verified"])
        self.assertEqual(result["evidence"], [])

    def test_tentative_iran_ceasefire_reports_do_not_confirm(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Iran considers ceasefire with Israel",
                    "source": "Reuters",
                    "published_at": "2026-08-03T01:00:00+00:00",
                    "confidence": "primary_aggregator",
                },
                {
                    "headline": "Iran may agree to truce with Israel",
                    "source": "Bloomberg",
                    "published_at": "2026-08-03T01:05:00+00:00",
                    "confidence": "cross_check_candidate",
                },
            ],
            now=datetime(2026, 8, 3, 2, 0, tzinfo=UTC),
        )

        self.assertFalse(result["verified"])
        self.assertEqual(result["evidence"], [])

    def test_semantic_terms_require_token_boundaries(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Oil prices surprise markets",
                    "source": "Reuters",
                    "published_at": "2026-08-03T01:00:00+00:00",
                    "confidence": "primary_aggregator",
                },
                {
                    "headline": "Oil surprise spreads through markets",
                    "source": "Bloomberg",
                    "published_at": "2026-08-03T01:05:00+00:00",
                    "confidence": "cross_check_candidate",
                },
                {
                    "headline": "Crude fallout continues",
                    "source": "Reuters",
                    "published_at": "2026-08-03T01:10:00+00:00",
                    "confidence": "primary_aggregator",
                },
                {
                    "headline": "Oil fallout concerns markets",
                    "source": "Bloomberg",
                    "published_at": "2026-08-03T01:15:00+00:00",
                    "confidence": "cross_check_candidate",
                },
            ],
            now=datetime(2026, 8, 3, 19, 0, tzinfo=UTC),
        )

        self.assertFalse(result["verified"])
        self.assertEqual(result["evidence"], [])

    def test_two_source_evidence_always_contains_two_sources(self) -> None:
        items = [
            {
                "headline": "Consumer price index release",
                "source": source,
                "published_at": "2026-07-29T15:00:00+00:00",
                "confidence": "primary_aggregator",
            }
            for source in ("Reuters", "Reuters", "Bloomberg")
        ]
        result = _market_moving_news(
            items,
            now=datetime(2026, 7, 29, 16, 0, tzinfo=UTC),
        )
        self.assertEqual(
            {item["source"] for item in result["evidence"]},
            {"Reuters", "Bloomberg"},
        )

    def test_old_fomc_statement_does_not_unlock_trading(self) -> None:
        items = [
            {
                "headline": "Federal Reserve issues FOMC statement",
                "source": "Federal Reserve",
                "published_at": "2026-07-28T18:00:00+00:00",
                "confidence": "official",
            }
        ]
        result = _market_moving_news(
            items,
            now=datetime(2026, 7, 29, 19, 0, tzinfo=UTC),
        )
        self.assertFalse(result["verified"])

    def test_overnight_iran_deescalation_synonyms_cross_confirm(self) -> None:
        items = [
            {
                "headline": (
                    "Trump says a US-Iran peace deal is near"
                ),
                "source": "Reuters",
                "published_at": "2026-08-02T15:04:24+00:00",
                "confidence": "primary_aggregator",
            },
            {
                "headline": "US-Iran peace hopes boost stocks and weaken crude",
                "source": "Bloomberg",
                "published_at": "2026-08-03T01:03:00+00:00",
                "confidence": "cross_check_candidate",
            },
        ]
        result = _market_moving_news(
            items,
            now=datetime(2026, 8, 3, 19, 0, tzinfo=UTC),
        )
        self.assertTrue(result["verified"])
        self.assertEqual(
            {item["category"] for item in result["evidence"]},
            {"geopolitical_deescalation"},
        )
        self.assertEqual(
            {
                item["event_fingerprint"]
                for item in result["evidence"]
            },
            {result["evidence"][0]["event_fingerprint"]},
        )

    def test_overnight_event_still_requires_two_sources(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Oil prices drop after Iran peace hopes",
                    "source": "Reuters",
                    "published_at": "2026-08-03T00:11:00+00:00",
                    "confidence": "primary_aggregator",
                }
            ],
            now=datetime(2026, 8, 3, 19, 0, tzinfo=UTC),
        )
        self.assertFalse(result["verified"])
        self.assertEqual(result["evidence"], [])

    def test_source_aliases_do_not_fake_two_source_evidence(self) -> None:
        items = [
            {
                "headline": "Iran peace hopes lift markets",
                "source": source,
                "published_at": "2026-08-03T01:00:00+00:00",
                "confidence": "cross_check_candidate",
            }
            for source in ("AP", "AP News")
        ]
        result = _market_moving_news(
            items,
            now=datetime(2026, 8, 3, 19, 0, tzinfo=UTC),
        )
        self.assertFalse(result["verified"])

    def test_overnight_event_expires_after_thirty_hours(self) -> None:
        items = [
            {
                "headline": "Iran peace hopes boost stocks",
                "source": source,
                "published_at": "2026-08-02T12:00:00+00:00",
                "confidence": "primary_aggregator",
            }
            for source in ("Reuters", "Bloomberg")
        ]
        result = _market_moving_news(
            items,
            now=datetime(2026, 8, 3, 19, 0, tzinfo=UTC),
        )
        self.assertFalse(result["verified"])

    def test_opposed_iran_events_do_not_cross_confirm(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Iran peace hopes lift markets",
                    "source": "Reuters",
                    "published_at": "2026-08-03T01:00:00+00:00",
                    "confidence": "primary_aggregator",
                },
                {
                    "headline": "Iran war risk rises after fresh strike",
                    "source": "Bloomberg",
                    "published_at": "2026-08-03T01:05:00+00:00",
                    "confidence": "cross_check_candidate",
                },
            ],
            now=datetime(2026, 8, 3, 19, 0, tzinfo=UTC),
        )
        self.assertFalse(result["verified"])

    def test_toward_diplomacy_is_not_mistaken_for_war(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Iran faces decapitation if it does not strike deal",
                    "source": "Reuters",
                    "published_at": "2026-08-03T18:33:56+00:00",
                    "confidence": "primary_aggregator",
                },
                {
                    "headline": "US shifts toward diplomacy with Iran",
                    "source": "WSJ",
                    "published_at": "2026-08-03T08:26:00+00:00",
                    "confidence": "cross_check_candidate",
                },
            ],
            now=datetime(2026, 8, 3, 20, 0, tzinfo=UTC),
        )
        self.assertFalse(result["verified"])

    def test_unrelated_systemic_incidents_do_not_cross_confirm(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Military attack reported in Ukraine",
                    "source": "Reuters",
                    "published_at": "2026-08-03T01:00:00+00:00",
                    "confidence": "primary_aggregator",
                },
                {
                    "headline": "Military attack reported near Taiwan",
                    "source": "Bloomberg",
                    "published_at": "2026-08-03T01:05:00+00:00",
                    "confidence": "cross_check_candidate",
                },
            ],
            now=datetime(2026, 8, 3, 2, 0, tzinfo=UTC),
        )

        self.assertFalse(result["verified"])
        self.assertEqual(result["evidence"], [])

    def test_same_country_different_attack_sites_do_not_confirm(self) -> None:
        result = _market_moving_news(
            [
                {
                    "headline": "Military attack reported in Kyiv, Ukraine",
                    "source": "Reuters",
                    "published_at": "2026-08-03T01:00:00+00:00",
                    "confidence": "primary_aggregator",
                },
                {
                    "headline": "Military attack reported in Odesa, Ukraine",
                    "source": "Bloomberg",
                    "published_at": "2026-08-03T01:05:00+00:00",
                    "confidence": "cross_check_candidate",
                },
            ],
            now=datetime(2026, 8, 3, 2, 0, tzinfo=UTC),
        )

        self.assertFalse(result["verified"])
        self.assertEqual(result["evidence"], [])

    def test_unlisted_attack_sites_do_not_fall_back_to_country(self) -> None:
        for first, second, country in (
            ("Kharkiv", "Lviv", "Ukraine"),
            ("Tel Aviv", "Haifa", "Israel"),
            ("Dnipro", "Zaporizhzhia", "Ukraine"),
            ("Ashdod", "Beersheba", "Israel"),
        ):
            with self.subTest(first=first, second=second):
                result = _market_moving_news(
                    [
                        {
                            "headline": (
                                f"Military attack reported in {first}, {country}"
                            ),
                            "source": "Reuters",
                            "published_at": "2026-08-03T01:00:00+00:00",
                            "confidence": "primary_aggregator",
                        },
                        {
                            "headline": (
                                f"Military attack reported in {second}, {country}"
                            ),
                            "source": "Bloomberg",
                            "published_at": "2026-08-03T01:05:00+00:00",
                            "confidence": "cross_check_candidate",
                        },
                    ],
                    now=datetime(2026, 8, 3, 2, 0, tzinfo=UTC),
                )
                self.assertFalse(result["verified"])
                self.assertEqual(result["evidence"], [])

    def test_same_systemic_incident_requires_timely_cross_check(self) -> None:
        items = [
            {
                "headline": "Military attack reported in Kyiv, Ukraine",
                "source": "Reuters",
                "published_at": "2026-08-03T01:00:00+00:00",
                "confidence": "primary_aggregator",
            },
            {
                "headline": "Kyiv, Ukraine military attack reported by officials",
                "source": "Bloomberg",
                "published_at": "2026-08-03T01:05:00+00:00",
                "confidence": "cross_check_candidate",
            },
        ]
        timely = _market_moving_news(
            items,
            now=datetime(2026, 8, 3, 2, 0, tzinfo=UTC),
        )
        stale = _market_moving_news(
            [
                items[0],
                {
                    **items[1],
                    "published_at": "2026-08-03T12:00:00+00:00",
                },
            ],
            now=datetime(2026, 8, 3, 13, 0, tzinfo=UTC),
        )

        self.assertTrue(timely["verified"])
        self.assertFalse(stale["verified"])

    def test_earnings_calendar_keeps_largest_estimated_events(self) -> None:
        rows = [
            {
                "symbol": "SMALL",
                "date": "2026-07-30",
                "hour": "bmo",
                "revenueEstimate": 10,
                "epsEstimate": 1,
            },
            {
                "symbol": "LARGE",
                "date": "2026-07-30",
                "hour": "amc",
                "revenueEstimate": 1_000,
                "epsEstimate": 2,
            },
        ]
        result = _normalize_earnings(rows, limit=1)
        self.assertEqual(result[0]["symbol"], "LARGE")
        self.assertEqual(result[0]["source"], "Finnhub Earnings Calendar")

    def test_earnings_watch_is_read_only_and_event_ids_are_stable(self) -> None:
        earnings = _normalize_earnings(
            [
                {
                    "symbol": "msft",
                    "date": "2026-07-29",
                    "hour": "amc",
                    "revenueEstimate": 90_000_000_000,
                    "epsEstimate": 4.24,
                },
                {
                    "symbol": "AMD",
                    "date": "2026-08-04",
                    "hour": "bmo",
                    "revenueEstimate": 8_000_000_000,
                    "epsEstimate": 1.61,
                },
            ]
        )
        watch = _earnings_watch(
            earnings,
            source_status="HEALTHY",
            generated_at="2026-07-29T18:00:00-07:00",
        )
        repeated = _earnings_watch(
            earnings,
            source_status="HEALTHY",
            generated_at="2026-07-29T18:00:00-07:00",
        )

        self.assertEqual(watch["contract_version"], "v1")
        self.assertEqual(watch["component"], "A1_EARNINGS_WATCH")
        self.assertFalse(watch["actionable"])
        self.assertEqual(watch["window_start"], "2026-07-29")
        self.assertEqual(watch["window_end"], "2026-08-04")
        self.assertEqual(
            [event["session"] for event in watch["events"]],
            ["AMC", "BMO"],
        )
        self.assertEqual(watch["events"][0]["symbol"], "MSFT")
        self.assertEqual(
            watch["events"][0]["market_impact_status"],
            "UNVERIFIED_CANDIDATE",
        )
        self.assertEqual(len(watch["events"][0]["event_id"]), 64)
        self.assertEqual(
            watch["events"][0]["event_id"],
            repeated["events"][0]["event_id"],
        )
        self.assertNotEqual(
            watch["events"][0]["event_id"],
            watch["events"][1]["event_id"],
        )

    def test_earnings_watch_degrades_without_calendar_data(self) -> None:
        watch = _earnings_watch(
            [],
            source_status="FAILED",
            generated_at="2026-07-29T18:00:00-07:00",
        )
        self.assertEqual(watch["status"], "DEGRADED")
        self.assertEqual(watch["events"], [])
        self.assertFalse(watch["actionable"])

    def test_finnhub_http_200_error_bodies_fail_closed(self) -> None:
        cases = [
            (
                {"error": "rate limit"},
                {"earningsCalendar": []},
                "FAILED",
                "HEALTHY",
            ),
            (
                [],
                {"error": "rate limit"},
                "HEALTHY",
                "FAILED",
            ),
            (
                [],
                {},
                "HEALTHY",
                "FAILED",
            ),
            (
                [],
                {
                    "earningsCalendar": [
                        {"symbol": "OLD", "date": "2000-01-01"}
                    ]
                },
                "HEALTHY",
                "FAILED",
            ),
        ]
        for news, calendar, news_status, earnings_status in cases:
            with self.subTest(news=news, calendar=calendar), patch.dict(
                "os.environ",
                {"FINNHUB_API_KEY": "test-key"},
                clear=True,
            ):
                collector = A1Collector(
                    load_config(),
                    _FinnhubClient(news, calendar),
                )
                result = collector._collect_finnhub()
            self.assertEqual(result["status"], news_status)
            self.assertEqual(
                result["earnings_status"],
                earnings_status,
            )

    def test_finnhub_empty_typed_responses_are_healthy_but_not_news(self) -> None:
        client = _FinnhubClient([], {"earningsCalendar": []})
        with patch.dict(
            "os.environ",
            {"FINNHUB_API_KEY": "test-key"},
            clear=True,
        ), patch("trading_os_v2.a1.service.datetime") as clock:
            clock.now.return_value = datetime(
                2026,
                7,
                30,
                tzinfo=UTC,
            )
            collector = A1Collector(
                load_config(),
                client,
            )
            result = collector._collect_finnhub()
        self.assertEqual(result["status"], "HEALTHY")
        self.assertEqual(result["earnings_status"], "HEALTHY")
        self.assertEqual(result["items"], [])
        self.assertEqual(result["earnings"], [])
        clock.now.assert_called_once_with(PT_ZONE)
        calendar_call = next(
            kwargs
            for path, kwargs in client.calls
            if path == "/calendar/earnings"
        )
        params = calendar_call["params"]
        self.assertIsInstance(params, dict)
        self.assertEqual(params["from"], "2026-07-30")
        self.assertEqual(params["to"], "2026-08-05")

    def test_finnhub_rejects_eighth_calendar_date(self) -> None:
        client = _FinnhubClient(
            [],
            {
                "earningsCalendar": [
                    {"symbol": "LATE", "date": "2026-08-06"}
                ]
            },
        )
        with patch.dict(
            "os.environ",
            {"FINNHUB_API_KEY": "test-key"},
            clear=True,
        ), patch("trading_os_v2.a1.service.datetime") as clock:
            clock.now.return_value = datetime(
                2026,
                7,
                30,
                tzinfo=UTC,
            )
            collector = A1Collector(load_config(), client)
            result = collector._collect_finnhub()
        self.assertEqual(result["earnings_status"], "FAILED")
        self.assertEqual(result["earnings"], [])

    def test_google_news_uses_separate_macro_and_catalyst_queries(self) -> None:
        xml = """<rss><channel><item>
          <title>Iran peace hopes lift Wall Street</title>
          <link>https://example.com/market</link>
          <guid>market-1</guid>
          <pubDate>Mon, 03 Aug 2026 18:00:00 GMT</pubDate>
          <source>Reuters</source>
        </item></channel></rss>"""

        class Client:
            def __init__(self) -> None:
                self.queries: list[str] = []
                self.labels: list[str] = []

            def text(
                self,
                _url: str,
                *,
                params: dict[str, str],
                label: str,
            ) -> str:
                self.queries.append(params["q"])
                self.labels.append(label)
                return xml

        client = Client()
        result = A1Collector(load_config(), client)._collect_google_news()

        self.assertEqual(result["status"], "HEALTHY")
        self.assertEqual(len(client.queries), 2)
        self.assertIn("when:1d", client.queries[0])
        self.assertIn("when:2d", client.queries[1])
        self.assertEqual(client.labels, ["Google News RSS 1", "Google News RSS 2"])
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["confidence"], "cross_check_candidate")

    def test_bls_data_fallback_preserves_official_evidence(self) -> None:
        xml = """<rss><channel><item>
          <title>Employment Situation</title>
          <link>https://www.bls.gov/news.release/empsit.htm</link>
          <guid>empsit</guid>
          <pubDate>Wed, 29 Jul 2026 18:00:00 GMT</pubDate>
        </item></channel></rss>"""

        class Client:
            def __init__(self) -> None:
                self.accept = ""

            def text(
                self,
                url: str,
                *,
                headers: dict[str, str],
                **_: object,
            ) -> str:
                self.accept = headers.get("Accept", "")
                if url == "primary":
                    raise ProviderError("BLS official feed: HTTP 403")
                return xml

            def post_json(
                self,
                url: str,
                payload: dict[str, object],
                **_: object,
            ) -> dict[str, object]:
                return {
                    "status": "REQUEST_SUCCEEDED",
                    "Results": {
                        "series": [
                            {
                                "seriesID": "CUSR0000SA0",
                                "data": [
                                    {
                                        "year": "2026",
                                        "period": "M06",
                                        "value": "332.568",
                                    }
                                ],
                            }
                        ]
                    },
                }

        client = Client()
        collector = A1Collector(
            {
                "providers": {
                    "official_news_feeds": [
                        {"name": "BLS", "url": "primary"},
                    ]
                }
            },
            client,
        )
        result = collector._collect_official_news()
        self.assertEqual(result["feeds"][0]["status"], "DEGRADED")
        self.assertTrue(result["feeds"][0]["fallback_used"])
        self.assertEqual(
            collector.errors,
            ["BLS official feed: HTTP 403"],
        )
        self.assertEqual(
            client.accept,
            (
                "application/rss+xml, application/atom+xml, "
                "application/xml, text/xml;q=0.9"
            ),
        )

    def test_http_text_forwards_calendar_accept_header(self) -> None:
        class Response:
            def __enter__(self) -> Response:
                return self

            def __exit__(self, *_: object) -> None:
                return None

            def read(self) -> bytes:
                return b"BEGIN:VCALENDAR\nEND:VCALENDAR\n"

        with patch(
            "trading_os_v2.a1.service.urllib.request.urlopen",
            return_value=Response(),
        ) as opened:
            result = HttpClient().text(
                BLS_RELEASE_CALENDAR_URL,
                headers={"Accept": "text/calendar"},
                label="BLS release calendar",
            )

        request = opened.call_args.args[0]
        self.assertEqual(request.get_header("Accept"), "text/calendar")
        self.assertIn("BEGIN:VCALENDAR", result)

    def test_http_text_rejects_calendar_above_byte_limit(self) -> None:
        class Response:
            requested = 0

            def __enter__(self) -> Response:
                return self

            def __exit__(self, *_: object) -> None:
                return None

            def read(self, size: int) -> bytes:
                self.requested = size
                return b"x" * size

        response = Response()
        with patch(
            "trading_os_v2.a1.service.urllib.request.urlopen",
            return_value=response,
        ):
            with self.assertRaisesRegex(ProviderError, "response too large"):
                HttpClient().text(
                    BLS_RELEASE_CALENDAR_URL,
                    headers={"Accept": "text/calendar"},
                    label="BLS release calendar",
                    max_bytes=BLS_RELEASE_CALENDAR_MAX_BYTES,
                )

        self.assertEqual(
            response.requested,
            BLS_RELEASE_CALENDAR_MAX_BYTES + 1,
        )

    def test_bls_calendar_freezes_unreleased_nonfarm_schedule_in_pt(self) -> None:
        calendar = """BEGIN:VCALENDAR
BEGIN:VEVENT
UID:employment-20260807
DTSTART;TZID=US-Eastern:20260807T083000
SUMMARY:Employment Situation for July 2026
END:VEVENT
BEGIN:VEVENT
UID:ignored-20260807
DTSTART;TZID=US-Eastern:20260807T100000
SUMMARY:Metropolitan Area Employment and Unemployment
END:VEVENT
END:VCALENDAR
"""
        events = _parse_bls_macro_calendar(
            calendar,
            generated_at="2026-08-06T18:00:00-07:00",
        )

        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event["category"], "employment")
        self.assertEqual(event["release_name"], "Employment Situation")
        self.assertEqual(event["scheduled_at"], "2026-08-07T05:30:00-07:00")
        self.assertEqual(event["market_impact_status"], "SCHEDULED_UNRELEASED")
        self.assertEqual(event["result_status"], "UNKNOWN")
        self.assertFalse("result" in event and event["result"])
        self.assertEqual(event["source_url"], BLS_RELEASE_CALENDAR_URL)
        self.assertEqual(len(event["event_fingerprint"]), 64)

    def test_bls_calendar_rejects_excessive_event_blocks(self) -> None:
        blocks = ["BEGIN:VCALENDAR"]
        for index in range(BLS_RELEASE_CALENDAR_MAX_EVENTS + 1):
            blocks.extend(
                (
                    "BEGIN:VEVENT",
                    f"UID:irrelevant-{index}",
                    "DTSTART:20260807T083000Z",
                    "SUMMARY:Irrelevant event",
                    "END:VEVENT",
                )
            )
        blocks.append("END:VCALENDAR")

        with self.assertRaisesRegex(ValueError, "too many events"):
            _parse_bls_macro_calendar(
                "\n".join(blocks),
                generated_at="2026-08-06T18:00:00-07:00",
            )

    def test_bls_calendar_normalizes_all_supported_release_names(self) -> None:
        releases = (
            (
                "Employment Situation",
                "Employment Situation for July 2026",
                "employment",
                "083000",
            ),
            (
                "Job Openings and Labor Turnover Survey",
                "Job Openings and Labor Turnover Survey for June 2026",
                "employment",
                "090000",
            ),
            (
                "Consumer Price Index",
                "Consumer Price Index for July 2026",
                "inflation",
                "093000",
            ),
            (
                "Producer Price Index",
                "Producer Price Index for July 2026",
                "inflation",
                "100000",
            ),
        )

        def calendar(*, suffixed: bool) -> str:
            blocks = ["BEGIN:VCALENDAR"]
            for index, (canonical, summary, _category, clock) in enumerate(
                releases
            ):
                blocks.extend(
                    (
                        "BEGIN:VEVENT",
                        f"UID:macro-{index}",
                        f"DTSTART;TZID=US-Eastern:20260807T{clock}",
                        f"SUMMARY:{summary if suffixed else canonical}",
                        "END:VEVENT",
                    )
                )
            blocks.append("END:VCALENDAR")
            return "\n".join(blocks)

        suffixed_events = _parse_bls_macro_calendar(
            calendar(suffixed=True),
            generated_at="2026-08-06T18:00:00-07:00",
        )
        self.assertEqual(
            [event["release_name"] for event in suffixed_events],
            [release[0] for release in releases],
        )
        self.assertEqual(
            [event["category"] for event in suffixed_events],
            [release[2] for release in releases],
        )
        with self.assertRaisesRegex(ValueError, "expected period is missing"):
            _parse_bls_macro_calendar(
                calendar(suffixed=False),
                generated_at="2026-08-06T18:00:00-07:00",
            )

    def test_bls_calendar_degrades_suspected_supported_title_drift(self) -> None:
        calendar = """BEGIN:VCALENDAR
BEGIN:VEVENT
UID:employment-20260807
DTSTART;TZID=US-Eastern:20260807T083000
SUMMARY:The Employment Situation for July 2026
END:VEVENT
END:VCALENDAR
"""

        class Client:
            def text(self, *_: object, **__: object) -> str:
                return calendar

        watch, due = A1Collector(
            {},
            Client(),
        )._collect_bls_macro_calendar_snapshot(
            generated_at="2026-08-06T18:00:00-07:00",
        )

        self.assertEqual(watch["status"], "DEGRADED")
        self.assertEqual(watch["events"], [])
        self.assertEqual(due, [])

    def test_bls_calendar_rejects_more_than_twenty_supported_week_events(
        self,
    ) -> None:
        blocks = ["BEGIN:VCALENDAR"]
        for hour in range(21):
            blocks.extend(
                (
                    "BEGIN:VEVENT",
                    f"UID:employment-{hour}",
                    (
                        "DTSTART;TZID=US-Eastern:"
                        f"20260807T{hour:02d}0000"
                    ),
                    "SUMMARY:Employment Situation for July 2026",
                    "END:VEVENT",
                )
            )
        blocks.append("END:VCALENDAR")

        with self.assertRaisesRegex(
            ValueError,
            "too many supported seven-day events",
        ):
            _parse_bls_macro_calendar(
                "\n".join(blocks),
                generated_at="2026-08-06T18:00:00-07:00",
            )

    def test_bls_calendar_is_fetched_once_and_projects_due_from_future(self) -> None:
        class Client:
            def __init__(self) -> None:
                self.calls = 0

            def text(self, *_: object, **__: object) -> str:
                self.calls += 1
                return BLS_EMPLOYMENT_CALENDAR

        client = Client()
        watch, due = A1Collector({}, client)._collect_bls_macro_calendar_snapshot(
            generated_at="2026-08-07T13:31:00+00:00",
        )

        self.assertEqual(client.calls, 1)
        self.assertEqual(
            [event["release_name"] for event in watch["events"]],
            ["Consumer Price Index"],
        )
        self.assertEqual(
            [event["schedule"]["release_name"] for event in due],
            ["Employment Situation"],
        )
        self.assertEqual(due[0]["expected_period"], "2026-07")
        self.assertEqual(
            due[0]["schedule"]["event_fingerprint"],
            _parse_bls_macro_calendar(
                BLS_EMPLOYMENT_CALENDAR,
                generated_at="2026-08-06T18:00:00-07:00",
            )[0]["event_fingerprint"],
        )

    def test_bls_latest_numbers_verifies_only_due_release_period(self) -> None:
        _future, due = _bls_macro_calendar_projections(
            BLS_EMPLOYMENT_CALENDAR,
            generated_at="2026-08-07T13:31:00+00:00",
        )
        result = _macro_results(
            due,
            official_items=[_bls_latest_numbers_item()],
            official_status="HEALTHY",
            calendar_status="HEALTHY",
            generated_at="2026-08-07T13:31:00+00:00",
        )[0]

        self.assertEqual(result["status"], "VERIFIED")
        self.assertEqual(result["release_name"], "Employment Situation")
        self.assertEqual(result["category"], "employment")
        self.assertEqual(result["published_at"], "2026-08-07T12:32:13+00:00")
        self.assertEqual(
            result["source_url"],
            "https://www.bls.gov/news.release/empsit.toc.htm",
        )
        self.assertEqual(
            result["schedule_event_fingerprint"],
            due[0]["schedule"]["event_fingerprint"],
        )
        self.assertEqual(
            result["metrics"],
            [
                {
                    "name": "PAYROLL_EMPLOYMENT_CHANGE",
                    "value": -23000,
                    "unit": "JOBS",
                    "period": "2026-07",
                    "preliminary": True,
                },
                {
                    "name": "UNEMPLOYMENT_RATE",
                    "value": 4.1,
                    "unit": "PERCENT",
                    "period": "2026-07",
                    "preliminary": False,
                },
                {
                    "name": "AVERAGE_HOURLY_EARNINGS_CHANGE",
                    "value": 0.02,
                    "unit": "USD",
                    "period": "2026-07",
                    "preliminary": True,
                },
            ],
        )
        self.assertNotIn(
            "CONSUMER_PRICE_INDEX_CHANGE",
            {metric["name"] for metric in result["metrics"]},
        )
        self.assertNotIn(
            "PRODUCER_PRICE_INDEX_FINAL_DEMAND_CHANGE",
            {metric["name"] for metric in result["metrics"]},
        )
        expected_hash_payload = {
            key: value
            for key, value in result.items()
            if key not in {"generated_at", "result_hash"}
        }
        self.assertEqual(
            result["result_hash"],
            sha256_json(expected_hash_payload),
        )

    def test_macro_results_require_unique_matching_due_fingerprints(self) -> None:
        _future, due = _bls_macro_calendar_projections(
            BLS_EMPLOYMENT_CALENDAR,
            generated_at="2026-08-07T13:31:00+00:00",
        )
        kwargs = {
            "official_items": [_bls_latest_numbers_item()],
            "official_status": "HEALTHY",
            "calendar_status": "HEALTHY",
            "generated_at": "2026-08-07T13:31:00+00:00",
        }

        with self.assertRaisesRegex(ValueError, "must be unique"):
            _macro_results(due + due, **kwargs)
        with patch(
            "trading_os_v2.a1.service._macro_result",
            return_value={"schedule_event_fingerprint": "0" * 64},
        ):
            with self.assertRaisesRegex(ValueError, "do not match"):
                _macro_results(due, **kwargs)

    def test_macro_result_hash_ignores_whitespace_but_not_actual_changes(self) -> None:
        _future, due = _bls_macro_calendar_projections(
            BLS_EMPLOYMENT_CALENDAR,
            generated_at="2026-08-07T13:31:00+00:00",
        )
        original = _bls_latest_numbers_item()
        whitespace_only = _bls_latest_numbers_item(
            " ".join(BLS_LATEST_NUMBERS_SUMMARY.split())
        )
        numeric_change = _bls_latest_numbers_item(
            BLS_LATEST_NUMBERS_SUMMARY.replace("-23,000(p)", "-22,000(p)")
        )

        self.assertEqual(
            _canonical_official_raw_item_hash(original),
            _canonical_official_raw_item_hash(whitespace_only),
        )
        self.assertNotEqual(
            _canonical_official_raw_item_hash(original),
            _canonical_official_raw_item_hash(numeric_change),
        )
        first = _macro_results(
            due,
            official_items=[original],
            official_status="HEALTHY",
            calendar_status="HEALTHY",
            generated_at="2026-08-07T13:31:00+00:00",
        )[0]
        repeated = _macro_results(
            due,
            official_items=[whitespace_only],
            official_status="HEALTHY",
            calendar_status="HEALTHY",
            generated_at="2026-08-07T13:46:00+00:00",
        )[0]
        changed = _macro_results(
            due,
            official_items=[numeric_change],
            official_status="HEALTHY",
            calendar_status="HEALTHY",
            generated_at="2026-08-07T13:46:00+00:00",
        )[0]

        self.assertEqual(first["result_hash"], repeated["result_hash"])
        self.assertNotEqual(first["result_hash"], changed["result_hash"])

    def test_macro_result_requires_all_three_employment_metrics(self) -> None:
        _future, due = _bls_macro_calendar_projections(
            BLS_EMPLOYMENT_CALENDAR,
            generated_at="2026-08-07T13:31:00+00:00",
        )
        missing_ahe = BLS_LATEST_NUMBERS_SUMMARY.replace(
            "<p>Average Hourly Earnings:",
            "<p>Ignored Earnings Metric:",
        )
        result = _macro_results(
            due,
            official_items=[_bls_latest_numbers_item(missing_ahe)],
            official_status="HEALTHY",
            calendar_status="HEALTHY",
            generated_at="2026-08-07T13:31:00+00:00",
        )[0]

        self.assertEqual(result["status"], "MISSING")
        self.assertIsNone(result["published_at"])
        self.assertIsNone(result["raw_item_hash"])
        self.assertEqual(result["metrics"], [])

    def test_macro_result_rejects_pre_schedule_or_wrong_release_items(self) -> None:
        _future, due = _bls_macro_calendar_projections(
            BLS_EMPLOYMENT_CALENDAR,
            generated_at="2026-08-07T13:31:00+00:00",
        )
        before_schedule = _bls_latest_numbers_item()
        before_schedule["published_at"] = "2026-08-07T12:29:59+00:00"
        wrong_release = _bls_latest_numbers_item(
            BLS_LATEST_NUMBERS_SUMMARY.replace(
                "https://www.bls.gov/news.release/empsit.toc.htm",
                "https://www.bls.gov/news.release/cpi.toc.htm",
            )
        )
        for item in (before_schedule, wrong_release):
            with self.subTest(item=item):
                result = _macro_results(
                    due,
                    official_items=[item],
                    official_status="HEALTHY",
                    calendar_status="HEALTHY",
                    generated_at="2026-08-07T13:31:00+00:00",
                )[0]
                self.assertEqual(result["status"], "MISSING")
                self.assertEqual(result["metrics"], [])

    def test_macro_result_degrades_for_provider_or_calendar_failure(self) -> None:
        _future, due = _bls_macro_calendar_projections(
            BLS_EMPLOYMENT_CALENDAR,
            generated_at="2026-08-07T13:31:00+00:00",
        )
        for provider_status, calendar_status in (
            ("DEGRADED", "HEALTHY"),
            ("HEALTHY", "DEGRADED"),
        ):
            with self.subTest(
                provider_status=provider_status,
                calendar_status=calendar_status,
            ):
                result = _macro_results(
                    due,
                    official_items=[_bls_latest_numbers_item()],
                    official_status=provider_status,
                    calendar_status=calendar_status,
                    generated_at="2026-08-07T13:31:00+00:00",
                )[0]
                self.assertEqual(result["status"], "DEGRADED")
                self.assertIsNone(result["source"])
                self.assertIsNone(result["raw_item_hash"])
                self.assertEqual(result["metrics"], [])

    def test_collect_adds_macro_results_without_changing_news_ttl_health(self) -> None:
        official_item = _bls_latest_numbers_item()

        class Collector(A1Collector):
            def _collect_tradier(self) -> dict[str, object]:
                return {
                    "clock": {},
                    "quotes": [],
                    "history": {},
                    "timesales": {},
                    "options": {},
                }

            def _collect_finnhub(self) -> dict[str, object]:
                return {
                    "status": "HEALTHY",
                    "items": [],
                    "earnings": [],
                    "earnings_status": "HEALTHY",
                    "error": "",
                    "earnings_error": "",
                }

            def _collect_official_news(self) -> dict[str, object]:
                return {
                    "status": "HEALTHY",
                    "healthy_feed_count": 2,
                    "feeds": [
                        {
                            "name": "BLS",
                            "status": "HEALTHY",
                            "fallback_used": False,
                        },
                        {
                            "name": "Federal Reserve",
                            "status": "HEALTHY",
                            "fallback_used": False,
                        },
                    ],
                    "items": [official_item],
                }

            def _collect_google_news(self) -> dict[str, object]:
                return {"status": "HEALTHY", "items": [], "error": ""}

            def _collect_bls_macro_calendar_snapshot(
                self,
                *,
                generated_at: str,
            ) -> tuple[dict[str, object], list[dict[str, object]]]:
                future, due = _bls_macro_calendar_projections(
                    BLS_EMPLOYMENT_CALENDAR,
                    generated_at=generated_at,
                )
                return (
                    _macro_watch(
                        generated_at=generated_at,
                        status="HEALTHY",
                        events=future,
                    ),
                    due,
                )

        collector = Collector(
            {
                "contract_version": "v1",
                "system": {"timezone": "America/Los_Angeles"},
            }
        )
        with patch(
            "trading_os_v2.a1.service.iso_now",
            return_value="2026-08-07T13:31:00+00:00",
        ):
            result = collector.collect()

        self.assertEqual(len(result["macro_results"]), 1)
        self.assertEqual(result["macro_results"][0]["status"], "VERIFIED")
        self.assertIn(official_item, result["news"])
        self.assertIn(official_item, result["information_archive"]["news"])
        self.assertFalse(result["health"]["verified_market_moving_news"])
        self.assertEqual(
            result["health"]["market_moving_news_evidence"],
            [],
        )

    def test_bls_calendar_failure_is_degraded_optional_evidence(self) -> None:
        class Client:
            def text(self, *_: object, **__: object) -> str:
                raise ProviderError("BLS release calendar: HTTP 403")

        collector = A1Collector({}, Client())
        watch = collector._collect_bls_macro_calendar(
            generated_at="2026-08-06T18:00:00-07:00",
        )

        self.assertEqual(watch["status"], "DEGRADED")
        self.assertEqual(watch["events"], [])
        self.assertFalse(watch["actionable"])
        self.assertEqual(collector.errors, [])

    def test_news_merge_reserves_first_thirty_for_all_source_layers(self) -> None:
        official = [
            {
                "id": f"{source}-{index}",
                "headline": f"{source} item {index}",
                "source": source,
                "provider": f"{source} official",
                "url": f"https://official.example/{source}/{index}",
            }
            for source in ("Federal Reserve", "BLS", "BEA", "SEC")
            for index in range(10)
        ]
        finnhub = [
            {
                "id": f"finnhub-{index}",
                "headline": f"Finnhub item {index}",
                "source": "Reuters",
                "provider": "Finnhub",
                "url": f"https://finnhub.example/{index}",
            }
            for index in range(20)
        ]
        google = [
            {
                "id": f"google-{index}",
                "headline": f"Google item {index}",
                "source": "Example",
                "provider": "Google News RSS",
                "url": f"https://google.example/{index}",
            }
            for index in range(20)
        ]

        result = _merge_news(official, finnhub, google)
        first_thirty = result[:30]

        self.assertEqual(
            sum(item["provider"].endswith("official") for item in first_thirty),
            15,
        )
        self.assertEqual(
            sum(item["provider"] == "Finnhub" for item in first_thirty),
            10,
        )
        self.assertEqual(
            sum(item["provider"] == "Google News RSS" for item in first_thirty),
            5,
        )
        self.assertIn("SEC", {item["source"] for item in first_thirty})
        self.assertEqual(len(result), 80)

    def test_news_merge_deduplicates_and_fills_missing_quota(self) -> None:
        duplicate = {
            "id": "same",
            "headline": "Same market headline",
            "source": "SEC",
            "provider": "SEC official",
            "url": "https://example.test/same",
        }
        official = [duplicate]
        finnhub = [
            {
                **duplicate,
                "provider": "Finnhub",
                "source": "Reuters",
            }
        ]
        google = [
            {
                "id": f"google-{index}",
                "headline": f"Google item {index}",
                "source": "Example",
                "provider": "Google News RSS",
                "url": f"https://google.example/{index}",
            }
            for index in range(35)
        ]

        result = _merge_news(official, finnhub, google)

        self.assertEqual(len(result), 36)
        self.assertEqual(
            sum(item["headline"] == "Same market headline" for item in result),
            1,
        )
        self.assertEqual(len({item["url"] for item in result}), len(result))

    def test_collect_clears_errors_without_mutating_previous_result(self) -> None:
        class Collector(A1Collector):
            calls = 0

            def _collect_tradier(self) -> dict[str, object]:
                self.calls += 1
                if self.calls == 1:
                    self.errors.append("transient failure")
                return {
                    "clock": {},
                    "quotes": [],
                    "history": {},
                    "timesales": {},
                    "options": {},
                }

            def _collect_finnhub(self) -> dict[str, object]:
                return {
                    "status": "HEALTHY",
                    "items": [{"headline": "Finnhub", "url": "finnhub"}],
                    "earnings": [],
                    "earnings_status": "HEALTHY",
                    "error": "",
                    "earnings_error": "",
                }

            def _collect_official_news(self) -> dict[str, object]:
                return {
                    "status": "HEALTHY",
                    "healthy_feed_count": 2,
                    "feeds": [],
                    "items": [{"headline": "Official", "url": "official"}],
                }

            def _collect_google_news(self) -> dict[str, object]:
                return {"status": "HEALTHY", "items": [], "error": ""}

            def _collect_bls_macro_calendar_snapshot(
                self,
                *,
                generated_at: str,
            ) -> tuple[dict[str, object], list[dict[str, object]]]:
                return (
                    _macro_watch(
                        generated_at=generated_at,
                        status="HEALTHY",
                        events=[],
                    ),
                    [],
                )

        collector = Collector(
            {
                "contract_version": "v1",
                "system": {"timezone": "America/Los_Angeles"},
            }
        )
        first = collector.collect()
        second = collector.collect()

        self.assertEqual(first["health"]["errors"], ["transient failure"])
        self.assertEqual(second["health"]["errors"], [])
        self.assertEqual(
            first["information_archive"],
            _information_archive(first),
        )
        self.assertNotIn("token", str(first["information_archive"]).lower())

    def test_macro_calendar_gap_does_not_degrade_core_a1_health(self) -> None:
        class Collector(A1Collector):
            def _collect_tradier(self) -> dict[str, object]:
                return {
                    "clock": {},
                    "quotes": [],
                    "history": {},
                    "timesales": {},
                    "options": {},
                }

            def _collect_finnhub(self) -> dict[str, object]:
                return {
                    "status": "HEALTHY",
                    "items": [{"headline": "Finnhub", "url": "finnhub"}],
                    "earnings": [],
                    "earnings_status": "HEALTHY",
                    "error": "",
                    "earnings_error": "",
                }

            def _collect_official_news(self) -> dict[str, object]:
                return {
                    "status": "HEALTHY",
                    "healthy_feed_count": 2,
                    "feeds": [],
                    "items": [{"headline": "Official", "url": "official"}],
                }

            def _collect_google_news(self) -> dict[str, object]:
                return {"status": "HEALTHY", "items": [], "error": ""}

            def _collect_bls_macro_calendar_snapshot(
                self,
                *,
                generated_at: str,
            ) -> tuple[dict[str, object], list[dict[str, object]]]:
                return (
                    _macro_watch(
                        generated_at=generated_at,
                        status="DEGRADED",
                        events=[],
                    ),
                    [],
                )

        result = Collector(
            {
                "contract_version": "v1",
                "system": {"timezone": "America/Los_Angeles"},
            }
        ).collect()

        self.assertEqual(result["health"]["state"], "HEALTHY")
        self.assertEqual(result["macro_watch"]["status"], "DEGRADED")
        self.assertEqual(
            result["providers"]["macro_calendar"]["status"],
            "DEGRADED",
        )

    def test_collect_checks_and_archives_news_beyond_display_quota(
        self,
    ) -> None:
        published = datetime.now(UTC).isoformat()

        class Collector(A1Collector):
            def _collect_tradier(self) -> dict[str, object]:
                return {
                    "clock": {},
                    "quotes": [],
                    "history": {},
                    "timesales": {},
                    "options": {},
                }

            def _collect_finnhub(self) -> dict[str, object]:
                ordinary = [
                    {
                        "id": f"ordinary-{index}",
                        "headline": f"Ordinary market item {index}",
                        "source": "Reuters",
                        "published_at": published,
                        "url": f"https://finnhub.example/{index}",
                        "provider": "Finnhub",
                        "confidence": "primary_aggregator",
                    }
                    for index in range(12)
                ]
                major = [
                    {
                        "id": f"major-{source}",
                        "headline": (
                            "Consumer price index release "
                            f"reported by {source}"
                        ),
                        "source": source,
                        "published_at": published,
                        "url": f"https://major.example/{source}",
                        "provider": "Finnhub",
                        "confidence": "primary_aggregator",
                    }
                    for source in ("Reuters", "Bloomberg")
                ]
                return {
                    "status": "HEALTHY",
                    "items": ordinary + major,
                    "earnings": [],
                    "earnings_status": "HEALTHY",
                    "error": "",
                    "earnings_error": "",
                }

            def _collect_official_news(self) -> dict[str, object]:
                return {
                    "status": "HEALTHY",
                    "healthy_feed_count": 2,
                    "feeds": [],
                    "items": [
                        {
                            "id": f"official-{index}",
                            "headline": f"Official ordinary item {index}",
                            "source": "SEC",
                            "published_at": published,
                            "url": f"https://official.example/{index}",
                            "provider": "SEC official",
                            "confidence": "official",
                        }
                        for index in range(90)
                    ],
                }

            def _collect_google_news(self) -> dict[str, object]:
                return {"status": "HEALTHY", "items": [], "error": ""}

            def _collect_bls_macro_calendar_snapshot(
                self,
                *,
                generated_at: str,
            ) -> tuple[dict[str, object], list[dict[str, object]]]:
                return (
                    _macro_watch(
                        generated_at=generated_at,
                        status="HEALTHY",
                        events=[],
                    ),
                    [],
                )

        collector = Collector(
            {
                "contract_version": "v1",
                "system": {"timezone": "America/Los_Angeles"},
            }
        )
        result = collector.collect()
        self.assertEqual(len(result["news"]), 104)
        self.assertTrue(result["health"]["verified_market_moving_news"])
        self.assertEqual(
            {
                item["source"]
                for item in result["health"][
                    "market_moving_news_evidence"
                ]
            },
            {"Reuters", "Bloomberg"},
        )
        self.assertEqual(
            result["information_archive"]["news"],
            result["news"],
        )


if __name__ == "__main__":
    unittest.main()
