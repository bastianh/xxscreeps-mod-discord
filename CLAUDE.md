# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

An [xxscreeps](https://github.com/laverdet/xxscreeps) server mod that adds
**Discord OAuth2 login/registration** (no email) and **Discord DM
notifications**, plus slash commands. Published to npm as `xxscreeps-mod-discord`.
See README.md for the full feature/config/setup docs.

## Layout

Plain-JS ESM, **no build step** — the shipped `.js` files are loaded directly by
the host. `package.json` has `"xxscreeps": true`; `index.js` exports the
`manifest` (`provides: ['config', 'backend', 'main']`). For each provider the
host imports the sibling module of that name:

- `config.js` + `config.schema.json` — the `discord:` block schema for
  `.screepsrc.yaml` (ships no `defaults`; values read at runtime via
  `config.discord`).
- `backend.js` — runs in the web process: Discord OAuth login routes + the
  interactions (slash-command) endpoint, registered via backend `hooks`.
- `main.js` — runs in the main service: registers the notification transport
  (`registerSendUserNotifications`) that DMs users, and auto-syncs slash commands.
- `lib/{discord,prefs,commands}.js` — Discord API client, per-user prefs
  (keyval under `discord-mod/...`), and the single source of truth for command
  definitions.
- `scripts/register-commands.js` — CLI to register commands manually to a guild.

`xxscreeps` is an **optional peer dependency**, provided by the host at runtime;
it is not installed here.

## Commands

There is no build or test suite. Checks are a syntax pass and changesets:

```sh
node --check <file.js>   # CI syntax-checks every shipped .js (see .github/workflows/ci.yml)
pnpm changeset           # record a version bump / changelog entry before shipping
```

## Releasing

Automated via changesets (`.github/workflows/release.yml`): pending changesets →
"Version Packages" PR → on merge, publish to npm + tag. Publishing uses npm
**trusted publishing (OIDC)** — no `NPM_TOKEN` secret. The workflow requests
`id-token: write` and runs on Node 24 (npm ≥ 11.5.1); the trusted publisher is
configured once in the package's npm settings (repo + `release.yml`). The package
already exists on npm, so no bootstrap is needed. Long-lived automation tokens for
publishing are being deprecated (~Jan 2027), which is why OIDC is used. Any code
change intended to ship should come with a `pnpm changeset`.
