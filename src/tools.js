// Pure tool handlers over seed data. No model, no external deps.
// Shared by both the mock agent and the live (Claude Agent SDK) agent.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(path.join(__dir, "..", "data", f), "utf8"));

const LISTINGS = load("listings.json");
const MENU = load("menu.json");

// In-memory demo state (per process). Keyed by sessionId where relevant.
const state = { bookings: [], leads: [], orders: {}, ticketSeq: 240, folioSeq: 5000 };

export const money = (n) => "$" + Number(n).toLocaleString("es-MX") + " MXN";
const norm = (s) => (s || "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// ---------- Real estate ----------
export function search_listings(args = {}) {
  const { op, colonia, max_precio, min_precio, recamaras } = args;
  const zonas = []
    .concat(colonia || [])
    .map(norm)
    .filter(Boolean);
  let r = LISTINGS.filter((l) => {
    if (op && norm(l.op) !== norm(op)) return false;
    if (zonas.length && !zonas.some((z) => norm(l.colonia).includes(z) || z.includes(norm(l.colonia)))) return false;
    if (max_precio && l.precio > Number(max_precio)) return false;
    if (min_precio && l.precio < Number(min_precio)) return false;
    if (recamaras && l.recamaras < Number(recamaras)) return false;
    return true;
  });
  r = r.sort((a, b) => a.precio - b.precio).slice(0, 3);
  return { count: r.length, listings: r };
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
  return { ok: true, ...lead };
}

// ---------- Restaurant ----------
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
    folio,
    tipo: args.tipo || "para llevar",
    hora: args.hora || null,
    nombre: args.nombre || null,
    telefono: args.telefono || null,
    direccion: args.direccion || null,
    items: order.items,
    total: order.total,
  };
  delete state.orders[sessionId];
  return { ok: true, ...ticket };
}

// Registry: name -> { description, parameters (for docs/live schema), handler, takesSession }
export const TOOLS = {
  search_listings: {
    description: "Busca propiedades en el catálogo. Devuelve SOLO inmuebles reales del inventario que cumplen los filtros.",
    parameters: { op: "renta|venta", colonia: "string opcional", max_precio: "number opcional", min_precio: "number opcional", recamaras: "number opcional (mínimo)" },
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

export const _state = state; // exposed for the demo "handoff" panel
