// BERU License Server
// ---------------------------------------------------------------
// A minimal license backend for the BERU MT4 indicator. Tracks which
// MT4 account numbers are currently licensed, and until when. The
// indicator calls GET /check?account=... every few minutes; you manage
// licenses through the /admin endpoints (used by admin.html) or by
// editing licenses.json directly.
//
// Run locally:   npm install && npm start
// Then set ADMIN_KEY (see below) and deploy somewhere reachable over
// HTTPS - see README.md for free hosting options (Render, Railway,
// Fly.io, etc). MT4's WebRequest requires HTTPS with a real cert;
// plain http:// or self-signed certs will not work from the terminal.
// ---------------------------------------------------------------

const express = require("express");
const fs = require("fs");
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

const DB_FILE = path.join(__dirname, "licenses.json");
const PORT = process.env.PORT || 3000;

// Change this before deploying! Whoever knows this key can add, revoke,
// or list every license, so treat it like a password (set it via the
// ADMIN_KEY environment variable in production - do not commit a real
// key to source control).
const ADMIN_KEY = process.env.ADMIN_KEY || "change-this-admin-key";

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (e) {
    console.error("Failed to parse licenses.json, starting empty:", e.message);
    return {};
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
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
app.get("/check", (req, res) => {
  const account = String(req.query.account || "");
  if (!account) return res.json({ valid: false });

  const db = loadDB();
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
app.get("/admin/list", requireAdmin, (req, res) => {
  const db = loadDB();
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
app.post("/admin/set", requireAdmin, (req, res) => {
  const { account, durationSeconds, expiresAt, note } = req.body || {};
  if (!account) return res.status(400).json({ error: "account is required" });

  const db = loadDB();
  let expires = null;
  if (expiresAt) expires = Number(expiresAt);
  else if (durationSeconds) expires = Date.now() + Number(durationSeconds) * 1000;

  db[String(account)] = {
    expiresAt: expires,
    revoked: false,
    note: note || "",
    updatedAt: Date.now(),
  };
  saveDB(db);
  res.json({ ok: true, account, expiresAt: expires });
});

// ---------------------------------------------------------------
// POST /admin/revoke   { account }
// Immediately invalidates a license - the indicator will lock out on
// its next check-in (within LicenseCheckIntervalMinutes, or up to
// OfflineGraceHours later if that customer happened to be offline).
// ---------------------------------------------------------------
app.post("/admin/revoke", requireAdmin, (req, res) => {
  const { account } = req.body || {};
  if (!account) return res.status(400).json({ error: "account is required" });

  const db = loadDB();
  if (!db[String(account)]) db[String(account)] = {};
  db[String(account)].revoked = true;
  db[String(account)].updatedAt = Date.now();
  saveDB(db);
  res.json({ ok: true, account, revoked: true });
});

// ---------------------------------------------------------------
// POST /admin/delete   { account }  - remove an account entirely
// ---------------------------------------------------------------
app.post("/admin/delete", requireAdmin, (req, res) => {
  const { account } = req.body || {};
  if (!account) return res.status(400).json({ error: "account is required" });

  const db = loadDB();
  delete db[String(account)];
  saveDB(db);
  res.json({ ok: true, account, deleted: true });
});

app.listen(PORT, () => {
  console.log(`BERU license server listening on port ${PORT}`);
  if (ADMIN_KEY === "change-this-admin-key") {
    console.warn("WARNING: using the default ADMIN_KEY. Set the ADMIN_KEY environment variable before going live.");
  }
});
