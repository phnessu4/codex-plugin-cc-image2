---
description: Inspect the status or final result of a queued Codex image job
argument-hint: "<job-id> [--json]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" image-result $ARGUMENTS
```

Operating rules:

- Forward the helper output verbatim. Do not paraphrase the path or error message.
- Possible status values: `pending` (waiting), `processing` (worker is generating now), `done` (image saved, path in result), `failed` (error class + message in result).
- If the user wants the live queue overview rather than one specific job, route them to `/codex:image-status` instead.
