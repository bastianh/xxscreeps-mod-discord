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
// for the header, the code-block fences, and the truncation marker.
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

const pad2 = n => String(n).padStart(2, '0')

// HH:MM:SS (UTC) — a compact per-line stamp inside the code block.
function formatTime(ms) {
  const d = new Date(ms)
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
}

// YYYY-MM-DD (UTC) — shown once in the header so the per-line stamps stay short.
function formatDate(ms) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

// Break up any backtick run with a zero-width space (invisible in Discord) so a
// notification body can't terminate the ``` code block we wrap it in.
function fenceSafe(text) {
  return text.replace(/`/g, '`' + String.fromCharCode(0x200b))
}

// Notifications arrive batched (grouped by the drain interval), each row carrying
// its own `date` (epoch ms), a merged occurrence `count`, and a `type`. Render
// them as a "New notifications:" header plus a code block of timestamped lines,
// so a burst reads as one tidy message instead of a wall of text.
function formatNotifications(rows) {
  const sorted = [ ...rows ].sort((a, b) => (a.date || 0) - (b.date || 0))
  const lines = sorted.map(row => {
    const stamp = Number.isFinite(row.date) ? `[${formatTime(row.date)}] ` : ''
    const prefix = row.type === 'error' ? '⚠️ ' : ''
    const suffix = row.count > 1 ? ` (x${row.count})` : ''
    return `${stamp}${prefix}${fenceSafe(String(row.message))}${suffix}`
  })
  let body = lines.join('\n').trim()
  if (body.length === 0) {
    return null
  }
  const dates = sorted.map(row => row.date).filter(Number.isFinite)
  const dateLabel = dates.length ? ` \`${formatDate(Math.max(...dates))} UTC\`` : ''
  const header = `**New notifications:**${dateLabel}`
  // Budget the code-block body against the cap, leaving room for the header, the
  // fences (```\n … \n```), and the truncation marker.
  const budget = MAX_CONTENT - header.length - 9
  if (body.length > budget) {
    body = `${body.slice(0, budget - 14).trimEnd()}\n…(truncated)`
  }
  return `${header}\n\`\`\`\n${body}\n\`\`\``
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
