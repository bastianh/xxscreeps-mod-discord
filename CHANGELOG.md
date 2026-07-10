# xxscreeps-mod-discord

## 0.2.0

### Minor Changes

- [`4c3b647`](https://github.com/bastianh/xxscreeps-mod-discord/commit/4c3b64769131c0c7f968f3b2df4cc747779d0999) Thanks [@bastianh](https://github.com/bastianh)! - Redesign Discord notification DMs. A drained batch now renders as a **New
  notifications:** header (with the batch's UTC date) followed by a code block of
  timestamped lines (`[HH:MM:SS] message`), oldest first — instead of a bare list.
  Error notifications keep the ⚠️ prefix and repeated ones the `(xN)` count; the
  body is fence-safe (a backtick run in a message can't break out of the code
  block) and truncated to stay under Discord's 2000-char message limit.
