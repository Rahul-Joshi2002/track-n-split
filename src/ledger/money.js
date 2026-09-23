/**
 * Parse a rupee amount into integer paise. Accepts 850, 850.5, 850.50, 850.500 (trailing zeros), ₹850, 1,850.50.
 * @param {string} raw
 * @returns {{ ok: true, paise: number } | { ok: false, error: string }}
 */
export function parseRupeesToPaise(raw) {
  if (raw == null) {
    return { ok: false, error: "Amount is required. Example: /paid 850 dinner /split equal all" }
  }

  let text = String(raw).trim()
  text = text.replace(/₹/g, "").replace(/rs\.?/gi, "").replace(/,/g, "").trim()

  if (!/^\d+(\.\d+)?$/.test(text)) {
    return { ok: false, error: "Amount must be rupees, like 850 or 850.50" }
  }

  const [whole, fraction = ""] = text.split(".")
  if (fraction.length > 2) {
    const extra = fraction.slice(2)
    if (!/^0+$/.test(extra)) {
      return { ok: false, error: "Amount can have at most 2 decimal places" }
    }
  }

  const paise = Number(whole) * 100 + Number((fraction + "00").slice(0, 2))
  if (!Number.isInteger(paise) || paise <= 0) {
    return { ok: false, error: "Amount must be greater than zero" }
  }

  return { ok: true, paise }
}

/**
 * Format integer paise as ₹850.50
 * @param {number} paise
 */
export function formatPaise(paise) {
  const sign = paise < 0 ? "-" : ""
  const abs = Math.abs(Math.trunc(paise))
  const rupees = Math.floor(abs / 100)
  const rem = abs % 100
  return `${sign}₹${rupees}.${String(rem).padStart(2, "0")}`
}
