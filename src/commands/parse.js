import { parseRupeesToPaise } from "../ledger/money.js"

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
  if (splitMatch) {
    return parseEqualSplit(amountRaw, description, splitMatch[1])
  }

  return parseCustomSplit(amountRaw, description, right)
}

function parseEqualSplit(amountRaw, description, rest) {
  const tokens = rest.trim().split(/\s+/).filter(Boolean)
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
      error: "Name who to split with. Example: /paid 850 dinner /split equal me @You",
    }
  }

  return { kind: "paid", amountRaw, description, split: "named", mentionTokens }
}

function parseCustomSplit(amountRaw, description, right) {
  const splitMatch = right.match(/^\/split\s+(.+)$/i)
  if (!splitMatch) {
    return {
      kind: "error",
      error: "Use /split equal all or /split me 700 @You 300",
    }
  }

  const tokens = splitMatch[1].trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) {
    return {
      kind: "error",
      error: "Add split pairs: person amount person amount. Example: /split me 400 @You 600",
    }
  }
  if (tokens.length % 2 !== 0) {
    return {
      kind: "error",
      error: "Custom split needs person-and-amount pairs. Example: /split me 700 @You 300",
    }
  }

  /** @type {{ personToken: string, amountRaw: string }[]} */
  const pairs = []
  for (let i = 0; i < tokens.length; i += 2) {
    const personRaw = tokens[i]
    const shareAmountRaw = tokens[i + 1]
    const personToken = normalizeMentionToken(personRaw)
    if (!personToken) {
      return { kind: "error", error: "Each share needs a person (me, @name, or sheet name)." }
    }
    if (personToken === "all") {
      return {
        kind: "error",
        error: "Custom split cannot use all. List each person and their share amount.",
      }
    }
    const shareAmount = parseRupeesToPaise(shareAmountRaw)
    if (!shareAmount.ok) {
      return {
        kind: "error",
        error: `Amount for ${personRaw} must be rupees (e.g. 300): ${shareAmount.error}`,
      }
    }
    pairs.push({ personToken, amountRaw: shareAmountRaw })
  }

  return { kind: "paid", amountRaw, description, split: "custom", pairs }
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
  "/paid 1000 dinner /split equal all",
  "paid 1000 dinner /split equal me @You",
  "/paid 1000 dinner /split me 400 @You 600",
  "names can be me, @ mention, or sheet names; alternate person and amount",
  "/balance",
  "/summary",
  "/undo",
  "/status",
  "",
  "Amounts are rupees (850 or 850.50), at most 2 decimal places",
  "Unequal shares must sum exactly to the paid amount",
].join("\n")
