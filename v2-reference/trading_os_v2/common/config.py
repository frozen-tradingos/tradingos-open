from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any
from zoneinfo import reset_tzpath

import tzdata


reset_tzpath([str(Path(tzdata.__file__).parent / "zoneinfo")])


ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = ROOT / "config" / "system.json"
PACKAGE_ROOT = ROOT.parent
DATA_ROOT = PACKAGE_ROOT / "web" / "data" / "live-shadow" / "v2-data"
RUNTIME_ROOT = PACKAGE_ROOT / "web" / "data" / "live-shadow" / "v2-runtime"


def package_data_path(path: Path) -> Path:
    data_root = PACKAGE_ROOT / "web" / "data"
    resolved = path.resolve()
    if data_root.resolve() != data_root or not resolved.is_relative_to(data_root):
        raise RuntimeError("V2 storage must remain inside this package's web/data")
    return resolved


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    config = json.loads(path.read_text(encoding="utf-8"))
    if config.get("contract_version") != "v1":
        raise RuntimeError("Unknown configuration contract version")
    system = config["system"]
    rules = config["trading_rules"]
    if system["execution_enabled"] or system["automatic_orders_enabled"]:
        raise RuntimeError("Phase 1 execution flags must remain false")
    if not rules["manual_only"] or not rules["single_leg_only"]:
        raise RuntimeError("Phase 1 must remain manual and single-leg only")
    dte_min = rules.get("dte_min")
    dte_max = rules.get("dte_max")
    if (
        type(dte_min) is not int
        or type(dte_max) is not int
        or not 0 <= dte_min <= dte_max <= 15
    ):
        raise RuntimeError("Phase 1 DTE range must be integer 0 through 15")
    range_policy = rules.get("range_market_policy")
    if range_policy != {
        "status": "TREND_ALIGNED_PULLBACK_ONLY",
        "wide_chop_new_trade_allowed": False,
        "transition_requires_qualified_context": True,
        "required_structure_timeframes": ["15m", "30m"],
        "microstructure_confirmation": "5M_BREAK_AND_NEXT_BAR_HOLD",
        "vwap_role": "EVIDENCE_ONLY",
    }:
        raise RuntimeError("Invalid trend-aligned range market policy")
    if "choppy_market_new_trade_allowed" in rules:
        raise RuntimeError("Obsolete choppy market policy is forbidden")
    spread = rules["spread_rule"]
    if spread.get("status") == "UNSET":
        if (
            spread.get("max_relative_pct") is not None
            or spread.get("max_absolute_usd") is not None
            or spread.get("effect") != "NO_NEW_TRADE_UNTIL_DEFINED"
        ):
            raise RuntimeError("Invalid unset spread rule")
    elif spread.get("status") == "DEFINED":
        thresholds = (
            spread.get("max_relative_pct"),
            spread.get("max_absolute_usd"),
        )
        if (
            any(
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or value <= 0
                for value in thresholds
            )
            or spread.get("effect") != "BLOCK_NEW_TRADE_OUTSIDE_THRESHOLD"
        ):
            raise RuntimeError("Invalid defined spread rule")
    else:
        raise RuntimeError("Unknown spread rule status")
    if system["legacy_paths_allowed"]:
        raise RuntimeError("Legacy paths are forbidden")
    if config.get("discord", {}).get("enabled") is not False or config["discord"].get("channels"):
        raise RuntimeError("Discord is disabled in the independent public package")
    data = config.get("data")
    if (
        not isinstance(data, dict)
        or data.get("contract_version") != "v1"
        or not isinstance(data.get("storage_root"), str)
        or data.get("storage_root") not in {"../web/data/live-shadow/v2-data", str(DATA_ROOT)}
        or data.get("contains_secrets") is not False
    ):
        raise RuntimeError("Invalid V2 data configuration")
    history = data.get("history")
    if (
        not isinstance(history, dict)
        or history.get("provider") != "tradier"
        or history.get("symbols") != ["SPY", "QQQ"]
        or history.get("interval") != "5min"
        or history.get("session_filter") != "open"
        or history.get("lookback_days") != 40
    ):
        raise RuntimeError("Invalid market-history configuration")
    forecast = data.get("half_hour_forecast")
    if (
        not isinstance(forecast, dict)
        or forecast.get("mode") != "SHADOW"
        or forecast.get("actionable") is not False
        or forecast.get("cadence_minutes") != 15
        or forecast.get("horizon_minutes") != 30
        or forecast.get("first_issue") != "07:00"
        or forecast.get("last_issue") != "12:30"
    ):
        raise RuntimeError("Half-hour forecast must remain non-actionable shadow data")
    data["storage_root"] = str(package_data_path(DATA_ROOT))
    config["review"]["storage_root"] = str(package_data_path(PACKAGE_ROOT / "web" / "data" / "reviews"))
    return config


def runtime_path(*parts: str) -> Path:
    configured = os.environ.get("TRADING_OS_V2_RUNTIME_ROOT")
    if configured is not None and Path(configured).resolve() != RUNTIME_ROOT:
        raise RuntimeError("External V2 runtime roots are not allowed")
    path = package_data_path(RUNTIME_ROOT.joinpath(*parts))
    if not path.is_relative_to(RUNTIME_ROOT):
        raise RuntimeError("V2 runtime paths must remain inside this package's runtime directory")
    return path
