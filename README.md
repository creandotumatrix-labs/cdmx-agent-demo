# CDMX Agent — White-Label WhatsApp Agents (MVP)

A real LLM agent: WhatsApp-style UI, native tool-calling over CDMX data, real bookings/orders/leads, Mexican Spanish. One runtime, two verticals (real estate + restaurant) swapped by config — the white-label pitch in one screen.

The agent is driven by a real model two ways: **your Max plan** (via the `claude` CLI, no per-token cost) or an **API key** (Anthropic or OpenRouter, native tool-calling). A deterministic offline mode exists only as stage insurance.

---

## Run on your Max plan (default, no per-token cost)
```bash
cd cdmx-agent-demo
claude            # confirm you're logged in on your Max plan, then /exit
unset ANTHROPIC_API_KEY     # so it uses the subscription, not API billing
node server.js             # LLM=claude-cli → drives `claude -p` with your Max
# open http://localhost:3000
```
Prove the real agent end-to-end (full qualify → search → book → lead flow) in your terminal:
```bash
node verify-live.js
```

## Run via API instead (most reliable; pennies/demo)
```bash
LLM=api ANTHROPIC_API_KEY=sk-ant-...  MODEL=claude-haiku-4-5  node server.js
# or OpenRouter (free + paid models, native tool-calling):
LLM=api OPENROUTER_API_KEY=or-...     MODEL=anthropic/claude-haiku-4.5  node server.js
```

## The honest trade-off (read before the client demo)
- **Max via `claude -p`** — no per-token cost, officially sanctioned for programmatic use. Caveats: it repurposes the coding CLI, and Anthropic is moving Agent-SDK/`-p` usage toward a separate credit pool (announced for Jun 15 2026, **paused** Jun 16). Great for cost; slightly less predictable.
- **API key (Anthropic/OpenRouter)** — rock-solid native tool-calling, fully predictable, **cents** for a whole demo. This is the reliability play for a client-facing "must be excellent" demo.

My recommendation: build and rehearse on Max; for the live client demo, keep an API key (or OpenRouter) configured as the path you actually present on, and the offline mode as the can't-fail backup.

## Offline backup (no model, no network)
```bash
LLM=offline node server.js      # deterministic agent — calls the SAME real tools
node _test_llm.mjs              # 7-point grounded-tools smoke test
```

---

## Demo script (90 seconds)
1. **Real estate:** `Hola, busco rentar en la Roma` → answer its questions (budget `25 mil`, `2 recámaras`) → 3 real listings with photos → `quiero agendar la 1` → give a day/time → `Marcos, 55 1234 5678`.
2. Hit **📋 Vista del asesor** → the qualified lead + booked viewing the agent handed off (also written to `_handoff.json`).
3. **Swap to 🌮 Restaurante** (top toggle) → header re-brands instantly, same backend → `3 tacos de pastor y una horchata` → it upsells guac → `es todo` → `para llevar 2pm` → kitchen **ticket** prints. That swap is the white-label story.

## Architecture (the product part)
```
server.js          HTTP server (Node built-in, zero deps)
llm.js         ← the agent: shared tool-loop + claude-cli (Max) and api adapters
tools.js       grounded tool handlers (search_listings, book_viewing, create_order, …)
configs.js     ← white-label config packs (persona + brand + tools per vertical)
mockAgent.js   offline deterministic fallback
listings.json ~12 CDMX listings   (swap this = new brokerage)
menu.json     taquería menu         (swap this = new restaurant)
index.html  WhatsApp-style UI
verify-live.js     one-command real-agent proof
```
**Adding a client or vertical = a new config pack + a data file. No code change.** That's what makes it resellable.

## Guardrails
- Grounded only — the agent shows/sells **only** what the tools return; no invented inventory, prices, or totals.
- Totals and bookings are computed by tools, not the model.
- Out-of-catalog requests decline gracefully (try `¿tienen algo en Cancún?`).

## What's verified vs. on your machine
- ✅ Tools, grounding, totals, the offline flow, and the **API tool-loop** (stubbed HTTP, real adapter code) — all tested here.
- ▶️ The real model itself runs on **your** machine (the model is your Max / your key). `node verify-live.js` is the 5-second proof.

## Phase 2 (not needed for the demo)
Front this same runtime with a real **WhatsApp Cloud API** number (test number = same-day, no verification) and point `book_viewing`/`create_lead` at **Google Calendar / Sheets**. The tool interfaces don't change — only their implementations.
