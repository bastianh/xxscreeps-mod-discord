// Per-user, Discord-only notification opt-out owned by this mod.
//
// Deliberately separate from xxscreeps' built-in notify prefs
// (`user/<id>/notifications/prefs`): that `disabled` switch silences *every*
// transport (email included), whereas this flag silences only the Discord DM
// transport — so a user can turn Discord DMs off while still receiving
// notifications through other channels.
//
// Stored in the main Database (`db.data`) so both services reach the same value:
// the backend service writes it from the slash-command handler, and the main
// service reads it in the notification transport.
const prefsKey = userId => `discord-mod/user/${userId}/prefs`

export async function isDiscordNotifyDisabled(db, userId) {
  return (await db.data.hGet(prefsKey(userId), 'notifyDisabled')) === '1'
}

export async function setDiscordNotifyDisabled(db, userId, disabled) {
  await db.data.hSet(prefsKey(userId), 'notifyDisabled', disabled ? '1' : '0')
}

// One-time welcome-DM state, tracked so it's sent exactly once per Discord-registered
// account. Values: 'pending' (registered, not yet delivered — retry on next login) or
// 'sent'. Absent means the account never registered via Discord, so it's never
// welcomed (avoids spamming users who linked before this feature existed).
export async function getWelcomeState(db, userId) {
  return db.data.hGet(prefsKey(userId), 'welcome')
}

export async function setWelcomeState(db, userId, state) {
  await db.data.hSet(prefsKey(userId), 'welcome', state)
}
