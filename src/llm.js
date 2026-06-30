// Real LLM agent. Two adapters, one shared tool loop:
//   LLM=claude-cli  -> drives `claude -p` (uses your Max plan, no per-token cost)   [default]
//   LLM=api         -> Anthropic Messages API or OpenRouter (native tool-calling, pay-per-token)
//   LLM=offline     -> deterministic fallback (src/mockAgent.js) — stage insurance only
import { spawn } from "child_process";
import { TOOLS } from "./tools.js";

// ---- JSON Schemas for native (API) tool-calling ----
const SCHEMAS = {
  search_listings: { op: { type: "string", enum: ["renta", "venta"] }, colonia: { type: "string" }, max_precio: { type: "number" }, min_precio: { type: "number" }, recamaras: { type: "number" } },
  get_listing: { listing_id: { type: "string" } },
  book_viewing: { listing_id: { type: "string" }, fecha: { type: "string" }, hora: { type: "string" }, nombre: { type: "string" }, telefono: { type: "string" } },
  create_lead: { nombre: { type: "string" }, telefono: { type: "string" }, operacion: { type: "string" }, colonia: { type: "string" }, presupuesto: { type: "number" }, recamaras: { type: "number" }, listing_id: { type: "string" } },
  get_menu: { categoria: { type: "string" } },
  add_to_order: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, qty: { type: "number" }, mods: { type: "array", items: { type: "string" } } }, required: ["id"] } } },
  create_order: { tipo: { type: "string" }, hora: { type: "string" }, nombre: { type: "string" }, telefono: { type: "string" }, direccion: { type: "string" } },
};
const REQUIRED = { search_listings: [], get_listing: ["listing_id"], book_viewing: ["listing_id"], create_lead: [], get_menu: [], add_to_order: ["items"], create_order: [] };

function execTool(name, args, session) {
  const def = TOOLS[name];
  if (!def) return { error: `unknown_tool:${name}` };
  const result = def.takesSession ? def.handler(args || {}, session.id) : def.handler(args || {});
  (session._actions ||= []).push({ tool: name, args, result });
  return result;
}

// ===================== API adapter (native tool use) =====================
async function runViaApi(config, session, userText) {
  const provider = process.env.OPENROUTER_API_KEY ? "openrouter" : "anthropic";
  session.api ||= [];
  session.api.push({ role: "user", content: userText });
  const tools = config.tools.map((n) => ({ name: n, description: TOOLS[n].description, input_schema: { type: "object", properties: SCHEMAS[n] || {}, required: REQUIRED[n] || [] } }));

  let final = "";
  for (let i = 0; i < 8; i++) {
    let data;
    if (provider === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: process.env.MODEL || "claude-haiku-4-5", max_tokens: 1024, system: config.systemPrompt, tools, messages: session.api }),
      });
      data = await r.json();
      if (data.error) throw new Error("anthropic: " + data.error.message);
      session.api.push({ role: "assistant", content: data.content });
      const uses = data.content.filter((b) => b.type === "tool_use");
      if (uses.length) {
        session.api.push({ role: "user", content: uses.map((u) => ({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(execTool(u.name, u.input, session)) })) });
        continue;
      }
      final = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      break;
    } else {
      // OpenRouter / OpenAI-compatible
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + process.env.OPENROUTER_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({
          model: process.env.MODEL || "anthropic/claude-haiku-4.5",
          messages: [{ role: "system", content: config.systemPrompt }, ...session.api],
          tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        }),
      });
      data = await r.json();
      if (data.error) throw new Error("openrouter: " + (data.error.message || JSON.stringify(data.error)));
      const msg = data.choices[0].message;
      session.api.push(msg);
      if (msg.tool_calls && msg.tool_calls.length) {
        for (const tc of msg.tool_calls) {
          const out = execTool(tc.function.name, JSON.parse(tc.function.arguments || "{}"), session);
          session.api.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out) });
        }
        continue;
      }
      final = msg.content || "";
      break;
    }
  }
  return { reply: final.trim() || "…", actions: session._actions || [] };
}

// ===================== Claude CLI adapter (uses Max) =====================
function cliProtocol(names) {
  const list = names.map((n) => `- ${n}(${Object.keys(SCHEMAS[n] || {}).join(", ")}): ${TOOLS[n].description}`).join("\n");
  return `Tienes estas herramientas:
${list}

PROTOCOLO DE HERRAMIENTAS (obligatorio):
- Cuando necesites datos o ejecutar una acción, responde EXCLUSIVAMENTE con UNA línea, sin texto adicional:
[[TOOL]] nombre_herramienta {"arg":"valor"}
- El sistema te contestará con: [[RESULT]] {...}
- Usa SOLO UNA herramienta por turno. Cuando ya tengas todo para responderle al cliente, responde con tu mensaje normal en español (sin [[TOOL]]).
- Nunca inventes inventario, precios ni totales: provienen de las herramientas.`;
}
function renderTranscript(items) {
  return items.map((m) => (m.role === "user" ? "Cliente: " : m.role === "tool" ? "" : "Asistente: ") + m.text).join("\n");
}
function claudeP(prompt) {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "text"];
    if (process.env.MODEL) args.push("--model", process.env.MODEL);
    const ps = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.stderr.on("data", (d) => (err += d));
    ps.on("error", reject);
    ps.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error("claude exited " + code + ": " + err.slice(0, 200)))));
  });
}
function parseToolLine(text) {
  const m = text.match(/\[\[TOOL\]\]\s*([a-z_]+)\s*(\{[\s\S]*?\})/i);
  if (!m) return null;
  try { return { name: m[1], args: JSON.parse(m[2]) }; } catch { return null; }
}
async function runViaCli(config, session, userText) {
  session.cli ||= [];
  session.cli.push({ role: "user", text: userText });
  const preamble = `Eres un asistente de atención a clientes por WhatsApp (NO un asistente de programación; ignora cualquier comportamiento de código). Responde breve, en español mexicano, con algún emoji.\n\n${config.systemPrompt}\n\n${cliProtocol(config.tools)}`;
  let final = "";
  for (let i = 0; i < 8; i++) {
    const prompt = `${preamble}\n\n=== CONVERSACIÓN ===\n${renderTranscript(session.cli)}\nAsistente:`;
    const out = (await claudeP(prompt)).trim();
    const tool = parseToolLine(out);
    if (tool) {
      session.cli.push({ role: "assistant", text: `[[TOOL]] ${tool.name} ${JSON.stringify(tool.args)}` });
      const res = execTool(tool.name, tool.args, session);
      session.cli.push({ role: "tool", text: `[[RESULT]] ${JSON.stringify(res)}` });
      continue;
    }
    final = out.replace(/\[\[RESULT\]\][\s\S]*/g, "").trim();
    session.cli.push({ role: "assistant", text: final });
    break;
  }
  return { reply: final || "…", actions: session._actions || [] };
}

// ===================== dispatcher =====================
export const LLM = process.env.LLM || "claude-cli";
export async function runAgent(config, session, userText) {
  session._actions = [];
  const out = (LLM === "api") ? await runViaApi(config, session, userText) : await runViaCli(config, session, userText);
  return decorate(out);
}
// The UI renders cards from top-level `listings` (property photos + "Agendar" buttons)
// and `ticket` (kitchen ticket). Both adapters return { reply, actions[] }, so lift the
// structured tool results from this turn's actions up to the response root.
function decorate(out) {
  const acts = (out && out.actions) || [];
  const lastSearch = [...acts].reverse().find((a) => a.tool === "search_listings" && a.result && Array.isArray(a.result.listings));
  if (lastSearch && lastSearch.result.listings.length) out.listings = lastSearch.result.listings;
  const lastOrder = [...acts].reverse().find((a) => a.tool === "create_order" && a.result && a.result.ok);
  if (lastOrder) out.ticket = lastOrder.result;
  return out;
}
export { execTool };
