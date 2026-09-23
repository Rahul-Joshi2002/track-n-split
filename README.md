# Trip expense bot

A small WhatsApp group expense tracker for a short trip. One Node process keeps a WhatsApp Web session (your personal number, as a linked device), listens to **one group**, writes every expense to **Google Sheets**, and serves a pairing page plus health checks.

Day-to-day use is WhatsApp commands. The only web UI is `/pair` for scanning a QR when the session drops.

**Before shipping:** set `SEND_GROUP_MESSAGES=true` in `.env`. It is `false` now so the bot stays silent in the group during local testing. Replies are printed in the terminal instead.

## What you need

- Node 20+ and npm (already on this machine is fine)
- A Google Sheet with `Members` and `Transactions` tabs
- A Google Cloud service account that can edit that sheet
- A free web host (Render or similar)
- An external uptime monitor that pings `/health`

Do not install packages globally. From this folder only: `npm install` / `npm ci`.

`npm start` takes **no CLI flags**. Everything is read from a `.env` file in this folder (or from the host’s environment variables).

## Start locally

You already have the sheet ID and service-account JSON. You still need a pairing secret, and (recommended) your phone number. Leave `GROUP_JID` empty on the first run.

```bash
cd /Users/rahuljoshi/local/trip-expense-bot
cp .env.example .env
```

Edit `.env` and set at least:

```bash
GOOGLE_SHEET_ID=your_sheet_id_here
GOOGLE_SERVICE_ACCOUNT_FILE=./service-account.json
PAIR_TOKEN=pick-a-long-random-secret
PAIR_PHONE=9198XXXXXXXX
GROUP_JID=
PORT=3000
```

Then:

```bash
cd /Users/rahuljoshi/local/trip-expense-bot
npm install
npm start
```

Open:

```text
http://localhost:3000/pair?token=YOUR_PAIR_TOKEN
```

Scan the QR (or type the pairing code). After WhatsApp is linked, send any message in the trip group, copy the logged `@g.us` id into `GROUP_JID`, and `npm start` again.

| Needed to start | You have it? |
|---|---|
| `GOOGLE_SHEET_ID` | yes |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | yes locally | Path to downloaded service-account JSON, e.g. `./service-account.json` |
| `PAIR_TOKEN` | create any long secret; used only for the `/pair` page |
| `PAIR_PHONE` | recommended — your number, digits only, no `+` |
| `GROUP_JID` | leave empty first time; required after you discover it |
| `PORT` | optional, default `3000` |
| `BOT_ONLINE_MESSAGE` | optional |

Also confirm the sheet is shared with the service account email, and that the `Members` / `Transactions` header row exists.

## WhatsApp commands

```text
/help
/status
/paid 850 dinner /split equal all
/paid amount description /split equal all
/paid 1000 dinner /split me 400 @You 600
/paid amount description /split person amount person amount …
/balance
/summary
/undo
```

- `/paid … /split equal all` — sender pays; split across every **active** member, including the payer.
- `/paid … /split equal me @You` — named people (WhatsApp mentions and/or names from the Members sheet) are the full list. The payer is **not** added unless named. Use `me`, `@You`, `they`, or sheet names.
- `/paid … /split me 700 @You 300` — unequal shares: alternate **person** and **amount**; each person once; share amounts must **sum exactly** to the paid total. Names can be `me`, `@You`, `they`, or sheet names. No `all`.
- Amounts are rupees (`850`, `850.50`). Stored as integer paise.
- Equal-split remainder (1 paise) goes to members in **JID order**.
- `/undo` reverses the caller’s latest active expense. Rows are never deleted.
- Unknown senders are rejected.

## 1. Google Sheet

Create one spreadsheet with two tabs. Row 1 headers must be:

**Members**

`jid` | `display_name` | `aliases` | `active`

**Transactions**

`serial` | `expense_at` | `description` | `payer_name` | `amount_formatted` | `participant_names` | `status` | `id` | `wa_message_id` | `timestamp` | `payer_jid` | `participant_jids` | `split_count` | `shares_json` | `command_text` | `reverses_id` | `reversed_by_id`

`expense_at` is human-readable local time (default timezone `Asia/Kolkata`; override with `EXPENSE_TIMEZONE`). `timestamp` stays ISO UTC for the bot.

Leave Transactions empty (no header row) on a fresh setup: the bot writes row 1 on startup. Fill Members after the first WhatsApp connect (the bot logs participant JIDs).

`active` is `TRUE` or `FALSE`. `aliases` is comma-separated (`asha,ash`).

Copy the sheet ID from the URL:

`https://docs.google.com/spreadsheets/d/`**`THIS_ID`**`/edit`

## 2. Google Cloud service account

The bot is not logged into Google as you. You invite a robot user.

1. Open [Google Cloud Console](https://console.cloud.google.com) and pick or create a project.
2. **APIs & Services → Library → Google Sheets API → Enable.**
3. **Credentials → Create credentials → Service account.** Name it e.g. `trip-expense-bot`.
4. Open the service account → **Keys → Add key → JSON** and download the file.
5. Copy `client_email` from that JSON.
6. In the spreadsheet: **Share → paste that email → Editor → uncheck Notify → Share.**

You will save the downloaded JSON as `service-account.json` in this folder (gitignored) and set `GOOGLE_SERVICE_ACCOUNT_FILE=./service-account.json`. On Render you can instead paste the JSON as one line into `GOOGLE_SERVICE_ACCOUNT_JSON`. Do not commit the key file.

## 3. Environment

Copy `.env.example` to `.env` for local runs.

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no (default 3000) | HTTP port. Hosts like Render set this. |
| `GROUP_JID` | yes after discovery | Trip group, e.g. `1203630…@g.us` |
| `GOOGLE_SHEET_ID` | yes | Spreadsheet ID |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | yes locally | Path to `service-account.json` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | yes on hosts | Full service-account JSON on one line (alternative to the file) |
| `PAIR_TOKEN` | yes | Secret for `/pair?token=…` |
| `PAIR_PHONE` | recommended | Your number, digits only, e.g. `9198XXXXXXXX` |
| `BOT_ONLINE_MESSAGE` | no | Default: `Expense bot is online.` |

Generate a long random `PAIR_TOKEN`. Bookmark `https://<host>/pair?token=…` before the trip.

## 4. WhatsApp pairing (personal number)

The bot becomes a **linked device** on your personal WhatsApp.

1. Start the app (`npm start` locally, or deploy).
2. Open `/pair?token=YOUR_TOKEN`.
3. Either:
   - Scan the QR from another screen: WhatsApp → **Linked devices** → **Link a device**.
   - On the same phone: **Link with phone number** and type the pairing code (`PAIR_PHONE` must be set).
4. Wait until the page says the bot is linked. The trip group gets `Expense bot is online.`

Logs also print a QR if the page is unreachable.

You need a free linked-device slot (WhatsApp allows a small number, typically 4). The primary phone should stay active from time to time.

## 5. Find the group JID

Leave `GROUP_JID` empty on the first run. After pairing, send any message in the trip group. The process logs inbound `@g.us` IDs only (no message bodies). Copy the trip group’s ID into `GROUP_JID` and restart.

After that, the bot listens and replies **only** in that group. Other chats are ignored. Message bodies from other chats are not logged.

## 6. Fill Members

On connect, the bot logs every participant JID and sends one group message listing people not yet on the sheet. Paste those JIDs into Members with a display name, aliases, and `TRUE`.

## 7. Deploy (Render-style free web service)

1. Push this folder as a repo.
2. Create a **Web Service**.
3. Build: `npm ci`
4. Start: `npm start` (runs `node src/index.js`). No build step.
5. Set the env vars above.
6. **Host health check must be `/live`**, not `/health`. `/health` returns 503 while WhatsApp is unpaired; a host probe on `/health` will reboot-loop during QR wait.
7. Open `https://<service>/pair?token=…` and link WhatsApp.

Dockerfile is included if the host uses containers (`CMD ["node","src/index.js"]`).

## 8. External uptime ping

Configure UptimeRobot (or similar) **outside** the host to `GET /health` every 5–10 minutes.

That ping reduces free-tier sleep. It does **not** prevent host restarts, crashes, or missed WhatsApp messages. This app does not ping itself.

`/health` is 200 only when WhatsApp is connected **and** the sheet is reachable. Otherwise 503. The monitor still counts as traffic.

## 9. Recovery during the trip

The WhatsApp session is **in memory**. If the host restarts, sleeps, or crashes, you must pair again.

1. Open the bookmarked `/pair?token=…` page.
2. Scan the QR or type the pairing code.
3. Wait for `Expense bot is online.` in the group.

The ledger stays in Google Sheets. Restarting the bot does not lose expenses.

## Known limits

- Baileys is unofficial WhatsApp Web automation. WhatsApp can drop or restrict a linked device. Group-only *behavior* does not hide the client. Using a personal number accepts that risk.
- While linked, the process *can see* every chat. It does not process or body-log other chats. Treat `PAIR_TOKEN`, the host URL, and the service-account JSON as secrets.
- Replies come from your personal number.
- A public `/pair` page without a token lets someone else bind the bot to the wrong account.
- Same-phone QR scanning is awkward; use the pairing code.
- Messages sent while the process is asleep may be missed. Dedup prevents doubles; it cannot invent traffic WhatsApp never delivered.
- History sync after a short outage is best-effort.
- No multi-currency, no dashboard, no AI parsing.

## Local run

See **Start locally** above. There are no extra CLI options: `npm start` is enough after `.env` is filled.
