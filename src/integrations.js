// Optional external integrations. Every function here is a NO-OP unless its env vars are
// set, so the app runs free/standalone by default and each integration "lights up" the
// moment its key is added in Railway. Failures are swallowed — they never break the agent.

const log = (tag, e) => console.error("[integrations:" + tag + "] " + (e && e.message ? e.message : e));

// ---------------------------------------------------------------- HubSpot (CRM)
// Pushes a qualified lead as a HubSpot contact. Needs HUBSPOT_TOKEN (private-app token).
export async function pushLeadToHubSpot(lead) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token || !lead) return;
  try {
    const props = {
      firstname: lead.nombre || "Prospecto",
      phone: lead.telefono || "",
      hs_lead_status: "NEW",
      lifecyclestage: "lead",
      // Deal context packed into a standard text prop so it's visible without custom fields.
      company: [lead.operacion, lead.colonia, lead.recamaras ? lead.recamaras + " rec" : "",
                lead.presupuesto ? "$" + Number(lead.presupuesto).toLocaleString() : ""]
                .filter(Boolean).join(" · "),
    };
    const r = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ properties: props }),
    });
    if (!r.ok) log("hubspot", "HTTP " + r.status + " " + (await r.text()).slice(0, 120));
    else console.log("[integrations:hubspot] contact created for", props.firstname);
  } catch (e) { log("hubspot", e); }
}

// ---------------------------------------------------------------- Google Calendar
// Creates a real calendar event for a booked viewing. Needs GOOGLE_CLIENT_ID,
// GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN (+ optional GOOGLE_CALENDAR_ID).
function parseWhen(b) {
  const isISO = /^\d{4}-\d{2}-\d{2}$/.test(b.fecha || "");
  const day = isISO ? new Date(b.fecha + "T12:00:00") : new Date(Date.now() + 24 * 3600 * 1000);
  const hm = /^(\d{1,2}):(\d{2})$/.exec(b.hora || "");
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hm ? +hm[1] : 12, hm ? +hm[2] : 0);
  const end = new Date(start.getTime() + 45 * 60000);
  return { start: start.toISOString(), end: end.toISOString() };
}
export async function createCalendarEvent(booking) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN || !booking) return;
  try {
    const tk = await (await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
                                  refresh_token: GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" }),
    })).json();
    if (!tk.access_token) return log("gcal", "no access_token from refresh");
    const cal = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || "primary");
    const when = parseWhen(booking);
    const event = {
      summary: `Visita: ${booking.colonia || "propiedad"} (${booking.folio || ""})`,
      description: `Lead: ${booking.nombre || "—"} · Tel: ${booking.telefono || "—"}\n` +
                   `Solicitado: ${booking.fecha || ""} ${booking.hora || ""} · Propiedad ${booking.listing_id || booking.colonia || ""}`,
      start: { dateTime: when.start, timeZone: "America/Mexico_City" },
      end: { dateTime: when.end, timeZone: "America/Mexico_City" },
    };
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${cal}/events`, {
      method: "POST", headers: { Authorization: "Bearer " + tk.access_token, "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!r.ok) log("gcal", "HTTP " + r.status + " " + (await r.text()).slice(0, 120));
    else console.log("[integrations:gcal] event created:", event.summary);
  } catch (e) { log("gcal", e); }
}

// ---------------------------------------------------------------- WhatsApp Cloud API (send)
// Sends a text reply via the Graph API. Needs WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID.
export function whatsappReady() {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}
export async function sendWhatsApp(to, bodyText) {
  if (!whatsappReady() || !to || !bodyText) return;
  const v = process.env.WHATSAPP_API_VERSION || "v21.0";
  try {
    const r = await fetch(`https://graph.facebook.com/${v}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.WHATSAPP_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: bodyText.slice(0, 4096) } }),
    });
    if (!r.ok) log("whatsapp", "HTTP " + r.status + " " + (await r.text()).slice(0, 120));
  } catch (e) { log("whatsapp", e); }
}
