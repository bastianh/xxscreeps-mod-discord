#!/usr/bin/env node
// Manually register this mod's Discord slash commands.
//
// Normally you don't need this: the `main` service auto-registers commands on boot
// (only when the definitions change). Use this script to register to a single guild
// for instant testing, or to register from CI / a machine other than the server.
//
// The command definitions live in lib/commands.js — this is just a CLI around them.
//
// Usage:
//   node scripts/register-commands.js <APP_ID> <BOT_TOKEN> [GUILD_ID]
//
//   APP_ID    Discord application Client ID   (config `discord.clientId`)
//   BOT_TOKEN Discord bot token               (config `discord.botToken`)
//   GUILD_ID  optional. Register to this one guild (appears instantly). Without it,
//             commands register globally (up to ~1h to propagate).
import { commands, registerCommands } from '../lib/commands.js'

const [appId, botToken, guildId] = process.argv.slice(2)
if (!appId || !botToken) {
  console.error('Usage: node scripts/register-commands.js <APP_ID> <BOT_TOKEN> [GUILD_ID]')
  process.exit(1)
}

try {
  await registerCommands({ appId, botToken, guildId })
  console.log(`Registered ${commands.length} command(s) ${guildId ? `to guild ${guildId}` : 'globally'}.`)
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
