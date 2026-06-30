// Proves the REAL agent works on your machine. Runs a full real-estate
// conversation through the live model and prints replies + the tools it fired.
//   node verify-live.js                          # uses your Max via `claude -p`
//   LLM=api ANTHROPIC_API_KEY=sk-... node verify-live.js
import { CONFIGS } from "./configs.js";
import { runAgent, LLM } from "./llm.js";

const turns = [
  "Hola, vi un anuncio, busco rentar en la Roma",
  "mi presupuesto es hasta 25 mil y quiero 2 recámaras",
  "me gusta la primera, quiero agendar una visita",
  "el jueves a las 5pm",
  "Marcos Pérez, mi teléfono es 55 1234 5678",
];

console.log(`\n=== verify-live · LLM=${LLM} ===`);
const session = { id: "verify", vertical: "real_estate", history: [] };
for (const t of turns) {
  console.log(`\n👤 ${t}`);
  try {
    const r = await runAgent(CONFIGS.real_estate, session, t);
    console.log(`🤖 ${r.reply}`);
    if (r.actions?.length) console.log(`   ⚙️  ${r.actions.map((a) => a.tool).join(" → ")}`);
  } catch (e) {
    console.error(`   ❌ ${e.message}`);
    console.error("   (For LLM=claude-cli, make sure `claude` runs in your terminal and ANTHROPIC_API_KEY is unset.)");
    process.exit(1);
  }
}
console.log("\n✅ Real agent completed the flow end-to-end.\n");
