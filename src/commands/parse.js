/**
 * @typedef {"help"|"status"|"balance"|"summary"|"undo"|"paid"|"error"|"unknown"|"ignore"} CommandKind
 */

/**
 * Parse a fixed command line. No NLP.
 * @param {string} text
 */
export function parseCommand(text) {
  const raw = String(text || "").replace(/\u00a0/g, " ").trim()
  if (!raw.startsWith("/")) return { kind: "ignore" }

  const name = raw.split(/\s+/, 1)[0].toLowerCase()

  if (name === "/help") return { kind: "help" }
  if (name === "/status") return { kind: "status" }
  if (name === "/balance") return { kind: "balance" }
  if (name === "/summary") return { kind: "summary" }
  if (name === "/undo") return { kind: "undo" }

  if (name === "/paid") return parsePaid(raw)

  return { kind: "unknown" }
}

function parsePaid(raw) {
  const splitAt = raw.search(/\s\/split\b/i)
  if (splitAt === -1) {
    return {
      kind: "error",
      error: "Add a split. Example: /paid 850 dinner /split equal all",
    }
  }

  const left = raw.slice(0, splitAt).trim()
  const right = raw.slice(splitAt).trim()
  const paidMatch = left.match(/^\/paid\s+(\S+)\s+(.+)$/i)
  if (!paidMatch) {
    return {
      kind: "error",
      error: "Usage: /paid 850 dinner /split equal all",
    }
  }

  const amountRaw = paidMatch[1]
  const description = paidMatch[2].trim()
  if (!description) {
    return {
      kind: "error",
      error: "Add a short description, e.g. dinner",
    }
  }

  const splitMatch = right.match(/^\/split\s+equal\s+(.+)$/i)
  if (!splitMatch) {
    return {
      kind: "error",
      error: "Use /split equal all or /split equal @Asha @Vikram",
    }
  }

  const tokens = splitMatch[1].trim().split(/\s+/).filter(Boolean)
  const mentionTokens = tokens
    .filter((token) => normalizeMentionToken(token) !== "all")
    .map(normalizeMentionToken)
    .filter(Boolean)

  const hasAll = tokens.some((token) => normalizeMentionToken(token) === "all")

  if (hasAll && mentionTokens.length) {
    return { kind: "error", error: "Use either all or named people, not both" }
  }
  if (hasAll) {
    return { kind: "paid", amountRaw, description, split: "all", mentionTokens: [] }
  }
  if (!mentionTokens.length) {
    return {
      kind: "error",
      error: "Name who to split with. Example: /paid 850 dinner /split equal me @Asha",
    }
  }

  return { kind: "paid", amountRaw, description, split: "named", mentionTokens }
}

function normalizeMentionToken(token) {
  return String(token || "")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/^[@\uFF20]+/g, "")
    .trim()
    .toLowerCase()
}

export const HELP_TEXT = [
  "Expense bot commands:",
  "/paid 850 dinner /split equal all",
  "/paid 850 dinner /split equal me @Asha",
  "/paid 850 dinner /split equal @Asha @Vikram",
  "/balance",
  "/summary",
  "/undo",
  "/status",
  "",
  "Amounts are rupees (850 or 850.50). Equal-split remainder (1 paise) goes to members in JID order.",
  "Named splits use only the people you list. WhatsApp cannot @mention you — type me (or @me) to include yourself.",
].join("\n")
