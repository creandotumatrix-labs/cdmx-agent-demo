// HTTP server. Default = REAL LLM agent on your Max plan via `claude -p`.
//   node server.js                 → real agent (LLM=claude-cli)
//   LLM=api ANTHROPIC_API_KEY=...   → real agent via Anthropic API (or OPENROUTER_API_KEY)
//   LLM=offline node server.js      → deterministic fallback (no model)
import http from "http";
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { CONFIGS, DEFAULT_VERTICAL } from "./src/configs.js";
import { mockRespond } from "./src/mockAgent.js";
import { runAgent, LLM } from "./src/llm.js";
import { _state } from "./src/tools.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const sessions = new Map();
// Badge honesty: only claim "live" if a model is actually reachable.
function liveUsable() {
  if (LLM === "offline") return false;
  if (LLM === "api") return !!(process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY);
  try { execSync("command -v claude", { stdio: "ignore" }); return true; } catch { return false; }
}
const uiMode = liveUsable() ? "live" : (LLM === "offline" ? "demo" : "nomodel");

function getSession(id, vertical) {
  let s = sessions.get(id);
  if (!s || s.vertical !== vertical) { s = { id, vertical, slots: null, history: [] }; sessions.set(id, s); }
  return s;
}
function persist() {
  try { writeFileSync(path.join(__dir, "data", "_handoff.json"), JSON.stringify({ leads: _state.leads, bookings: _state.bookings }, null, 2)); } catch {}
}
// Mock runs ONLY when explicitly requested (LLM=offline, for dev/CI). In any live
// mode a model failure fails loudly — it never silently falls back to a mock.
async function respond(config, session, text) {
  if (LLM === "offline") return mockRespond(config, session, text);
  try { return await runAgent(config, session, text); }
  catch (e) {
    console.error("[live model error]", e.message);
    return { reply: "⚠️ No hay un modelo disponible. Inicia sesión en Claude Code (plan Max), o usa LLM=api con una API key. Para pruebas sin modelo: LLM=offline.", _error: e.message };
  }
}

const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d ? JSON.parse(d) : {})); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(readFileSync(path.join(__dir, "public", "index.html"), "utf8"));
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      const c = CONFIGS[url.searchParams.get("v") || DEFAULT_VERTICAL] || CONFIGS[DEFAULT_VERTICAL];
      return send(res, 200, { mode: uiMode, llm: LLM, vertical: c.id, brand: c.brand, greeting: c.greeting, starters: c.starters });
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const { sessionId = "default", vertical = DEFAULT_VERTICAL, text = "" } = await body(req);
      const config = CONFIGS[vertical] || CONFIGS[DEFAULT_VERTICAL];
      const out = await respond(config, getSession(sessionId, vertical), text);
      persist();
      return send(res, 200, out);
    }
    if (req.method === "POST" && url.pathname === "/api/reset") {
      const { sessionId = "default" } = await body(req); sessions.delete(sessionId); return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/handoff") {
      return send(res, 200, { leads: _state.leads, bookings: _state.bookings });
    }
    send(res, 404, { error: "not_found" });
  } catch (e) { console.error(e); send(res, 500, { error: e.message }); }
});

server.listen(PORT, () => {
  console.log(`\n  CDMX Agent Demo  ·  LLM: ${LLM}  ·  badge: ${uiMode.toUpperCase()}`);
  console.log(`  ▶  http://localhost:${PORT}\n`);
  if (uiMode === "demo") console.log("  No model reachable — running the deterministic DEMO agent (badge shows DEMO).\n  For the real agent: have `claude` on PATH (LLM=claude-cli), or set LLM=api with a key.\n");
  else if (LLM === "claude-cli") console.log("  Live on your Max plan via `claude -p`.\n");
  else console.log(`  Live via ${process.env.OPENROUTER_API_KEY ? "OpenRouter" : "Anthropic API"}. Model: ${process.env.MODEL || "default"}.\n`);
});
