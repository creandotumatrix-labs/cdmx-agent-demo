// Complete UAT — full stack + real-model adapter. Data-agnostic for the live
// real-estate inventory (SimplyRETS live, or the committed snapshot when offline).
//   node uat.mjs   → exits 0 if all pass, 1 otherwise.
import { spawn } from "child_process";

let pass = 0, fail = 0; const log = [];
const check = (name, cond, detail = "") => { cond ? pass++ : fail++; const line = `${cond ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`; log.push(line); console.log("  " + line); };
const section = (t) => { log.push("\n### " + t); console.log("\n" + t); };
const PORT = 3999, BASE = `http://localhost:${PORT}`;
const post = async (p, b) => (await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json();
const get = async (p) => (await fetch(BASE + p)).json();

// ---- 1) Real-estate tools — live inventory, data-agnostic ----
section("1) Real-estate tools — live inventory (data-agnostic)");
const tools = await import("./src/tools.js");
console.log("  inventory source:", tools.dataSource(), "·", tools.allListings().length, "listings");
const all = tools.search_listings({});
check("inventory returns listings", all.count > 0, all.count + " of " + tools.allListings().length);
check("every result has price + beds", all.listings.every((l) => l.precio > 0 && l.recamaras >= 0));
const prices = tools.allListings().map((l) => l.precio).sort((a, b) => a - b);
const mid = prices[Math.floor(prices.length / 2)] || 0;
check("max_precio filter respected", tools.search_listings({ max_precio: mid }).listings.every((l) => l.precio <= mid), "<= $" + mid.toLocaleString());
check("recamaras filter respected (>=3)", tools.search_listings({ recamaras: 3 }).listings.every((l) => l.recamaras >= 3));
check("impossible filter returns nothing (no hallucination)", tools.search_listings({ min_precio: 1e12 }).count === 0);

section("1b) Booking + handoff (direct)");
const pick = all.listings[0];
const bk = tools.book_viewing({ listing_id: pick.id, fecha: "jueves", hora: "5 pm", nombre: "Marcos", telefono: "55 1234 5678" });
check("book_viewing creates a booking with folio", bk.ok && /^VIS-/.test(bk.folio));
const ld = tools.create_lead({ nombre: "Marcos", telefono: "55 1234 5678", listing_id: pick.id });
check("create_lead returns a LEAD id", ld.ok && /^LEAD-/.test(ld.id));

// ---- 2) HTTP — server + restaurant white-label ----
section("2) HTTP — server + restaurant white-label");
const srv = spawn("node", ["server.js"], { env: { ...process.env, LLM: "offline", PORT: String(PORT) }, stdio: "ignore" });
process.on("exit", () => srv.kill());
for (let i = 0; i < 60; i++) { try { await get("/api/config?v=real_estate"); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
const cfgR = await get("/api/config?v=real_estate");
check("config: real-estate brand + live inventory source", cfgR.brand?.name?.includes("Casa Nova") && !!cfgR.source, cfgR.source);
const rc = await get("/api/config?v=restaurant");
check("config: restaurant re-brands (white-label swap)", rc.brand?.name?.includes("Agave"));
const o1 = await post("/api/chat", { sessionId: "uat-r", vertical: "restaurant", text: "quiero 3 tacos de pastor y una horchata" });
check("restaurant takes the order (tool fired)", o1.actions?.some((a) => a.tool === "add_to_order"));
check("restaurant offers an upsell", /guacamole|promo|🥑/i.test(o1.reply));
await post("/api/chat", { sessionId: "uat-r", vertical: "restaurant", text: "no, es todo" });
const close = await post("/api/chat", { sessionId: "uat-r", vertical: "restaurant", text: "para llevar a las 2pm" });
check("kitchen ticket total is tool-computed (125)", close.ticket?.total === 125, "total=" + close.ticket?.total);
srv.kill();

// ---- 3) Guardrails ----
section("3) Guardrails (direct)");
const sold = tools.add_to_order({ items: [{ id: "churros", qty: 1 }] }, "uat-86");
check("86'd item (churros) is refused", sold.added?.[0]?.ok === false && sold.order.items.length === 0);

// ---- 4) Real-model API adapter — native tool-loop (stubbed HTTP, real adapter code) ----
section("4) Real-model API adapter — native tool-loop (stubbed HTTP)");
process.env.LLM = "api"; process.env.ANTHROPIC_API_KEY = "uat";
let calls = 0;
globalThis.fetch = async (url, opts) => {
  calls++;
  const b = JSON.parse(opts.body);
  if (calls === 1) return { json: async () => ({ content: [{ type: "tool_use", id: "t1", name: "search_listings", input: { recamaras: 1 } }] }) };
  const sawResult = JSON.stringify(b.messages).includes("tool_result");
  return { json: async () => ({ content: [{ type: "text", text: sawResult ? "Tengo opciones para ti 👇" : "NO_RESULT" }] }) };
};
const { runAgent } = await import("./src/llm.js");
const { CONFIGS } = await import("./src/configs.js");
const apiRes = await runAgent(CONFIGS.real_estate, { id: "uat-api", vertical: "real_estate", history: [] }, "busca propiedades de al menos 1 recámara");
check("adapter executes the native tool call", apiRes.actions?.some((a) => a.tool === "search_listings"));
check("tool returned real listings to the model", apiRes.actions?.[0]?.result?.count >= 1);
check("model receives tool_result and replies", /opciones/i.test(apiRes.reply), apiRes.reply);

// ---- summary ----
section("Summary");
const total = pass + fail;
console.log(`\n${fail ? "❌ FAIL" : "✅ PASS"} — ${pass}/${total} checks passed\n`);
const { writeFileSync } = await import("fs");
writeFileSync("UAT-REPORT.md", `# UAT Report — cdmx-agent-demo

**Result:** ${fail ? "❌ FAIL" : "✅ PASS"} — ${pass}/${total} checks passed
**When:** ${new Date().toISOString()}
**Inventory source:** ${tools.dataSource()} (${tools.allListings().length} listings)

## Checks
${log.join("\n")}

## Reproduce
\`\`\`bash
node uat.mjs            # this suite
node verify-live.js     # the real model on your Max or an API key
\`\`\`
`);
console.log("Wrote UAT-REPORT.md");
process.exit(fail ? 1 : 0);
