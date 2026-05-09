---
description: Block-wait a single image-enqueue job; print one line on completion (token-efficient)
argument-hint: "<job-id> [interval-seconds]"
allowed-tools: Bash(bash:*)
---

Run:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/sprite/img-wait" $ARGUMENTS
```

Operating rules:

- This is the recommended way for an LLM agent to wait for a specific image job: pair it with the agent's `run_in_background` so completion arrives as a single ≤2-token notification instead of polling every few seconds.
- Output is exactly one line: `ok <output-path>` (exit 0) or `failed <class>` (exit 1).
- Reads `~/.codex/image-jobs/<job-id>.json` directly; no codex CLI subprocess overhead.
