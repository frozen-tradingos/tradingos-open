"""Load the versioned Discord display contract without package-name coupling."""

from __future__ import annotations

import json
from typing import Any

from trading_os_v2.common.config import ROOT


_CONTRACT_PATH = (
    ROOT / "contracts" / "v1" / "discord-display-formats.schema.json"
)


def _load_contract() -> dict[str, Any]:
    try:
        contract = json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Discord display contract is unavailable") from exc
    properties = contract.get("properties")
    if (
        contract.get("additionalProperties") is not False
        or not isinstance(properties, dict)
    ):
        raise RuntimeError("Discord display contract shape is invalid")
    return contract


def _format_property(
    contract: dict[str, Any],
    name: str,
) -> tuple[frozenset[str], str, str | None, frozenset[str], str]:
    value = contract["properties"].get(name)
    if not isinstance(value, dict):
        raise RuntimeError(f"Discord display contract lacks {name}")
    versions = value.get("enum")
    current = value.get("default")
    previous = value.get("x-previous")
    retained = value.get("x-retained", [])
    legacy = value.get("x-legacy")
    if (
        not isinstance(versions, list)
        or not versions
        or not all(isinstance(item, str) and item for item in versions)
        or len(versions) != len(set(versions))
        or not isinstance(current, str)
        or current not in versions
        or (previous is not None and previous not in versions)
        or not isinstance(retained, list)
        or not all(isinstance(item, str) and item for item in retained)
        or len(retained) != len(set(retained))
        or any(item not in versions for item in retained)
        or not isinstance(legacy, str)
        or legacy not in versions
    ):
        raise RuntimeError(f"Discord display contract {name} is invalid")
    accepted = frozenset(versions)
    declared = {current, legacy}
    if previous is not None:
        declared.add(previous)
    declared.update(retained)
    if declared != accepted:
        raise RuntimeError(f"Discord display contract {name} roles are incomplete")
    return accepted, current, previous, frozenset(retained), legacy


_CONTRACT = _load_contract()
DISCORD_DISPLAY_CONTRACT_VERSION = _CONTRACT["properties"][
    "contract_version"
]["const"]
DISCORD_DISPLAY_COMPONENT = _CONTRACT["properties"]["component"]["const"]

(
    TS_DISCORD_FORMAT_VERSIONS,
    TS_DISCORD_FORMAT_VERSION,
    TS_DISCORD_PREVIOUS_FORMAT_VERSION,
    TS_DISCORD_RETAINED_FORMAT_VERSIONS,
    TS_DISCORD_LEGACY_FORMAT_VERSION,
) = _format_property(_CONTRACT, "ts_discord_format_version")
if TS_DISCORD_PREVIOUS_FORMAT_VERSION is None:
    raise RuntimeError("Discord TS display contract lacks previous version")

(
    A2_DISCORD_FORMAT_VERSIONS,
    A2_DISCORD_FORMAT_VERSION,
    _A2_DISCORD_PREVIOUS_FORMAT_VERSION,
    _A2_DISCORD_RETAINED_FORMAT_VERSIONS,
    A2_DISCORD_LEGACY_FORMAT_VERSION,
) = _format_property(_CONTRACT, "a2_discord_format_version")
if _A2_DISCORD_PREVIOUS_FORMAT_VERSION is not None:
    raise RuntimeError("Discord A2 display contract has unexpected previous version")
if _A2_DISCORD_RETAINED_FORMAT_VERSIONS:
    raise RuntimeError("Discord A2 display contract has unexpected retained versions")
