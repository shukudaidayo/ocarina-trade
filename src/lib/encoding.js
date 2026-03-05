/**
 * Encode order params to a URL-safe base64 string.
 */
export function encodeOrder(params) {
  const json = JSON.stringify(params)
  const b64 = btoa(json)
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decode a URL-safe base64 string back to order params.
 */
export function decodeOrder(encoded) {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const json = atob(b64)
  return JSON.parse(json)
}
