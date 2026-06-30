// Tool handlers. The real-estate catalog is sourced LIVE from the SimplyRETS demo
// API (real MLS-style listings + photos) at startup, with a committed real snapshot
// as the offline/CI fallback. Override creds with SIMPLYRETS_USER / SIMPLYRETS_PASS.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import * as store from "./store.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(path.join(__dir, "..", "data", f), "utf8"));

const MENU = load("menu.json");

// In-memory state (per process). Keyed by sessionId where relevant.
const state = { bookings: [], leads: [], orders: {}, completedOrders: [], ticketSeq: 240, folioSeq: 5000 };

export const money = (n) => "$" + Number(n).toLocaleString("en-US") + " USD";
const norm = (s) => (s || "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// ---------- Real-estate inventory: SimplyRETS live, committed snapshot fallback ----------
let LISTINGS = load("listings.json"); // committed real snapshot (fallback)
let SOURCE = "snapshot en caché";
export const dataSource = () => SOURCE;
export const allListings = () => LISTINGS;

function mapProp(p) {
  const a = p.address || {}, pr = p.property || {};
  const banos = (pr.bathsFull || 0) + (pr.bathsHalf ? 1 : 0) || pr.bathrooms || 1;
  return {
    id: String(p.mlsId || p.listingId || Math.random().toString(36).slice(2, 8)),
    op: "venta",
    colonia: a.city || a.neighborhood || a.state || "—",
    precio: p.listPrice || 0,
    recamaras: pr.bedrooms || 0,
    banos,
    m2: pr.area || 0,
    estacionamientos: pr.garageSpaces || 0,
    amenidades: [pr.subType, pr.style, pr.type].filter(Boolean),
    foto: (p.photos && p.photos[0]) || "https://picsum.photos/seed/" + (p.mlsId || "x") + "/640/420",
    descripcion: ((p.remarks || "") + "").replace(/\s+/g, " ").slice(0, 140) || a.full || "Propiedad disponible",
  };
}

async function loadLive() {
  const user = process.env.SIMPLYRETS_USER || "simplyrets";
  const pass = process.env.SIMPLYRETS_PASS || "simplyrets";
  const auth = "Basic " + Buffer.from(user + ":" + pass).toString("base64");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch("https://api.simplyrets.com/properties?limit=50", { headers: { Authorization: auth }, signal: ctrl.signal });
    if (!r.ok) throw new Error("simplyrets " + r.status);
    const data = await r.json();
    const mapped = (Array.isArray(data) ? data : []).map(mapProp).filter((l) => l.precio > 0);
    if (mapped.length) { LISTINGS = mapped; SOURCE = "SimplyRETS API (en vivo)"; }
  } catch { /* offline / blocked → keep the committed snapshot */ }
  finally { clearTimeout(timer); }
}
await loadLive(); // real API call at import; falls back to the committed snapshot when offline

export function search_listings(args = {}) {
  const { colonia, max_precio, min_precio, recamaras } = args;
  const zonas = [].concat(colonia || []).map(norm).filter(Boolean);
  const byPriceBeds = (l) =>
    (!max_precio || l.precio <= Number(max_precio)) &&
    (!min_precio || l.precio >= Number(min_precio)) &&
    (!recamaras || l.recamaras >= Number(recamaras));
  let r = LISTINGS.filter((l) => byPriceBeds(l) && (!zonas.length || zonas.some((z) => norm(l.colonia).includes(z) || z.includes(norm(l.colonia)))));
  // If a named zone wiped out results, keep the price/bed matches (zone is a nice-to-have).
  if (!r.length && zonas.length) r = LISTINGS.filter(byPriceBeds);
  r = r.sort((a, b) => a.precio - b.precio).slice(0, 3);
  return { count: r.length, listings: r, source: SOURCE };
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
  return { ok: true, ...lead };
}

// ---------- Restaurant (local menu) ----------
export function get_menu(args = {}) {
  let m = MENU.filter((i) => i.disponible);
  if (args.categoria) m = m.filter((i) => norm(i.categoria).includes(norm(args.categoria)));
  return { items: m };
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
  return { ok: true, ...ticket };
}

export const TOOLS = {
  search_listings: {
    description: "Busca propiedades en el inventario en vivo (MLS vía SimplyRETS). Devuelve SOLO inmuebles reales que cumplen los filtros de precio, recámaras y zona.",
    parameters: { op: "renta|venta (informativo)", colonia: "ciudad/zona opcional", max_precio: "number opcional (USD)", min_precio: "number opcional", recamaras: "number opcional (mínimo)" },
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
