import { google } from "googleapis"
import { parseRupeesToPaise } from "./money.js"

export const MEMBER_HEADERS = ["jid", "display_name", "aliases", "active"]
export const TXN_HEADERS = [
  "serial",
  "expense_at",
  "description",
  "payer_name",
  "entered_by_name",
  "amount_formatted",
  "participant_names",
  "status",
  "id",
  "wa_message_id",
  "timestamp",
  "payer_jid",
  "entered_by_jid",
  "participant_jids",
  "split_count",
  "shares_json",
  "command_text",
  "reverses_id",
  "reversed_by_id",
]

const EXPENSE_TIMEZONE = process.env.EXPENSE_TIMEZONE || "Asia/Kolkata"

const TXN_SHEET_RANGE = `A:${columnLetter(TXN_HEADERS.length - 1)}`

export class Ledger {
  /**
   * @param {{ sheetId: string, serviceAccount: object }} opts
   */
  constructor({ sheetId, serviceAccount }) {
    this.sheetId = sheetId
    this.auth = new google.auth.JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    })
    this.sheets = google.sheets({ version: "v4", auth: this.auth })
    this.inflight = new Set()
  }

  async ping() {
    await this.sheets.spreadsheets.get({
      spreadsheetId: this.sheetId,
      fields: "spreadsheetId",
    })
  }

  async ensureReady() {
    await this.ensureTabs(["Members", "Transactions"])
    await this.dropColumnIfPresent("Transactions", "amount_paise")
    await this.ensureTabHeaders("Members", MEMBER_HEADERS)
    await this.ensureTabHeaders("Transactions", TXN_HEADERS)
  }

  async ensureTabs(titles) {
    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId: this.sheetId,
      fields: "sheets.properties.title",
    })
    const existing = new Set(
      (meta.data.sheets || []).map((sheet) => sheet.properties?.title).filter(Boolean),
    )
    const requests = titles
      .filter((title) => !existing.has(title))
      .map((title) => ({ addSheet: { properties: { title } } }))
    if (!requests.length) return
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.sheetId,
      requestBody: { requests },
    })
  }

  async dropColumnIfPresent(tab, headerName) {
    const headerRes = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: `${tab}!1:1`,
    })
    const head = (headerRes.data.values && headerRes.data.values[0]) || []
    const index = head.indexOf(headerName)
    if (index < 0) return

    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId: this.sheetId,
      fields: "sheets.properties",
    })
    const sheet = (meta.data.sheets || []).find((item) => item.properties?.title === tab)
    const sheetId = sheet?.properties?.sheetId
    if (sheetId == null) return

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.sheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: "COLUMNS",
                startIndex: index,
                endIndex: index + 1,
              },
            },
          },
        ],
      },
    })
    console.log(`Removed ${tab} column ${headerName}`)
  }

  async listMembers() {
    const rows = await this.readRows("Members", MEMBER_HEADERS)
    return rows
      .map((row) => ({
        jid: String(row.jid || "").trim(),
        name: String(row.display_name || "").trim(),
        aliases: String(row.aliases || "")
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean),
        active: isTruthy(row.active),
      }))
      .map((m) => ({ ...m, label: m.aliases[0] || m.name || m.jid }))
      .filter((m) => m.jid)
  }

  /**
   * Append missing group JIDs only. Leaves name, aliases, and active blank.
   * @param {string[]} jids
   * @returns {Promise<number>}
   */
  async addMissingMemberJids(jids) {
    const existing = await this.listMembers()
    const known = new Set(existing.map((m) => normalizeJid(m.jid)))
    const rows = []
    for (const jid of jids) {
      const clean = String(jid || "").trim()
      const key = normalizeJid(clean)
      if (!key || known.has(key)) continue
      known.add(key)
      rows.push([clean, "", "", ""])
    }
    if (!rows.length) return 0
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId,
      range: "Members!A:D",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    })
    return rows.length
  }

  /**
   * On a group message: add the JID if new, set display_name once, and mark active.
   * @param {{ jids: string[], displayName?: string }} opts
   * @returns {Promise<string|null>} sheet JID to use as sender
   */
  async rememberMemberFromMessage({ jids, displayName }) {
    const candidates = [...new Set((jids || []).map((jid) => String(jid || "").trim()).filter(Boolean))]
    if (!candidates.length) return null

    const rows = await this.readRows("Members", MEMBER_HEADERS)
    const found = rows.find((row) =>
      candidates.some((jid) => normalizeJid(row.jid) === normalizeJid(jid)),
    )
    const name = String(displayName || "").trim()

    if (!found) {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.sheetId,
        range: "Members!A:D",
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [[candidates[0], name, "", name ? "TRUE" : ""]] },
      })
      return candidates[0]
    }

    if (name && !String(found.display_name || "").trim()) {
      await this.updateCells(`Members!B${found.row}`, [[name]])
    }
    if (name && !String(found.active || "").trim()) {
      await this.updateCells(`Members!D${found.row}`, [["TRUE"]])
    }
    return String(found.jid || "").trim() || candidates[0]
  }

  async listTransactions() {
    const rows = await this.readRows("Transactions", TXN_HEADERS)
    return rows.map(rowToTxn).filter((txn) => txn.id)
  }

  /**
   * Append an active expense if this WhatsApp message has not been recorded.
   * @returns {"created"|"duplicate"}
   */
  async recordExpense(txn) {
    if (this.inflight.has(txn.waMessageId)) return "duplicate"
    this.inflight.add(txn.waMessageId)
    try {
      const existing = await this.listTransactions()
      if (existing.some((row) => row.waMessageId === txn.waMessageId)) {
        return "duplicate"
      }
      const serial = nextSerial(existing)
      await this.appendRow("Transactions", txnToRow(enrichTxnForSheet(txn, serial)))
      return "created"
    } finally {
      this.inflight.delete(txn.waMessageId)
    }
  }

  /**
   * Reverse the caller's latest active transaction.
   * @returns {{ original: object, reversal: object } | null}
   */
  async undoLatest(actorJid, undoMessageId) {
    const existing = await this.listTransactions()
    const want = normalizeJid(actorJid)
    const original = [...existing]
      .reverse()
      .find((txn) => {
        if (txn.status !== "active") return false
        if (normalizeJid(txn.payerJid) === want) return true
        const entered = String(txn.enteredByJid || "").trim()
        return entered && normalizeJid(entered) === want
      })
    if (!original) return null

    const reversal = {
      id: newTxnId(),
      waMessageId: undoMessageId,
      timestamp: new Date().toISOString(),
      payerJid: original.payerJid,
      payerName: original.payerName,
      enteredByJid: original.enteredByJid || original.payerJid,
      enteredByName: original.enteredByName || original.payerName,
      amountPaise: original.amountPaise,
      amountFormatted: original.amountFormatted,
      description: `undo ${original.description}`,
      participantJids: original.participantJids,
      participantNames: original.participantNames,
      splitCount: original.splitCount,
      shares: original.shares,
      commandText: "/undo",
      status: "reversal",
      reversesId: original.id,
      reversedById: "",
    }

    await this.updateTxnStatus(original.row, {
      status: "reversed",
      reversesId: original.reversesId,
      reversedById: reversal.id,
    })
    const serial = nextSerial(existing)
    await this.appendRow("Transactions", txnToRow(enrichTxnForSheet(reversal, serial)))
    return { original, reversal }
  }

  async ensureTabHeaders(tab, headers) {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: `${tab}!1:1`,
    })
    const first = (res.data.values && res.data.values[0]) || []
    if (first.length === 0) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.sheetId,
        range: `${tab}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] },
      })
    }
  }

  async readRows(tab, headers) {
    const colRange =
      tab === "Transactions" ? TXN_SHEET_RANGE : `A:${columnLetter(headers.length - 1)}`
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: `${tab}!${colRange}`,
    })
    const values = res.data.values || []
    if (values.length <= 1) return []
    const head = values[0]
    return values.slice(1).map((cells, index) => {
      const row = { row: index + 2 }
      for (const key of headers) {
        const col = head.indexOf(key)
        row[key] = col >= 0 ? cells[col] ?? "" : ""
      }
      return row
    })
  }

  async appendRow(tab, values) {
    const colRange =
      tab === "Transactions" ? TXN_SHEET_RANGE : `A:${columnLetter(values.length - 1)}`
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId,
      range: `${tab}!${colRange}`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [values] },
    })
  }

  async updateTxnStatus(rowNumber, { status, reversesId, reversedById }) {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: "Transactions!1:1",
    })
    const head = (res.data.values && res.data.values[0]) || TXN_HEADERS
    const fields = [
      ["status", status],
      ["reverses_id", reversesId || ""],
      ["reversed_by_id", reversedById || ""],
    ]
    for (const [name, value] of fields) {
      const col = head.indexOf(name)
      if (col < 0) {
        throw new Error(`Transactions sheet is missing a ${name} column`)
      }
      await this.updateCells(`Transactions!${columnLetter(col)}${rowNumber}`, [[value]])
    }
  }

  async updateCells(range, values) {
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.sheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values },
    })
  }
}

export function newTxnId() {
  const rand = Math.random().toString(36).slice(2, 8)
  return `txn_${Date.now().toString(36)}_${rand}`
}

function isTruthy(value) {
  const text = String(value || "").trim().toLowerCase()
  return text === "true" || text === "yes" || text === "1"
}

export function normalizeJid(jid) {
  return String(jid || "")
    .trim()
    .replace(/:\d+@/, "@")
    .toLowerCase()
}

/** @param {string|Date} when */
export function formatExpenseAt(when) {
  const date = when instanceof Date ? when : new Date(when)
  if (Number.isNaN(date.getTime())) return ""
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EXPENSE_TIMEZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date)
  const pick = (type) => parts.find((p) => p.type === type)?.value ?? ""
  const day = pick("day")
  const month = pick("month")
  const year = pick("year")
  const hour = pick("hour")
  const minute = pick("minute")
  const dayPeriod = pick("dayPeriod").toUpperCase()
  return `${day} ${month} ${year}, ${hour}:${minute} ${dayPeriod}`
}

function nextSerial(transactions) {
  let max = 0
  for (const txn of transactions) {
    const n = Number(txn.serial) || 0
    if (n > max) max = n
  }
  return max + 1
}

function enrichTxnForSheet(txn, serial) {
  return {
    ...txn,
    serial,
    expenseAt: txn.expenseAt || formatExpenseAt(txn.timestamp),
  }
}

function txnToRow(txn) {
  const record = {
    serial: String(txn.serial ?? ""),
    expense_at: txn.expenseAt ?? "",
    description: txn.description,
    payer_name: txn.payerName,
    entered_by_name: txn.enteredByName || txn.payerName || "",
    amount_formatted: txn.amountFormatted,
    participant_names: txn.participantNames.join(","),
    status: txn.status,
    id: txn.id,
    wa_message_id: txn.waMessageId,
    timestamp: txn.timestamp,
    payer_jid: txn.payerJid,
    entered_by_jid: txn.enteredByJid || txn.payerJid || "",
    participant_jids: txn.participantJids.join(","),
    split_count: String(txn.splitCount),
    shares_json: JSON.stringify(txn.shares),
    command_text: txn.commandText,
    reverses_id: txn.reversesId || "",
    reversed_by_id: txn.reversedById || "",
  }
  return TXN_HEADERS.map((key) => record[key] ?? "")
}

function rowToTxn(row) {
  let shares = []
  try {
    shares = row.shares_json ? JSON.parse(row.shares_json) : []
  } catch {
    shares = []
  }
  const shareTotal = shares.reduce((sum, share) => sum + Number(share.paise || 0), 0)
  const parsed = parseRupeesToPaise(row.amount_formatted)
  return {
    row: row.row,
    serial: Number(row.serial) || 0,
    id: String(row.id || "").trim(),
    waMessageId: String(row.wa_message_id || "").trim(),
    timestamp: String(row.timestamp || "").trim(),
    payerJid: String(row.payer_jid || "").trim(),
    payerName: String(row.payer_name || "").trim(),
    enteredByJid: String(row.entered_by_jid || "").trim(),
    enteredByName: String(row.entered_by_name || "").trim(),
    amountPaise: shareTotal || (parsed.ok ? parsed.paise : 0),
    amountFormatted: String(row.amount_formatted || "").trim(),
    description: String(row.description || "").trim(),
    participantJids: splitList(row.participant_jids),
    participantNames: splitList(row.participant_names),
    splitCount: Number(row.split_count) || 0,
    shares,
    commandText: String(row.command_text || "").trim(),
    status: String(row.status || "").trim() || "active",
    reversesId: String(row.reverses_id || "").trim(),
    reversedById: String(row.reversed_by_id || "").trim(),
  }
}

function columnLetter(index) {
  let n = index + 1
  let out = ""
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
}
