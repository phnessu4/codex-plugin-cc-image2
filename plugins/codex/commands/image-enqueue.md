---
description: Queue an image generation job (returns immediately; daemon worker drains the queue serially)
argument-hint: "[--size <1024x1024|1024x1536|1536x1024|auto>] [--output <path>] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh>] [--prompt-file <path>] [--cwd <path>] [--json] [prompt text]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" image-enqueue $ARGUMENTS
```

Operating rules:

- This command returns immediately after writing the job record. Do NOT block waiting for the image; instead surface the printed job id to the user and tell them they can check `/codex:image-status` or `/codex:image-result <job-id>` later.
- The first enqueue spawns a detached worker daemon. Subsequent enqueues add to the same FIFO queue.
- Image generation is hard-serialized at the ChatGPT backend layer; do not advise the user to bypass this. The worker is the right way to queue many shots without losing them when the terminal closes.
- Forward the helper output verbatim. Do not paraphrase the job id.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
