import crypto from 'node:crypto'
import { hooks } from 'xxscreeps/backend/index.js'
import { config } from 'xxscreeps/config/index.js'
import * as User from 'xxscreeps/engine/db/user/index.js'
import { buildAuthorizeUrl, exchangeCode, fetchCurrentUser, sendBotDm, verifyInteractionSignature } from './lib/discord.js'
import { getWelcomeState, isDiscordNotifyDisabled, setDiscordNotifyDisabled, setWelcomeState } from './lib/prefs.js'

// Credentials come from the `discord` block in `.screepsrc.yaml` (see the mod's
// config schema). Keeping them here rather than in env vars fits a SOPS-encrypted
// `.screepsrc.yaml`:
//
//   discord:
//     clientId: "..."       # Discord application "Client ID"
//     clientSecret: "..."   # Discord application "Client Secret"
//     redirectUri: "..."    # (optional) override the OAuth callback URL. Defaults to
//                           #   `<request origin>/api/auth/discord/callback`. Set this when the
//                           #   public origin can't be derived from the request (e.g. behind a
//                           #   reverse proxy that doesn't forward X-Forwarded-* headers).
//                           #   Whatever value is used here must be listed as a redirect URI in
//                           #   the Discord app settings.
const discordConfig = config.discord ?? {}
const clientId = discordConfig.clientId
const clientSecret = discordConfig.clientSecret
const redirectUriOverride = discordConfig.redirectUri
// App public key (Developer Portal → General Information). Enables the slash-command
// interactions endpoint; without it, commands are inactive.
const publicKey = discordConfig.publicKey
// Bot token (shared with the notifications transport). Enables the one-time welcome DM
// on first Discord registration; without it, no welcome is sent.
const botToken = discordConfig.botToken

// Signing key for the OAuth `state` parameter. Reuse the backend session secret
// so state survives across multiple backend replicas without shared storage.
const stateSecret = config.backend?.secret ?? 'xxscreeps-mod-discord'
const STATE_TTL_MS = 10 * 60 * 1000

function signState() {
  const payload = `${crypto.randomBytes(16).toString('hex')}.${Date.now().toString(36)}`
  const sig = crypto.createHmac('sha256', stateSecret).update(payload).digest('hex').slice(0, 32)
  return `${payload}.${sig}`
}

function verifyState(state) {
  if (typeof state !== 'string') {
    return false
  }
  const parts = state.split('.')
  if (parts.length !== 3) {
    return false
  }
  const [nonce, ts, sig] = parts
  const expected = crypto.createHmac('sha256', stateSecret).update(`${nonce}.${ts}`).digest('hex').slice(0, 32)
  const sigBuf = Buffer.from(sig)
  const expectedBuf = Buffer.from(expected)
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return false
  }
  const age = Date.now() - parseInt(ts, 36)
  return age >= 0 && age < STATE_TTL_MS
}

function callbackRedirectUri(context) {
  return redirectUriOverride ?? `${context.origin}/api/auth/discord/callback`
}

// Render the popup-closing HTML the client's login flow expects. Mirrors the Steam
// mod: the message is JSON, double-stringified so it embeds as a JS string literal.
function postMessageHtml(payload) {
  const json = JSON.stringify(JSON.stringify(payload))
  return `<!doctype html><html><body><script type="text/javascript">try{opener&&opener.postMessage(${json}, '*');}catch(e){}window.close();</script></body></html>`
}

function welcomeMessage(name) {
  const greeting = name ? ` **${name}**` : ''
  return `👋 Welcome to the Screeps server${greeting}! Your Discord account is now linked, so in-game notifications will arrive here as direct messages.\n` +
    'Send `/discord-notify enabled:false` any time to silence these DMs (your other notification channels stay on), or `/screeps` to check your status.'
}

// Deliver the one-time welcome DM for a first Discord registration. Delivery is
// best-effort and deliberately retryable: a brand-new user usually shares no guild
// with the bot yet, so the first attempt often fails with "no mutual guilds". We mark
// the account 'pending' on registration and only flip to 'sent' once a DM succeeds, so
// the next Discord login retries until it lands. Accounts that never registered via
// Discord (no marker) are never welcomed.
async function maybeSendWelcome(db, userId, discordId, name, isNewRegistration) {
  if (!botToken || userId === undefined) {
    return
  }
  const state = await getWelcomeState(db, userId)
  if (state === 'sent') {
    return
  }
  if (state !== 'pending') {
    if (!isNewRegistration) {
      return
    }
    await setWelcomeState(db, userId, 'pending')
  }
  try {
    await sendBotDm({ botToken, recipientId: discordId, content: welcomeMessage(name) })
    await setWelcomeState(db, userId, 'sent')
  } catch (err) {
    // Most likely no mutual guild yet — stay 'pending' and retry on the next login.
    console.warn(`[xxscreeps-mod-discord] welcome DM deferred for user ${userId}: ${err.message}`)
  }
}

// Advertise Discord as a login option in the server options list at `/api/version`
// so the client can gate its login UI (render a "Sign in with Discord" button that
// opens `/api/auth/discord`). Self-describing and order-independent: the client
// reads it with `getServerFeature(version, 'discord')` and checks `discordLogin`.
const discordLoginEnabled = Boolean(clientId && clientSecret)
hooks.register('version', serverData => {
  if (Array.isArray(serverData.features)) {
    serverData.features.push({
      name: 'discord',
      version: 1,
      discordLogin: discordLoginEnabled,
      loginUrl: '/api/auth/discord',
    })
  }
})

// Surface the linked Discord id on the private user-info payload (parity with the
// Steam mod's `userInfo.steam`).
hooks.register('sendUserInfo', async (db, userId, userInfo, privateSelf) => {
  if (privateSelf) {
    const providers = await User.findProvidersForUser(db, userId)
    if (providers.discord) {
      userInfo.discord = { id: providers.discord }
    }
  }
})

if (!clientId || !clientSecret) {
  console.warn('[xxscreeps-mod-discord] Config `discord.clientId` / `discord.clientSecret` missing; Discord login inactive')
} else {
  hooks.register('middleware', (koa, router) => {
    // Step 1: kick off the OAuth dance. Opened by the client in a popup window.
    router.get('/api/auth/discord', context => {
      context.redirect(buildAuthorizeUrl({
        clientId,
        redirectUri: callbackRedirectUri(context),
        state: signState(),
      }))
    })

    // Step 2: Discord redirects back here with `?code=...&state=...`.
    router.get('/api/auth/discord/callback', async context => {
      try {
        const { code, state, error: oauthError } = context.query
        if (oauthError) {
          throw new Error(`Discord authorization declined (${oauthError})`)
        }
        if (typeof code !== 'string' || !verifyState(state)) {
          throw new Error('Invalid Discord authentication response')
        }

        // Exchange the code and resolve the Discord account.
        const token = await exchangeCode({
          clientId,
          clientSecret,
          code,
          redirectUri: callbackRedirectUri(context),
        })
        const discordUser = await fetchCurrentUser(token.access_token)
        if (!discordUser?.id) {
          throw new Error('Discord user lookup returned no id')
        }

        // Log in (existing account) or stage a new registration. The generic
        // `/api/register/set-username` endpoint completes new accounts and only
        // attaches an email if one is supplied — so Discord signup needs none.
        await context.authenticateForProvider('discord', String(discordUser.id))
        const screepsToken = await context.flushToken()

        // For an existing user we can report their screeps username; for a brand
        // new registration there isn't one yet, so the client shows the
        // choose-a-username step (same signal the Steam flow uses).
        const isNewRegistration = context.state.newUserId !== undefined
        const userId = context.state.newUserId ?? context.state.userId
        let username = 'New User'
        if (userId !== undefined) {
          username = await context.db.data.hGet(User.infoKey(userId), 'username') ?? 'New User'
        }

        // One-time welcome DM for first Discord registrations. Greet with the Screeps
        // username once chosen, otherwise the Discord display name (not yet set during
        // the initial registration hop). Best-effort — see maybeSendWelcome.
        const welcomeName = username !== 'New User'
          ? username
          : (discordUser.global_name ?? discordUser.username ?? null)
        await maybeSendWelcome(context.db, userId, String(discordUser.id), welcomeName, isNewRegistration)

        context.type = 'html'
        context.body = postMessageHtml({
          token: screepsToken,
          username,
          discordId: String(discordUser.id),
          discordName: discordUser.global_name ?? discordUser.username ?? null,
        })
      } catch (err) {
        console.error('[xxscreeps-mod-discord] login failed:', err.message)
        context.type = 'html'
        context.body = postMessageHtml({ error: 'discord-auth-failed' })
      }
    })
  })
}

// --- Slash-command interactions -------------------------------------------------
//
// Discord delivers each slash-command invocation as an HTTP POST to the
// "Interactions Endpoint URL" configured in the Developer Portal. We expose one at
// `/api/discord/interactions`, verify the Ed25519 signature, answer the PING
// health-check, and handle `/discord-notify`. Requires `discord.publicKey`; the bot
// token is only needed to *register* the commands (see scripts/register-commands.js).

// Discord interaction + response type constants, plus the ephemeral message flag.
const INTERACTION_PING = 1
const INTERACTION_APPLICATION_COMMAND = 2
const RESPONSE_PONG = 1
const RESPONSE_MESSAGE = 4
const EPHEMERAL_FLAG = 1 << 6

// Ephemeral reply — only the invoking user sees it, which is what we want for a
// settings toggle.
function ephemeral(content) {
  return { type: RESPONSE_MESSAGE, data: { content, flags: EPHEMERAL_FLAG } }
}

if (!publicKey) {
  console.warn('[xxscreeps-mod-discord] Config `discord.publicKey` missing; Discord slash commands inactive')
} else {
  hooks.register('middleware', (koa, router) => {
    router.post('/api/discord/interactions', async context => {
      // Verify the request really came from Discord. The signature covers the exact
      // raw request bytes, so we check against koa-bodyparser's `rawBody`.
      const signature = context.get('x-signature-ed25519')
      const timestamp = context.get('x-signature-timestamp')
      const rawBody = context.request.rawBody
      if (!signature || !timestamp || typeof rawBody !== 'string' ||
          !verifyInteractionSignature({ publicKey, signature, timestamp, body: rawBody })) {
        context.status = 401
        context.body = 'invalid request signature'
        return
      }

      const interaction = context.request.body
      // Discord pings this endpoint (both when you save the URL and periodically) to
      // confirm it's alive; a signed PING must be answered with a PONG.
      if (interaction.type === INTERACTION_PING) {
        context.body = { type: RESPONSE_PONG }
        return
      }

      if (interaction.type === INTERACTION_APPLICATION_COMMAND) {
        const commandName = interaction.data?.name
        // Every command acts on the caller's own linked account, so resolve it once.
        // Guild invocations carry the caller under `member.user`; DM/user-context
        // invocations carry it under `user`.
        const discordId = interaction.member?.user?.id ?? interaction.user?.id
        if (!discordId) {
          context.body = ephemeral('Could not determine your Discord account.')
          return
        }
        const userId = await User.findUserByProvider(context.db, 'discord', String(discordId))
        if (!userId) {
          context.body = ephemeral('No Screeps account is linked to this Discord user. Sign in on the server with Discord first.')
          return
        }

        if (commandName === 'discord-notify') {
          const enabled = Boolean(interaction.data.options?.find(option => option.name === 'enabled')?.value)
          await setDiscordNotifyDisabled(context.db, userId, !enabled)
          context.body = ephemeral(enabled
            ? '✅ Discord DM notifications **enabled**. Your other notification channels are unchanged.'
            : '🔕 Discord DM notifications **disabled**. You will still receive notifications through your other channels (e.g. email).')
          return
        }

        if (commandName === 'screeps') {
          const info = await context.db.data.hGetAll(User.infoKey(userId))
          const notifyDisabled = await isDiscordNotifyDisabled(context.db, userId)
          const lines = [
            `**${info.username ?? 'Unknown'}** — linked to this Discord account`,
            `Screeps user id: \`${userId}\``,
            `Discord DM notifications: ${notifyDisabled ? '🔕 off' : '🔔 on'}`,
          ]
          if (info.registeredDate) {
            // Discord renders `<t:UNIX:D>` as a localized date for the viewer.
            lines.push(`Registered: <t:${Math.floor(Number(info.registeredDate) / 1000)}:D>`)
          }
          if (info.lastViewedRoom) {
            lines.push(`Last viewed room: ${info.lastViewedRoom}`)
          }
          context.body = ephemeral(lines.join('\n'))
          return
        }

        context.body = ephemeral('Unknown command.')
        return
      }

      context.body = ephemeral('Unknown interaction.')
    })
  })
}
