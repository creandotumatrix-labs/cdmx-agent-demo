// Offline smoke test — no model, no network. Verifies the grounded tools.
//   node _test_llm.mjs
import { search_listings, add_to_order, create_order } from "./tools.js";

let pass = 0, fail = 0;
const ok = (name, cond) => (cond ? (pass++, console.log("  ✅ " + name)) : (fail++, console.log("  ❌ " + name)));

console.log("Real estate tools:");
const a = search_listings({ op: "renta", colonia: "Roma", max_precio: 25000, recamaras: 2 });
ok("rent/Roma/<=25k/2rec returns matches", a.count > 0);
ok("all results respect budget", a.listings.every((l) => l.precio <= 25000));
ok("all results are Roma Norte", a.listings.every((l) => l.colonia === "Roma Norte"));
ok("all results >= 2 recámaras", a.listings.every((l) => l.recamaras >= 2));

const none = search_listings({ op: "renta", colonia: "Cancun", max_precio: 5000 });
ok("out-of-catalog (Cancún) returns nothing (no hallucination)", none.count === 0);

console.log("Restaurant tools:");
add_to_order({ items: [{ id: "taco_pastor", qty: 3 }, { id: "agua_horchata", qty: 1 }] }, "smoke");
const ord = create_order({ tipo: "para llevar", hora: "2pm" }, "smoke");
ok("order total is tool-computed (3×30 + 35 = 125)", ord.total === 125);
ok("kitchen ticket has a folio", /^A-\d+$/.test(ord.folio));

console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
