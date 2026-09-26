import { HELP_TEXT, parseCommand } from "./parse.js"
import { formatPaise, parseRupeesToPaise } from "../ledger/money.js"
import { splitEqual } from "../ledger/split.js"
import { computeNets, suggestSettlements, totalSpent } from "../ledger/settle.js"
import { formatExpenseAt, newTxnId, normalizeJid } from "../ledger/sheets.js"

/**
 * @param {object} opts
 * @param {import("../ledger/sheets.js").Ledger} opts.ledger
 * @param {{ whatsapp: string, connectedAt: Date|null }} opts.state
 * @param {Date} opts.startedAt
 */
export function createHandler({ ledger, state, startedAt }) {
  return async function handleCommand(input) {
    const parsed = parseCommand(input.text)
    if (parsed.kind === "ignore") return null

    if (parsed.kind === "unknown") {
      return "Unknown command. Send /help for examples."
    }
    if (parsed.kind === "error") return parsed.error
    if (parsed.kind === "help") return HELP_TEXT
    if (parsed.kind === "status") return formatStatus(state, startedAt, ledger)

    let members
    try {
      members = await ledger.listMembers()
    } catch (err) {
      return `Could not read the Members sheet: ${err.message}`
    }

    const sender = findMember(members, input.senderJid)
    if (!sender) {
      return "You're not on the trip roster. Ask the organiser to add your WhatsApp JID to the Members sheet."
    }

    if (parsed.kind === "paid") {
      return handlePaid({ parsed, input, members, sender, ledger })
    }
    if (parsed.kind === "undo") {
      return handleUndo({ input, sender, ledger })
    }
    if (parsed.kind === "balance" || parsed.kind === "summary") {
      return handleReport({ kind: parsed.kind, members, ledger })
    }

    return "Unknown command. Send /help for examples."
  }
}

async function handlePaid({ parsed, input, members, sender, ledger }) {
  const amount = parseRupeesToPaise(parsed.amountRaw)
  if (!amount.ok) return amount.error

  let payerMember
  let participants
  let shares
  try {
    payerMember = resolvePayer(parsed.payerToken, {
      members,
      sender,
      mentionedJids: input.mentionedJids,
    })
    if (parsed.split === "custom") {
      const built = buildCustomShares({
        pairs: parsed.pairs,
        totalPaise: amount.paise,
        members,
        recorder: sender,
        mentionedJids: input.mentionedJids,
      })
      shares = built.shares
      participants = built.participants
    } else {
      participants = resolveParticipants({
        split: parsed.split,
        mentionTokens: parsed.mentionTokens,
        mentionedJids: input.mentionedJids,
        members,
        recorder: sender,
      })
      shares = splitEqual(amount.paise, participants)
    }
  } catch (err) {
    return err.message
  }
  const txn = {
    id: newTxnId(),
    waMessageId: input.messageId,
    timestamp: new Date().toISOString(),
    payerJid: payerMember.jid,
    payerName: payerMember.name,
    enteredByJid: sender.jid,
    enteredByName: publicLabel(sender),
    amountPaise: amount.paise,
    amountFormatted: formatPaise(amount.paise),
    description: parsed.description,
    participantJids: participants.map((p) => p.jid),
    participantNames: participants.map((p) => p.name),
    splitCount: participants.length,
    shares,
    commandText: input.text,
    status: "active",
    reversesId: "",
    reversedById: "",
  }

  let result
  try {
    result = await ledger.recordExpense(txn)
  } catch (err) {
    return `Could not save that expense to the sheet: ${err.message}`
  }

  if (result === "duplicate") return null

  const lines = ["*Transaction recorded*"]
  lines.push(`${txn.payerName} paid *${txn.amountFormatted}* for _${txn.description}_`)
  if (normalizeJid(txn.payerJid) !== normalizeJid(txn.enteredByJid)) {
    lines.push(`Entered by ${txn.enteredByName}`)
  }
  lines.push("")
  lines.push(`*Split (${txn.splitCount} ways)*`)
  for (const share of shares) {
    lines.push(`${share.name}  ${formatPaise(share.paise)}`)
  }
  return lines.join("\n")
}

async function handleUndo({ input, sender, ledger }) {
  let result
  try {
    result = await ledger.undoLatest(sender.jid, input.messageId)
  } catch (err) {
    return `Could not undo on the sheet: ${err.message}`
  }
  if (!result) return "_Nothing to undo._"

  const { original } = result
  return [
    "*Transaction reversed*",
    `${original.payerName} paid *${original.amountFormatted}* for _${original.description}_`,
  ].join("\n")
}

async function handleReport({ kind, members, ledger }) {
  let transactions
  try {
    transactions = await ledger.listTransactions()
  } catch (err) {
    return `Could not read the Transactions sheet: ${err.message}`
  }

  const active = transactions.filter((txn) => txn.status === "active")
  const roster = members.filter((m) => m.active).map((m) => ({ ...m, name: publicLabel(m) }))
  const nets = computeNets(active, roster)
  const settlements = suggestSettlements(nets)
  const lines = []

  if (kind === "summary") {
    lines.push("*Summary*")
    lines.push("")
    lines.push(`*Total spent:* ${formatPaise(totalSpent(active))}`)
    lines.push("")
    lines.push("*Balances*")
  } else {
    lines.push("*Balances*")
  }

  for (const net of nets) {
    const sign = net.netPaise > 0 ? "+" : ""
    lines.push(`${net.name}  ${sign}${formatPaise(net.netPaise)}`)
  }

  lines.push("")
  if (!settlements.length) {
    lines.push("*Settlements*")
    lines.push("_None needed — everyone is square._")
  } else {
    lines.push("*Suggested settlements*")
    for (const s of settlements) {
      lines.push(`${s.fromName} → ${s.toName}  ${formatPaise(s.paise)}`)
    }
  }

  return lines.join("\n")
}

async function formatStatus(state, startedAt, ledger) {
  let sheets = "error"
  try {
    await ledger.ping()
    sheets = "ok"
  } catch {
    sheets = "error"
  }
  const startedIst = formatExpenseAt(startedAt)
  return [
    `*WhatsApp:* _${state.whatsapp}_`,
    `*Sheets:* _${sheets}_`,
    `*Started (IST):* _${startedIst}_`,
  ].join("\n")
}

function resolvePayer(payerToken, { members, sender, mentionedJids }) {
  if (!payerToken) {
    return { jid: sender.jid, name: publicLabel(sender) }
  }
  if (isMeToken(payerToken)) {
    return { jid: sender.jid, name: publicLabel(sender) }
  }
  const mentionQueue = [...(mentionedJids || [])]
  return resolveOneParticipant(payerToken, {
    members,
    recorder: sender,
    mentionQueue,
    usedJids: new Set(),
  })
}

function buildCustomShares({ pairs, totalPaise, members, recorder, mentionedJids }) {
  const shares = []
  const usedJids = new Set()
  const mentionQueue = [...(mentionedJids || [])]

  for (const pair of pairs) {
    const person = resolveOneParticipant(pair.personToken, {
      members,
      recorder,
      mentionQueue,
      usedJids,
    })
    if (usedJids.has(normalizeJid(person.jid))) {
      throw new Error(`Duplicate split for ${person.name}. Each person can appear once.`)
    }
    usedJids.add(normalizeJid(person.jid))

    const shareAmount = parseRupeesToPaise(pair.amountRaw)
    if (!shareAmount.ok) {
      throw new Error(shareAmount.error)
    }

    shares.push({
      jid: person.jid,
      name: person.name,
      paise: shareAmount.paise,
    })
  }

  const sum = shares.reduce((acc, share) => acc + share.paise, 0)
  if (sum !== totalPaise) {
    throw new Error(
      `Shares sum to ${formatPaise(sum)} but paid amount is ${formatPaise(totalPaise)}.`,
    )
  }

  const participants = shares.map((share) => ({ jid: share.jid, name: share.name }))
  return { shares, participants }
}

function resolveOneParticipant(token, { members, recorder, mentionQueue, usedJids }) {
  if (isMeToken(token)) {
    return { jid: recorder.jid, name: publicLabel(recorder) }
  }

  const matches = matchName(members, token)
  if (matches.length > 1) {
    throw new Error(
      `@${token} is ambiguous (${matches.map((m) => m.name).join(", ")}). Use a fuller name or a WhatsApp mention.`,
    )
  }
  if (matches.length === 1) {
    return { jid: matches[0].jid, name: publicLabel(matches[0]) }
  }

  while (mentionQueue.length) {
    const jid = mentionQueue.shift()
    const norm = normalizeJid(jid)
    if (usedJids.has(norm)) continue
    const active = members.filter((m) => m.active)
    const member = findMember(active, jid) || findMember(members, jid)
    if (!member) {
      throw new Error(`Mentioned person is not an active trip member: ${jid}`)
    }
    return { jid: member.jid, name: publicLabel(member) }
  }

  throw new Error(
    `No member matches @${token}. Use a WhatsApp mention, a sheet name/alias, or me. Example: /split me 400 @Name 600`,
  )
}

function resolveParticipants({ split, mentionTokens, mentionedJids, members, recorder }) {
  const active = members.filter((m) => m.active)
  if (split === "all") {
    if (!active.length) {
      throw new Error("No active members in the Members sheet.")
    }
    return active.map((m) => ({ jid: m.jid, name: publicLabel(m) }))
  }

  const found = new Map()

  for (const jid of mentionedJids || []) {
    const member = findMember(active, jid) || findMember(members, jid)
    if (!member) {
      throw new Error(`Mentioned person is not an active trip member: ${jid}`)
    }
    found.set(member.jid, { jid: member.jid, name: publicLabel(member) })
  }

  for (const token of mentionTokens) {
    if (isMeToken(token)) {
      found.set(recorder.jid, { jid: recorder.jid, name: publicLabel(recorder) })
      continue
    }
    const matches = matchName(members, token)
    if (matches.length === 0) {
      // WhatsApp mentions already resolved by JID; leftover @Name text is not a sheet alias.
      if ((mentionedJids || []).length) continue
      throw new Error(
        `No member matches @${token}. Use a WhatsApp mention, a sheet name/alias, or me. Example: /paid 850 dinner /split equal me @Name`,
      )
    }
    if (matches.length > 1) {
      throw new Error(
        `@${token} is ambiguous (${matches.map((m) => m.name).join(", ")}). Use a fuller name or a WhatsApp mention.`,
      )
    }
    found.set(matches[0].jid, { jid: matches[0].jid, name: publicLabel(matches[0]) })
  }

  if (!found.size) {
    throw new Error("Name who to split with. Example: /paid 850 dinner /split equal me @Name")
  }

  return [...found.values()]
}

function findMember(members, jid) {
  const want = normalizeJid(jid)
  return members.find((m) => normalizeJid(m.jid) === want) || null
}

function isMeToken(token) {
  const text = String(token || "")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/^[@\uFF20]+/g, "")
    .trim()
    .toLowerCase()
  return text === "me" || text === "myself"
}

/** Prefer the first alias in replies; otherwise display_name; otherwise JID. */
function publicLabel(member) {
  if (member.label) return member.label
  const alias = (member.aliases || [])[0]
  if (alias) return alias
  return member.name || member.jid
}

function matchName(members, token) {
  const needle = token.toLowerCase()
  return members.filter((m) => {
    const names = [m.name, ...(m.aliases || [])].filter(Boolean).map((n) => n.toLowerCase())
    return names.some((name) => name === needle || name.startsWith(needle))
  })
}
