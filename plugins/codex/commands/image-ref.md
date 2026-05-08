---
description: Generate an image with reference image(s) attached (image-to-image / character-anchor / scene-anchor mode via gpt-image-2)
argument-hint: "--ref <path>[,<path>...] [--ref <path>]... [--size <1024x1024|1024x1536|1536x1024|auto>] [--output <path>] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh>] [--prompt-file <path>] [--cwd <path>] [--json] [prompt text]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" image-ref $ARGUMENTS
```

Operating rules:

- This command is for **reference-image / image-to-image** generation. At least one `--ref <path>` is required. For text-only generation, use `/codex:image` instead.
- `--ref` may be repeated, or take a comma-separated list, or both: `--ref char.png --ref scene.png,prop.png`. Each value resolves against the current working directory; absolute paths also work. Accepted extensions: `.png`, `.jpg`, `.jpeg`, `.webp`.
- Image-to-image is **experimental and observed to be unstable on current frontier image models** (per OpenAI plugin notes); the model may over-preserve reference details rather than generalize. Treat output as a hypothesis to A:B-test against `/codex:image` text-only output, not as a drop-in upgrade.
- The companion serializes calls behind the same `~/.codex/.image-gen.lock` as `/codex:image`, so reference-mode and text-mode calls do not collide. Do not spawn parallel `/codex:image-ref` invocations.
- The companion verifies the produced PNG by reading from `~/.codex/generated_images/{session-id}/` using the Codex thread id, so it cannot get fooled by hallucinated success.
- If the response says the image is below 50 KB or no PNG was found, treat the run as failed and surface the error to the user. Do not retry silently; ask the user how to proceed.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
- Forward the helper output verbatim. Do not paraphrase or summarize the path.

Raw user request:
$ARGUMENTS
