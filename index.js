// Manifest for the Discord mod.
//
// - `config` contributes the `discord` block schema to `.screepsrc.yaml`.
// - `backend` wires up the Discord OAuth2 login/registration routes (mirrors the
//   Steam mod, but never asks for an email).
// - `main` registers a notification transport that DMs users on Discord.
export const manifest = {
  provides: ['config', 'backend', 'main'],
}
