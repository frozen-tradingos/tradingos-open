"""Run with the package's .venv Python against the bundled V2 core.
Uses only synthetic evidence and captures prompts without invoking a model.
"""
import copy
from datetime import UTC, datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
from unittest.mock import patch


root = Path(__file__).resolve().parents[1]
reference = root.parent / "v2-reference"
sys.dont_write_bytecode = True
adapter = runpy.run_path(str(root / "scripts/live-shadow-v2.py"))
sample = json.loads((root / "public/samples/v2-snapshot-import-v1.sanitized.json").read_text(encoding="utf-8"))["contracts"]["TS_OUTPUT"][0]


def rejects(call, fragment, error_type=RuntimeError):
    try:
        call()
    except RuntimeError as error:
        assert fragment in str(error), error
        assert isinstance(error, error_type), type(error)
    else:
        raise AssertionError(f"Expected rejection: {fragment}")


(root / "data/live-shadow").mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="trading-os-prior-context-", dir=root / "data/live-shadow") as directory:
    runtime = Path(directory)
    base_instruction_path = reference / "trading_os_v2/ts/instructions.md"
    base_instructions = base_instruction_path.read_bytes()
    _, agent_runtime, orchestrator, _ = adapter["configure"](reference, runtime)
    old_lookup = orchestrator._prior_delivered_ts_forecast
    from trading_os_v2.common.io import sha256_json

    def prior(kind, at, run_id, delivered_at):
        output = copy.deepcopy(sample)
        output["report_type"] = kind
        output["evidence_snapshot"]["run_id"] = f"frozen-{kind}"
        output["evidence_snapshot"]["packet_hash"] = "a" * 64
        output["evidence_snapshot"]["market_time"].update(observed_at=at, market_date=at[:10])
        output["forecast_window"]["start_at"] = at
        output["next_validation"] = orchestrator._ts_required_next_validation(kind, adapter["aware"](at, "fixture")) or output["next_validation"]
        raw = json.dumps(output, ensure_ascii=False, separators=(",", ":"))
        slot = datetime.strptime(run_id.split(":", 1)[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
        deadline = slot + timedelta(seconds=(600 if at[:10] >= "2026-09-21" else 300) if run_id.endswith("T133000Z") else 90)
        return {"slot_id": run_id, "run_id": run_id, "forecast_id": output["evidence_snapshot"]["run_id"], "delivery_record_id": f"{run_id}:TS", "received_at": delivered_at, "delivered_at": delivered_at, "payload_json": raw, "forecast_hash": hashlib.sha256(raw.encode()).hexdigest(), "freeze_deadline_at": deadline.isoformat()}

    night = prior("NEXT_SESSION", "2026-09-03T18:00:43-07:00", "live-shadow:20260904T010000Z", "2026-09-03T18:02:00-07:00")
    morning = prior("OPENING_FORECAST", "2026-09-04T06:30:18-07:00", "live-shadow:20260904T133000Z", "2026-09-04T06:32:00-07:00")
    packet = {"run_id": "new-frozen-packet", "packet_hash": "b" * 64, "a1": {}, "a2": {}}

    def context(at, reason, records, legacy=False):
        freshness = {"freshness_hash": "c" * 64, "market_clock": {"observed_at": at, "state": "REGULAR"}}
        if legacy or "ts_report_context" not in adapter:
            return orchestrator._ts_report_context(packet, freshness, reason)
        slot = datetime.fromisoformat(at).replace(second=0, microsecond=0)
        slot = slot.replace(minute=(slot.minute // 15) * 15)
        deadline = slot + timedelta(seconds=(600 if at[:10] >= "2026-09-21" else 300) if slot.strftime("%H:%M") == "06:30" else 90)
        return adapter["ts_report_context"](orchestrator, packet, freshness, reason, {"PRIOR_TS_FORECASTS": records, "slot_id": f"live-shadow:{slot.astimezone(UTC):%Y%m%dT%H%M%SZ}", "SLOT_FREEZE_DEADLINE_AT": deadline.isoformat()})

    rejects(lambda: context("2026-09-04T06:30:18-07:00", "早盘固定分析", [night], legacy=True), "no delivered NEXT_SESSION")
    print("RED: unchanged V2 file lookup cannot see the genuine frozen SQLite input")
    frozen_before = json.dumps([night, morning], sort_keys=True)
    for at, reason, expected, records in [
        ("2026-09-04T06:30:18-07:00", "早盘固定分析", night, [night]),
        ("2026-09-04T06:45:18-07:00", "开盘15分钟验证", morning, [night, morning]),
        ("2026-09-04T07:00:18-07:00", "开盘30分钟验证", morning, [night, morning]),
        ("2026-09-04T07:30:18-07:00", "4070 Live Shadow", morning, [night, morning]),
    ]:
        result = context(at, reason, records)
        expected_output = json.loads(expected["payload_json"])
        assert result["prior_forecast"] == expected_output
        assert result["forecast_update"] == {"mode": "CHECK", "prior_run_id": expected["forecast_id"], "prior_forecast_hash": sha256_json(expected_output)}
        assert orchestrator._prior_delivered_ts_forecast is old_lookup
    bad_night = {**night, "forecast_hash": "0" * 64}
    assert context("2026-09-04T06:45:18-07:00", "开盘15分钟验证", [bad_night, morning])["prior_forecast"] == json.loads(morning["payload_json"])
    assert context("2026-09-04T07:00:18-07:00", "开盘30分钟验证", [bad_night, morning])["prior_forecast"] == json.loads(morning["payload_json"])
    assert context("2026-09-04T07:30:18-07:00", "4070 Live Shadow", [bad_night, morning])["prior_forecast"] == json.loads(morning["payload_json"])
    rejects(lambda: context("2026-09-04T06:30:18-07:00", "早盘固定分析", [bad_night]), "hash mismatch")
    bad_previous_night = {**bad_night, "slot_id": "live-shadow:20260903T010000Z"}
    assert context("2026-09-04T06:30:18-07:00", "早盘固定分析", [bad_previous_night, night])["prior_forecast"] == json.loads(night["payload_json"])
    bad_required_morning = {**morning, "forecast_hash": "0" * 64}
    rejects(lambda: context("2026-09-04T06:45:18-07:00", "开盘15分钟验证", [night, bad_required_morning]), "hash mismatch")
    late_morning = prior("OPENING_FORECAST", "2026-09-04T06:34:00-07:00", morning["slot_id"], "2026-09-04T06:36:00-07:00")
    late_output = json.loads(late_morning["payload_json"])
    rejects(lambda: orchestrator._validate_prior_ts_slot(late_output, {"run_id": late_morning["forecast_id"], "packet_hash": "a" * 64}, datetime.fromisoformat("2026-09-04T06:30:00-07:00")), "not bound to its owned slot")
    assert context("2026-09-04T06:45:18-07:00", "开盘15分钟验证", [late_morning])["prior_forecast"] == json.loads(late_morning["payload_json"])
    late_current = context("2026-09-04T06:34:00-07:00", "早盘固定分析", [night])
    assert late_current["report_type"] == "OPENING_FORECAST" and late_current["forecast_window"]["start_at"] == "2026-09-04T06:34:00-07:00"
    after_deadline = prior("OPENING_FORECAST", "2026-09-04T06:35:01-07:00", morning["slot_id"], "2026-09-04T06:36:00-07:00")
    before_slot = prior("OPENING_FORECAST", "2026-09-04T06:29:59-07:00", morning["slot_id"], "2026-09-04T06:36:00-07:00")
    late_check = prior("OPEN_15M_CHECK", "2026-09-04T06:46:31-07:00", "live-shadow:20260904T134500Z", "2026-09-04T06:48:00-07:00")
    for invalid in [after_deadline, before_slot, late_check]:
        rejects(lambda: context("2026-09-04T07:30:18-07:00", "4070 Live Shadow", [invalid]), "outside its owned slot freeze window")
    wrong_type = prior("INTRADAY_30_60M", "2026-09-04T06:34:00-07:00", morning["slot_id"], "2026-09-04T06:36:00-07:00")
    rejects(lambda: context("2026-09-04T06:45:18-07:00", "开盘15分钟验证", [wrong_type]), "report type does not match")
    rejects(lambda: context("2026-09-04T06:45:18-07:00", "早盘固定分析", [night]), "report type does not match")
    new_opening = context("2026-09-21T06:39:18-07:00", "早盘固定分析", [])
    assert new_opening["report_type"] == "OPENING_FORECAST"
    assert new_opening["forecast_update"] == {"mode": "NEW", "prior_run_id": None, "prior_forecast_hash": None}
    assert new_opening["prior_forecast"] is None
    assert new_opening["prior_forecast_review"] == {"status": "UNAVAILABLE", "expected_report_type": "NEXT_SESSION", "reason": "NO_DELIVERED_PRIOR_NEXT_SESSION"}
    assert new_opening["forecast_window"] == {"horizon": "OPEN_TO_60_MINUTES", "start_at": "2026-09-21T06:39:18-07:00", "end_at": "2026-09-21T07:39:18-07:00", "end_condition": "AT_TIMESTAMP"}
    assert new_opening["evidence_snapshot"]["packet_hash"] == packet["packet_hash"]
    rejects(lambda: context("2026-09-21T06:40:01-07:00", "早盘固定分析", []), "outside its owned slot freeze window")
    for at, reason, fragment in [("06:30", "早盘固定分析", "no delivered NEXT_SESSION"), ("06:45", "开盘15分钟验证", "缺少同日原始早盘预测"), ("07:00", "开盘30分钟验证", "缺少同日原始早盘预测")]:
        rejects(lambda: context(f"2026-09-04T{at}:18-07:00", reason, []), fragment, adapter["DataBlocked"])
    future = {**morning, "received_at": "2026-09-04T06:46:00-07:00", "delivered_at": "2026-09-04T06:46:00-07:00"}
    rejects(lambda: context("2026-09-04T06:45:18-07:00", "开盘15分钟验证", [future]), "缺少同日原始早盘预测")
    for bad, message in [
        ({**morning, "payload_json": morning["payload_json"] + " "}, "hash mismatch"),
        ({**morning, "forecast_id": "different"}, "identity mismatch"),
        ({**morning, "delivery_record_id": "other:TS"}, "identity mismatch"),
        ({**morning, "received_at": "2026-09-04T06:00:00-07:00"}, "precedes frozen evidence"),
    ]:
        rejects(lambda: context("2026-09-04T06:45:18-07:00", "开盘15分钟验证", [bad]), message)
    rejects(lambda: context("2026-09-04T06:45:18-07:00", "开盘15分钟验证", [morning, morning]), "duplicated")
    assert orchestrator._prior_delivered_ts_forecast is old_lookup
    assert json.dumps([night, morning], sort_keys=True) == frozen_before
    assert all(path == runtime / "v2-runtime/instructions" or path.parent == runtime / "v2-runtime/instructions" or path == runtime / "v2-runtime" for path in runtime.rglob("*")), "Only composed TS instructions may be written; no legacy ownership or delivery files"
    print("GREEN: fresh opening forecasts do not require a prior evening report; opening checks still require a real morning forecast; immutable history and legacy files preserved")

    # Capture the real runtime's constructed prompt at the subprocess boundary.
    # No Codex executable, provider, model, database or production runtime is used.
    instruction_path = agent_runtime.ROLE_FILES["TS"][0]
    adapter["configure"](reference, runtime)
    assert agent_runtime.ROLE_FILES["TS"][0] == instruction_path
    composed = instruction_path.read_text(encoding="utf-8")
    assert composed.count("## Local known-event-day risk boundary") == 1
    assert instruction_path.stem == "ts-" + hashlib.sha256(composed.encode()).hexdigest()
    assert base_instruction_path.read_bytes() == base_instructions
    assert composed.startswith(base_instruction_path.read_text(encoding="utf-8"))

    risk_context = context("2026-09-16T07:30:18-07:00", "4070 Live Shadow", [])
    event = {"event_id": "d" * 64, "release_name": "FOMC Meeting Decision", "category": "central_bank", "scheduled_at": "2026-09-16T12:00:00+00:00", "time_precision": "DATE_ONLY", "confidence": "issuing_agency_official_date_only", "source_url": "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"}
    official = {"status": "DEGRADED", "as_of": "2026-09-16T14:30:18Z", "collected_at": "2026-09-16T14:30:18Z", "events": [event]}
    original = copy.deepcopy([risk_context, official])
    risk = adapter["known_event_day_risk"](risk_context, official)
    assert risk["status"] == "KNOWN_EVENT_DAY" and risk["market_date"] == "2026-09-16"
    assert risk["events"][0]["scheduled_at"] is None
    assert risk["events"][0]["time_precision"] == "DATE_ONLY"
    assert [risk_context, official] == original
    for invalid in [None, {}, {**event, "release_name": []}, {**event, "release_name": "FOMC Minutes"},
                    {**event, "scheduled_at": "2026-09-17"}, {**event, "scheduled_at": "2026-09-31"},
                    {**event, "scheduled_at": "2026-09-16Tinvalid"}, {**event, "time_precision": "UNKNOWN"},
                    {**event, "time_precision": "EXACT"}, {**event, "time_precision": []},
                    {**event, "source_url": "https://www.federalreserve.gov.example.com/calendar"},
                    {**event, "source_url": "https://user@www.federalreserve.gov/calendar"},
                    {**event, "source_url": "http://www.federalreserve.gov/calendar"},
                    {**event, "source_url": 123},
                    {**event, "category": "employment"}, {**event, "event_id": "invalid"}]:
        assert adapter["known_event_day_risk"](risk_context, {**official, "events": [invalid]})["events"] == [], invalid
    for invalid_context in [{**official, "as_of": "2026-09-16T14:30:19Z"},
                            {**official, "collected_at": "2026-09-16T14:30:19Z"},
                            {**official, "status": "STALE"},
                            {**official, "as_of": "invalid"}, {**official, "status": "UNKNOWN"},
                            {**official, "events": []}]:
        assert adapter["known_event_day_risk"](risk_context, invalid_context)["status"] == "NOT_OBSERVED"
    # Known calendar dates do not receive an invented intraday expiry in this projection.
    assert adapter["known_event_day_risk"](risk_context, {**official, "as_of": "2026-09-15T14:30:18Z"})["status"] == "KNOWN_EVENT_DAY"
    mixed_sources = {**official, "status": "DATA_BLOCKED", "providers": {"BLS": {"schedule_status": "DATA_BLOCKED", "results_status": "DATA_BLOCKED"}, "BEA": {"schedule_status": "DATA_BLOCKED"}}, "supplemental_sources": [{"source": "FEDERAL_RESERVE", "status": "LIVE"}], "coverage": {"central_bank": "LIVE"}}
    assert adapter["known_event_day_risk"](risk_context, mixed_sources)["status"] == "KNOWN_EVENT_DAY"
    assert adapter["known_event_day_risk"](risk_context, {**mixed_sources, "events": []})["status"] == "NOT_OBSERVED"
    midnight = {**event, "scheduled_at": "2026-09-16T00:00:00Z"}
    assert adapter["known_event_day_risk"](risk_context, {**official, "events": [midnight]})["events"][0]["market_date"] == "2026-09-16"
    exact = {**event, "time_precision": "EXACT", "confidence": "official_schedule", "scheduled_at": "2026-09-16T18:00:00Z"}
    assert adapter["known_event_day_risk"](risk_context, {**official, "events": [exact]})["events"][0]["scheduled_at"] == exact["scheduled_at"]
    assert adapter["known_event_day_risk"](risk_context, {**official, "events": [{**exact, "scheduled_at": midnight["scheduled_at"]}]})["events"] == []
    for name, category, source in [
        ("Consumer Price Index", "inflation", "https://www.bls.gov/schedule"),
        ("Producer Price Index", "inflation", "https://www.bls.gov/schedule"),
        ("Employment Situation", "employment", "https://www.bls.gov/schedule"),
        ("Personal Income and Outlays", "inflation_consumption", "https://apps.bea.gov/API/signup/release_dates.json"),
        ("Gross Domestic Product", "growth", "https://apps.bea.gov/API/signup/release_dates.json"),
    ]:
        assert adapter["known_event_day_risk"](risk_context, {**official, "events": [{**exact, "release_name": name, "category": category, "source_url": source}]})["status"] == "KNOWN_EVENT_DAY"
    fred = {**event, "release_name": "Consumer Price Index", "category": "inflation", "source_url": "https://fred.stlouisfed.org/releases/calendar?rid=10", "confidence": "official_federal_reserve_aggregator_date_only"}
    assert adapter["known_event_day_risk"](risk_context, {**official, "events": [fred]})["status"] == "KNOWN_EVENT_DAY"
    assert adapter["known_event_day_risk"](risk_context, {**official, "events": [{**fred, "source_url": fred["source_url"] + "&rid=46"}]})["events"] == []
    next_session = {**risk_context, "report_type": "NEXT_SESSION", "required_next_validation": {"at": "2026-09-17T06:30:00-07:00"}}
    assert adapter["known_event_day_risk"](next_session, {**official, "events": [{**event, "scheduled_at": "2026-09-17"}]})["status"] == "KNOWN_EVENT_DAY"

    assessment_before = copy.deepcopy(risk_context["evidence_assessment"])
    bound = adapter["apply_frozen_market_evidence"](risk_context, official, {})
    assert bound["evidence_assessment"] == assessment_before
    assert "MACRO_SCHEDULE" in bound["evidence_assessment"]["enhanced_missing"]
    immutable_packet = {"contract_version": "v1"}
    immutable_packet.update(run_id="test-only-event-day", packet_hash=sha256_json(immutable_packet))
    assert agent_runtime._ts_machine_causal_claims(immutable_packet, bound) == []
    assert orchestrator._ts_scheduled_macro_events(immutable_packet, "INTRADAY_30_60M", datetime.fromisoformat("2026-09-16T07:30:18-07:00")) == []
    supplemental = {"ts_report_context": bound}
    agent_runtime._verify_supplemental(supplemental)

    class PromptCaptured(Exception):
        pass

    prompts = []
    def capture_prompt(*args, **kwargs):
        prompts.append(kwargs["input"])
        raise PromptCaptured()

    runner = object.__new__(agent_runtime.CodexAgentRuntime)
    runner.executable = Path("TEST_ONLY_NO_EXECUTABLE")
    runner.workspace = runtime
    runner.timeout_seconds = 1
    with patch.object(agent_runtime.subprocess, "run", capture_prompt):
        try:
            runner.run("TS", immutable_packet, supplemental)
        except PromptCaptured:
            pass
    assert len(prompts) == 1
    prompt = prompts[0]
    assert composed in prompt and '"known_event_day_risk":{"status":"KNOWN_EVENT_DAY"' in prompt
    assert '"time_precision":"DATE_ONLY","scheduled_at":null' in prompt
    assert "TS_MACHINE_OWNED_CAUSAL_CLAIMS:\n\n[]" in prompt
    assert "18:00:00" not in prompt and "11:00" not in prompt
    assert base_instruction_path.read_bytes() == base_instructions
    print("GREEN: actual TS prompt contains validated event-day risk; exact schedule/causal gates and immutable V2 instructions preserved; zero model calls")
