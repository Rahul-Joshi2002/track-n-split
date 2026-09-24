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
  const head = parsePaidHead(left)
  if (head.kind === "error") return head

  const { payerToken, amountRaw, description } = head

  const splitMatch = right.match(/^\/split\s+equal\s+(.+)$/i)
  if (splitMatch) {
    return parseEqualSplit({ payerToken, amountRaw, description, rest: splitMatch[1] })
  }

  return parseCustomSplit({ payerToken, amountRaw, description, right })
}

function parsePaidHead(left) {
  if (/^\/paid\s+by\s+/i.test(left)) {
    const byMatch = left.match(/^\/paid\s+by\s+(\S+)\s+(\S+)\s+(.+)$/i)
    if (!byMatch) {
      return {
        kind: "error",
        error: "Usage: /paid by @Name 1000 dinner /split equal all",
      }
    }
    const payerToken = normalizeMentionToken(byMatch[1])
    const description = byMatch[3].trim()
    if (!payerToken) {
      return { kind: "error", error: "Who paid? Example: /paid by @Name 1000 dinner /split equal all" }
    }
    if (!description) {
      return { kind: "error", error: "Add a short description, e.g. dinner" }
    }
    return { kind: "ok", payerToken, amountRaw: byMatch[2], description }
  }

  const paidMatch = left.match(/^\/paid\s+(\S+)\s+(.+)$/i)
  if (!paidMatch) {
    return {
      kind: "error",
      error: "Usage: /paid 850 dinner /split equal all",
    }
  }

  const description = paidMatch[2].trim()
  if (!description) {
    return {
      kind: "error",
      error: "Add a short description, e.g. dinner",
    }
  }

  return { kind: "ok", payerToken: null, amountRaw: paidMatch[1], description }
}

function parseEqualSplit({ payerToken, amountRaw, description, rest }) {
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
    return { kind: "paid", payerToken, amountRaw, description, split: "all", mentionTokens: [] }
  }
  if (!mentionTokens.length) {
    return {
      kind: "error",
      error: "Name who to split with. Example: /paid 850 dinner /split equal me @Name",
    }
  }

  return { kind: "paid", payerToken, amountRaw, description, split: "named", mentionTokens }
}

function parseCustomSplit({ payerToken, amountRaw, description, right }) {
  const splitMatch = right.match(/^\/split\s+(.+)$/i)
  if (!splitMatch) {
    return {
      kind: "error",
      error: "Use /split equal all or /split me 700 @Name 300",
    }
  }

  const tokens = splitMatch[1].trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) {
    return {
      kind: "error",
      error: "Add split pairs: person amount person amount. Example: /split me 400 @Name 600",
    }
  }
  if (tokens.length % 2 !== 0) {
    return {
      kind: "error",
      error: "Custom split needs person-and-amount pairs. Example: /split me 700 @Name 300",
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

  return { kind: "paid", payerToken, amountRaw, description, split: "custom", pairs }
}

function normalizeMentionToken(token) {
  return String(token || "")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/^[@\uFF20]+/g, "")
    .trim()
    .toLowerCase()
}

export const HELP_TEXT = [
  "*Trip expense bot*",
  "",
  "*You paid*",
  "/paid 1000 dinner /split equal all",
  "/paid 1000 dinner /split equal me @Name",
  "",
  "*Someone else paid* (you enter it)",
  "/paid by @Name 1000 dinner /split equal all",
  "",
  "*Unequal split*",
  "Alternate person and amount; shares must sum to the paid total.",
  "/paid 1000 dinner /split me 400 @Name 600",
  "",
  "*Reports*",
  "/balance",
  "/summary",
  "",
  "*Other*",
  "/undo",
  "/status",
  "",
  "_Amounts:_ rupees (850 or 850.50), at most 2 decimal places.",
  "_Names in splits:_ me = you (sender), @mention, or sheet name/alias.",
].join("\n")
