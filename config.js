// `config` provider for the Discord mod.
//
// This module has no runtime behaviour — its only job is to exist so the loader
// pairs it with the sibling `config.schema.json`, which teaches xxscreeps (and the
// yaml-language-server via `.screepsrc.yaml`'s `$schema`) about the `discord:`
// block. Values are read at runtime through `config.discord` in backend.js/main.js.
//
// (Optionally export `defaults` / `initializationDefaults` objects here to seed
// config values; we intentionally ship none.)
