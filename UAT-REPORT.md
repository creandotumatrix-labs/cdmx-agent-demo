# UAT Report — cdmx-agent-demo

**Result:** ✅ PASS — 22/22 checks passed
**When:** 2026-06-30T00:33:29.315Z
**Scope:** full stack via HTTP (deterministic offline agent over the real tools) + the real-model API adapter (HTTP stubbed, adapter code real).
**Not covered here:** live model *quality* (es-MX phrasing) — that needs your Max/key and is exercised by `verify-live.js`.

## Checks

### 1) HTTP end-to-end — real estate
✅ config returns brokerage brand  — Casa Nova Inmobiliaria
✅ config exposes a greeting
✅ qualifies before searching (asks budget)
✅ returns grounded listings  — count=2
✅ every result respects budget (<=25000)
✅ every result is in Roma Norte
✅ every result has >= 2 recámaras
✅ confirms the booking to the user
✅ lead handed off with contact + listing
✅ viewing booked with folio

### 1b) HTTP — grounding / no hallucination
✅ out-of-catalog returns zero listings
✅ agent declines gracefully (no invented inventory)

### 2) HTTP end-to-end — restaurant (white-label swap)
✅ config re-brands to the restaurant  — Taquería El Agave
✅ takes the order (tool fired)
✅ offers an upsell
✅ emits a kitchen ticket  — A-241
✅ ticket total is tool-computed (3×30 + 35 = 125)  — total=125

### 3) Tool guardrails (direct)
✅ 86'd item (churros, disponible:false) is refused
✅ sale search returns only 'venta' listings

### 4) Real model adapter — API tool-loop (stubbed HTTP, real adapter code)
✅ adapter executes the native tool call
✅ tool returned grounded listings to the model
✅ model receives tool_result and replies  — Tengo 2 opciones en Roma Norte 👇

### Summary

## How to reproduce
```bash
node uat.mjs            # this suite
node verify-live.js     # real model on your Max (LLM=claude-cli) or API key
```
