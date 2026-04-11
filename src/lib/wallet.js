/**
 * Truncate address for display: 0x1234...abcd
 */
export function truncateAddress(address) {
  return address.slice(0, 6) + '...' + address.slice(-4)
}

/**
 * Format a token amount for display: trims trailing zeros but keeps
 * up to 6 significant decimal places.
 * "50.000000" → "50", "0.050000" → "0.05", "1.123456789" → "1.123456"
 */
export function formatTokenAmount(raw) {
  const s = typeof raw === 'string' ? raw : String(raw)
  if (!s.includes('.')) return s
  const trimmed = s.replace(/\.?0+$/, '')
  // cap at 6 decimal places
  const dot = trimmed.indexOf('.')
  if (dot === -1) return trimmed
  return trimmed.slice(0, dot + 7).replace(/\.?0+$/, '')
}
