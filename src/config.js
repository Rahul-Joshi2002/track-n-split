import { readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

/**
 * @typedef {object} AppConfig
 * @property {number} port
 * @property {string|null} groupJid
 * @property {string} sheetId
 * @property {object} serviceAccount
 * @property {string} pairToken
 * @property {string|null} pairPhone
 * @property {string} onlineMessage
 * @property {boolean} sendGroupMessages
 * @property {Date} startedAt
 */

/**
 * Load and validate environment. GROUP_JID may be empty for first-run discovery.
 * @returns {AppConfig}
 */
export function loadConfig() {
  const port = Number(process.env.PORT || 3000)
  const groupJid = String(process.env.GROUP_JID || "").trim() || null
  const sheetId = String(process.env.GOOGLE_SHEET_ID || "").trim()
  const pairToken = String(process.env.PAIR_TOKEN || "").trim()
  const pairPhone = String(process.env.PAIR_PHONE || "").replace(/\D/g, "") || null
  const onlineMessage = String(process.env.BOT_ONLINE_MESSAGE || "Expense bot is online.").trim()
  // SHIPPING: set SEND_GROUP_MESSAGES=true so receipts go to the WhatsApp group.
  const sendGroupMessages = isTruthy(process.env.SEND_GROUP_MESSAGES)
  const rawJson = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim()
  const jsonFile = String(process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "").trim()

  const missing = []
  if (!Number.isInteger(port) || port <= 0) missing.push("PORT")
  if (!sheetId) missing.push("GOOGLE_SHEET_ID")
  if (!pairToken) missing.push("PAIR_TOKEN")
  if (!rawJson && !jsonFile) missing.push("GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_ACCOUNT_JSON")

  if (missing.length) {
    throw new Error(`Missing or invalid environment variables: ${missing.join(", ")}`)
  }

  const serviceAccount = loadServiceAccount(jsonFile, rawJson)

  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error("Service account JSON must include client_email and private_key")
  }

  return {
    port,
    groupJid,
    sheetId,
    serviceAccount,
    pairToken,
    pairPhone,
    onlineMessage,
    sendGroupMessages,
    startedAt: new Date(),
  }
}

function isTruthy(value) {
  const text = String(value || "").trim().toLowerCase()
  return text === "true" || text === "yes" || text === "1"
}

function loadServiceAccount(jsonFile, rawJson) {
  const source = jsonFile || rawJson
  const text = looksLikeJson(source) ? source : readFileSync(resolvePath(source), "utf8")
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(
      "Service account is not valid JSON. Prefer GOOGLE_SERVICE_ACCOUNT_FILE=./service-account.json (multiline JSON does not work inside .env).",
    )
  }
}

function looksLikeJson(value) {
  return value.startsWith("{")
}

function resolvePath(file) {
  return isAbsolute(file) ? file : resolve(process.cwd(), file)
}
