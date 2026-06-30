# Run it — real agent, ~2 minutes

This is a real LLM agent (native tool-calling, grounded, Mexican Spanish). It runs on a model — your **Max plan** (free) or an **API key** (pennies). The deterministic offline agent is **CI-only** (`LLM=offline`) and never runs in front of a client.

## Clone
```bash
git clone https://github.com/adventurewave-labs/cdmx-agent-demo.git
cd cdmx-agent-demo            # zero npm install needed — no runtime deps
```

## Pick ONE way to run

**A) Your Max plan — free**
```bash
claude            # confirm you're logged in (Max), then /exit
unset ANTHROPIC_API_KEY
node server.js                       # → http://localhost:3000   (badge: LIVE)
```

**B) API key — most reliable for a client demo (cents)**
```bash
LLM=api ANTHROPIC_API_KEY=sk-ant-...  MODEL=claude-sonnet-4-6  node server.js
# OpenRouter works too:  LLM=api OPENROUTER_API_KEY=or-...  MODEL=anthropic/claude-sonnet-4.6  node server.js
```
`MODEL` is optional (defaults to a fast Haiku). For the most natural es-MX in front of a client, use **`claude-sonnet-4-6`**.

## Prove it's real — do this TONIGHT
```bash
node verify-live.js          # runs a full real-estate conversation through the REAL model
```
Green output = the agent qualified, searched, booked, and handed off using real tool calls. If this is green tonight, tomorrow is solid. (If it errors, you're not on a model — fix auth/key before the meeting.)

## Demo script (90 seconds)
1. **Real estate:** type `Busco casa para comprar` → give a budget (e.g., `hasta 500,000`) and `3 recámaras` → **real MLS listings with real photos** appear (live from the SimplyRETS API — the header shows "Inventario: SimplyRETS API (en vivo)") → tap **Agendar la 1** → give a day/time → `Marcos, 55 1234 5678`.
2. Hit **📋 Vista del asesor** → the qualified lead + booked viewing the agent captured and handed to the human.
3. Toggle **🌮 Restaurante** → the whole UI re-brands (same engine) → `3 tacos de pastor y una horchata` → it upsells guac → `es todo` → `para llevar 2pm` → a kitchen ticket prints.

The line that sells it: *"one engine, swap a config file = a new business — that's what your clients in CDMX resell."*

## What's real vs. what's next
- **Real now:** the LLM agent, native tool-calling, grounded data (no hallucinations), tool-computed totals, structured human handoff, white-label vertical swap, the WhatsApp-style UX.
- **Next (productization, not needed to show the MVP):** a real WhatsApp Cloud API number, the client's own catalog/menu, real Google Calendar / CRM / POS writes, a database, multi-tenant + billing. See `cdmx-agent-STATUS.md`.

## Deploy to Railway (live URL)
1. railway.app → **New Project → Deploy from GitHub repo** → `adventurewave-labs/cdmx-agent-demo`.
2. **+ New → Database → PostgreSQL** — Railway injects `DATABASE_URL`; the app creates its tables on boot and rehydrates the dashboard after restarts.
3. Service **Variables:** `LLM=api`, `ANTHROPIC_API_KEY=…`, `MODEL=claude-sonnet-4-6` (add `DATABASE_SSL=true` only if your Postgres needs SSL).
4. Deploy. Nixpacks builds it, starts `node server.js`, healthchecks `/health`, and **auto-deploys on every push to `main`**. The public URL serves the chat at `/` and the broker dashboard at `/dashboard`.

Without `DATABASE_URL` the app runs in memory mode (zero deps); durable Postgres turns on automatically once the plugin is attached.

## Quick checks
```bash
npm test      # UAT — 16 checks over the real tools (CI uses LLM=offline)
npm run smoke # grounded-tools smoke test
```
