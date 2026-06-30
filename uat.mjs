// Complete UAT — runs the full stack and asserts behavior end-to-end.
//   node uat.mjs
// Exits 0 if all pass, 1 otherwise. Same script runs locally or in a Codespace.
import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";

let pass = 0, fail = 0;
const log = [];
const check = (name, cond, detail = "") => {
  (cond ? (pass++) : (fail++));
  const line = `${cond ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`;
  log.push(line); console.log("  " + line);
};
const section = (t) => { log.push("\n### " + t); console.log("\n" + t); };
const PORT = 3999, BASE = `http://localhost:${PORT}`;
const post = async (path, body) => (await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
const get = async (path) => (await fetch(BASE + path)).json();
const SID = "uat-" + Date.now();

// ---------------- 1) HTTP end-to-end (offline server = deterministic full stack) ----------------
section("1) HTTP end-to-end — real estate");
const srv = spawn("node", ["server.js"], { env: { ...process.env, LLM: "offline", PORT: String(PORT) }, stdio: "ignore" });
process.on("exit", () => srv.kill());
// wait for boot
for (let i = 0; i < 40; i++) { try { await get("/api/config?v=real_estate"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

const cfg = await get("/api/config?v=real_estate");
check("config returns brokerage brand", cfg.brand?.name?.includes("Casa Nova"), cfg.brand?.name);
check("config exposes a greeting", typeof cfg.greeting === "string" && cfg.greeting.length > 0);

const q1 = await post("/api/chat", { sessionId: SID, vertical: "real_estate", text: "Hola, busco rentar en la Roma" });
check("qualifies before searching (asks budget)", /presupuesto/i.test(q1.reply) && !(q1.listings?.length));

const q2 = await post("/api/chat", { sessionId: SID, vertical: "real_estate", text: "hasta 25 mil, 2 recámaras" });
check("returns grounded listings", q2.listings?.length >= 1, `count=${q2.listings?.length}`);
check("every result respects budget (<=25000)", q2.listings?.every((l) => l.precio <= 25000));
check("every result is in Roma Norte", q2.listings?.every((l) => l.colonia === "Roma Norte"));
check("every result has >= 2 recámaras", q2.listings?.every((l) => l.recamaras >= 2));

await post("/api/chat", { sessionId: SID, vertical: "real_estate", text: "quiero agendar la 1" });
await post("/api/chat", { sessionId: SID, vertical: "real_estate", text: "el jueves" });
await post("/api/chat", { sessionId: SID, vertical: "real_estate", text: "5 pm" });
const done = await post("/api/chat", { sessionId: SID, vertical: "real_estate", text: "Marcos, 55 1234 5678" });
check("confirms the booking to the user", /agendad|listo|✅/i.test(done.reply));

const handoff = await get("/api/handoff");
check("lead handed off with contact + listing", handoff.leads?.some((l) => l.nombre && l.telefono && l.listing_id));
check("viewing booked with folio", handoff.bookings?.some((b) => /^VIS-/.test(b.folio)));

section("1b) HTTP — grounding / no hallucination");
const oot = await post("/api/chat", { sessionId: "uat-oot", vertical: "real_estate", text: "busco rentar en Cancún con 5000" });
check("out-of-catalog returns zero listings", !(oot.listings?.length));
check("agent declines gracefully (no invented inventory)", /no encontr|no tengo|cercano|ajust/i.test(oot.reply));

section("2) HTTP end-to-end — restaurant (white-label swap)");
await post("/api/reset", { sessionId: "uat-r" });
const rc = await get("/api/config?v=restaurant");
check("config re-brands to the restaurant", rc.brand?.name?.includes("Agave"), rc.brand?.name);
const o1 = await post("/api/chat", { sessionId: "uat-r", vertical: "restaurant", text: "quiero 3 tacos de pastor y una horchata" });
check("takes the order (tool fired)", o1.actions?.some((a) => a.tool === "add_to_order"));
check("offers an upsell", /guacamole|promo|🥑/i.test(o1.reply));
await post("/api/chat", { sessionId: "uat-r", vertical: "restaurant", text: "no, es todo" });
const close = await post("/api/chat", { sessionId: "uat-r", vertical: "restaurant", text: "para llevar a las 2pm" });
check("emits a kitchen ticket", !!close.ticket, close.ticket?.folio);
check("ticket total is tool-computed (3×30 + 35 = 125)", close.ticket?.total === 125, "total=" + close.ticket?.total);

srv.kill();

// ---------------- 2) In-process — tools, guardrails, model adapter ----------------
section("3) Tool guardrails (direct)");
const tools = await import("./tools.js");
const sold = tools.add_to_order({ items: [{ id: "churros", qty: 1 }] }, "uat-86");
check("86'd item (churros, disponible:false) is refused", sold.added?.[0]?.ok === false && sold.order.items.length === 0);
const venta = tools.search_listings({ op: "venta", colonia: "Polanco" });
check("sale search returns only 'venta' listings", venta.listings.every((l) => l.op === "venta") && venta.count >= 1);

section("4) Real model adapter — API tool-loop (stubbed HTTP, real adapter code)");
process.env.LLM = "api";
process.env.ANTHROPIC_API_KEY = "uat";
let calls = 0;
globalThis.fetch = async (url, opts) => {
  calls++;
  const b = JSON.parse(opts.body);
  if (calls === 1) {
    const sentTools = b.tools?.length > 0;
    return { json: async () => ({ _sentTools: sentTools, content: [{ type: "tool_use", id: "t1", name: "search_listings", input: { op: "renta", colonia: "Roma", max_precio: 25000, recamaras: 2 } }] }) };
  }
  const sawResult = JSON.stringify(b.messages).includes("tool_result");
  return { json: async () => ({ _sawResult: sawResult, content: [{ type: "text", text: sawResult ? "Tengo 2 opciones en Roma Norte 👇" : "NO_RESULT" }] }) };
};
const { runAgent } = await import("./llm.js");
const { CONFIGS } = await import("./configs.js");
const apiRes = await runAgent(CONFIGS.real_estate, { id: "uat-api", vertical: "real_estate", history: [] }, "rentar en la Roma, 25 mil, 2 recamaras");
check("adapter executes the native tool call", apiRes.actions?.some((a) => a.tool === "search_listings"));
check("tool returned grounded listings to the model", apiRes.actions?.[0]?.result?.count >= 1);
check("model receives tool_result and replies", /Roma Norte/.test(apiRes.reply), apiRes.reply);

// ---------------- summary + report ----------------
section("Summary");
const total = pass + fail;
console.log(`\n${fail ? "❌ FAIL" : "✅ PASS"} — ${pass}/${total} checks passed\n`);

const report = `# UAT Report — cdmx-agent-demo

**Result:** ${fail ? "❌ FAIL" : "✅ PASS"} — ${pass}/${total} checks passed
**When:** ${new Date().toISOString()}
**Scope:** full stack via HTTP (deterministic offline agent over the real tools) + the real-model API adapter (HTTP stubbed, adapter code real).
**Not covered here:** live model *quality* (es-MX phrasing) — that needs your Max/key and is exercised by \`verify-live.js\`.

## Checks
${log.join("\n")}

## How to reproduce
\`\`\`bash
node uat.mjs            # this suite
node verify-live.js     # real model on your Max (LLM=claude-cli) or API key
\`\`\`
`;
const { writeFileSync } = await import("fs");
writeFileSync("UAT-REPORT.md", report);
console.log("Wrote UAT-REPORT.md");
process.exit(fail ? 1 : 0);
