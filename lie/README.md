# BERU License Server

A minimal backend that lets you remotely control who can use the BERU
MT4 indicator, and for how long. This is what makes "revoke access
whenever I want" and "give this customer 1 hour / 1 day / 1 month / 1
year" actually possible - an offline license key can't do either of
those once it's already been sent to someone.

## Honest limits, up front

- This raises the bar a lot, but it is **not unbreakable**. Client-side
  checks running on someone else's computer can, in principle, be
  patched by a sufficiently determined person. Every commercial
  indicator/EA that does this kind of licensing accepts the same
  tradeoff - the goal is to stop casual copying and give you a remote
  kill switch, not to make reverse engineering mathematically
  impossible.
- The MT4 side only checks in every `LicenseCheckIntervalMinutes` (and
  tolerates `OfflineGraceHours` of being unreachable before locking a
  legitimate customer out during a network blip). A revoke takes effect
  on the customer's *next* successful check, not instantly to the
  second.

## 1. Run it locally first

```bash
cd beru-license-server
npm install
ADMIN_KEY="pick-a-long-random-string" npm start
```

Visit `http://localhost:3000/admin.html` in your browser to use the
admin panel. Paste the same `ADMIN_KEY` into the "Admin key" field at
the top.

## 2. Deploy it somewhere with HTTPS

MT4's `WebRequest()` needs a real HTTPS endpoint (not `http://`, not a
self-signed cert). Easiest free/cheap options:

- **Render.com** - "New Web Service", connect this folder/repo, build
  command `npm install`, start command `npm start`, add an environment
  variable `ADMIN_KEY` with your secret value.
- **Railway.app** - similar: new project from this folder, set the
  `ADMIN_KEY` env var, it gives you an HTTPS URL automatically.
- Any VPS you already have, behind Caddy/nginx with a free Let's
  Encrypt certificate, running `node server.js` under `pm2` or a
  systemd service.

Whichever you choose, note the final HTTPS URL, e.g.
`https://beru-license.onrender.com`.

**Important:** `licenses.json` is a plain file on disk. On platforms
with ephemeral/rebuilding filesystems (some free tiers), it can reset
on redeploy. For anything beyond casual/small-scale use, swap
`loadDB`/`saveDB` in `server.js` for a real database (e.g. a hosted
Postgres/SQLite/Redis) - the rest of the code doesn't need to change.

## 3. Point the indicator at your server

In MT4, on each customer's terminal:

1. **Tools > Options > Expert Advisors** > check "Allow WebRequest for
   listed URL" and add your server's domain (e.g.
   `https://beru-license.onrender.com`). Without this step, every
   license check fails with error 4060 - that's MT4 blocking it, not a
   bug.
2. In the indicator's input `LicenseServerURL`, set it to
   `https://beru-license.onrender.com/check` (your domain + `/check`).

## 4. Add a customer

Open `https://your-domain/admin.html`, paste your admin key, enter
their **MT4 account number** (found in MT4 under Tools > Options >
Server, or just visible in the terminal title bar), pick a duration
(1 minute up to 1 year, or custom hours, or no expiry), and click
Grant. They'll be picked up on their indicator's next check-in.

## 5. Revoke a customer

Same admin page - find their row, click **Revoke**. Their indicator
will show "LICENSE: REVOKED / EXPIRED - signals disabled" and stop
firing stars/arrows once it next checks in (or once `OfflineGraceHours`
of cached trust runs out if they happened to be offline).

## API reference

- `GET /check?account=12345` - public, used by the indicator itself.
  Returns `{"valid": true, "expires": 1735689600000}` or
  `{"valid": false}`.
- `GET /admin/list` - requires `x-admin-key` header. Lists all licenses.
- `POST /admin/set` - requires `x-admin-key` header. Body:
  `{"account": "12345", "durationSeconds": 86400, "note": "optional"}`.
  Omit `durationSeconds` (or send `null`) for no expiry.
- `POST /admin/revoke` - requires `x-admin-key` header. Body:
  `{"account": "12345"}`.
- `POST /admin/delete` - requires `x-admin-key` header. Body:
  `{"account": "12345"}`. Removes the account entirely.
