---
description: Install Python dependencies for the [Beta] sprite pipeline (rembg, onnxruntime, scipy, pillow, numpy)
argument-hint: ""
allowed-tools: Bash(bash:*)
---

Run:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/sprite/sprite-setup.sh"
```

Operating rules:

- Runs `pip install rembg onnxruntime scipy pillow numpy` and verifies all imports.
- The isnet-general-use model weight (~180 MB) is downloaded on the first `/codex:sprite-pipeline` run, not here.
- This command is idempotent — safe to re-run if any package was upgraded or is missing.
- Forward the final "Done." line verbatim. If pip fails, surface the error and suggest the user run `pip install --user rembg onnxruntime scipy pillow numpy` manually.
