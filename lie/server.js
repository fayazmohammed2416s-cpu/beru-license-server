// BERU License Server
// ---------------------------------------------------------------
// A minimal license backend for the BERU MT4 indicator. Tracks which
// MT4 account numbers are currently licensed, and until when. The
// indicator calls GET /check?account=... every few minutes; you manage
// licenses through the /admin endpoints (used by admin.html).
//
// STORAGE: licenses are stored in Upstash Redis (a free, permanent
// cloud key-value store) instead of a local file. This matters because
// hosts like Render's free tier wipe the local disk on every restart -
// a plain licenses.json file would silently lose every license you'd
// granted. Upstash persists forever regardless of restarts/redeploys.
//
// Setup: create a free database at upstash.com, then set these two
// environment variables wherever you deploy this (Render > your
// service > Environment):
//   UPSTASH_REDIS_REST_URL   - from the Upstash dashboard
//   UPSTASH_REDIS_REST_TOKEN - from the Upstash dashboard
//
// Run locally:   npm install && npm start
// Then set ADMIN_KEY (see below) and deploy somewhere reachable over
// HTTPS - see README.md for free hosting options (Render, Railway,
// Fly.io, etc). MT4's WebRequest requires HTTPS with a real cert;
// plain http:// or self-signed certs will not work from the terminal.
// ---------------------------------------------------------------

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname))); // serves admin.html at /admin.html

// CORS: admin.html is often hosted somewhere else entirely (a static host
// like Netlify) while this server runs elsewhere (Render/Railway/etc), so
// the browser needs explicit permission to call across origins. The admin
// key itself is what actually protects these endpoints, so allowing any
// origin here is fine - a stranger's browser still can't do anything
// without the correct x-admin-key.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-this-admin-key";

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = "beru_licenses_db"; // single key holding the whole licenses object as JSON

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.warn("WARNING: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set.");
  console.warn("Licenses will NOT persist across restarts until these are set (see comment at top of this file).");
}

// ---------------------------------------------------------------
// loadDB / saveDB - talk to Upstash's REST API directly (no extra
// npm package needed; Node 18+ has fetch built in). Falls back to an
// in-memory object if Upstash isn't configured yet, so the server
// still runs for local testing - it just won't remember anything
// between restarts in that case.
// ---------------------------------------------------------------
let memoryFallback = {};

async function loadDB() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return memoryFallback;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${REDIS_KEY}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json();
    if (!data.result) return {};
    return JSON.parse(data.result);
  } catch (e) {
    console.error("Failed to load licenses from Upstash:", e.message);
    return {};
  }
}

async function saveDB(db) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    memoryFallback = db;
    return;
  }
  await fetch(`${UPSTASH_URL}/set/${REDIS_KEY}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: JSON.stringify(db),
  });
}

function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key");
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: "invalid admin key" });
  }
  next();
}

// ---------------------------------------------------------------
// GET /check?account=12345
// Called by the MT4 indicator itself. Public (no admin key needed) -
// it only reveals whether ONE account number is currently valid.
// ---------------------------------------------------------------
app.get("/check", async (req, res) => {
  const account = String(req.query.account || "");
  if (!account) return res.json({ valid: false });

  const db = await loadDB();
  const entry = db[account];

  if (!entry) return res.json({ valid: false });
  if (entry.revoked) return res.json({ valid: false });

  const now = Date.now();
  if (entry.expiresAt && now > entry.expiresAt) {
    return res.json({ valid: false, expired: true, expires: entry.expiresAt });
  }

  return res.json({ valid: true, expires: entry.expiresAt || null });
});

// ---------------------------------------------------------------
// GET /admin/list  - all licenses, admin key required
// ---------------------------------------------------------------
app.get("/admin/list", requireAdmin, async (req, res) => {
  const db = await loadDB();
  const rows = Object.keys(db).map((account) => ({
    account,
    ...db[account],
  }));
  res.json({ licenses: rows });
});

// ---------------------------------------------------------------
// POST /admin/set   { account, durationSeconds }  OR  { account, expiresAt }
// Creates or updates a license. durationSeconds is measured from NOW.
// Examples: 1 hour = 3600, 1 day = 86400, 1 month = 2592000 (30d),
// 1 year = 31536000. Omit both duration fields for a license with no
// expiry (valid until you revoke it manually).
// ---------------------------------------------------------------
app.post("/admin/set", requireAdmin, async (req, res) => {
  const { account, durationSeconds, expiresAt, note } = req.body || {};
  if (!account) return res.status(400).json({ error: "account is required" });

  const db = await loadDB();
  let expires = null;
  if (expiresAt) expires = Number(expiresAt);
  else if (durationSeconds) expires = Date.now() + Number(durationSeconds) * 1000;

  db[String(account)] = {
    expiresAt: expires,
    revoked: false,
    note: note || "",
    updatedAt: Date.now(),
  };
  await saveDB(db);
  res.json({ ok: true, account, expiresAt: expires });
});

// ---------------------------------------------------------------
// POST /admin/revoke   { account }
// Immediately invalidates a license - the indicator will lock out on
// its next check-in (within LicenseCheckIntervalMinutes, or up to
// OfflineGraceHours later if that customer happened to be offline).
// ---------------------------------------------------------------
app.post("/admin/revoke", requireAdmin, async (req, res) => {
  const { account } = req.body || {};
  if (!account) return res.status(400).json({ error: "account is required" });

  const db = await loadDB();
  if (!db[String(account)]) db[String(account)] = {};
  db[String(account)].revoked = true;
  db[String(account)].updatedAt = Date.now();
  await saveDB(db);
  res.json({ ok: true, account, revoked: true });
});

// ---------------------------------------------------------------
// POST /admin/delete   { account }  - remove an account entirely
// ---------------------------------------------------------------
app.post("/admin/delete", requireAdmin, async (req, res) => {
  const { account } = req.body || {};
  if (!account) return res.status(400).json({ error: "account is required" });

  const db = await loadDB();
  delete db[String(account)];
  await saveDB(db);
  res.json({ ok: true, account, deleted: true });
});

app.listen(PORT, () => {
  console.log(`BERU license server listening on port ${PORT}`);
  if (ADMIN_KEY === "change-this-admin-key") {
    console.warn("WARNING: using the default ADMIN_KEY. Set the ADMIN_KEY environment variable before going live.");
  }
});
