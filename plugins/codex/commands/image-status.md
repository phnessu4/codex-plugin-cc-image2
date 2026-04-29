---
description: Inspect the global Codex image generation queue (whether an image is in flight)
argument-hint: "[--json]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" image-status $ARGUMENTS
```

Operating rules:

- Forward the helper output verbatim. Do not paraphrase the lock holder pid, timestamp, or age.
- The `idle` state means a new `/codex:image` will start immediately.
- The `busy` state means a new `/codex:image` will queue behind the current one and wait until it finishes (typically 60-180 seconds).
- The `stale` state (lock older than ~10 minutes) means the previous run died without releasing; the next `/codex:image` will reclaim the lock automatically — no manual cleanup needed.
- This command is read-only and never modifies the lock file.
