// Single source of truth for this mod's Discord slash commands. Imported by both the
// startup auto-sync (main.js) and the manual CLI (scripts/register-commands.js), so
// the definition never drifts between the two.
import crypto from 'node:crypto'

export const commands = [{
  name: 'discord-notify',
  type: 1, // CHAT_INPUT
  description: 'Toggle Discord DM notifications from the Screeps server (other channels unaffected)',
  options: [{
    type: 5, // BOOLEAN
    name: 'enabled',
    description: 'true = receive Discord DMs · false = silence only Discord',
    required: true,
  }],
}, {
  name: 'screeps',
  type: 1, // CHAT_INPUT
  description: 'Show the Screeps account linked to your Discord user and your notification status',
}]

// Content hash used to skip re-registration when nothing changed. Includes the app id
// so pointing the same database at a different Discord application forces a re-sync.
export function commandsSignature(appId) {
  return crypto.createHash('sha1').update(JSON.stringify(commands)).update(String(appId)).digest('hex')
}

// PUT the full command set for the given scope. Global (no `guildId`) can take up to
// ~1h to propagate; a `guildId` registers to that one guild and appears instantly.
// `PUT` is idempotent — it replaces the scope's command set — so it's safe to repeat.
export async function registerCommands({ appId, botToken, guildId }) {
  const url = guildId
    ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${appId}/commands`
  const res = await fetch(url, {
    method: 'PUT',
    headers: { authorization: `Bot ${botToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(commands),
  })
  if (!res.ok) {
    throw new Error(`command registration failed (${res.status}): ${await res.text()}`)
  }
  return res.json()
}
