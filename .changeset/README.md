# Changesets

This folder is managed by [`@changesets/cli`](https://github.com/changesets/changesets).

Run `pnpm changeset` to record a change: pick the bump type (patch / minor /
major) and write a short summary — it becomes the changelog entry. Commit the
generated `.changeset/*.md` alongside your change. When it lands on `main`, the
Release workflow opens a "Version Packages" PR; merging that PR publishes to npm.
