/**
 * Split paise equally. Remainder (+1 paise) goes to the first `rem` people
 * after sorting participant JIDs lexicographically.
 *
 * @param {number} paise
 * @param {{ jid: string, name: string }[]} participants
 * @returns {{ jid: string, name: string, paise: number }[]}
 */
export function splitEqual(paise, participants) {
  if (!participants.length) {
    throw new Error("Need at least one participant")
  }

  const ordered = [...participants].sort((a, b) => a.jid.localeCompare(b.jid))
  const n = ordered.length
  const base = Math.floor(paise / n)
  const rem = paise % n

  return ordered.map((person, index) => ({
    jid: person.jid,
    name: person.name,
    paise: base + (index < rem ? 1 : 0),
  }))
}
