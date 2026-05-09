---
description: "[BETA] One-shot white-bg sprite generation: codex enqueue → wait → rembg → alpha post-process"
argument-hint: "--prompt-file <path> --output <out.png> [--size 1536x1024] [--algorithm rembg|hybrid] [--no-keep-raw]"
allowed-tools: Bash(bash:*)
---

Run:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/sprite/sprite-pipeline.sh" $ARGUMENTS
```

Operating rules:

- **BETA**: alpha is reconstructed locally from RGB output (codex CLI cannot return RGBA — see codex#18944). The result has a hard quality ceiling vs. ChatGPT web-UI direct RGBA. Empirically loses ~12% of soft-glow detail.
- **Dependencies**: requires `rembg`, `onnxruntime`, `scipy`, `pillow`, `numpy`. If missing, instruct user: `pip install rembg onnxruntime scipy pillow numpy`.
- **First run downloads model weight** (~180MB for `isnet-general-use`); subsequent runs are fast.
- **Algorithm selection**:
  - `rembg` (default): clean shapes, slightly soft edges. Good for bulk dividers / page numbers.
  - `hybrid`: rembg silhouette × color-to-alpha gradient. Slightly better edge fidelity for gold/snow/vine decorative sprites. ~10% slower.
- **Fallback for critical sprites**: if quality is insufficient, advise user to keep the white-bg `.raw.png`, then upload to ChatGPT web-UI and ask it to "remove the white background to transparent PNG" — web-UI returns true RGBA.
- This command can take 1-3 minutes (codex enqueue is serialized + rembg inference). Do NOT background it; it already runs serially with progress lines.
- Forward the final ✅ line verbatim. If exit ≠ 0, surface the failing step.
