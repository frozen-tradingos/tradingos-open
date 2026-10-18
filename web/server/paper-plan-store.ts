import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "./robinhood-mcp.ts";
import { paperTrackingWindow, projectPaperLearning, validatePaperEvent, type PaperEventPayloads, type PaperLearning, type PaperPlan, type PaperPlanEvent } from "../app/paper-plan.ts";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export function makePaperEvent<K extends keyof PaperEventPayloads>(planId: string, at: string, type: K, payload: PaperEventPayloads[K]): Extract<PaperPlanEvent, { event_type: K }> {
  const event = { plan_id: planId, market_date: planId.split(":")[1] ?? "", recorded_at: at, event_type: type, payload };
  return { ...event, event_id: `paper-event:${hash(event)}` } as unknown as Extract<PaperPlanEvent, { event_type: K }>;
}

export function openPaperPlanStore(database: DatabaseSync, options: { readOnly?: boolean } = {}) {
  if (!options.readOnly) {
    database.exec("SAVEPOINT paper_plan_schema");
    try { database.exec(`
    CREATE TABLE IF NOT EXISTS paper_plan_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      plan_id TEXT NOT NULL,
      market_date TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('ATTEMPT', 'CREATED', 'MARK', 'GAP', 'ENDED')),
      recorded_at TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS paper_plan_events_by_plan ON paper_plan_events(plan_id, sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS paper_plan_once_per_id ON paper_plan_events(plan_id) WHERE event_type = 'CREATED';
    CREATE UNIQUE INDEX IF NOT EXISTS paper_plan_distinct_daily_symbol ON paper_plan_events(market_date, json_extract(payload_json, '$.payload.plan.symbol')) WHERE event_type = 'CREATED';
    DROP INDEX IF EXISTS paper_plan_once_daily;
    CREATE TRIGGER IF NOT EXISTS paper_plan_events_no_update BEFORE UPDATE ON paper_plan_events BEGIN SELECT RAISE(ABORT, 'Paper observations are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS paper_plan_events_no_delete BEFORE DELETE ON paper_plan_events BEGIN SELECT RAISE(ABORT, 'Paper observations are append-only'); END;
    `); database.exec("RELEASE paper_plan_schema"); }
    catch (error) { database.exec("ROLLBACK TO paper_plan_schema; RELEASE paper_plan_schema"); throw error; }
  }
  const exists = Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'paper_plan_events'").get());
  const parse = (row: unknown) => row ? JSON.parse((row as { payload_json: string }).payload_json) as PaperPlanEvent : null;
  const rows = (sql: string, planId?: string) => exists ? (planId === undefined ? database.prepare(sql).all() : database.prepare(sql).all(planId)).map((row) => parse(row)!) : [];
  const origin = (id: string) => parse(database.prepare("SELECT payload_json FROM paper_plan_events WHERE plan_id = ? AND event_type = 'CREATED'").get(id));
  const eventsForPlan = (id: string) => rows("SELECT payload_json FROM paper_plan_events WHERE plan_id = ? ORDER BY sequence", id);
  let learningCache: { sequence: number; value: PaperLearning } | undefined;
  return {
    append(event: PaperPlanEvent) {
      if (options.readOnly) throw new Error("模拟观察库为只读");
      const ownTransaction = !database.isTransaction;
      if (ownTransaction) database.exec("BEGIN IMMEDIATE");
      try {
        const payloadHash = hash(event), existing = database.prepare("SELECT payload_hash FROM paper_plan_events WHERE event_id = ?").get(event.event_id) as { payload_hash: string } | undefined;
        if (existing) {
          if (existing.payload_hash !== payloadHash) throw new Error("模拟观察事件身份冲突；原记录不变");
          if (ownTransaction) database.exec("COMMIT");
          return { duplicate: true };
        }
        const { event_id, ...identity } = event;
        if (event_id !== `paper-event:${hash(identity)}`) throw new Error("模拟观察事件摘要不匹配");
        const created = origin(event.plan_id), plan = created?.event_type === "CREATED" ? created.payload.plan : null;
        validatePaperEvent(event, plan);
        const last = parse(database.prepare("SELECT payload_json FROM paper_plan_events WHERE plan_id = ? ORDER BY sequence DESC LIMIT 1").get(event.plan_id));
        if (last && Date.parse(event.recorded_at) < Date.parse(last.recorded_at)) throw new Error("模拟观察不能倒序追加");
        if (last?.event_type === "ENDED") throw new Error(`模拟观察${last.payload.reason === "OWNER_VOID" ? "已作废" : last.payload.reason === "OBSERVATION_WINDOW" ? "观察期已结束" : "已到期"}结束，不能改写后续价格`);
        if (event.event_type === "CREATED" && plan) throw new Error("本交易日已有原始模拟单");
        if (event.event_type === "CREATED" && event.payload.plan.owner_reselection) {
          const request = event.payload.plan.owner_reselection;
          for (const id of request.replaces_plan_ids) {
            const ended = parse(database.prepare("SELECT payload_json FROM paper_plan_events WHERE plan_id = ? AND event_type = 'ENDED' ORDER BY sequence DESC LIMIT 1").get(id));
            if (!origin(id) || ended?.event_type !== "ENDED" || ended.payload.reason !== "OWNER_VOID" || Date.parse(ended.recorded_at) > Date.parse(event.recorded_at)) throw new Error("重选前须保留并作废全部原始三单");
            if (ended.payload.owner_request_ref !== request.request_id) throw new Error("重选请求与原单Owner作废授权不一致");
          }
        }
        if (event.event_type === "MARK") {
          const previous = parse(database.prepare("SELECT payload_json FROM paper_plan_events WHERE plan_id = ? AND event_type = 'MARK' ORDER BY sequence DESC LIMIT 1").get(event.plan_id));
          if (previous?.event_type === "MARK" && Date.parse(event.payload.quote.quoted_at) < Date.parse(previous.payload.quote.quoted_at)) throw new Error("不使用倒序报价覆盖后续观察");
        }
        database.prepare("INSERT INTO paper_plan_events (event_id, plan_id, market_date, event_type, recorded_at, payload_hash, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(event.event_id, event.plan_id, event.market_date, event.event_type, event.recorded_at, payloadHash, JSON.stringify(event));
        if (ownTransaction) database.exec("COMMIT");
        return { duplicate: false };
      } catch (error) { if (ownTransaction) database.exec("ROLLBACK"); throw error; }
    },
    eventsForPlan,
    learning(): PaperLearning {
      const sequence = exists ? (database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM paper_plan_events").get() as { sequence: number }).sequence : 0;
      if (learningCache?.sequence === sequence) return learningCache.value;
      // ponytail: aggregate after new paper events, then cache by append sequence; incremental aggregates only if measured slow.
      const events = rows(`SELECT payload_json FROM paper_plan_events WHERE event_type = 'CREATED'
        OR sequence IN (SELECT MIN(mark.sequence) FROM paper_plan_events mark JOIN paper_plan_events origin ON origin.plan_id = mark.plan_id AND origin.event_type = 'CREATED' WHERE mark.event_type = 'MARK'
          AND (json_extract(mark.payload_json, '$.payload.estimated_return_pct') >= json_extract(origin.payload_json, '$.payload.plan.take_profit_pct') OR json_extract(mark.payload_json, '$.payload.estimated_return_pct') <= json_extract(origin.payload_json, '$.payload.plan.stop_loss_pct') OR json_type(mark.payload_json, '$.payload.risk_exit') = 'object') GROUP BY mark.plan_id)
        OR sequence IN (SELECT MIN(sequence) FROM paper_plan_events WHERE event_type = 'GAP' GROUP BY plan_id)
        OR sequence IN (SELECT MAX(sequence) FROM paper_plan_events GROUP BY plan_id)
        ORDER BY sequence`);
      const value = projectPaperLearning(events);
      learningCache = { sequence, value };
      return value;
    },
    recentEvents() {
      if (!exists) return [];
      const events = rows(`SELECT origin.payload_json FROM paper_plan_events origin WHERE origin.event_type = 'CREATED'
        AND (NOT EXISTS (SELECT 1 FROM paper_plan_events ending WHERE ending.plan_id = origin.plan_id AND ending.event_type = 'ENDED')
          OR origin.sequence IN (SELECT sequence FROM paper_plan_events WHERE event_type = 'CREATED' ORDER BY sequence DESC LIMIT 10))
        ORDER BY origin.sequence DESC`);
      for (const created of [...events]) {
        // ponytail: bounded indexed reads per visible plan; retain causal window evidence, use a single window query only if measured slow.
        for (const order of ["sequence DESC", "CASE WHEN event_type = 'MARK' THEN 0 ELSE 1 END, sequence DESC", "CASE WHEN event_type = 'MARK' THEN 0 ELSE 1 END, json_extract(payload_json, '$.payload.estimated_return_pct') DESC", "CASE WHEN event_type = 'MARK' THEN 0 ELSE 1 END, json_extract(payload_json, '$.payload.estimated_return_pct') ASC"]) {
          const value = parse(database.prepare(`SELECT payload_json FROM paper_plan_events WHERE plan_id = ? ORDER BY ${order} LIMIT 1`).get(created.plan_id));
          if (value) events.push(value);
        }
        if (created.event_type !== "CREATED") continue;
        const plan = created.payload.plan, cutoff = paperTrackingWindow(plan).ends_at;
        const firstRow = database.prepare(`SELECT sequence, payload_json FROM paper_plan_events WHERE plan_id = ? AND event_type = 'MARK'
          AND (json_extract(payload_json, '$.payload.estimated_return_pct') >= ? OR json_extract(payload_json, '$.payload.estimated_return_pct') <= ? OR json_type(payload_json, '$.payload.risk_exit') = 'object') ORDER BY sequence LIMIT 1`).get(created.plan_id, plan.take_profit_pct, plan.stop_loss_pct) as { sequence: number; payload_json: string } | undefined;
        const first = parse(firstRow); if (first) events.push(first);
        const within = "plan_id = ? AND event_type = 'MARK' AND julianday(recorded_at) <= julianday(?) AND julianday(json_extract(payload_json, '$.payload.quote.quoted_at')) <= julianday(?)";
        for (const order of ["DESC", "ASC"]) {
          const value = parse(database.prepare(`SELECT payload_json FROM paper_plan_events WHERE ${within} ORDER BY json_extract(payload_json, '$.payload.estimated_return_pct') ${order}, sequence LIMIT 1`).get(created.plan_id, cutoff, cutoff));
          if (value) events.push(value);
        }
        const gap = parse(database.prepare("SELECT payload_json FROM paper_plan_events WHERE plan_id = ? AND event_type = 'GAP' AND julianday(recorded_at) <= julianday(?) ORDER BY sequence LIMIT 1").get(created.plan_id, cutoff));
        if (gap) events.push(gap);
        if (first?.event_type === "MARK" && first.payload.quote.bid < plan.reference.ask) {
          for (const threshold of [0, plan.take_profit_pct]) {
            const recovered = parse(database.prepare(`SELECT payload_json FROM paper_plan_events WHERE ${within} AND sequence > ?
              AND julianday(recorded_at) >= julianday(?) AND julianday(json_extract(payload_json, '$.payload.quote.quoted_at')) > julianday(?)
              AND json_extract(payload_json, '$.payload.estimated_return_pct') >= ? ORDER BY sequence LIMIT 1`).get(created.plan_id, cutoff, cutoff, firstRow!.sequence, first.recorded_at, first.payload.quote.quoted_at, threshold));
            if (recovered) events.push(recovered);
          }
        }
      }
      const attempted = rows("SELECT payload_json FROM paper_plan_events WHERE event_type = 'ATTEMPT' ORDER BY sequence DESC LIMIT 1");
      const ids = [...new Set([...events, ...attempted].map((event) => event.event_id))];
      return ids.length ? database.prepare(`SELECT payload_json FROM paper_plan_events WHERE event_id IN (${ids.map(() => "?").join(",")}) ORDER BY sequence`).all(...ids).map((row) => parse(row)!) : [];
    },
    activePlans(): PaperPlan[] {
      return rows(`SELECT origin.payload_json FROM paper_plan_events origin
        WHERE origin.event_type = 'CREATED' AND NOT EXISTS (SELECT 1 FROM paper_plan_events ending WHERE ending.plan_id = origin.plan_id AND ending.event_type = 'ENDED')
        ORDER BY (SELECT MAX(event.sequence) FROM paper_plan_events event WHERE event.plan_id = origin.plan_id), origin.sequence`)
        .flatMap((event) => event.event_type === "CREATED" ? [event.payload.plan] : []);
    },
  };
}
