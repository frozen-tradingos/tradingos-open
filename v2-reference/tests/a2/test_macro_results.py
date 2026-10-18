from __future__ import annotations

import copy
import unittest

from trading_os_v2.a2.service import (
    _canonical_official_raw_item_hash,
    _validated_macro_results,
)
from trading_os_v2.common.io import sha256_json


SCHEDULED_AT = "2026-08-07T05:30:00-07:00"
COLLECTED_AT = "2026-08-07T13:31:00+00:00"
EMPLOYMENT_URL = "https://www.bls.gov/news.release/empsit.toc.htm"
BLS_SUMMARY = """
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


def _official_item(summary: str = BLS_SUMMARY) -> dict[str, object]:
    return {
        "id": "BLS:https://www.bls.gov/",
        "headline": "Major Economic Indicators Latest Numbers",
        "summary": summary,
        "source": "BLS",
        "published_at": "2026-08-07T12:32:13+00:00",
        "url": "https://www.bls.gov/",
        "provider": "BLS official",
        "confidence": "official",
    }


def _schedule_fingerprint(
    *,
    category: str = "employment",
    release_name: str = "Employment Situation",
    scheduled_at: str = SCHEDULED_AT,
) -> str:
    return sha256_json(
        {
            "contract_version": "v1",
            "component": "A1_MACRO_WATCH",
            "category": category,
            "release_name": release_name,
            "scheduled_at": scheduled_at,
            "source": "BLS Official Release Calendar",
        }
    )


def _rehash(result: dict[str, object]) -> dict[str, object]:
    payload = {
        key: value
        for key, value in result.items()
        if key not in {"generated_at", "result_hash"}
    }
    result["result_hash"] = sha256_json(payload)
    return result


def _result(*, status: str = "VERIFIED") -> dict[str, object]:
    item = _official_item()
    result: dict[str, object] = {
        "contract_version": "v1",
        "component": "A1_MACRO_RESULT",
        "actionable": False,
        "status": status,
        "generated_at": COLLECTED_AT,
        "timezone": "America/Los_Angeles",
        "market_date": "2026-08-07",
        "selection_rule": (
            "BLS_OFFICIAL_MARKET_MOVING_RESULTS_CURRENT_MARKET_DATE"
        ),
        "schedule_event_fingerprint": _schedule_fingerprint(),
        "category": "employment",
        "release_name": "Employment Situation",
        "scheduled_at": SCHEDULED_AT,
        "published_at": None,
        "source": None,
        "source_url": None,
        "raw_item_hash": None,
        "confidence": None,
        "metrics": [],
        "result_hash": "",
    }
    if status == "VERIFIED":
        result.update(
            {
                "published_at": item["published_at"],
                "source": "BLS",
                "source_url": EMPLOYMENT_URL,
                "raw_item_hash": _canonical_official_raw_item_hash(item),
                "confidence": "official_result",
                "metrics": [
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
            }
        )
    return _rehash(result)


def _raw(*, result: dict[str, object] | None = None) -> dict[str, object]:
    return {
        "collected_at": COLLECTED_AT,
        "providers": {
            "macro_calendar": {
                "status": "HEALTHY",
                "source": "BLS Official Release Calendar",
            },
            "official_news": {
                "status": "HEALTHY",
                "feeds": [
                    {
                        "name": "BLS",
                        "status": "HEALTHY",
                        "fallback_used": False,
                    }
                ],
            },
        },
        "news": [_official_item()],
        "macro_results": [result or _result()],
    }


class A2MacroResultTests(unittest.TestCase):
    def test_accepts_verified_employment_result_and_excludes_stale_rows(self) -> None:
        raw = _raw()

        frozen = _validated_macro_results(raw)

        self.assertIs(frozen, raw["macro_results"])
        self.assertEqual(
            [metric["name"] for metric in frozen[0]["metrics"]],
            [
                "PAYROLL_EMPLOYMENT_CHANGE",
                "UNEMPLOYMENT_RATE",
                "AVERAGE_HOURLY_EARNINGS_CHANGE",
            ],
        )

    def test_accepts_each_release_specific_single_metric_result(self) -> None:
        cases = (
            (
                "Job Openings and Labor Turnover Survey",
                "employment",
                "Job Openings",
                "JOB_OPENINGS",
                "JOBS",
                7500000,
                "7,500,000 in Jul 2026",
                "https://www.bls.gov/news.release/jolts.toc.htm",
            ),
            (
                "Consumer Price Index",
                "inflation",
                "Consumer Price Index (CPI)",
                "CONSUMER_PRICE_INDEX_CHANGE",
                "PERCENT",
                0.2,
                "+0.2% in Jul 2026",
                "https://www.bls.gov/news.release/cpi.toc.htm",
            ),
            (
                "Producer Price Index",
                "inflation",
                "Producer Price Index - Final Demand",
                "PRODUCER_PRICE_INDEX_FINAL_DEMAND_CHANGE",
                "PERCENT",
                -0.1,
                "-0.1%(p) in Jul 2026",
                "https://www.bls.gov/news.release/ppi.toc.htm",
            ),
        )
        for (
            release_name,
            category,
            label,
            metric_name,
            unit,
            value,
            raw_value,
            source_url,
        ) in cases:
            with self.subTest(release=release_name):
                summary = (
                    f'<p>{label}:<br><strong><span class="data">'
                    f'{raw_value}</span></strong><br><a href="{source_url}">'
                    "News Release</a></p>"
                )
                item = _official_item(summary)
                result = _result(status="MISSING")
                result.update(
                    {
                        "status": "VERIFIED",
                        "category": category,
                        "release_name": release_name,
                        "schedule_event_fingerprint": _schedule_fingerprint(
                            category=category,
                            release_name=release_name,
                        ),
                        "published_at": item["published_at"],
                        "source": "BLS",
                        "source_url": source_url,
                        "raw_item_hash": _canonical_official_raw_item_hash(item),
                        "confidence": "official_result",
                        "metrics": [
                            {
                                "name": metric_name,
                                "value": value,
                                "unit": unit,
                                "period": "2026-07",
                                "preliminary": "(p)" in raw_value,
                            }
                        ],
                    }
                )
                raw = _raw(result=_rehash(result))
                raw["news"] = [item]
                self.assertEqual(
                    _validated_macro_results(raw)[0]["release_name"],
                    release_name,
                )

    def test_raw_hash_is_whitespace_insensitive_but_numeric_sensitive(self) -> None:
        raw = _raw()
        raw["news"][0]["summary"] = BLS_SUMMARY.replace("\n", "\n \t")
        _validated_macro_results(raw)

        changed = _raw()
        changed["news"][0]["summary"] = BLS_SUMMARY.replace(
            "-23,000(p)",
            "-24,000(p)",
        )
        with self.assertRaisesRegex(RuntimeError, "raw proof"):
            _validated_macro_results(changed)

    def test_rejects_invented_provenance_or_metrics_even_with_new_hash(self) -> None:
        for field, value in (
            ("source_url", "https://www.bls.gov/news.release/cpi.toc.htm"),
            ("published_at", "2026-08-07T12:31:00+00:00"),
        ):
            with self.subTest(field=field):
                raw = _raw()
                raw["macro_results"][0][field] = value
                _rehash(raw["macro_results"][0])
                with self.assertRaises(RuntimeError):
                    _validated_macro_results(raw)

        raw = _raw()
        raw["macro_results"][0]["metrics"][0]["value"] = -24000
        _rehash(raw["macro_results"][0])
        with self.assertRaisesRegex(RuntimeError, "raw proof"):
            _validated_macro_results(raw)

    def test_accepts_truthful_missing_and_degraded_status_branches(self) -> None:
        missing = _raw(result=_result(status="MISSING"))
        missing["news"] = []
        self.assertEqual(_validated_macro_results(missing)[0]["status"], "MISSING")

        degraded = _raw(result=_result(status="DEGRADED"))
        degraded["providers"]["macro_calendar"]["status"] = "DEGRADED"
        self.assertEqual(
            _validated_macro_results(degraded)[0]["status"],
            "DEGRADED",
        )

        for raw in (
            _raw(result=_result(status="DEGRADED")),
            copy.deepcopy(degraded),
        ):
            if raw["macro_results"][0]["status"] == "DEGRADED" and raw[
                "providers"
            ]["macro_calendar"]["status"] == "DEGRADED":
                raw["macro_results"][0] = _result(status="MISSING")
            with self.assertRaisesRegex(RuntimeError, "status"):
                _validated_macro_results(raw)

    def test_rejects_shape_hash_metric_identity_and_duplicates(self) -> None:
        raw = _raw()
        raw["macro_results"] = {"results": raw["macro_results"]}
        with self.assertRaisesRegex(RuntimeError, "missing or malformed"):
            _validated_macro_results(raw)

        for mutation in ("extra", "hash", "unit", "period", "duplicate_name"):
            with self.subTest(mutation=mutation):
                raw = _raw()
                result = raw["macro_results"][0]
                if mutation == "extra":
                    result["unexpected"] = True
                elif mutation == "hash":
                    result["result_hash"] = "0" * 64
                elif mutation == "unit":
                    result["metrics"][0]["unit"] = "PERCENT"
                    _rehash(result)
                elif mutation == "period":
                    result["metrics"][0]["period"] = "2026-06"
                    _rehash(result)
                else:
                    result["metrics"][1]["name"] = (
                        "PAYROLL_EMPLOYMENT_CHANGE"
                    )
                    _rehash(result)
                with self.assertRaises(RuntimeError):
                    _validated_macro_results(raw)

        raw = _raw()
        raw["macro_results"].append(copy.deepcopy(raw["macro_results"][0]))
        with self.assertRaisesRegex(RuntimeError, "not unique"):
            _validated_macro_results(raw)

    def test_rejects_false_schedule_time_and_result_ordering(self) -> None:
        raw = _raw(result=_result(status="MISSING"))
        raw["news"] = []
        raw["macro_results"][0]["schedule_event_fingerprint"] = "0" * 64
        _rehash(raw["macro_results"][0])
        with self.assertRaisesRegex(RuntimeError, "identity"):
            _validated_macro_results(raw)

        raw = _raw(result=_result(status="MISSING"))
        raw["news"] = []
        raw["macro_results"][0]["generated_at"] = (
            "2026-08-07T13:32:00+00:00"
        )
        with self.assertRaisesRegex(RuntimeError, "identity"):
            _validated_macro_results(raw)

        later = _result(status="MISSING")
        later["scheduled_at"] = "2026-08-07T06:00:00-07:00"
        later["schedule_event_fingerprint"] = _schedule_fingerprint(
            scheduled_at=later["scheduled_at"],
        )
        _rehash(later)
        earlier = _result(status="MISSING")
        raw = _raw(result=later)
        raw["news"] = []
        raw["macro_results"].append(earlier)
        with self.assertRaisesRegex(RuntimeError, "not ordered"):
            _validated_macro_results(raw)


if __name__ == "__main__":
    unittest.main()
