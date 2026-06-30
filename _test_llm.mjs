// Offline smoke test — grounded tools, data-agnostic (works with live or cached inventory).
//   node _test_llm.mjs
import { search_listings, add_to_order, create_order, dataSource, allListings } from "./src/tools.js";

let pass = 0, fail = 0;
const ok = (name, cond) => (cond ? (pass++, console.log("  ✅ " + name)) : (fail++, console.log("  ❌ " + name)));

console.log("Inventory:", dataSource(), "·", allListings().length, "listings");
const all = search_listings({});
ok("inventory returns listings", all.count > 0);
ok("results carry price + beds", all.listings.every((l) => l.precio > 0 && l.recamaras >= 0));
const prices = allListings().map((l) => l.precio).sort((a, b) => a - b);
const mid = prices[Math.floor(prices.length / 2)] || 0;
ok("max_precio filter respected", search_listings({ max_precio: mid }).listings.every((l) => l.precio <= mid));
ok("impossible filter returns nothing (no hallucination)", search_listings({ min_precio: 1e12 }).count === 0);

console.log("Restaurant tools:");
add_to_order({ items: [{ id: "taco_pastor", qty: 3 }, { id: "agua_horchata", qty: 1 }] }, "smoke");
const ord = create_order({ tipo: "para llevar", hora: "2pm" }, "smoke");
ok("order total is tool-computed (3×30 + 35 = 125)", ord.total === 125);
ok("kitchen ticket has a folio", /^A-\d+$/.test(ord.folio));

console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
