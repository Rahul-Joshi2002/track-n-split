/**
 * Net position from active transactions: paid minus share.
 * @param {{ payerJid: string, amountPaise: number, shares: { jid: string, paise: number }[] }[]} transactions
 * @param {{ jid: string, name: string }[]} members
 * @returns {{ jid: string, name: string, netPaise: number }[]}
 */
export function computeNets(transactions, members) {
  const nets = new Map(members.map((m) => [m.jid, 0]))

  for (const txn of transactions) {
    if (!nets.has(txn.payerJid)) nets.set(txn.payerJid, 0)
    nets.set(txn.payerJid, nets.get(txn.payerJid) + txn.amountPaise)

    for (const share of txn.shares) {
      if (!nets.has(share.jid)) nets.set(share.jid, 0)
      nets.set(share.jid, nets.get(share.jid) - share.paise)
    }
  }

  const byJid = new Map(members.map((m) => [m.jid, m.name]))
  return [...nets.entries()]
    .map(([jid, netPaise]) => ({
      jid,
      name: byJid.get(jid) || jid,
      netPaise,
    }))
    .sort((a, b) => a.jid.localeCompare(b.jid))
}

/**
 * Deterministic greedy settlements: largest |net| first, then JID.
 * @param {{ jid: string, name: string, netPaise: number }[]} nets
 * @returns {{ fromJid: string, fromName: string, toJid: string, toName: string, paise: number }[]}
 */
export function suggestSettlements(nets) {
  const debtors = nets
    .filter((n) => n.netPaise < 0)
    .map((n) => ({ ...n, remaining: -n.netPaise }))
    .sort(compareAbsThenJid)

  const creditors = nets
    .filter((n) => n.netPaise > 0)
    .map((n) => ({ ...n, remaining: n.netPaise }))
    .sort(compareAbsThenJid)

  const transfers = []
  let i = 0
  let j = 0

  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].remaining, creditors[j].remaining)
    if (pay > 0) {
      transfers.push({
        fromJid: debtors[i].jid,
        fromName: debtors[i].name,
        toJid: creditors[j].jid,
        toName: creditors[j].name,
        paise: pay,
      })
      debtors[i].remaining -= pay
      creditors[j].remaining -= pay
    }
    if (debtors[i].remaining === 0) i += 1
    if (creditors[j].remaining === 0) j += 1
  }

  return transfers
}

function compareAbsThenJid(a, b) {
  const absDiff = Math.abs(b.netPaise) - Math.abs(a.netPaise)
  if (absDiff !== 0) return absDiff
  return a.jid.localeCompare(b.jid)
}

/**
 * Sum of active expense amounts (not reversals).
 * @param {{ amountPaise: number }[]} transactions
 */
export function totalSpent(transactions) {
  return transactions.reduce((sum, txn) => sum + txn.amountPaise, 0)
}
