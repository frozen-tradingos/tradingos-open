from __future__ import annotations

import json
import math
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import UTC, date, datetime, timedelta
from email.utils import parsedate_to_datetime
from html import unescape
from typing import Any
from zoneinfo import ZoneInfo

from trading_os_v2.common.io import iso_now, sha256_json


ET_ZONE = ZoneInfo("America/New_York")
PT_ZONE = ZoneInfo("America/Los_Angeles")
USER_AGENT = "TradingOSV2-A1/0.1 owner-contact-local"
TRUSTED_DISCOVERY_SOURCES = {
    "Reuters",
    "Associated Press",
    "AP",
    "AP News",
    "Federal Reserve",
    "BLS",
    "BEA",
    "SEC",
    "Nasdaq",
    "CNBC",
    "Bloomberg",
    "The Wall Street Journal",
    "WSJ",
    "Fortune",
}
NEWS_SOURCE_ALIASES = {
    "AP": "Associated Press",
    "AP News": "Associated Press",
    "WSJ": "The Wall Street Journal",
}
MARKET_MOVING_EVENTS = (
    ("central_bank", "fomc_decision", ("fomc statement",), 6),
    (
        "central_bank",
        "rate_decision",
        (
            "federal funds rate",
            "interest rate decision",
            "monetary policy decision",
        ),
        6,
    ),
    ("central_bank", "emergency_lending", ("emergency lending",), 6),
    ("inflation", "cpi", ("consumer price index",), 6),
    ("inflation", "ppi", ("producer price index",), 6),
    ("inflation", "pce", ("pce price index",), 6),
    ("inflation", "inflation_report", ("inflation report",), 6),
    (
        "employment",
        "employment_report",
        (
            "employment situation",
            "nonfarm payroll",
            "unemployment rate",
        ),
        6,
    ),
    ("employment", "job_openings", ("job openings",), 6),
    (
        "growth",
        "gdp",
        ("gross domestic product", "gdp release"),
        6,
    ),
    ("growth", "personal_income", ("personal income and outlays",), 6),
    ("systemic_event", "market_halt", ("market-wide trading halt",), 30),
    ("systemic_event", "government_shutdown", ("government shutdown",), 30),
    ("systemic_event", "debt_ceiling", ("debt ceiling",), 30),
    ("systemic_event", "military_attack", ("military attack",), 30),
    ("systemic_event", "war_declaration", ("declares war",), 30),
    ("systemic_event", "banking_emergency", ("banking emergency",), 30),
)
SEMANTIC_MARKET_EVENTS = (
    {
        "category": "geopolitical_deescalation",
        "event_key": "iran_deescalation",
        "required_groups": (
            ("iran",),
            (
                "ceasefire",
                "truce",
                "peace hopes",
                "peace deal",
                "deal is near",
                "deal was near",
                "deal near",
                "diplomacy",
                "talks optimism",
                "hold off",
                "holds off",
                "held off",
                "calls off",
                "cancel",
                "halt",
                "pause",
            ),
        ),
        "excluded": (
            "no talks",
            "talks fail",
            "talks collapse",
            "rejects deal",
            "decapitation",
        ),
        "max_age_hours": 30,
    },
    {
        "category": "geopolitical_escalation",
        "event_key": "iran_escalation",
        "required_groups": (
            ("iran",),
            (
                "attack",
                "attacks",
                "attacked",
                "strike",
                "strikes",
                "struck",
                "war",
                "decapitation",
            ),
        ),
        "excluded": (
            "ceasefire",
            "truce",
            "peace hopes",
            "talks optimism",
            "hold off",
            "holds off",
            "held off",
            "calls off",
            "cancel",
            "halt",
            "pause",
        ),
        "max_age_hours": 30,
    },
    {
        "category": "energy",
        "event_key": "oil_down",
        "required_groups": (
            ("oil", "crude"),
            (
                "drop",
                "drops",
                "dropped",
                "fall",
                "falls",
                "falling",
                "fell",
                "fallen",
                "slide",
                "slides",
                "sliding",
                "slid",
                "plunge",
                "plunges",
                "plunged",
                "lower",
                "lowers",
                "lowered",
                "weaken",
                "weakens",
                "weakened",
            ),
        ),
        "excluded": (),
        "max_age_hours": 30,
    },
    {
        "category": "energy",
        "event_key": "oil_up",
        "required_groups": (
            ("oil", "crude"),
            (
                "surge",
                "surges",
                "surged",
                "jump",
                "jumps",
                "jumped",
                "rise",
                "rises",
                "rising",
                "rose",
                "rally",
                "rallies",
                "rallied",
                "higher",
                "spike",
                "spikes",
                "spiked",
            ),
        ),
        "excluded": (),
        "max_age_hours": 30,
    },
)
ENERGY_CATALYST_IDENTITIES = (
    (
        "supply_policy",
        (
            "opec",
            "production cut",
            "production cuts",
            "supply cut",
            "supply cuts",
            "supply reduction",
            "output cut",
            "output cuts",
        ),
    ),
    (
        "inventory",
        (
            "inventory",
            "inventories",
            "stockpile",
            "stockpiles",
            "crude stocks",
        ),
    ),
    (
        "geopolitical_supply",
        (
            "iran",
            "middle east",
            "hormuz",
            "sanction",
            "sanctions",
            "military attack",
        ),
    ),
    (
        "demand",
        (
            "oil demand",
            "crude demand",
            "demand outlook",
        ),
    ),
)
GEOPOLITICAL_DEESCALATION_COUNTERPARTS = (
    ("iran_israel", ("israel", "israeli")),
    (
        "us_iran",
        (
            "us",
            "u.s.",
            "united states",
            "american",
            "washington",
            "trump",
        ),
    ),
)
GEOPOLITICAL_DEESCALATION_INCIDENTS = (
    ("ceasefire", ("ceasefire", "truce")),
    ("nuclear_talks", ("nuclear talks", "nuclear deal")),
    (
        "diplomatic_deal",
        (
            "peace hopes",
            "peace deal",
            "deal is near",
            "deal was near",
            "deal near",
            "quick deal",
            "diplomacy",
            "talks optimism",
        ),
    ),
    (
        "military_pause",
        (
            "hold off",
            "holds off",
            "held off",
            "calls off",
            "cancel",
            "halt",
            "pause",
        ),
    ),
)
GEOPOLITICAL_ESCALATION_COUNTERPARTS = (
    (
        "us_forces",
        (
            "us base",
            "u.s. base",
            "american base",
            "us forces",
            "u.s. forces",
            "american forces",
        ),
    ),
    ("israel", ("israel", "israeli")),
    ("shipping", ("ship", "shipping", "tanker", "hormuz")),
)
GEOPOLITICAL_ESCALATION_DESCRIPTORS = (
    ("nuclear_site", ("nuclear site", "nuclear facility")),
)
GEOPOLITICAL_ESCALATION_QUALIFIERS = (
    ("iraq", ("iraq", "iraqi")),
    ("syria", ("syria", "syrian")),
    ("qatar", ("qatar", "qatari")),
    ("bahrain", ("bahrain", "bahraini")),
    ("jordan", ("jordan", "jordanian")),
    ("lebanon", ("lebanon", "lebanese")),
    ("yemen", ("yemen", "yemeni")),
    ("saudi_arabia", ("saudi arabia", "saudi")),
    ("uae", ("uae", "u.a.e.", "united arab emirates")),
    ("tehran", ("tehran",)),
    ("dimona", ("dimona",)),
    ("soreq", ("soreq",)),
    ("hormuz", ("hormuz",)),
    ("red_sea", ("red sea",)),
    ("persian_gulf", ("persian gulf",)),
    ("gulf_of_oman", ("gulf of oman",)),
)
SYSTEMIC_EVENT_IDENTITIES = (
    ("us", ("united states", "u.s.", "us", "american", "wall street")),
    ("ukraine", ("ukraine", "ukrainian")),
    ("kyiv", ("kyiv", "kiev")),
    ("odesa", ("odesa", "odessa")),
    ("kharkiv", ("kharkiv",)),
    ("lviv", ("lviv",)),
    ("russia", ("russia", "russian")),
    ("taiwan", ("taiwan", "taiwanese")),
    ("china", ("china", "chinese")),
    ("israel", ("israel", "israeli")),
    ("tel_aviv", ("tel aviv",)),
    ("haifa", ("haifa",)),
    ("iran", ("iran", "iranian")),
    ("nyse", ("nyse", "new york stock exchange")),
    ("nasdaq", ("nasdaq",)),
)
SYSTEMIC_ATTACK_SITES = frozenset(
    {"kyiv", "odesa", "kharkiv", "lviv", "tel_aviv", "haifa"}
)
INVERSE_EVENT_PATTERNS = {
    "iran_deescalation": (
        re.compile(
            r"\b(?:peace|deal|ceasefire|truce|talks|hopes|optimism)"
            r"(?:\s+\w+){0,3}\s+"
            r"(?:fade(?:s|d|ing)?|collapse(?:s|d|ing)?|"
            r"fail(?:s|ed|ing)?|stall(?:s|ed|ing)?|"
            r"end(?:s|ed|ing)?|break(?:s|ing)?)\b"
        ),
        re.compile(
            r"\b(?:no|not|without|rejects?|rejected)\s+"
            r"(?:peace|deal|ceasefire|truce|talks|diplomacy)\b"
        ),
        re.compile(
            r"\b(?:peace(?:\s+(?:hopes?|deal))?|deal|ceasefire|truce|talks|"
            r"diplomacy|optimism)(?:\s+\w+){0,4}\s+"
            r"(?:unlikely|impossible|doubtful|dead|denied|dismissed|rejected|"
            r"ruled\s+out|off\s+the\s+table)\b"
        ),
        re.compile(
            r"\b(?:peace(?:\s+(?:hopes?|deal))?|deal|ceasefire|truce|talks|"
            r"diplomacy)(?:\s+\w+){0,3}\s+not\s+"
            r"(?:expected|likely|possible|anticipated|seen)\b"
        ),
        re.compile(
            r"\b(?:rules?|ruled|ruling)\s+out(?:\s+\w+){0,3}\s+"
            r"(?:peace|deal|ceasefire|truce|talks)\b"
        ),
        re.compile(
            r"\b(?:violat(?:e|es|ed|ing)|breach(?:es|ed|ing)?|"
            r"breaks?|broke|broken)(?:\s+\w+){0,2}\s+"
            r"(?:ceasefire|truce)\b"
        ),
        re.compile(
            r"\b(?:ceasefire|truce)(?:\s+\w+){0,3}\s+"
            r"(?:violat(?:e|es|ed|ing)|breach(?:es|ed|ing)?|"
            r"breaks?|broke|broken)\b"
        ),
        re.compile(
            r"\b(?:consider(?:s|ed|ing)?|may|might|could|propos(?:e|es|ed|ing))"
            r"(?:\s+\w+){0,4}\s+"
            r"(?:peace|deal|ceasefire|truce)\b"
        ),
    ),
    "iran_escalation": (
        re.compile(
            r"\b(?:war|attack|strike|conflict|tensions?|risks?|fears?)"
            r"(?:\s+\w+){0,3}\s+"
            r"(?:ease(?:s|d|ing)?|fade(?:s|d|ing)?|"
            r"recede(?:s|d|ing)?|averted|called\s+off)\b"
        ),
        re.compile(r"\b(?:avoids?|avoided)\s+(?:war|attack|conflict)\b"),
    ),
}
BLS_SERIES = {
    "CUSR0000SA0": "CPI",
    "LNS14000000": "Unemployment rate",
    "CES0000000001": "Total nonfarm payrolls",
}
BLS_RELEASE_CALENDAR_URL = (
    "https://www.bls.gov/schedule/news_release/bls.ics"
)
BLS_RELEASE_CALENDAR_MAX_BYTES = 1_048_576
BLS_RELEASE_CALENDAR_MAX_EVENTS = 2_048
BLS_MACRO_RELEASES = (
    ("Employment Situation", "employment"),
    ("Job Openings and Labor Turnover Survey", "employment"),
    ("Consumer Price Index", "inflation"),
    ("Producer Price Index", "inflation"),
)
BLS_MACRO_RESULT_METRICS = {
    "Employment Situation": (
        ("Payroll Employment", "PAYROLL_EMPLOYMENT_CHANGE", "JOBS"),
        ("Unemployment Rate", "UNEMPLOYMENT_RATE", "PERCENT"),
        (
            "Average Hourly Earnings",
            "AVERAGE_HOURLY_EARNINGS_CHANGE",
            "USD",
        ),
    ),
    "Job Openings and Labor Turnover Survey": (
        ("Job Openings", "JOB_OPENINGS", "JOBS"),
    ),
    "Consumer Price Index": (
        (
            "Consumer Price Index (CPI)",
            "CONSUMER_PRICE_INDEX_CHANGE",
            "PERCENT",
        ),
    ),
    "Producer Price Index": (
        (
            "Producer Price Index - Final Demand",
            "PRODUCER_PRICE_INDEX_FINAL_DEMAND_CHANGE",
            "PERCENT",
        ),
    ),
}
BLS_MACRO_RESULT_URLS = {
    "Employment Situation": (
        "https://www.bls.gov/news.release/empsit.toc.htm"
    ),
    "Job Openings and Labor Turnover Survey": (
        "https://www.bls.gov/news.release/jolts.toc.htm"
    ),
    "Consumer Price Index": "https://www.bls.gov/news.release/cpi.toc.htm",
    "Producer Price Index": "https://www.bls.gov/news.release/ppi.toc.htm",
}
BLS_MONTHS = {
    month: index
    for index, month in enumerate(
        (
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December",
        ),
        start=1,
    )
}
NEWS_SOURCE_QUOTAS = (15, 10, 5)
GOOGLE_NEWS_QUERIES = (
    (
        "(SPY OR QQQ OR Nasdaq OR \"Wall Street\" OR \"stock futures\" OR "
        "Federal Reserve OR CPI OR jobs) when:1d"
    ),
    (
        "(SPY OR QQQ OR Nasdaq OR \"Wall Street\" OR \"stock futures\") "
        "(Iran OR oil OR crude OR tariffs OR earnings OR Nvidia OR Microsoft "
        "OR Apple OR Amazon OR Meta OR Alphabet) when:2d"
    ),
)


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _safe_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class ProviderError(RuntimeError):
    pass


class HttpClient:
    def json(
        self,
        base_url: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        label: str,
        timeout: int = 20,
    ) -> Any:
        query = urllib.parse.urlencode(params or {}, doseq=True)
        url = f"{base_url.rstrip('/')}/{path.lstrip('/')}"
        if query:
            url = f"{url}?{query}"
        request = urllib.request.Request(
            url,
            headers={"User-Agent": USER_AGENT, **(headers or {})},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise ProviderError(f"{label}: HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise ProviderError(f"{label}: {type(exc).__name__}") from exc

    def text(
        self,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        label: str,
        timeout: int = 20,
        max_bytes: int | None = None,
    ) -> str:
        query = urllib.parse.urlencode(params or {}, doseq=True)
        target = f"{url}?{query}" if query else url
        request = urllib.request.Request(
            target,
            headers={"User-Agent": USER_AGENT, **(headers or {})},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                if max_bytes is None:
                    payload = response.read()
                else:
                    payload = response.read(max_bytes + 1)
                    if len(payload) > max_bytes:
                        raise ProviderError(f"{label}: response too large")
                return payload.decode("utf-8")
        except urllib.error.HTTPError as exc:
            raise ProviderError(f"{label}: HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, UnicodeDecodeError) as exc:
            raise ProviderError(f"{label}: {type(exc).__name__}") from exc

    def post_json(
        self,
        url: str,
        payload: dict[str, Any],
        *,
        label: str,
        timeout: int = 20,
    ) -> Any:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "User-Agent": USER_AGENT,
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise ProviderError(f"{label}: HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise ProviderError(f"{label}: {type(exc).__name__}") from exc


class A1Collector:
    def __init__(self, config: dict[str, Any], client: HttpClient | None = None):
        self.config = config
        self.client = client or HttpClient()
        self.errors: list[str] = []

    def _tradier(self, path: str, params: dict[str, Any], label: str) -> Any:
        provider = self.config["providers"]["tradier"]
        token = os.environ.get(provider["token_env"])
        if not token:
            raise ProviderError("Tradier: credential missing")
        return self.client.json(
            provider["base_url"],
            path,
            params=params,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
            label=label,
        )

    def collect_position_quotes(self, option_symbols: list[str]) -> dict[str, Any]:
        """Fetch only the clock and one batch of quotes for open positions."""
        symbols = sorted(set(option_symbols))
        clock = self._tradier("/markets/clock", {}, "Tradier clock").get("clock", {})
        quotes: list[dict[str, Any]] = []
        if symbols:
            payload = self._tradier(
                "/markets/quotes",
                {"symbols": ",".join(symbols), "greeks": "false"},
                "Tradier position quotes",
            )
            quotes = _as_list(payload.get("quotes", {}).get("quote"))
        return {
            "collected_at": iso_now(),
            "clock": clock,
            "quotes": quotes,
        }

    def _collect_tradier(self) -> dict[str, Any]:
        symbols = self.config["system"]["symbols"]
        now_et = datetime.now(ET_ZONE)
        market_day = now_et.date()
        start_daily = market_day - timedelta(days=100)
        start_intraday = datetime.combine(
            market_day, datetime.strptime("09:30", "%H:%M").time(), ET_ZONE
        )
        end_intraday = datetime.combine(
            market_day, datetime.strptime("16:00", "%H:%M").time(), ET_ZONE
        )

        clock = self._tradier("/markets/clock", {}, "Tradier clock").get("clock", {})
        quote_payload = self._tradier(
            "/markets/quotes",
            {"symbols": ",".join(symbols), "greeks": "false"},
            "Tradier quotes",
        )
        quotes = _as_list(quote_payload.get("quotes", {}).get("quote"))

        history: dict[str, list[dict[str, Any]]] = {}
        timesales: dict[str, list[dict[str, Any]]] = {}
        options: dict[str, dict[str, Any]] = {}
        for symbol in symbols:
            try:
                payload = self._tradier(
                    "/markets/history",
                    {
                        "symbol": symbol,
                        "interval": "daily",
                        "start": start_daily.isoformat(),
                        "end": market_day.isoformat(),
                    },
                    f"Tradier {symbol} history",
                )
                history[symbol] = _as_list(payload.get("history", {}).get("day"))
            except ProviderError as exc:
                self.errors.append(str(exc))
                history[symbol] = []

            try:
                payload = self._tradier(
                    "/markets/timesales",
                    {
                        "symbol": symbol,
                        "interval": "5min",
                        "start": start_intraday.strftime("%Y-%m-%d %H:%M"),
                        "end": end_intraday.strftime("%Y-%m-%d %H:%M"),
                        "session_filter": "all",
                    },
                    f"Tradier {symbol} timesales",
                )
                timesales[symbol] = _as_list(payload.get("series", {}).get("data"))
            except ProviderError as exc:
                self.errors.append(str(exc))
                timesales[symbol] = []

            expirations_payload = self._tradier(
                "/markets/options/expirations",
                {"symbol": symbol, "includeAllRoots": "true", "strikes": "false"},
                f"Tradier {symbol} expirations",
            )
            expiration_values = _as_list(
                expirations_payload.get("expirations", {}).get("date")
            )
            rules = self.config["trading_rules"]
            expirations = [
                value
                for value in expiration_values
                if (dte := _dte(value, market_day)) is not None
                and rules["dte_min"] <= dte <= rules["dte_max"]
            ]
            chains: dict[str, list[dict[str, Any]]] = {}
            for expiration in expirations:
                try:
                    payload = self._tradier(
                        "/markets/options/chains",
                        {
                            "symbol": symbol,
                            "expiration": expiration,
                            "greeks": "true",
                        },
                        f"Tradier {symbol} chain {expiration}",
                    )
                    chains[expiration] = _as_list(
                        payload.get("options", {}).get("option")
                    )
                except ProviderError as exc:
                    self.errors.append(str(exc))
                    chains[expiration] = []
            options[symbol] = {"expirations": expirations, "chains": chains}

        return {
            "clock": clock,
            "quotes": quotes,
            "history": history,
            "timesales": timesales,
            "options": options,
        }

    def _collect_finnhub(self) -> dict[str, Any]:
        provider = self.config["providers"]["finnhub"]
        token = os.environ.get(provider["token_env"])
        if not token:
            return {
                "status": "MISSING_CREDENTIAL",
                "items": [],
                "earnings": [],
                "earnings_status": "MISSING_CREDENTIAL",
                "error": "",
                "earnings_error": "",
            }
        news_error = ""
        earnings_error = ""
        try:
            items = self.client.json(
                provider["base_url"],
                "/news",
                params={"category": "general", "minId": 0, "token": token},
                label="Finnhub market news",
            )
            if not isinstance(items, list):
                raise ProviderError("Finnhub market news: invalid response")
            normalized = []
            for item in items[:50]:
                if not isinstance(item, dict):
                    raise ProviderError(
                        "Finnhub market news: invalid item"
                    )
                candidate = {
                    "id": str(item.get("id", "")),
                    "headline": str(item.get("headline", "")).strip(),
                    "summary": str(item.get("summary", "")).strip(),
                    "source": str(item.get("source", "")).strip(),
                    "published_at": _epoch_to_iso(item.get("datetime")),
                    "url": str(item.get("url", "")).strip(),
                    "provider": "Finnhub",
                    "confidence": "primary_aggregator",
                }
                if not all(
                    candidate[field]
                    for field in ("headline", "source", "published_at")
                ):
                    raise ProviderError(
                        "Finnhub market news: incomplete item"
                    )
                normalized.append(candidate)
        except ProviderError as exc:
            normalized = []
            news_error = str(exc)
            self.errors.append(news_error)

        market_day = datetime.now(PT_ZONE).date()
        try:
            calendar = self.client.json(
                provider["base_url"],
                "/calendar/earnings",
                params={
                    "from": market_day.isoformat(),
                    "to": (market_day + timedelta(days=6)).isoformat(),
                    "international": "false",
                    "token": token,
                },
                label="Finnhub earnings calendar",
            )
            if (
                not isinstance(calendar, dict)
                or "error" in calendar
                or set(calendar).isdisjoint({"earningsCalendar"})
                or not isinstance(calendar.get("earningsCalendar"), list)
            ):
                raise ProviderError(
                    "Finnhub earnings calendar: invalid response"
                )
            calendar_rows = calendar["earningsCalendar"]
            if any(
                not isinstance(row, dict)
                or not isinstance(row.get("symbol"), str)
                or not row["symbol"].strip()
                or not isinstance(row.get("date"), str)
                or _dte(row["date"], market_day) is None
                or not 0 <= int(_dte(row["date"], market_day)) <= 6
                for row in calendar_rows
            ):
                raise ProviderError(
                    "Finnhub earnings calendar: invalid item"
                )
            earnings = _normalize_earnings(
                calendar_rows
            )
            earnings_status = "HEALTHY"
        except ProviderError as exc:
            earnings = []
            earnings_status = "FAILED"
            earnings_error = str(exc)
            self.errors.append(earnings_error)

        return {
            "status": "HEALTHY" if not news_error else "FAILED",
            "items": normalized,
            "earnings": earnings,
            "earnings_status": earnings_status,
            "error": news_error,
            "earnings_error": earnings_error,
        }

    def _collect_google_news(self) -> dict[str, Any]:
        provider = self.config["providers"]["google_news_rss"]
        try:
            items = []
            seen: set[str] = set()
            for index, query in enumerate(GOOGLE_NEWS_QUERIES, start=1):
                text = self.client.text(
                    provider["url"],
                    params={
                        "q": query,
                        "hl": "en-US",
                        "gl": "US",
                        "ceid": "US:en",
                    },
                    label=f"Google News RSS {index}",
                )
                root = ET.fromstring(text)
                for item in root.findall("./channel/item")[:40]:
                    source_node = item.find("source")
                    source = (
                        source_node.text.strip()
                        if source_node is not None and source_node.text
                        else ""
                    )
                    pub_date = item.findtext("pubDate", "")
                    normalized = {
                        "id": (
                            item.findtext("guid", "")
                            or item.findtext("link", "")
                        ),
                        "headline": item.findtext("title", "").strip(),
                        "summary": "",
                        "source": source,
                        "published_at": _rfc822_to_iso(pub_date),
                        "url": item.findtext("link", "").strip(),
                        "provider": "Google News RSS",
                        "confidence": (
                            "cross_check_candidate"
                            if source in TRUSTED_DISCOVERY_SOURCES
                            else "discovery_only"
                        ),
                    }
                    keys = _news_keys(normalized)
                    if keys & seen:
                        continue
                    items.append(normalized)
                    seen.update(keys)
            return {"status": "HEALTHY", "items": items, "error": ""}
        except (ProviderError, ET.ParseError) as exc:
            message = (
                str(exc)
                if isinstance(exc, ProviderError)
                else "Google News RSS: XML parse failed"
            )
            self.errors.append(message)
            return {"status": "FAILED", "items": [], "error": message}

    def _collect_bls_data(self) -> list[dict[str, Any]]:
        year = datetime.now(ET_ZONE).year
        payload = self.client.post_json(
            "https://api.bls.gov/publicAPI/v2/timeseries/data/",
            {
                "seriesid": list(BLS_SERIES),
                "startyear": str(year - 1),
                "endyear": str(year),
            },
            label="BLS public data fallback",
        )
        if payload.get("status") != "REQUEST_SUCCEEDED":
            raise ProviderError("BLS public data fallback: request failed")
        series = _as_list(payload.get("Results", {}).get("series"))
        items = []
        for row in series:
            points = _as_list(row.get("data"))
            if not points:
                continue
            point = points[0]
            series_id = str(row.get("seriesID", ""))
            items.append(
                {
                    "id": f"bls-data:{series_id}:{point.get('year', '')}:"
                    f"{point.get('period', '')}",
                    "headline": (
                        f"BLS official data snapshot: "
                        f"{BLS_SERIES.get(series_id, series_id)} "
                        f"{point.get('value', '')}"
                    ),
                    "summary": "RSS unavailable; official API snapshot only.",
                    "source": "BLS",
                    "published_at": "",
                    "url": "https://api.bls.gov/publicAPI/v2/timeseries/data/",
                    "provider": "BLS Public Data API",
                    "confidence": "official_data_snapshot",
                }
            )
        if not items:
            raise ProviderError("BLS public data fallback: no data")
        return items

    def _collect_bls_macro_calendar(
        self,
        *,
        generated_at: str,
    ) -> dict[str, Any]:
        watch, _due_events = self._collect_bls_macro_calendar_snapshot(
            generated_at=generated_at,
        )
        return watch

    def _collect_bls_macro_calendar_snapshot(
        self,
        *,
        generated_at: str,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        try:
            text = self.client.text(
                BLS_RELEASE_CALENDAR_URL,
                headers={"Accept": "text/calendar"},
                label="BLS release calendar",
                max_bytes=BLS_RELEASE_CALENDAR_MAX_BYTES,
            )
            events, due_events = _bls_macro_calendar_projections(
                text,
                generated_at=generated_at,
            )
        except (ProviderError, ValueError):
            return (
                _macro_watch(
                    generated_at=generated_at,
                    status="DEGRADED",
                    events=[],
                ),
                [],
            )
        return (
            _macro_watch(
                generated_at=generated_at,
                status="HEALTHY",
                events=events,
            ),
            due_events,
        )

    def _collect_official_news(self) -> dict[str, Any]:
        items: list[dict[str, Any]] = []
        feed_statuses: list[dict[str, Any]] = []
        for feed in self.config["providers"]["official_news_feeds"]:
            name = feed["name"]
            fallback_used = False
            try:
                text = self.client.text(
                    feed["url"],
                    headers={
                        "Accept": (
                            "application/rss+xml, application/atom+xml, "
                            "application/xml, text/xml;q=0.9"
                        )
                    },
                    label=f"{name} official feed",
                )
                feed_items = _parse_official_feed(text, name)[:15]
            except (ProviderError, ET.ParseError) as exc:
                message = (
                    str(exc)
                    if isinstance(exc, ProviderError)
                    else f"{name} official feed: XML parse failed"
                )
                feed_items = []
                if name == "BLS":
                    try:
                        feed_items = self._collect_bls_data()
                        fallback_used = True
                    except ProviderError:
                        pass
                if not feed_items:
                    self.errors.append(message)
                    feed_statuses.append(
                        {
                            "name": name,
                            "status": "FAILED",
                            "item_count": 0,
                            "error": message,
                            "fallback_used": False,
                        }
                    )
                    continue
                self.errors.append(message)
            items.extend(feed_items)
            feed_statuses.append(
                {
                    "name": name,
                    "status": "DEGRADED" if fallback_used else "HEALTHY",
                    "item_count": len(feed_items),
                    "error": message if fallback_used else "",
                    "fallback_used": fallback_used,
                }
            )
        healthy_count = sum(
            feed["status"] == "HEALTHY" for feed in feed_statuses
        )
        status = (
            "HEALTHY"
            if healthy_count >= 2
            else "DEGRADED"
            if healthy_count == 1
            else "FAILED"
        )
        return {
            "status": status,
            "healthy_feed_count": healthy_count,
            "feeds": feed_statuses,
            "items": items,
        }

    def collect(self) -> dict[str, Any]:
        self.errors = []
        collected_at = iso_now()
        tradier_status = "HEALTHY"
        try:
            tradier = self._collect_tradier()
        except ProviderError as exc:
            tradier_status = "FAILED"
            self.errors.append(str(exc))
            tradier = {
                "clock": {},
                "quotes": [],
                "history": {},
                "timesales": {},
                "options": {},
            }

        finnhub = self._collect_finnhub()
        official = self._collect_official_news()
        google = self._collect_google_news()
        macro_watch, due_macro_events = (
            self._collect_bls_macro_calendar_snapshot(
                generated_at=collected_at,
            )
        )
        macro_results = _macro_results(
            due_macro_events,
            official_items=official["items"],
            official_status=_bls_official_feed_status(official),
            calendar_status=macro_watch["status"],
            generated_at=collected_at,
        )
        reliable_official_news = (
            official["healthy_feed_count"] >= 2 and bool(official["items"])
        )
        reliable_news_available = bool(finnhub["items"]) or reliable_official_news
        combined_news = _merge_news(
            official["items"],
            finnhub["items"],
            google["items"],
            limit=(
                len(official["items"])
                + len(finnhub["items"])
                + len(google["items"])
            ),
        )
        material_news = _market_moving_news(combined_news)

        if tradier_status == "FAILED":
            state = "BLOCKED"
        elif not reliable_news_available:
            state = "DEGRADED_NO_TRADE"
        elif finnhub["status"] != "HEALTHY":
            state = "DEGRADED"
        elif self.errors:
            state = "DEGRADED"
        else:
            state = "HEALTHY"

        result = {
            "contract_version": self.config["contract_version"],
            "collected_at": collected_at,
            "timezone": self.config["system"]["timezone"],
            "health": {
                "state": state,
                "errors": self.errors,
                "reliable_broad_market_news_available": reliable_news_available,
                "verified_market_moving_news": material_news["verified"],
                "market_moving_news_evidence": material_news["evidence"],
            },
            "providers": {
                "tradier": {"status": tradier_status},
                "finnhub": {
                    "status": finnhub["status"],
                    "error": finnhub["error"],
                    "earnings_status": finnhub["earnings_status"],
                    "earnings_error": finnhub["earnings_error"],
                },
                "google_news_rss": {
                    "status": google["status"],
                    "error": google["error"],
                },
                "official_news": {
                    "status": official["status"],
                    "healthy_feed_count": official["healthy_feed_count"],
                    "feeds": official["feeds"],
                },
                "macro_calendar": {
                    "status": macro_watch["status"],
                    "source": "BLS Official Release Calendar",
                },
            },
            "market": {
                "clock": tradier["clock"],
                "quotes": tradier["quotes"],
                "history": tradier["history"],
                "timesales": tradier["timesales"],
            },
            "options": tradier["options"],
            "earnings": finnhub["earnings"],
            "earnings_watch": _earnings_watch(
                finnhub["earnings"],
                source_status=finnhub["earnings_status"],
                generated_at=collected_at,
            ),
            "macro_watch": macro_watch,
            "macro_results": macro_results,
            "news": combined_news,
            "positions": [],
        }
        result["information_archive"] = _information_archive(result)
        return result


def _dte(value: str, market_day: date) -> int | None:
    try:
        return (date.fromisoformat(value) - market_day).days
    except (TypeError, ValueError):
        return None


def _normalize_earnings(
    rows: list[dict[str, Any]],
    *,
    limit: int = 20,
) -> list[dict[str, Any]]:
    ranked = sorted(
        (
            row
            for row in rows
            if row.get("symbol") and row.get("date")
        ),
        key=lambda row: abs(_safe_float(row.get("revenueEstimate")) or 0),
        reverse=True,
    )
    return [
        {
            "event_type": "earnings",
            "symbol": str(row.get("symbol", "")),
            "date": str(row.get("date", "")),
            "session": str(row.get("hour", "")),
            "eps_estimate": _safe_float(row.get("epsEstimate")),
            "revenue_estimate": _safe_float(row.get("revenueEstimate")),
            "source": "Finnhub Earnings Calendar",
            "confidence": "scheduled_event",
        }
        for row in ranked[:limit]
    ]


def _earnings_watch(
    earnings: list[dict[str, Any]],
    *,
    source_status: str,
    generated_at: str,
) -> dict[str, Any]:
    generated = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    if generated.tzinfo is None:
        raise ValueError("A1 earnings watch generated_at must be timezone-aware")
    start = generated.astimezone(PT_ZONE).date()
    events = []
    if source_status == "HEALTHY":
        for rank, item in enumerate(earnings[:20], start=1):
            symbol = str(item.get("symbol", "")).strip().upper()
            event_date = str(item.get("date", "")).strip()
            session = _earnings_watch_session(item.get("session"))
            date.fromisoformat(event_date)
            event_identity = {
                "contract_version": "v1",
                "component": "A1_EARNINGS_WATCH",
                "symbol": symbol,
                "date": event_date,
                "session": session,
            }
            events.append(
                {
                    "event_id": sha256_json(event_identity),
                    "symbol": symbol,
                    "date": event_date,
                    "session": session,
                    "eps_estimate": item.get("eps_estimate"),
                    "revenue_estimate": item.get("revenue_estimate"),
                    "importance_rank": rank,
                    "market_impact_status": "UNVERIFIED_CANDIDATE",
                    "source": "Finnhub Earnings Calendar",
                    "confidence": "scheduled_event",
                }
            )
    return {
        "contract_version": "v1",
        "component": "A1_EARNINGS_WATCH",
        "actionable": False,
        "status": "HEALTHY" if source_status == "HEALTHY" else "DEGRADED",
        "generated_at": generated_at,
        "timezone": "America/Los_Angeles",
        "window_start": start.isoformat(),
        "window_end": (start + timedelta(days=6)).isoformat(),
        "selection_rule": "TOP_20_ABSOLUTE_REVENUE_ESTIMATE",
        "events": events,
    }


def _earnings_watch_session(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"bmo", "before market open", "before_market_open"}:
        return "BMO"
    if normalized in {"amc", "after market close", "after_market_close"}:
        return "AMC"
    return "UNKNOWN"


def _macro_watch(
    *,
    generated_at: str,
    status: str,
    events: list[dict[str, Any]],
) -> dict[str, Any]:
    generated = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    if generated.tzinfo is None:
        raise ValueError("A1 macro watch generated_at must be timezone-aware")
    start = generated.astimezone(PT_ZONE).date()
    return {
        "contract_version": "v1",
        "component": "A1_MACRO_WATCH",
        "actionable": False,
        "status": status,
        "generated_at": generated_at,
        "timezone": "America/Los_Angeles",
        "window_start": start.isoformat(),
        "window_end": (start + timedelta(days=6)).isoformat(),
        "selection_rule": "BLS_MARKET_MOVING_RELEASES_NEXT_7_CALENDAR_DAYS",
        "events": events,
    }


def _bls_official_feed_status(official: dict[str, Any]) -> str:
    feeds = official.get("feeds", [])
    if not isinstance(feeds, list):
        return "DEGRADED"
    for feed in feeds:
        if not isinstance(feed, dict) or feed.get("name") != "BLS":
            continue
        if (
            feed.get("status") == "HEALTHY"
            and feed.get("fallback_used") is False
        ):
            return "HEALTHY"
        return "DEGRADED"
    return "DEGRADED"


def _macro_results(
    due_events: list[dict[str, Any]],
    *,
    official_items: list[dict[str, Any]],
    official_status: str,
    calendar_status: str,
    generated_at: str,
) -> list[dict[str, Any]]:
    generated = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    if generated.tzinfo is None:
        raise ValueError("A1 macro result generated_at must be timezone-aware")
    expected_fingerprints = [
        event["schedule"]["event_fingerprint"] for event in due_events
    ]
    if len(expected_fingerprints) != len(set(expected_fingerprints)):
        raise ValueError("A1 macro result due fingerprints must be unique")
    results = [
        _macro_result(
            due_event,
            official_items=official_items,
            official_status=official_status,
            calendar_status=calendar_status,
            generated=generated,
            generated_at=generated_at,
        )
        for due_event in due_events
    ]
    result_fingerprints = [
        result["schedule_event_fingerprint"] for result in results
    ]
    if (
        len(result_fingerprints) != len(set(result_fingerprints))
        or sorted(result_fingerprints) != sorted(expected_fingerprints)
    ):
        raise ValueError("A1 macro results do not match due fingerprints")
    return sorted(
        results,
        key=lambda item: (item["scheduled_at"], item["release_name"]),
    )


def _macro_result(
    due_event: dict[str, Any],
    *,
    official_items: list[dict[str, Any]],
    official_status: str,
    calendar_status: str,
    generated: datetime,
    generated_at: str,
) -> dict[str, Any]:
    schedule = due_event["schedule"]
    scheduled = datetime.fromisoformat(
        str(schedule["scheduled_at"]).replace("Z", "+00:00")
    )
    if scheduled.tzinfo is None or scheduled > generated:
        raise ValueError("A1 macro result schedule is invalid")
    status = "MISSING"
    match: tuple[dict[str, Any], datetime, list[dict[str, Any]]] | None = None
    if calendar_status != "HEALTHY" or official_status != "HEALTHY":
        status = "DEGRADED"
    else:
        match = _matching_bls_macro_result(
            schedule,
            expected_period=str(due_event.get("expected_period", "")),
            official_items=official_items,
            generated=generated,
        )
        if match is not None:
            status = "VERIFIED"

    result: dict[str, Any] = {
        "contract_version": "v1",
        "component": "A1_MACRO_RESULT",
        "actionable": False,
        "status": status,
        "generated_at": generated_at,
        "timezone": "America/Los_Angeles",
        "market_date": scheduled.astimezone(PT_ZONE).date().isoformat(),
        "selection_rule": (
            "BLS_OFFICIAL_MARKET_MOVING_RESULTS_CURRENT_MARKET_DATE"
        ),
        "schedule_event_fingerprint": schedule["event_fingerprint"],
        "category": schedule["category"],
        "release_name": schedule["release_name"],
        "scheduled_at": schedule["scheduled_at"],
        "published_at": None,
        "source": None,
        "source_url": None,
        "raw_item_hash": None,
        "confidence": None,
        "metrics": [],
    }
    if match is not None:
        item, published, metrics = match
        result.update(
            {
                "published_at": published.isoformat(),
                "source": "BLS",
                "source_url": BLS_MACRO_RESULT_URLS[schedule["release_name"]],
                "raw_item_hash": _canonical_official_raw_item_hash(item),
                "confidence": "official_result",
                "metrics": metrics,
            }
        )
    hash_payload = {
        key: value
        for key, value in result.items()
        if key != "generated_at"
    }
    return {**result, "result_hash": sha256_json(hash_payload)}


def _matching_bls_macro_result(
    schedule: dict[str, Any],
    *,
    expected_period: str,
    official_items: list[dict[str, Any]],
    generated: datetime,
) -> tuple[dict[str, Any], datetime, list[dict[str, Any]]] | None:
    if not expected_period:
        return None
    scheduled = datetime.fromisoformat(
        str(schedule["scheduled_at"]).replace("Z", "+00:00")
    ).astimezone(UTC)
    candidates: list[
        tuple[datetime, str, dict[str, Any], list[dict[str, Any]]]
    ] = []
    for item in official_items:
        if (
            not isinstance(item, dict)
            or item.get("source") != "BLS"
            or item.get("provider") != "BLS official"
            or item.get("confidence") != "official"
            or not str(item.get("url", "")).startswith(
                "https://www.bls.gov/"
            )
        ):
            continue
        published = _parse_iso(item.get("published_at", ""))
        if (
            published is None
            or published < scheduled
            or published > generated.astimezone(UTC)
        ):
            continue
        metrics = _bls_release_metrics(
            str(item.get("summary", "")),
            release_name=str(schedule["release_name"]),
            expected_period=expected_period,
        )
        if metrics is None:
            continue
        candidates.append(
            (
                published,
                _canonical_official_raw_item_hash(item),
                item,
                metrics,
            )
        )
    if not candidates:
        return None
    published, _raw_hash, item, metrics = min(
        candidates,
        key=lambda candidate: (candidate[0], candidate[1]),
    )
    return item, published, metrics


def _canonical_official_raw_item_hash(item: dict[str, Any]) -> str:
    payload = {
        field: _canonical_whitespace(item.get(field, ""))
        for field in (
            "id",
            "headline",
            "summary",
            "source",
            "published_at",
            "url",
            "provider",
            "confidence",
        )
    }
    payload["summary"] = re.sub(
        r"\s+",
        "",
        str(item.get("summary", "")),
    )
    return sha256_json(payload)


def _canonical_whitespace(value: Any) -> str:
    return " ".join(str(value or "").split())


def _bls_release_metrics(
    summary: str,
    *,
    release_name: str,
    expected_period: str,
) -> list[dict[str, Any]] | None:
    expected = BLS_MACRO_RESULT_METRICS.get(release_name)
    source_url = BLS_MACRO_RESULT_URLS.get(release_name)
    if not expected or not source_url or not summary:
        return None
    rows: dict[str, str] = {}
    paragraphs = re.findall(
        r"<p(?:\s[^>]*)?>(.*?)</p\s*>",
        summary,
        flags=re.IGNORECASE | re.DOTALL,
    )
    for paragraph in paragraphs:
        links = {
            unescape(value).strip()
            for value in re.findall(
                r"<a\b[^>]*\bhref=[\"']([^\"']+)[\"']",
                paragraph,
                flags=re.IGNORECASE,
            )
        }
        if source_url not in links:
            continue
        data_span = None
        for span in re.finditer(
            r"<span\b(?P<attributes>[^>]*)>(?P<value>.*?)</span\s*>",
            paragraph,
            flags=re.IGNORECASE | re.DOTALL,
        ):
            class_match = re.search(
                r"\bclass=[\"']([^\"']*)[\"']",
                span.group("attributes"),
                flags=re.IGNORECASE,
            )
            if (
                class_match is not None
                and "data" in class_match.group(1).split()
            ):
                data_span = span
                break
        if data_span is None:
            return None
        value_text = _html_text(data_span.group("value"))
        label = _html_text(paragraph[: data_span.start()]).rstrip(":")
        if not value_text or not label:
            return None
        if label in rows:
            return None
        rows[label] = value_text

    metrics = []
    for label, name, unit in expected:
        value_text = rows.get(label)
        if value_text is None:
            return None
        metric = _bls_actual_metric(
            value_text,
            name=name,
            unit=unit,
            expected_period=expected_period,
        )
        if metric is None:
            return None
        metrics.append(metric)
    return metrics


def _html_text(value: str) -> str:
    return _canonical_whitespace(
        unescape(re.sub(r"<[^>]+>", " ", value))
    )


def _bls_actual_metric(
    value_text: str,
    *,
    name: str,
    unit: str,
    expected_period: str,
) -> dict[str, Any] | None:
    match = re.fullmatch(
        r"(?P<actual>[+-]?\$?[0-9][0-9,]*(?:\.[0-9]+)?%?)"
        r"(?P<preliminary>\(p\))?\s+in\s+"
        r"(?P<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)"
        r"\s+(?P<year>[0-9]{4})",
        _canonical_whitespace(value_text),
    )
    if match is None:
        return None
    month = next(
        (
            number
            for full_name, number in BLS_MONTHS.items()
            if full_name[:3] == match.group("month")
        ),
        None,
    )
    if month is None:
        return None
    period = f"{match.group('year')}-{month:02d}"
    actual = match.group("actual")
    if (
        period != expected_period
        or (unit == "JOBS" and ("$" in actual or "%" in actual))
        or (unit == "PERCENT" and not actual.endswith("%"))
        or (unit == "USD" and "$" not in actual)
    ):
        return None
    try:
        value = float(
            actual.replace("$", "").replace("%", "").replace(",", "")
        )
    except ValueError:
        return None
    if (
        not math.isfinite(value)
        or not -1_000_000_000_000 <= value <= 1_000_000_000_000
    ):
        return None
    if unit == "JOBS":
        if not value.is_integer():
            return None
        normalized_value: int | float = int(value)
    else:
        normalized_value = value
    return {
        "name": name,
        "value": normalized_value,
        "unit": unit,
        "period": period,
        "preliminary": match.group("preliminary") is not None,
    }


def _parse_bls_macro_calendar(
    text: str,
    *,
    generated_at: str,
) -> list[dict[str, Any]]:
    events, _due_events = _bls_macro_calendar_projections(
        text,
        generated_at=generated_at,
    )
    return events


def _bls_macro_calendar_projections(
    text: str,
    *,
    generated_at: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    generated = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    if generated.tzinfo is None:
        raise ValueError("BLS release calendar observation must be aware")
    normalized = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    if "BEGIN:VCALENDAR" not in normalized or "END:VCALENDAR" not in normalized:
        raise ValueError("BLS release calendar envelope is invalid")
    unfolded: list[str] = []
    for line in normalized.split("\n"):
        if line.startswith((" ", "\t")) and unfolded:
            unfolded[-1] += line[1:]
        else:
            unfolded.append(line)

    blocks: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    event_count = 0
    for line in unfolded:
        if line == "BEGIN:VEVENT":
            if current is not None:
                raise ValueError("nested BLS calendar event")
            event_count += 1
            if event_count > BLS_RELEASE_CALENDAR_MAX_EVENTS:
                raise ValueError("BLS release calendar has too many events")
            current = {}
            continue
        if line == "END:VEVENT":
            if current is None:
                raise ValueError("orphan BLS calendar event end")
            blocks.append(current)
            current = None
            continue
        if current is not None and ":" in line:
            key, value = line.split(":", 1)
            current[key] = value
    if current is not None:
        raise ValueError("unterminated BLS calendar event")

    start = generated.astimezone(PT_ZONE).date()
    end = start + timedelta(days=6)
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for block in blocks:
        summary = _ics_text(block.get("SUMMARY", ""))
        release = _bls_macro_release(summary)
        if release is None:
            normalized_summary = re.sub(
                r"[^a-z0-9]+",
                " ",
                summary.lower(),
            ).strip()
            if any(
                re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()
                in normalized_summary
                for name, _category in BLS_MACRO_RELEASES
            ):
                raise ValueError(
                    "BLS calendar supported release title is unrecognized"
                )
            continue
        release_name, category = release
        start_items = [
            (key, value)
            for key, value in block.items()
            if key == "DTSTART" or key.startswith("DTSTART;")
        ]
        if len(start_items) != 1:
            raise ValueError("BLS calendar event start is invalid")
        scheduled = _ics_datetime(*start_items[0]).astimezone(PT_ZONE)
        if not start <= scheduled.date() <= end:
            continue
        expected_period = _bls_expected_period(summary, release_name)
        if not expected_period:
            raise ValueError("BLS calendar expected period is missing")
        identity = {
            "contract_version": "v1",
            "component": "A1_MACRO_WATCH",
            "category": category,
            "release_name": release_name,
            "scheduled_at": scheduled.isoformat(),
            "source": "BLS Official Release Calendar",
        }
        event_fingerprint = sha256_json(identity)
        if event_fingerprint in seen:
            continue
        seen.add(event_fingerprint)
        records.append(
            {
                "schedule": {
                    "event_fingerprint": event_fingerprint,
                    "category": category,
                    "release_name": release_name,
                    "scheduled_at": scheduled.isoformat(),
                    "market_impact_status": "SCHEDULED_UNRELEASED",
                    "result_status": "UNKNOWN",
                    "source": "BLS Official Release Calendar",
                    "source_url": BLS_RELEASE_CALENDAR_URL,
                    "confidence": "official_schedule",
                },
                "expected_period": expected_period,
            }
        )
        if len(records) > 20:
            raise ValueError(
                "BLS calendar has too many supported seven-day events"
            )
    records.sort(
        key=lambda item: (
            item["schedule"]["scheduled_at"],
            item["schedule"]["release_name"],
        )
    )
    generated_pt = generated.astimezone(PT_ZONE)
    future = [
        record["schedule"]
        for record in records
        if datetime.fromisoformat(record["schedule"]["scheduled_at"])
        > generated_pt
    ]
    due = [
        record
        for record in records
        if (
            datetime.fromisoformat(record["schedule"]["scheduled_at"])
            <= generated_pt
            and datetime.fromisoformat(
                record["schedule"]["scheduled_at"]
            ).date()
            == generated_pt.date()
        )
    ]
    return future, due


def _bls_expected_period(summary: str, release_name: str) -> str:
    match = re.fullmatch(
        rf"{re.escape(release_name)} for "
        r"(?P<month>January|February|March|April|May|June|July|August|"
        r"September|October|November|December) (?P<year>[0-9]{4})",
        _canonical_whitespace(summary),
    )
    if match is None:
        return ""
    return f"{match.group('year')}-{BLS_MONTHS[match.group('month')]:02d}"


def _bls_macro_category(release_name: str) -> str | None:
    release = _bls_macro_release(release_name)
    return release[1] if release is not None else None


def _bls_macro_release(release_name: str) -> tuple[str, str] | None:
    normalized = " ".join(release_name.split())
    for canonical_name, category in BLS_MACRO_RELEASES:
        if normalized == canonical_name or normalized.startswith(
            f"{canonical_name} for "
        ):
            return canonical_name, category
    return None


def _ics_datetime(key: str, value: str) -> datetime:
    if value.endswith("Z"):
        return datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
    timezone = ""
    for parameter in key.split(";")[1:]:
        if parameter.startswith("TZID="):
            timezone = parameter.split("=", 1)[1]
    if timezone not in {"US-Eastern", "America/New_York"}:
        raise ValueError("unsupported BLS calendar timezone")
    return datetime.strptime(value, "%Y%m%dT%H%M%S").replace(tzinfo=ET_ZONE)


def _ics_text(value: str) -> str:
    return (
        value.replace("\\n", " ")
        .replace("\\N", " ")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
        .strip()
    )


def _merge_news(
    official: list[dict[str, Any]],
    finnhub: list[dict[str, Any]],
    google: list[dict[str, Any]],
    *,
    limit: int = 80,
) -> list[dict[str, Any]]:
    official = _round_robin_by_source(official)
    groups = (official, finnhub, google)
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(items: list[dict[str, Any]], count: int) -> None:
        if count <= 0:
            return
        for item in items:
            keys = _news_keys(item)
            if keys & seen:
                continue
            merged.append(item)
            seen.update(keys)
            if len(merged) >= limit or count == 1:
                return
            count -= 1

    for items, quota in zip(groups, NEWS_SOURCE_QUOTAS, strict=True):
        add(items, quota)
    for items in groups:
        add(items, limit - len(merged))
        if len(merged) >= limit:
            break
    return merged


def _round_robin_by_source(
    items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    sources: dict[str, list[dict[str, Any]]] = {}
    for item in items:
        sources.setdefault(str(item.get("source", "")), []).append(item)
    return [
        bucket[index]
        for index in range(max(map(len, sources.values()), default=0))
        for bucket in sources.values()
        if index < len(bucket)
    ]


def _news_keys(item: dict[str, Any]) -> set[str]:
    keys = set()
    url = str(item.get("url", "")).strip().lower().rstrip("/")
    headline = " ".join(str(item.get("headline", "")).lower().split())
    if url:
        keys.add(f"url:{url}")
    if headline:
        keys.add(f"headline:{headline}")
    if not keys:
        keys.add(
            f"id:{item.get('provider', '')}:{item.get('id', '')}"
        )
    return keys


def _epoch_to_iso(value: Any) -> str:
    try:
        return datetime.fromtimestamp(float(value), UTC).isoformat()
    except (TypeError, ValueError, OSError):
        return ""


def _rfc822_to_iso(value: str) -> str:
    try:
        parsed = parsedate_to_datetime(value)
        return parsed.astimezone(UTC).isoformat()
    except (TypeError, ValueError):
        return ""


def _parse_official_feed(text: str, source: str) -> list[dict[str, Any]]:
    root = ET.fromstring(text)
    entries = [
        element
        for element in root.iter()
        if _local_name(element.tag) in {"item", "entry"}
    ]
    items = []
    for entry in entries:
        title = _child_text(entry, "title")
        url = _child_text(entry, "link")
        if not url:
            link = next(
                (
                    child
                    for child in entry
                    if _local_name(child.tag) == "link"
                    and child.attrib.get("href")
                ),
                None,
            )
            url = link.attrib["href"] if link is not None else ""
        item_id = (
            _child_text(entry, "guid")
            or _child_text(entry, "id")
            or url
            or title
        )
        published = (
            _child_text(entry, "pubDate")
            or _child_text(entry, "published")
            or _child_text(entry, "updated")
        )
        items.append(
            {
                "id": f"{source}:{item_id}",
                "headline": title,
                "summary": (
                    _child_text(entry, "description")
                    or _child_text(entry, "summary")
                ),
                "source": source,
                "published_at": _normalize_feed_date(published),
                "url": url,
                "provider": f"{source} official",
                "confidence": "official",
            }
        )
    return [item for item in items if item["headline"]]


def _market_moving_news(
    items: list[dict[str, Any]],
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    current = (now or datetime.now(UTC)).astimezone(UTC)
    candidates: list[tuple[dict[str, Any], str, str, str]] = []
    for item in items:
        published = _parse_iso(item.get("published_at", ""))
        if published is None:
            continue
        age_hours = (current - published).total_seconds() / 3600
        if age_hours < 0:
            continue
        headline = str(item.get("headline", "")).lower()
        match = _match_market_event(headline)
        if match and age_hours <= match[2]:
            candidates.append(
                (
                    item,
                    match[0],
                    match[1],
                    _market_event_identity(headline, match[0], match[1]),
                )
            )

    verified: list[tuple[dict[str, Any], str, str, str, str, str]] = []
    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for item, category, event_key, event_identity in candidates:
        groups.setdefault((category, event_key, event_identity), []).append(item)
    for (category, event_key, event_identity), matching in sorted(groups.items()):
        official = [
            item
            for item in matching
            if item.get("confidence") == "official"
            and item.get("source")
            in {"Federal Reserve", "BLS", "BEA", "SEC"}
        ]
        if official:
            accepted = official[:3]
            event_date = min(
                _parse_iso(item["published_at"]).date().isoformat()
                for item in accepted
            )
            verified.extend(
                (
                    item,
                    category,
                    event_key,
                    event_identity,
                    event_date,
                    "OFFICIAL_SINGLE_SOURCE",
                )
                for item in accepted
            )
            continue
        accepted = _cross_checked_items(
            matching,
            max_span_hours=6 if category == "systemic_event" else None,
        )
        if len(accepted) >= 2 and event_identity != f"{event_key}:unverified":
            event_date = min(
                _parse_iso(item["published_at"]).date().isoformat()
                for item in accepted
            )
            verified.extend(
                (
                    item,
                    category,
                    event_key,
                    event_identity,
                    event_date,
                    "SAME_CATEGORY_TWO_SOURCE",
                )
                for item in accepted
            )
    evidence = []
    for (
        item,
        category,
        event_key,
        event_identity,
        event_date,
        verification_rule,
    ) in verified:
        fingerprint = sha256_json(
            {
                "contract_version": "v1",
                "category": category,
                "event_key": event_key,
                "event_identity": event_identity,
                "publication_date_utc": event_date,
            }
        )
        evidence.append(
            {
                "event_fingerprint": fingerprint,
                "category": category,
                "headline": item.get("headline", ""),
                "source": item.get("source", ""),
                "published_at": item.get("published_at", ""),
                "verification_rule": verification_rule,
            }
        )
    return {
        "verified": bool(evidence),
        "evidence": evidence,
    }


def _cross_checked_items(
    matching: list[dict[str, Any]],
    *,
    max_span_hours: int | None,
) -> list[dict[str, Any]]:
    anchors = matching if max_span_hours is not None else matching[:1]
    for anchor in anchors:
        anchor_time = _parse_iso(anchor.get("published_at", ""))
        by_source: dict[str, dict[str, Any]] = {}
        for item in matching:
            published = _parse_iso(item.get("published_at", ""))
            if (
                published is None
                or anchor_time is None
                or (
                    max_span_hours is not None
                    and abs((published - anchor_time).total_seconds())
                    > max_span_hours * 3600
                )
            ):
                continue
            source = str(item.get("source", "")).strip()
            if (
                source
                and item.get("confidence")
                in {"primary_aggregator", "cross_check_candidate"}
            ):
                by_source.setdefault(NEWS_SOURCE_ALIASES.get(source, source), item)
        if len(by_source) >= 2:
            return list(by_source.values())[:3]
    return []


def _match_market_event(headline: str) -> tuple[str, str, int] | None:
    for category, event_key, phrases, max_age_hours in MARKET_MOVING_EVENTS:
        if any(phrase in headline for phrase in phrases):
            return category, event_key, max_age_hours
    matches = []
    for rule in SEMANTIC_MARKET_EVENTS:
        event_key = str(rule["event_key"])
        if any(_event_term_present(headline, term) for term in rule["excluded"]):
            continue
        if _inverse_event_direction(headline, event_key):
            continue
        if all(
            any(_event_term_present(headline, term) for term in alternatives)
            for alternatives in rule["required_groups"]
        ):
            matches.append(rule)
    energy_matches = [
        rule for rule in matches if str(rule["category"]) == "energy"
    ]
    if len(energy_matches) > 1:
        current = _current_energy_event(headline, energy_matches)
        if current is None:
            return None
        matches = [current]
    if matches:
        rule = matches[0]
        return (
            str(rule["category"]),
            str(rule["event_key"]),
            int(rule["max_age_hours"]),
        )
    return None


def _event_term_present(headline: str, term: str) -> bool:
    return re.search(
        rf"(?<!\w){re.escape(term)}(?!\w)",
        headline,
    ) is not None


def _inverse_event_direction(headline: str, event_key: str) -> bool:
    return (
        event_key == "iran_deescalation"
        and _active_attack_with_ceasefire_talks(headline)
    ) or any(
        pattern.search(headline) is not None
        for pattern in INVERSE_EVENT_PATTERNS.get(event_key, ())
    )


def _active_attack_with_ceasefire_talks(headline: str) -> bool:
    contextual_talks = re.search(
        r"\b(?:ceasefire|truce)\s+(?:talks|negotiations?|discussions?)\b",
        headline,
    )
    active_attack = re.search(
        r"\b(?:resume(?:s|d|ing)?|continue(?:s|d|ing)?|"
        r"renew(?:s|ed|ing)?|launch(?:es|ed|ing)?)"
        r"(?:\s+\w+){0,2}\s+(?:attacks?|strikes?)\b"
        r"|\b(?:iran|israel)(?:\s+\w+){0,3}\s+(?:attacks?|strikes?)\b",
        headline,
    )
    return contextual_talks is not None and active_attack is not None


def _current_energy_event(
    headline: str,
    matches: list[dict[str, Any]],
) -> dict[str, Any] | None:
    contrast = re.split(r"\b(?:but|however|while|and(?:\s+then)?|then)\b", headline)
    if len(contrast) > 1:
        current = _energy_events_in_text(contrast[-1], matches)
        if not current and any(
            _event_term_present(" ".join(contrast[:-1]), term)
            for term in ("oil", "crude")
        ):
            current = _elliptical_energy_events_in_text(contrast[-1], matches)
        if len(current) == 1:
            return current[0]
    current_clause = re.split(
        r"\b(?:after|following|despite|having)\b",
        headline,
        maxsplit=1,
    )[0]
    current = _energy_events_in_text(current_clause, matches)
    if len(current) == 1:
        return current[0]

    commodity_positions = [
        found.start()
        for term in ("oil", "crude")
        for found in re.finditer(rf"(?<!\w){term}(?!\w)", headline)
    ]
    ranked = []
    for rule in matches:
        positions = [
            found.start()
            for term in rule["required_groups"][1]
            for found in re.finditer(
                rf"(?<!\w){re.escape(term)}(?!\w)",
                headline,
            )
        ]
        if positions and commodity_positions:
            ranked.append(
                (
                    min(abs(direction - commodity) for direction in positions for commodity in commodity_positions),
                    rule,
                )
            )
    if not ranked:
        return None
    best_distance = min(item[0] for item in ranked)
    best = [rule for distance, rule in ranked if distance == best_distance]
    return best[0] if len(best) == 1 else None


def _energy_events_in_text(
    text: str,
    matches: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not any(_event_term_present(text, term) for term in ("oil", "crude")):
        return []
    return [
        rule
        for rule in matches
        if any(
            _event_term_present(text, term)
            for term in rule["required_groups"][1]
        )
    ]


def _elliptical_energy_events_in_text(
    text: str,
    matches: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    ranked: list[tuple[int, dict[str, Any]]] = []
    for rule in matches:
        positions = [
            found.start()
            for term in rule["required_groups"][1]
            for found in re.finditer(
                rf"(?<!\w){re.escape(term)}(?!\w)",
                text,
            )
        ]
        if positions:
            ranked.append((min(positions), rule))
    if not ranked:
        return []
    first_direction = min(position for position, _rule in ranked)
    prefix = text[:first_direction].strip(" ,:-")
    if re.fullmatch(
        r"(?:(?:then|now|later|subsequently|currently)|"
        r"(?:is|are|was|were|has|have|had)"
        r"(?:\s+(?:now|still|since|currently|already))?)?",
        prefix,
    ) is None:
        return []
    return [rule for _position, rule in ranked]


def _market_event_identity(
    headline: str,
    category: str,
    event_key: str,
) -> str:
    if category == "energy":
        identities = ENERGY_CATALYST_IDENTITIES
    elif event_key == "iran_deescalation":
        counterparts = _matched_event_identities(
            headline,
            GEOPOLITICAL_DEESCALATION_COUNTERPARTS,
        )
        incidents = _matched_event_identities(
            headline,
            GEOPOLITICAL_DEESCALATION_INCIDENTS,
        )
        if "iran_israel" in counterparts:
            counterparts = ["iran_israel"]
        if len(counterparts) != 1 or len(incidents) != 1:
            return f"{event_key}:unverified"
        if not _deescalation_incident_is_bound(headline, incidents[0]):
            return f"{event_key}:unverified"
        return f"{event_key}:{counterparts[0]}:{incidents[0]}"
    elif event_key == "iran_escalation":
        counterparts = _matched_event_identities(
            headline,
            GEOPOLITICAL_ESCALATION_COUNTERPARTS,
        )
        if len(counterparts) != 1:
            return f"{event_key}:unverified"
        descriptors = _matched_event_identities(
            headline,
            GEOPOLITICAL_ESCALATION_DESCRIPTORS,
        )
        qualifiers = _matched_event_identities(
            headline,
            GEOPOLITICAL_ESCALATION_QUALIFIERS,
        )
        counterpart = counterparts[0]
        if (
            len(qualifiers) > 1
            or (
                counterpart in {"us_forces", "shipping"}
                and len(qualifiers) != 1
            )
            or (counterpart == "israel" and len(qualifiers) != 1)
        ):
            return f"{event_key}:unverified"
        attributes = [counterpart, *descriptors, *qualifiers]
        return f"{event_key}:{'+'.join(attributes)}"
    elif category == "systemic_event":
        matched = _matched_event_identities(headline, SYSTEMIC_EVENT_IDENTITIES)
        if not matched:
            return f"{event_key}:unverified"
        if event_key == "military_attack":
            sites = [item for item in matched if item in SYSTEMIC_ATTACK_SITES]
            if len(sites) != 1:
                return f"{event_key}:unverified"
        return f"{event_key}:{'+'.join(sorted(matched))}"
    else:
        return event_key

    matched = _matched_event_identities(headline, identities)
    if len(matched) != 1:
        return f"{event_key}:unverified"
    return f"{event_key}:{matched[0]}"


def _deescalation_incident_is_bound(headline: str, incident: str) -> bool:
    if incident == "military_pause":
        return re.search(
            r"\biran(?:\s+\w+){0,4}\s+"
            r"(?:(?:hold|holds|holding|held)\s+off|calls?\s+off|cancel(?:s|ed|ing)?|"
            r"halt(?:s|ed|ing)?|pause(?:s|d|ing)?)\b"
            r"|\b(?:(?:hold|holds|holding|held)\s+off|calls?\s+off|"
            r"cancel(?:s|ed|ing)?|halt(?:s|ed|ing)?|pause(?:s|d|ing)?)"
            r"(?:\s+(?!(?:as|while|after|because|amid)\b)\w+){0,3}\s+"
            r"(?:attacks?|strikes?|retaliation|response|operations?|hostilities|fire)\b",
            headline,
        ) is not None
    if incident == "diplomatic_deal" and "diplomacy" in headline:
        return re.search(
            r"\biran(?:\s+\w+){0,5}\s+diplomacy\b"
            r"|\bdiplomacy(?:\s+\w+){0,4}\s+iran\b",
            headline,
        ) is not None
    incident_terms = dict(GEOPOLITICAL_DEESCALATION_INCIDENTS)[incident]
    clauses = re.split(
        r"\b(?:as|while|whereas|amid|despite|because)\b|[,;]",
        headline,
    )
    return any(
        _event_term_present(clause, "iran")
        and any(_event_term_present(clause, term) for term in incident_terms)
        for clause in clauses
    )


def _matched_event_identities(
    headline: str,
    identities: tuple[tuple[str, tuple[str, ...]], ...],
) -> list[str]:
    return [
        identity
        for identity, terms in identities
        if any(_event_term_present(headline, term) for term in terms)
    ]


def _information_archive(raw: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "contract_version": "v1",
        "collected_at": str(raw.get("collected_at", "")),
        "providers": raw.get("providers", {}),
        "news": raw.get("news", []),
        "earnings": raw.get("earnings", []),
    }
    return {
        **payload,
        "information_hash": sha256_json(payload),
    }


def _child_text(element: ET.Element, name: str) -> str:
    for child in element:
        if _local_name(child.tag) == name:
            return (child.text or "").strip()
    return ""


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _normalize_feed_date(value: str) -> str:
    if not value:
        return ""
    parsed = _rfc822_to_iso(value)
    if parsed:
        return parsed
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(
            UTC
        ).isoformat()
    except ValueError:
        return value


def _parse_iso(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed.astimezone(UTC)
    except (AttributeError, ValueError):
        return None


