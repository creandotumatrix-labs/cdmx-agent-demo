// Zero-dependency deterministic agent. Calls the REAL tools so listings,
// bookings and orders are genuine. Used for the no-account fallback and for
// automated verification. The live agent (Claude via Max) is the real thing.
import * as T from "./tools.js";

const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const COLONIAS = ["roma norte", "roma", "condesa", "polanco", "del valle", "napoles", "narvarte", "coyoacan"];

function parseMoney(t) {
  const m = norm(t).replace(/[, ]/g, "");
  let g = m.match(/(\d+)mil/);
  if (g) return parseInt(g[1], 10) * 1000;
  g = m.match(/\$?(\d{4,9})/);
  if (g) return parseInt(g[1], 10);
  return null;
}
function parseRecamaras(t) {
  const g = norm(t).match(/(\d+)\s*(rec|reca|recamara|habitac|cuarto|dormitor)/);
  if (g) return parseInt(g[1], 10);
  const g2 = norm(t).match(/\bde\s+(\d+)\b/);
  return g2 ? parseInt(g2[1], 10) : null;
}
function parseColonia(t) {
  const n = norm(t);
  for (const c of COLONIAS) if (n.includes(c)) return c === "roma" ? "Roma Norte" : c;
  return null;
}
function fmtListing(l) {
  return `*${l.colonia}* · ${l.recamaras} rec · ${l.m2}m² · ${T.money(l.precio)}${l.op === "renta" ? "/mes" : ""}\n_${l.id}_`;
}

// ---- Real estate state machine ----
function realEstate(session, text) {
  const s = (session.slots ||= { op: null, colonia: null, presupuesto: null, recamaras: null, shown: [], pick: null, fecha: null, hora: null });
  const actions = [];
  const n = norm(text);

  // Re-read the operation while we still have nothing to show: if we just told the customer
  // there is no inventory for what they asked (sinInventario, below) and they switch, honour
  // the switch instead of repeating the same message forever.
  if (!s.op || s.sinInventario) {
    if (/(rent|renta)/.test(n)) s.op = "renta";
    else if (/(compr|venta|comprar)/.test(n)) s.op = "venta";
  }
  if (!s.colonia) s.colonia = parseColonia(text) || s.colonia;
  if (!s.presupuesto) s.presupuesto = parseMoney(text) || s.presupuesto;
  if (!s.recamaras) s.recamaras = parseRecamaras(text) || s.recamaras;

  // Booking sub-flow
  if (s.shown.length && /(visit|agend|ver la|me late|quiero la|apart|cita)/.test(n)) {
    const pickNum = (n.match(/\b([123])\b/) || [])[1];
    s.pick = s.pick || (pickNum ? s.shown[parseInt(pickNum, 10) - 1] : s.shown[0]);
  }
  if (s.pick && !s.fecha) {
    const day = (text.match(/\b(\d{1,2}\s*(de\s*)?\w+|mañana|hoy|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b/i) || [])[0];
    if (day) s.fecha = day;
  }
  if (s.pick && s.fecha && !s.hora) {
    const hr = (text.match(/\b(\d{1,2}(:\d{2})?\s*(am|pm|hrs|horas)?)\b/i) || [])[0];
    if (hr && /[ap]m|:|hrs|hora/i.test(hr)) s.hora = hr;
  }
  if (s.pick && s.fecha && s.hora && !s.nombre) {
    // expect "Nombre, 55 1234 5678"
    const tel = (text.match(/(\+?52)?[\s-]?(\d[\s-]?){10}/) || [])[0];
    if (tel) {
      s.telefono = tel.trim();
      s.nombre = text.split(/[,\d]/)[0].trim() || "Cliente";
    }
  }

  // Decide reply
  if (!s.op) return { reply: "¡Claro! ¿Buscas *comprar* o *rentar*? 🙂", actions };
  if (!s.presupuesto) return { reply: `Perfecto, ${s.op}. ¿Qué presupuesto manejas${s.op === "renta" ? " al mes" : ""} y en qué zona?`, actions };

  if (!s.shown.length) {
    const res = T.search_listings({ op: s.op, colonia: s.colonia, max_precio: s.op === "renta" ? s.presupuesto : null, recamaras: s.recamaras });
    actions.push({ tool: "search_listings", args: { op: s.op, colonia: s.colonia, max_precio: s.presupuesto, recamaras: s.recamaras }, result: res });
    // Nothing at all for the requested operation — say it plainly. NEVER fall back to listings
    // of the other operation: a property for sale is not a substitute for a rental.
    if (res.no_inventory_for_op) {
      s.sinInventario = true;
      return { reply: s.op === "renta"
        ? "Te soy honesto: por ahora solo tengo propiedades en *venta* en el catálogo 😕 ¿Te muestro opciones de venta o prefieres que un asesor te contacte para renta?"
        : "Te soy honesto: por ahora solo tengo propiedades en *renta* en el catálogo 😕 ¿Te muestro opciones de renta o prefieres que un asesor te contacte para venta?", actions };
    }
    if (!res.count) {
      s.colonia = null;
      return { reply: "Mmm, no encontré algo exacto con esos filtros 😕 ¿Te muestro lo más cercano en otra colonia o ajustamos el presupuesto?", actions };
    }
    s.sinInventario = false;
    s.shown = res.listings.map((l) => l.id);
    const cards = res.listings.map((l, i) => `${i + 1}) ${fmtListing(l)}`).join("\n\n");
    // Only say they "encajan" when NOTHING was relaxed. Otherwise be upfront that these are
    // the closest we have, not what the customer actually asked for.
    const intro = res.exact_match
      ? `Tengo ${res.count} que encajan 👇`
      : "No encontré exactamente lo que pediste, pero te muestro lo más cercano 👇";
    return { reply: `${intro}\n\n${cards}\n\n¿Quieres agendar una visita a alguna?`, actions, listings: res.listings };
  }

  if (s.pick && (!s.fecha || !s.hora)) {
    const l = T.get_listing({ listing_id: s.pick });
    if (!s.fecha) return { reply: `¡Excelente elección! 🏡 ${l.colonia}, ${T.money(l.precio)}. ¿Qué día te gustaría visitarla?`, actions };
    return { reply: "Va. ¿A qué hora te acomoda?", actions };
  }
  if (s.pick && s.fecha && s.hora && !s.nombre) {
    return { reply: "Para confirmar la cita, ¿a qué *nombre* y *teléfono* la registro?", actions };
  }
  if (s.pick && s.nombre && !s.done) {
    const bk = T.book_viewing({ listing_id: s.pick, fecha: s.fecha, hora: s.hora, nombre: s.nombre, telefono: s.telefono });
    actions.push({ tool: "book_viewing", args: { listing_id: s.pick, fecha: s.fecha, hora: s.hora }, result: bk });
    const ld = T.create_lead({ nombre: s.nombre, telefono: s.telefono, operacion: s.op, colonia: s.colonia, presupuesto: s.presupuesto, recamaras: s.recamaras, listing_id: s.pick });
    actions.push({ tool: "create_lead", args: { nombre: s.nombre, listing_id: s.pick }, result: ld });
    s.done = true;
    return { reply: `¡Listo, ${s.nombre}! ✅ Visita agendada: *${s.fecha}, ${s.hora}* en ${bk.colonia}. Tu asesor te confirma por aquí y te manda la ubicación. ¡Gracias! 🙌`, actions };
  }
  return { reply: "¿Quieres que agende una visita a la 1, 2 o 3? 😊", actions };
}

// ---- Restaurant state machine ----
const ITEM_WORDS = [
  ["pastor", "taco_pastor"], ["suadero", "taco_suadero"], ["bistec", "taco_bistec"], ["campechano", "taco_campechano"],
  ["gringa", "gringa_pastor"], ["quesadilla", "quesadilla"], ["guacamole", "orden_guacamole"], ["papas", "orden_papas"],
  ["horchata", "agua_horchata"], ["jamaica", "agua_jamaica"], ["refresco", "refresco"], ["coca", "refresco"],
  ["cerveza", "cerveza"], ["flan", "flan"],
];
const NUMWORDS = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, par: 2 };
function parseItems(text) {
  const toks = norm(text).split(/[^a-z0-9]+/).filter(Boolean);
  const items = [];
  for (const [word, id] of ITEM_WORDS) {
    const ti = toks.findIndex((t) => t.includes(word));
    if (ti === -1) continue;
    let qty = 1;
    for (let j = ti; j >= Math.max(0, ti - 4); j--) {
      if (/^\d+$/.test(toks[j])) { qty = parseInt(toks[j], 10); break; }
      if (NUMWORDS[toks[j]] != null) { qty = NUMWORDS[toks[j]]; break; }
    }
    items.push({ id, qty });
  }
  return items;
}
function restaurant(session, text) {
  const s = (session.slots ||= { started: false, upsold: false, tipo: null, hora: null, nombre: null });
  const actions = [];
  const n = norm(text);

  const newItems = parseItems(text);
  if (newItems.length) {
    const res = T.add_to_order({ items: newItems }, session.id);
    actions.push({ tool: "add_to_order", args: { items: newItems }, result: res });
    s.started = true;
    if (!s.upsold) {
      s.upsold = true;
      const lines = res.order.items.map((i) => `• ${i.qty} ${i.nombre} — ${T.money(i.precio * i.qty)}`).join("\n");
      return { reply: `Van 👇\n${lines}\n\n¿Le sumas una *orden de guacamole* en promo a $45? 🥑 Va perfecto.`, actions };
    }
  }

  if (/(no|así|asi|es todo|nada mas|nada más|ya|confirm|cerrar)/.test(n) && s.started && !s.tipo) {
    const order = T.add_to_order({ items: [] }, session.id).order; // read current
    const lines = order.items.map((i) => `• ${i.qty} ${i.nombre} — ${T.money(i.precio * i.qty)}`).join("\n");
    s.readBack = true;
    return { reply: `Perfecto, tu pedido:\n${lines}\n*Total: ${T.money(order.total)}*\n\n¿Es para *llevar*, *entrega* o *en sitio*? ¿A qué hora?`, actions };
  }

  if (s.readBack && !s.tipo) {
    if (/llevar/.test(n)) s.tipo = "para llevar";
    else if (/entrega|domicilio/.test(n)) s.tipo = "entrega";
    else if (/sitio|local|aqui|aquí/.test(n)) s.tipo = "en sitio";
    const hr = (text.match(/\b(\d{1,2}(:\d{2})?\s*(am|pm)?)\b/i) || [])[0];
    if (hr) s.hora = hr;
    if (s.tipo) {
      const res = T.create_order({ tipo: s.tipo, hora: s.hora || "lo antes posible" }, session.id);
      actions.push({ tool: "create_order", args: { tipo: s.tipo, hora: s.hora }, result: res });
      return { reply: `¡Listo! ✅ Pedido *${res.folio}* (${res.tipo}${s.hora ? ", " + s.hora : ""}). Total ${T.money(res.total)}. Te avisamos cuando esté. ¡Gracias! 🌮`, actions, ticket: res };
    }
    return { reply: "¿Para *llevar*, *entrega* o *en sitio*? 🙂", actions };
  }

  if (!s.started) return { reply: "¡Con gusto! Dime qué se te antoja 🌮 (por ejemplo: *3 tacos de pastor y una horchata*).", actions };
  return { reply: "¿Algo más o cerramos el pedido? 😋", actions };
}

export function mockRespond(config, session, text) {
  session.id ||= "default";
  return config.id === "restaurant" ? restaurant(session, text) : realEstate(session, text);
}
