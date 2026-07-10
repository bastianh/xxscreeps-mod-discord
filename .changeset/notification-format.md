---
"xxscreeps-mod-discord": minor
---

Redesign Discord notification DMs. A drained batch now renders as a **New
notifications:** header (with the batch's UTC date) followed by a code block of
timestamped lines (`[HH:MM:SS] message`), oldest first — instead of a bare list.
Error notifications keep the ⚠️ prefix and repeated ones the `(xN)` count; the
body is fence-safe (a backtick run in a message can't break out of the code
block) and truncated to stay under Discord's 2000-char message limit.
