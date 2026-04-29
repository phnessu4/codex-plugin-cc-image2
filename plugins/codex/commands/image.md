---
description: Generate an image with Codex's built-in image_generation tool (gpt-image-2)
argument-hint: "[--size <WxH>] [--output <path>] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh>] [--prompt-file <path>] [--cwd <path>] [--json] [prompt text]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" image $ARGUMENTS
```

Operating rules:

- The companion serializes image generation calls behind a global lock at `~/.codex/.image-gen.lock`. If another image is in flight, this call will queue automatically — do not spawn parallel `/codex:image` invocations to "speed it up"; doing so triggers ChatGPT-side stream breaks and corrupted outputs.
- The companion verifies the produced PNG by reading from `~/.codex/generated_images/{session-id}/` using the Codex thread id, so it cannot get fooled by hallucinated success.
- If the response says the image is below 50 KB or no PNG was found, treat the run as failed and surface the error to the user. Do not retry silently; ask the user how to proceed.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
- Forward the helper output verbatim. Do not paraphrase or summarize the path.

Raw user request:
$ARGUMENTS
