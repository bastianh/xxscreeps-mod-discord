// Minimal Discord REST helpers built on the global `fetch` (Node >= 20). We only
// need the OAuth2 authorization-code flow (identify scope, no email) and the two
// bot calls required to DM a user, so there's no reason to pull in discord.js.

import crypto from 'node:crypto'

const API = 'https://discord.com/api/v10'

// Fixed ASN.1 SPKI header for an Ed25519 public key. Prepending it to the raw
// 32-byte key yields DER that `crypto.createPublicKey` accepts, letting us verify
// interaction signatures with Node's built-in crypto — no `tweetnacl` dependency.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

// Verify a Discord interaction request. Discord signs `timestamp + rawBody` with the
// application's Ed25519 key; the signature/timestamp arrive in the `X-Signature-*`
// headers and `publicKey` is the app's hex public key (Developer Portal → General
// Information). Returns false on any malformed input rather than throwing, so the
// caller can simply answer 401.
export function verifyInteractionSignature({ publicKey, signature, timestamp, body }) {
  try {
    const keyDer = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, 'hex')])
    const key = crypto.createPublicKey({ key: keyDer, format: 'der', type: 'spki' })
    return crypto.verify(null, Buffer.from(timestamp + body), key, Buffer.from(signature, 'hex'))
  } catch {
    return false
  }
}

// Wrapper that transparently honours a single 429 (rate limit) retry. Discord
// returns `retry_after` in seconds; we clamp it so a misbehaving response can't
// stall the caller for long.
async function discordFetch(url, options, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, options)
    if (res.status === 429 && attempt < retries) {
      const body = await res.clone().json().catch(() => ({}))
      const retryAfter = Number(body.retry_after ?? res.headers.get('retry-after') ?? 1)
      await new Promise(resolve => setTimeout(resolve, Math.min(Math.max(retryAfter, 0), 5) * 1000))
      continue
    }
    return res
  }
}

// Build the URL we send the browser to so the user can authorize the app. We ask
// only for `identify` — that yields the user's Discord id and username, and
// deliberately never requests `email`.
export function buildAuthorizeUrl({ clientId, redirectUri, state, scope = 'identify' }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    state,
  })
  return `https://discord.com/oauth2/authorize?${params}`
}

// Exchange the authorization `code` for an access token. `redirectUri` must match
// the value used in `buildAuthorizeUrl` exactly or Discord rejects the exchange.
export async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const res = await discordFetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  })
  if (!res.ok) {
    throw new Error(`Discord token exchange failed (${res.status})`)
  }
  return res.json()
}

// Resolve the authorizing user. Returns `{ id, username, global_name, ... }`.
export async function fetchCurrentUser(accessToken) {
  const res = await discordFetch(`${API}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    throw new Error(`Discord user lookup failed (${res.status})`)
  }
  return res.json()
}

// Pull Discord's structured error (`{ code, message }`) out of a failed response so
// callers can log *why* a request was rejected, not just the HTTP status. The DM
// path in particular fails with distinct, actionable codes — e.g. 50278 "no mutual
// guilds" (bot not in a server the recipient is in) vs 50007 "cannot send messages
// to this user" (recipient blocks DMs from server members) — that a bare `403`
// hides. Falls back to the status alone if the body isn't the expected JSON shape.
async function describeError(res) {
  const body = await res.json().catch(() => null)
  if (body && (body.code !== undefined || body.message)) {
    return `${res.status} code ${body.code ?? '?'}: ${body.message ?? ''}`.trim()
  }
  return String(res.status)
}

// DM a user by their Discord id: open (or reuse) the 1:1 DM channel, then post the
// message. Note Discord only permits this when the bot shares a mutual guild with
// the recipient and the recipient has not blocked DMs from server members.
export async function sendBotDm({ botToken, recipientId, content }) {
  const auth = { authorization: `Bot ${botToken}` }
  const dmRes = await discordFetch(`${API}/users/@me/channels`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ recipient_id: recipientId }),
  })
  if (!dmRes.ok) {
    throw new Error(`open DM channel failed (${await describeError(dmRes)})`)
  }
  const channel = await dmRes.json()
  const msgRes = await discordFetch(`${API}/channels/${channel.id}/messages`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!msgRes.ok) {
    throw new Error(`send DM failed (${await describeError(msgRes)})`)
  }
}
