import { config } from 'xxscreeps/config/index.js'
import { registerShardInitializer } from 'xxscreeps/engine/processor/index.js'
import { providerIdForUser } from 'xxscreeps/engine/db/user/index.js'
import { registerSendUserNotifications } from 'xxscreeps/mods/notifications/transports.js'
import { sendBotDm } from './lib/discord.js'
import { isDiscordNotifyDisabled } from './lib/prefs.js'
import { commandsSignature, registerCommands } from './lib/commands.js'

// `discord.botToken` in `.screepsrc.yaml`: bot token used to DM users their
// notifications. The bot must share a mutual guild with each recipient (Discord
// requirement for bot-initiated DMs), so users need to join your Discord server.
const botToken = config.discord?.botToken
// App id (== login Client ID); needed to register slash commands on boot.
const clientId = config.discord?.clientId

// Discord's single-message content limit is 2000 chars; stay under it with room
// for the truncation marker.
const MAX_CONTENT = 1900

// Keyval marker: hash of the last successfully-registered command set. Registration
// only runs when this differs from the current definitions, so normal restarts make
// no Discord API calls and command edits sync automatically. See lib/commands.js.
const COMMANDS_HASH_KEY = 'discord-mod/commands/hash'

// Register/refresh slash commands once, and only when the definitions changed. Runs
// from the `main` service (a singleton), so no cross-replica coordination is needed;
// even if it did run twice, `PUT` is idempotent. Order matters: register first, then
// persist the hash — a failed registration leaves the old hash so the next boot retries.
async function syncCommands(db) {
  if (!clientId || !botToken) {
    return
  }
  const signature = commandsSignature(clientId)
  if (await db.data.get(COMMANDS_HASH_KEY) === signature) {
    return
  }
  await registerCommands({ appId: clientId, botToken })
  await db.data.set(COMMANDS_HASH_KEY, signature)
  console.log('[xxscreeps-mod-discord] slash commands registered/updated (global)')
}

// The notification transport is handed only `(userId, rows)`, so capture the main
// Database from a shard initializer to resolve the user's Discord id. All shards
// share the same main Database instance, so the first initializer suffices.
let mainDb
let commandsSynced = false
registerShardInitializer(shard => {
  mainDb = shard.db
  if (!commandsSynced) {
    commandsSynced = true
    syncCommands(mainDb).catch(err =>
      console.error('[xxscreeps-mod-discord] slash command sync failed:', err.message))
  }
})

function formatNotifications(rows) {
  const lines = rows.map(row => {
    const prefix = row.type === 'error' ? '⚠️ ' : ''
    const suffix = row.count > 1 ? ` (x${row.count})` : ''
    return `${prefix}${row.message}${suffix}`
  })
  let content = lines.join('\n').trim()
  if (content.length === 0) {
    return null
  }
  if (content.length > MAX_CONTENT) {
    content = `${content.slice(0, MAX_CONTENT)}\n…(truncated)`
  }
  return content
}

if (!botToken) {
  console.warn('[xxscreeps-mod-discord] Config `discord.botToken` missing; Discord notifications inactive')
} else {
  registerSendUserNotifications(async (userId, notifications) => {
    if (!mainDb) {
      return
    }
    // Per-user Discord-only opt-out (set via the `/discord-notify` slash command).
    // Distinct from the built-in notify prefs the drain loop already honours: this
    // silences *only* the Discord DM, leaving other transports (e.g. email) intact.
    if (await isDiscordNotifyDisabled(mainDb, userId)) {
      return
    }
    const discordId = await providerIdForUser(mainDb, 'discord', userId)
    if (!discordId) {
      // User hasn't linked a Discord account; nothing to deliver to.
      return
    }
    const content = formatNotifications(notifications)
    if (!content) {
      return
    }
    try {
      await sendBotDm({ botToken, recipientId: discordId, content })
    } catch (err) {
      console.error(`[xxscreeps-mod-discord] failed to DM user ${userId}:`, err.message)
    }
  })
}
