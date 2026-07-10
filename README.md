# xxscreeps-mod-discord

An [xxscreeps](https://github.com/laverdet/xxscreeps) mod that adds:

1. **Discord login & registration** — an OAuth2 flow modelled on the built-in Steam
   mod. New accounts are created without ever asking for an email address.
2. **Discord notifications** — a notification transport that delivers each user's
   in-game notifications as a Discord **DM** from your bot.

Both halves are optional and activate only when their credentials are present, so
you can run just login, just notifications, or both.

## Install

This is a plain-JS ESM xxscreeps mod (no build step). Install it alongside your
server and add it to `mods` in `.screepsrc.yaml`:

```yaml
mods:
  - xxscreeps/mods/classic
  - xxscreeps/mods/backend/cookie
  - xxscreeps/mods/backend/password
  - xxscreeps/mods/backend/steam
  - xxscreeps-mod-discord   # <-- add this
```

During local development you can point at the sibling checkout, e.g. with pnpm:

```jsonc
// package.json
"dependencies": {
  "xxscreeps-mod-discord": "link:../xxscreeps-mod-discord"
}
```

## Configuration

Settings live in a `discord:` block in `.screepsrc.yaml`. The mod ships a config
schema, so these keys are validated (and autocompleted via the file's `$schema`).
Because everything is in `.screepsrc.yaml`, the secrets encrypt cleanly with SOPS.

```yaml
discord:
  clientId: "YOUR_DISCORD_CLIENT_ID"          # login
  clientSecret: "YOUR_DISCORD_CLIENT_SECRET"  # login (secret)
  botToken: "YOUR_DISCORD_BOT_TOKEN"          # notifications (secret)
  publicKey: "YOUR_DISCORD_PUBLIC_KEY"         # slash commands
  # redirectUri: "https://your-server/api/auth/discord/callback"  # optional override
```

| Key | Used by | Purpose |
| --- | --- | --- |
| `discord.clientId` | login | Discord application **Client ID** |
| `discord.clientSecret` | login | Discord application **Client Secret** |
| `discord.botToken` | notifications | Bot token used to DM users |
| `discord.publicKey` | slash commands | Discord application **Public Key** — verifies the interactions endpoint signature |
| `discord.redirectUri` | login | *(optional)* Override the OAuth callback URL. Defaults to `<request origin>/api/auth/discord/callback`. |

Each half activates independently: with only `clientId`/`clientSecret`, login
works; with only `botToken`, notifications work; with `publicKey` (plus `botToken`
to register the commands), slash commands work.

### Discord application setup

1. Create an application at <https://discord.com/developers/applications>.
2. **OAuth2 → Redirects**: add your callback URL,
   `https://YOUR_SERVER/api/auth/discord/callback`. This is **required** — Discord
   rejects the login with `invalid redirect_uri` unless the value the mod sends
   matches a registered redirect URL **exactly, including the scheme** (`https`
   vs `http`), host, and path. The mod requests only the `identify` scope — no email.

   The URL the mod sends is either `discord.redirectUri` (if set) or, by default,
   `<request origin>/api/auth/discord/callback` derived from the incoming request.
   Behind a TLS-terminating reverse proxy the derived origin can come out as `http`
   unless the server trusts the proxy's `X-Forwarded-Proto` header; if that
   happens, either fix the proxy trust or pin the value with `discord.redirectUri`
   and register that exact URL here.
3. **Bot**: add a bot to the application and copy its token into
   `discord.botToken`.
4. **Invite the bot to a server** (a *guild*) that your players also join.
   **Discord only lets a bot DM users who share a mutual guild with it**, so
   notification delivery requires players to be members of that server *and* to
   have "Allow direct messages from server members" enabled for it.

   Use a **bot invite** URL — the `bot` scope, not a user-install:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=0
   ```

   The bot needs no special permissions to DM (`permissions=0` is fine) — only the
   shared membership. When you open the link there must be an **"Add to Server"**
   dropdown; pick a server where you have *Manage Server*.

   > **Common trap:** authorizing the app *to your account* (it then shows up under
   > User Settings → "Authorized Apps") is a **user-install**, not a guild install —
   > it does **not** put the bot in any server. If the invite link only offers "add
   > to your account", enable **Guild Install** under the app's **Installation**
   > settings (with `bot` in its scopes) in the developer portal, then retry.

## How login works

- The client opens `/api/auth/discord` in a popup.
- The mod redirects to Discord, receives the callback, exchanges the code, and
  resolves the Discord account (id + username).
- Existing accounts are logged straight in. New accounts get a temporary token and
  the popup posts it back to the opener window — exactly like the Steam flow — so
  the client shows its "choose a username" step, which finishes via the built-in
  `/api/register/set-username` endpoint. No email is requested at any point.
- `/api/version` advertises Discord in the server options list as
  `{ name: 'discord', version: 1, discordLogin: true, loginUrl: '/api/auth/discord' }`.
  A client reads it with `getServerFeature(version, 'discord')` and shows the button
  when `discordLogin` is true — the same way it gates Steam via `steamLogin`.

> **Client note:** the server side is complete, but the web client needs a
> "Sign in with Discord" button that opens `/api/auth/discord` in a popup and
> reuses the same `postMessage` login handler as the Steam button.

## How notifications work

Registered as a `main`-service transport via the notifications mod's
`registerSendUserNotifications`. When a user's notifications are drained, the mod
looks up their linked Discord id and DMs the whole batch as one message: a
**New notifications:** header (with the batch's UTC date) followed by a code block
of timestamped lines, oldest first:

````text
**New notifications:** `2026-07-10 UTC`
```
[14:23:05] Creep Harvester1 died in room W7N3
[14:24:40] ⚠️ Script error: Cannot read property x of undefined (x3)
[14:27:05] Attack! Hostile creep in W7N3 (x2)
```
````

Each line is `[HH:MM:SS]` (UTC) plus the message; error notifications are prefixed
with ⚠️ and repeated ones get an `(xN)` count. The body is fence-safe (backtick
runs in a message can't break out of the code block) and truncated to stay under
Discord's 2000-char message limit. Users without a linked Discord account are
skipped. Delivery respects each user's existing in-game notification preferences
(throttling, grouping, disable) — this mod is only the final delivery hop.

Failed DMs log Discord's structured error, so the reason is visible in the server
log — e.g. `send DM failed (403 code 50278: Cannot send messages to this user due
to having no mutual guilds)` means the recipient shares no server with the bot.

### Welcome message

On a user's **first Discord registration**, the mod sends a one-time welcome DM
(requires `discord.botToken`). Because a brand-new user usually doesn't share a guild
with the bot yet, the first attempt often can't be delivered — so the account is
marked `welcome: pending` and the DM is **retried on each subsequent Discord login**
until it lands, then marked `sent`. Accounts that linked Discord before this feature
existed are never marked, so they aren't back-filled with a welcome. Delivery is
best-effort: a failure is logged, never blocks login.

## Slash commands

The mod exposes an **interactions endpoint** at `/api/discord/interactions` and one
command:

| Command | Effect |
| --- | --- |
| `/discord-notify enabled:false` | **Discord-only** opt-out — stops the bot from DMing this user. Other notification channels (e.g. email) are unaffected. |
| `/discord-notify enabled:true` | Re-enables Discord DMs. |
| `/screeps` | Shows the Screeps account linked to your Discord user, plus your current Discord-notification status. |

This is intentionally distinct from the in-game `disabled` notify pref, which
silences *every* transport. The flag lives in the main DB under
`discord-mod/user/<userId>/prefs` and is honoured by the notification transport.
The command maps the invoking Discord user to their linked Screeps account, so it
only ever changes the caller's own setting; replies are ephemeral.

**Setup:**

1. Set `discord.publicKey` (Developer Portal → *General Information → Public Key*).
2. In the Developer Portal → *General Information*, set **Interactions Endpoint
   URL** to `https://YOUR_SERVER/api/discord/interactions`. Discord verifies it with
   a signed PING on save, so the server must be running, publicly reachable over
   **HTTPS**, and `discord.publicKey` must be set — otherwise Discord rejects the URL.

The commands themselves are registered **automatically**: on startup the `main`
service compares a hash of the command definitions against one stored in the DB
(`discord-mod/commands/hash`) and registers globally only when they differ — so
normal restarts make no API calls, and editing a command syncs on the next boot.
This needs `discord.clientId` and `discord.botToken` set (the same values used by
login and notifications).

To register manually instead — e.g. to a single guild for instant testing, or from
CI — use the CLI wrapper around the same definitions:

```bash
node scripts/register-commands.js <CLIENT_ID> <BOT_TOKEN> [GUILD_ID]
```

The command definitions are the single source of truth in `lib/commands.js`; both
the auto-sync and the script import them.

The endpoint verifies every request's Ed25519 signature against `discord.publicKey`
using Node's built-in crypto (no extra dependency), and rejects anything unsigned or
tampered with `401`.

## Releasing

Versioning and publishing are automated with
[changesets](https://github.com/changesets/changesets), publishing via npm
**trusted publishing (OIDC)** — no `NPM_TOKEN` secret, with automatic
[provenance](https://docs.npmjs.com/generating-provenance-statements).

1. Record your change: `pnpm changeset` (patch/minor/major + summary). Commit the
   generated `.changeset/*.md`.
2. Push / merge to `main` — `.github/workflows/release.yml` opens a **“Version
   Packages”** PR. Merging it bumps the version, updates `CHANGELOG.md`, publishes
   to npm via OIDC, and tags the release.

One-time: on [npmjs.com](https://docs.npmjs.com/trusted-publishers), add a
**GitHub Actions** trusted publisher to this package (owner `bastianh`, repo
`xxscreeps-mod-discord`, workflow `release.yml`). The package is already on npm,
so no first-publish bootstrap is needed. `.github/workflows/ci.yml` syntax-checks
the JS on every push/PR.

> Note: long-lived automation / 2FA-bypass npm tokens
> [lose direct publishing ability around January 2027](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/),
> so OIDC is the forward-looking default here.
