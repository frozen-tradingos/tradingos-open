---
name: tradingos-research
description: Use the bundled Trading OS Open local program for market research, conditional trade studies, trading plans and reviews. Use when the user asks to set up this package, check data or authorization readiness, generate a real TS forecast through its existing pipeline, or review its evidence. Requires the companion program; never invent forecasts, broker connections or performance.
---

# Trading OS research companion

## Find and check the program

This repository-scoped Skill ships with its companion program. The package root is three directories above this folder and contains `package.json`, `tools/public-entry.mjs`, `web/`, and `v2-reference/`. If those are missing, explain that the Skill alone is not the application. Do not download an unrelated project or silently use another Trading OS checkout.

Read the package `AGENTS.md` and `README.md`. Work only in this copy. Existing personal deployments and their data, accounts, processes and ports are out of scope.

Run from the package root:

```text
node --experimental-strip-types tools/public-entry.mjs doctor
```

The doctor is offline: completed local authorization steps are not proof that remote permissions remain valid. Never print configuration contents, credentials, login links, tokens or account identifiers.

## First use

Guide the user through `Start.cmd` or `pnpm setup`. Environment preparation, a local password, their own model login and supported broker authorization are separate steps. Users enter credentials only in the provider's official flow or the local hidden-input prompt, never in chat.

The initial candidate supports Windows x64 and Robinhood official MCP read-only. Other brokers, SnapTrade, SaaS accounts, cloud hosting, domain purchase and billing are not connected. Do not claim otherwise. Optional news access requires the user's own Finnhub authorization and applicable entitlement.

Default start is a blank local workspace without external requests. Automatic analysis requires an explicit user-enabled live session. Explain that market/account evidence is sent to the user's model provider and usage may consume quota or incur charges. Do not enable it, log into a provider, purchase data or install a service as an implicit step in a research request.

## Research and forecasts

Use the existing A1 → A2 → TS → review/risk pipeline and contracts. Do not replace it with a paragraph written by the assistant. Before presenting an output as current, verify its actual source, market timestamp, target session, authorization status and freshness from this copy's local evidence.

- Missing permission, missing data, stale prices or incomplete risk settings means blocked / not ready, not an invented forecast.
- Keep current-session analysis separate from next-session forecasts. An expired forecast is not a current entry signal.
- A direction is not permission to trade. Preserve trigger, invalidation, risk and evidence conditions.
- Do not alter TS algorithms, thresholds, probabilities or risk rules to make an output look successful.
- Never replay, backfill or relabel a missed natural slot as a successful live run.
- Synthetic samples and offline tests must stay labeled and excluded from real prediction accuracy and P/L.

Report briefly: data time and target session; result and uncertainty; conditions/invalidations; what is blocked; and the next safe action. This is research assistance, not order placement, suitability advice or guaranteed returns.

## Plans and reviews

Use only this user's explicit inputs and records in this copy. Never inherit another user's capital, holdings, loss limits, watchlist or private thesis. Ask for missing personal settings rather than applying sample capital as a recommendation.

Separate forecast correctness, path/condition correctness and actual realized trade outcome. Do not infer fills or profits from price touches. Keep original plans and failures; add a review instead of rewriting history.

## Safety boundaries

Broker tools must remain read-only. Never place/cancel orders, invoke undocumented broker tools, enable a production manager, change firewall/scheduled tasks or touch ports 4070–4076. Test with synthetic local adapters, not real broker/model calls.

Before handing off changes, run the smallest relevant local checks and name untested live steps. Never publish, add a remote, push a package or select a final license without the Owner's approval. A passing install is not evidence of prediction accuracy or profitability.
