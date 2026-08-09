// Tool handlers. The real-estate catalog is sourced LIVE from the SimplyRETS demo
// API (real MLS-style listings + photos) at startup, with a committed real snapshot
// as the offline/CI fallback. Override creds with SIMPLYRETS_USER / SIMPLYRETS_PASS.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import * as store from "./store.js";
import * as integrations from "./integrations.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(path.join(__dir, "..", "data", f), "utf8"));

let MENU = load("menu.json");
let MENU_SOURCE = "menú local (respaldo)";
export const menuSource = () => MENU_SOURCE;

// Restaurant menu sourced LIVE from a real food API (TheMealDB), mapped to menu items.
// Prices are representative MXN until a real POS (Square/Toast) is connected. Falls back
// to the committed menu.json when offline/blocked. Parallel to the SimplyRETS listing feed.
async function loadMenuLive() {
  if ((process.env.MENU || "live").toLowerCase() !== "live") return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch("https://www.themealdb.com/api/json/v1/1/filter.php?a=Mexican", { signal: ctrl.signal });
    if (!r.ok) throw new Error("themealdb " + r.status);
    const meals = ((await r.json()) || {}).meals || [];
    const mapped = meals.map((m) => {
      const id = String(m.idMeal);
      const precio = 55 + (parseInt(id.slice(-2), 10) % 9) * 15; // representative MXN 55–175
      return { id: "M" + id, nombre: m.strMeal, categoria: "Platillo", precio, disponible: true, foto: m.strMealThumb };
    });
    if (mapped.length) { MENU = mapped; MENU_SOURCE = "TheMealDB API (en vivo)"; }
  } catch { /* offline / blocked → keep the committed menu */ }
  finally { clearTimeout(timer); }
}
await loadMenuLive();

// In-memory state (per process). Keyed by sessionId where relevant.
const state = { bookings: [], leads: [], orders: {}, completedOrders: [], ticketSeq: 240, folioSeq: 5000 };

export const money = (n, moneda = "MXN") => "$" + Number(n).toLocaleString(moneda === "USD" ? "en-US" : "es-MX") + " " + moneda;
const norm = (s) => (s || "").toString().toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");

// ---------- Real-estate inventory: SimplyRETS live, committed snapshot fallback ----------
let LISTINGS = load("listings.json"); // curated CDMX inventory (default demo set)
let SOURCE = "CDMX (demo)";
export const dataSource = () => SOURCE;
export const allListings = () => LISTINGS;

function mapProp(p) {
  const a = p.address || {}, pr = p.property || {};
  const banos = (pr.bathsFull || 0) + (pr.bathsHalf ? 1 : 0) || pr.bathrooms || 1;
  return {
    id: String(p.mlsId || p.listingId || Math.random().toString(36).slice(2, 8)),
    op: "venta",
    moneda: "USD",
    colonia: a.city || a.neighborhood || a.state || "—",
    precio: p.listPrice || 0,
    recamaras: pr.bedrooms || 0,
    banos,
    m2: pr.area || 0,
    estacionamientos: pr.garageSpaces || 0,
    amenidades: [pr.subType, pr.style, pr.type].filter(Boolean),
    foto: (p.photos && p.photos[0]) || "https://picsum.photos/seed/" + (p.mlsId || "x") + "/640/420",
    descripcion: ((p.remarks || "") + "").replace(/\\s+/g, " ").slice(0, 140) || a.full || "Propiedad disponible",
  };
}

async function loadLive() {
  const user = process.env.SIMPLYRETS_USER || "simplyrets";
  const pass = process.env.SIMPLYRETS_PASS || "simplyrets";
  const auth = "Basic " + Buffer.from(user + ":" + pass).toString("base64");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch("https://api.simplyrets.com/properties?minbeds=3&limit=100", { headers: { Authorization: auth }, signal: ctrl.signal });
    if (!r.ok) throw new Error("simplyrets " + r.status);
    const data = await r.json();
    const mapped = (Array.isArray(data) ? data : []).map(mapProp).filter((l) => l.precio > 0);
    if (mapped.length) { LISTINGS = mapped; SOURCE = "SimplyRETS API (en vivo)"; }
  } catch { /* offline / blocked → keep the committed snapshot */ }
  finally { clearTimeout(timer); }
}
// LIVE by default: real listings pulled from the SimplyRETS MLS API at boot — real API
// calls, no seeded data. The committed snapshot is a last-resort fallback used ONLY if the
// live API is unreachable, so the service never hard-fails. INVENTORY=curated forces demo.
const INV = (process.env.INVENTORY || "live").toLowerCase();
if (INV === "live") {
  SOURCE = "MLS (conectando…)";
  await loadLive();                                  // sets "SimplyRETS API (en vivo)" on success
  if (SOURCE !== "SimplyRETS API (en vivo)") SOURCE = "Respaldo MLS (sin conexión)";
}

export function search_listings(args = {}) {
  const { op, colonia, max_precio, min_precio, recamaras } = args;
  const zonas = [].concat(colonia || []).map(norm).filter(Boolean);
  const inPrice = (l) => (!max_precio || l.precio <= Number(max_precio)) && (!min_precio || l.precio >= Number(min_precio));
  const inBeds = (l) => !recamaras || l.recamaras >= Number(recamaras);
  const inZone = (l) => !zonas.length || zonas.some((z) => norm(l.colonia).includes(z) || z.includes(norm(l.colonia)));
  // `op` (renta vs venta) is a HARD filter and is NEVER relaxed: a property for sale is not a
  // substitute for a rental. If the inventory has nothing for the requested operation we say so
  // (no_inventory_for_op) instead of quietly answering with listings of the other operation.
  const pool = op ? LISTINGS.filter((l) => norm(l.op) === norm(op)) : LISTINGS;
  if (op && !pool.length) return { count: 0, listings: [], source: SOURCE, op, relaxed: [], exact_match: false, no_inventory_for_op: true };
  // Always give the customer a real CHOICE (2–3 options). Relax the least-important
  // constraint first — zone, then bedrooms, then price — until at least 2 real listings
  // qualify. Prevents a narrow filter (one exact-zone match, a tight budget) from surfacing
  // a single card when the live inventory clearly has more to show. Whatever gets dropped is
  // reported in `relaxed` so the caller never presents a relaxed result as an exact match.
  const asked = { colonia: zonas.length > 0, recamaras: !!recamaras, precio: !!(max_precio || min_precio) };
  const tiers = [
    { drop: [], pass: (l) => inPrice(l) && inBeds(l) && inZone(l) },        // exact match
    { drop: ["colonia"], pass: (l) => inPrice(l) && inBeds(l) },            // drop the zone
    { drop: ["colonia", "recamaras"], pass: (l) => inPrice(l) },            // drop the bedroom minimum
    { drop: ["colonia", "recamaras", "precio"], pass: () => true },         // last resort: any real listing
  ];
  let r = [], relaxed = [];
  for (const tier of tiers) { r = pool.filter(tier.pass); relaxed = tier.drop.filter((k) => asked[k]); if (r.length >= 2) break; }
  r = r.sort((a, b) => a.precio - b.precio).slice(0, 3);
  return { count: r.length, listings: r, source: SOURCE, op: op || null, relaxed, exact_match: relaxed.length === 0 };
}

export function get_listing(args = {}) {
  return LISTINGS.find((l) => norm(l.id) === norm(args.listing_id || args.id)) || null;
}

export function book_viewing(args = {}) {
  const listing = get_listing(args);
  if (!listing) return { ok: false, error: "listing_not_found" };
  const folio = "VIS-" + ++state.folioSeq;
  const b = { folio, listing_id: listing.id, colonia: listing.colonia, fecha: args.fecha, hora: args.hora, nombre: args.nombre || null, telefono: args.telefono || null };
  state.bookings.push(b);
  store.saveBooking(b);
  integrations.createCalendarEvent(b);   // gated: real Google Calendar event if configured
  return { ok: true, ...b };
}

export function create_lead(args = {}) {
  const id = "LEAD-" + (state.leads.length + 1);
  const lead = {
    id,
    nombre: args.nombre || null,
    telefono: args.telefono || null,
    operacion: args.operacion || null,
    colonia: args.colonia || null,
    presupuesto: args.presupuesto || null,
    recamaras: args.recamaras || null,
    listing_id: args.listing_id || null,
    score: args.score || "calificado",
  };
  state.leads.push(lead);
  store.saveLead(lead);
  integrations.pushLeadToHubSpot(lead);   // gated: real HubSpot contact if configured
  return { ok: true, ...lead };
}

// ---------- Restaurant (local menu) ----------
export function get_menu(args = {}) {
  if (!/vivo/.test(MENU_SOURCE)) loadMenuLive();  // self-heal if the boot fetch missed the live API
  let m = MENU.filter((i) => i.disponible);
  if (args.categoria) m = m.filter((i) => norm(i.categoria).includes(norm(args.categoria)));
  return { items: m, source: MENU_SOURCE };
}

function findItem(idOrName) {
  const q = norm(idOrName);
  return MENU.find((i) => norm(i.id) === q) || MENU.find((i) => norm(i.nombre).includes(q));
}

export function add_to_order(args = {}, sessionId = "default") {
  const order = (state.orders[sessionId] ||= { items: [], total: 0 });
  const added = [];
  for (const it of args.items || []) {
    const item = findItem(it.id || it.nombre);
    if (!item || !item.disponible) {
      added.push({ requested: it.id || it.nombre, ok: false, error: "no_disponible" });
      continue;
    }
    const qty = Number(it.qty || 1);
    order.items.push({ id: item.id, nombre: item.nombre, precio: item.precio, qty, mods: it.mods || [] });
    added.push({ ok: true, nombre: item.nombre, qty, precio: item.precio });
  }
  order.total = order.items.reduce((s, i) => s + i.precio * i.qty, 0);
  return { ok: true, added, order };
}

export function create_order(args = {}, sessionId = "default") {
  const order = state.orders[sessionId];
  if (!order || !order.items.length) return { ok: false, error: "orden_vacia" };
  const folio = "A-" + ++state.ticketSeq;
  const ticket = {
    folio, tipo: args.tipo || "para llevar", hora: args.hora || null,
    nombre: args.nombre || null, telefono: args.telefono || null, direccion: args.direccion || null,
    items: order.items, total: order.total,
  };
  delete state.orders[sessionId];
  const record = { ...ticket, at: Date.now() };
  state.completedOrders.push(record);
  store.saveOrder(record);
  // Every order is also a customer lead — capture the contact (name/phone/address) for the CRM.
  if (ticket.nombre || ticket.telefono) {
    const lead = {
      id: "LEAD-" + (state.leads.length + 1),
      nombre: ticket.nombre || null, telefono: ticket.telefono || null,
      operacion: "pedido", colonia: ticket.direccion || ticket.tipo || null,
      presupuesto: null, recamaras: null, listing_id: null, score: "cliente",
    };
    state.leads.push(lead);
    store.saveLead(lead);
    integrations.pushLeadToHubSpot(lead);
  }
  // Put the order on the owner's calendar too (pickup / delivery / table time) so every
  // customer commitment — restaurant or real-estate — lands in Google Calendar, not just HubSpot.
  integrations.createCalendarEvent({
    folio, fecha: new Date().toISOString().slice(0, 10), hora: ticket.hora,
    nombre: ticket.nombre, telefono: ticket.telefono,
    summary: `🌮 Pedido ${folio} — ${ticket.tipo}`,
    description: `Pedido ${folio} · ${ticket.tipo}${ticket.direccion ? " · " + ticket.direccion : ""}\\n` +
      `Cliente: ${ticket.nombre || "—"} · Tel: ${ticket.telefono || "—"}\\n` +
      ticket.items.map((i) => `${i.qty}× ${i.nombre}`).join(", ") + ` · Total $${ticket.total}`,
  });
  return { ok: true, ...ticket };
}

export const TOOLS = {
  search_listings: {
    description:
      "Busca propiedades en el inventario en vivo (MLS vía SimplyRETS). Devuelve SOLO inmuebles reales. " +
      "`op` (renta|venta) es un filtro DURO que NUNCA se relaja: jamás se devuelven propiedades de la otra operación. " +
      "Si no hay inventario para esa operación devuelve no_inventory_for_op:true — díselo al cliente y NO ofrezcas propiedades de la otra operación. " +
      "Zona, recámaras y precio SÍ se relajan para poder mostrar opciones: `relaxed` lista los filtros que se ignoraron y `exact_match` es true solo si no se relajó ninguno. " +
      "Si `relaxed` NO está vacío, NO afirmes que los resultados cumplen lo que pidió el cliente: aclara qué se amplió y presenta las propiedades como lo más cercano.",
    parameters: { op: "renta|venta — filtro DURO, nunca se relaja", colonia: "ciudad/zona opcional (se puede relajar)", max_precio: "number opcional, moneda del inventario (se puede relajar)", min_precio: "number opcional (se puede relajar)", recamaras: "number opcional (mínimo, se puede relajar)" },
    handler: (a) => search_listings(a),
  },
  get_listing: { description: "Devuelve el detalle de una propiedad por id.", parameters: { listing_id: "string" }, handler: (a) => get_listing(a) },
  book_viewing: {
    description: "Agenda una visita a una propiedad. Confirma fecha, hora y datos de contacto antes de llamar.",
    parameters: { listing_id: "string", fecha: "string", hora: "string", nombre: "string opcional", telefono: "string opcional" },
    handler: (a) => book_viewing(a),
  },
  create_lead: {
    description: "Registra el lead calificado y lo entrega al asesor humano.",
    parameters: { nombre: "string", telefono: "string", operacion: "string", colonia: "string", presupuesto: "number", recamaras: "number", listing_id: "string opcional" },
    handler: (a) => create_lead(a),
  },
  get_menu: { description: "Devuelve los platillos disponibles del menú (respeta artículos agotados).", parameters: { categoria: "string opcional" }, handler: (a) => get_menu(a) },
  add_to_order: {
    description: "Agrega platillos a la orden y recalcula el total (el total lo calcula la herramienta, no el modelo).",
    parameters: { items: "array de {id, qty, mods}" },
    handler: (a, s) => add_to_order(a, s),
    takesSession: true,
  },
  create_order: {
    description: "Cierra la orden y emite el ticket para cocina. Confirma el total con el cliente antes de llamar.",
    parameters: { tipo: "para llevar|entrega|en sitio", hora: "string", nombre: "string opcional", telefono: "string opcional", direccion: "string opcional" },
    handler: (a, s) => create_order(a, s),
    takesSession: true,
  },
};

export const _state = state;
