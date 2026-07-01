// Optional external integrations. Every function here is a NO-OP unless its env vars are
// set, so the app runs free/standalone by default and each integration "lights up" the
// moment its key is added in Railway. Failures are swallowed — they never break the agent.
//
// Env var names are flexible (aliases) so the same variables used by sibling services work
// as-is: WhatsApp token = WHATSAPP_TOKEN | WHATSAPP_ACCESS_TOKEN; verify token =
// WEBHOOK_VERIFY_TOKEN | WHATSAPP_VERIFY_TOKEN; Google auth = service account JSON OR OAuth.
import crypto from "crypto";

const log = (tag, e) => console.error("[integrations:" + tag + "] " + (e && e.message ? e.message : e));
const env = (...names) => { for (const n of names) if (process.env[n]) return process.env[n]; return undefined; };

// ---------------------------------------------------------------- HubSpot (CRM)
export async function pushLeadToHubSpot(lead) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token || !lead) return;
  try {
    const props = {
      firstname: lead.nombre || "Prospecto",
      phone: lead.telefono || "",
      hs_lead_status: "NEW",
      lifecyclestage: "lead",
      company: [lead.operacion, lead.colonia, lead.recamaras ? lead.recamaras + " rec" : "",
                lead.presupuesto ? "$" + Number(lead.presupuesto).toLocaleString() : ""]
                .filter(Boolean).join(" · "),
    };
    const r = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ properties: props }),
    });
    if (!r.ok) log("hubspot", "HTTP " + r.status + " " + (await r.text()).slice(0, 140));
    else console.log("[integrations:hubspot] contact created:", props.firstname);
  } catch (e) { log("hubspot", e); }
}

// ---------------------------------------------------------------- Google auth (SA JSON or OAuth)
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

async function googleTokenFromServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  let sa; try { sa = JSON.parse(raw); } catch { return log("gcal", "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON"); }
  if (!sa.client_email || !sa.private_key) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
    ...(process.env.GOOGLE_IMPERSONATE ? { sub: process.env.GOOGLE_IMPERSONATE } : {}),
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(header + "." + claim); signer.end();
  const jwt = header + "." + claim + "." + b64url(signer.sign(sa.private_key.replace(/\\n/g, "\n")));
  const j = await (await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  })).json();
  return j.access_token || log("gcal", "SA token: " + JSON.stringify(j).slice(0, 140));
}

async function googleTokenFromOAuth() {
  const cid = process.env.GOOGLE_CLIENT_ID, cs = process.env.GOOGLE_CLIENT_SECRET, rt = process.env.GOOGLE_REFRESH_TOKEN;
  if (!cid || !cs || !rt) return null;
  const j = await (await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cid, client_secret: cs, refresh_token: rt, grant_type: "refresh_token" }),
  })).json();
  return j.access_token || null;
}

async function getGoogleAccessToken() {
  return (await googleTokenFromServiceAccount()) || (await googleTokenFromOAuth());
}
export const calendarReady = () =>
  !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN));

// ---------------------------------------------------------------- Google Calendar (event)
function parseWhen(b) {
  const isISO = /^\d{4}-\d{2}-\d{2}$/.test(b.fecha || "");
  const day = isISO ? new Date(b.fecha + "T12:00:00") : new Date(Date.now() + 24 * 3600 * 1000);
  const hm = /^(\d{1,2}):(\d{2})$/.exec(b.hora || "");
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hm ? +hm[1] : 12, hm ? +hm[2] : 0);
  const end = new Date(start.getTime() + 45 * 60000);
  return { start: start.toISOString(), end: end.toISOString() };
}
export async function createCalendarEvent(booking) {
  if (!calendarReady() || !booking) return;
  try {
    const token = await getGoogleAccessToken();
    if (!token) return;
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
      method: "POST", headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!r.ok) log("gcal", "HTTP " + r.status + " " + (await r.text()).slice(0, 140));
    else console.log("[integrations:gcal] event created:", event.summary);
  } catch (e) { log("gcal", e); }
}

// ---------------------------------------------------------------- WhatsApp Cloud API (send)
const waToken = () => env("WHATSAPP_TOKEN", "WHATSAPP_ACCESS_TOKEN");
export const waVerifyToken = () => env("WEBHOOK_VERIFY_TOKEN", "WHATSAPP_VERIFY_TOKEN");
export const whatsappReady = () => !!(waToken() && process.env.WHATSAPP_PHONE_NUMBER_ID);

export async function sendWhatsApp(to, bodyText) {
  if (!whatsappReady() || !to || !bodyText) return;
  const v = process.env.WHATSAPP_API_VERSION || "v21.0";
  try {
    const r = await fetch(`https://graph.facebook.com/${v}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: "Bearer " + waToken(), "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: bodyText.slice(0, 4096) } }),
    });
    if (!r.ok) log("whatsapp", "HTTP " + r.status + " " + (await r.text()).slice(0, 140));
  } catch (e) { log("whatsapp", e); }
}

// Register the WhatsApp webhook via the Graph API (bypasses the dashboard form entirely).
// Needs META_APP_SECRET (and META_APP_ID, defaults to the known app). Sets callback_url +
// verify_token + subscribes the `messages` field in one call. Returns status, never secrets.
export async function registerWhatsAppWebhook() {
  const appId = process.env.META_APP_ID || "1665595468028864";
  const secret = process.env.META_APP_SECRET;
  if (!secret) return { ok: false, error: "Set META_APP_SECRET in Railway (Meta → App Settings → Basic → App secret)." };
  const base = (process.env.PUBLIC_URL || "https://cdmx-agent-demo-production.up.railway.app").replace(/\/+$/, "");
  const v = process.env.WHATSAPP_API_VERSION || "v21.0";
  const params = new URLSearchParams({
    object: "whatsapp_business_account",
    callback_url: base + "/webhook",
    verify_token: waVerifyToken() || "cdmx-verify-2026",
    fields: "messages",
    access_token: appId + "|" + secret,
  });
  try {
    const r = await fetch(`https://graph.facebook.com/${v}/${appId}/subscriptions`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params,
    });
    const j = await r.json();
    return { ok: r.ok && j && j.success !== false, status: r.status, callback: base + "/webhook", response: j };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Live credential probe — actively authenticates each token and reports ok/invalid.
// Returns status strings only, never secret values.
export async function diagnose() {
  const out = {};
  if (whatsappReady()) {
    try {
      const v = process.env.WHATSAPP_API_VERSION || "v21.0";
      const r = await fetch(`https://graph.facebook.com/${v}/${process.env.WHATSAPP_PHONE_NUMBER_ID}?fields=id`, { headers: { Authorization: "Bearer " + waToken() } });
      out.whatsapp = r.ok ? "ok" : "invalid(" + r.status + ")";
    } catch { out.whatsapp = "error"; }
  } else out.whatsapp = "unset";
  if (process.env.HUBSPOT_TOKEN) {
    try {
      const r = await fetch("https://api.hubapi.com/crm/v3/objects/contacts?limit=1", { headers: { Authorization: "Bearer " + process.env.HUBSPOT_TOKEN } });
      out.hubspot = r.ok ? "ok" : "invalid(" + r.status + ")";
    } catch { out.hubspot = "error"; }
  } else out.hubspot = "unset";
  out.calendar = await (async () => {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw && !(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN)) return "unset";
    if (raw) {
      if (raw.trim() === "REPLACE_ME") return "still_placeholder";
      let sa; try { sa = JSON.parse(raw); } catch { return "bad_json (paste the key on ONE line, keep the \\n escapes)"; }
      if (!sa.client_email || !sa.private_key) return "missing_fields (need client_email + private_key)";
    }
    try { return (await getGoogleAccessToken()) ? "ok" : "auth_rejected (check Calendar API enabled + key valid)"; } catch { return "error"; }
  })();
  out.rapidapi = process.env.RAPIDAPI_KEY ? "set" : "unset";
  return out;
}

// Readiness snapshot for /health (booleans only — never values).
export const integrationsStatus = () => ({
  whatsapp: whatsappReady(),
  hubspot: !!process.env.HUBSPOT_TOKEN,
  calendar: calendarReady(),
  rapidapi: !!process.env.RAPIDAPI_KEY,
});
