// Optional Postgres persistence. Memory-mode (default) when DATABASE_URL is unset —
// the app stays zero-dependency for local/CI. With DATABASE_URL (e.g. Railway Postgres),
// records are written through to Postgres and the working set is hydrated on boot.
// `pg` is imported lazily so it's only needed when a database is configured.
let pool = null;
let MODE = "memory";
export const storeMode = () => MODE;

export async function init(state) {
  if (!process.env.DATABASE_URL) return MODE;
  try {
    const pg = (await import("pg")).default;
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leads    (id text PRIMARY KEY,    data jsonb NOT NULL, created_at timestamptz DEFAULT now());
      CREATE TABLE IF NOT EXISTS bookings (folio text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz DEFAULT now());
      CREATE TABLE IF NOT EXISTS orders   (folio text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz DEFAULT now());
    `);
    if (state) {
      const L = await pool.query("SELECT data FROM leads ORDER BY created_at DESC LIMIT 500");
      const B = await pool.query("SELECT data FROM bookings ORDER BY created_at DESC LIMIT 500");
      const O = await pool.query("SELECT data FROM orders ORDER BY created_at DESC LIMIT 500");
      state.leads.push(...L.rows.map((r) => r.data).reverse());
      state.bookings.push(...B.rows.map((r) => r.data).reverse());
      state.completedOrders.push(...O.rows.map((r) => r.data).reverse());
      // Continue folio/ticket sequences past the hydrated max so numbers never collide across restarts.
      const maxN = (arr) => arr.reduce((m, x) => { const n = parseInt(String(x.folio || "").replace(/\D/g, ""), 10) || 0; return n > m ? n : m; }, 0);
      state.folioSeq = Math.max(state.folioSeq, maxN(state.bookings));
      state.ticketSeq = Math.max(state.ticketSeq, maxN(state.completedOrders));
    }
    MODE = "postgres";
  } catch (e) {
    console.error("[store] Postgres unavailable, using memory:", e.message);
    pool = null;
  }
  return MODE;
}

// Wipe all leads/bookings/orders (in-memory + Postgres). Used to clean test data before a demo.
export async function clearAll(state) {
  if (state) { state.leads.length = 0; state.bookings.length = 0; state.completedOrders.length = 0; }
  if (pool) {
    try { await pool.query("DELETE FROM leads"); await pool.query("DELETE FROM bookings"); await pool.query("DELETE FROM orders"); }
    catch (e) { console.error("[store] clearAll failed:", e.message); }
  }
}

const write = (table, key, id, rec) => {
  if (!pool || !id) return;
  pool.query(`INSERT INTO ${table}(${key}, data) VALUES($1,$2) ON CONFLICT(${key}) DO UPDATE SET data=$2`, [id, rec]).catch((e) => console.error("[store] " + table + " write failed:", e.message));
};
export const saveLead = (l) => write("leads", "id", l.id, l);
export const saveBooking = (b) => write("bookings", "folio", b.folio, b);
export const saveOrder = (o) => write("orders", "folio", o.folio, o);
