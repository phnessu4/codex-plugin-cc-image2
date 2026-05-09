---
description: "[BETA] Local alpha reconstruction for white-bg PNGs (rembg / color-to-alpha / hybrid / chroma)"
argument-hint: "<input> <output> [--clean-edges|--fill-holes|--chroma <hex>|--color-to-alpha <hex>|--hybrid-mask <rembg-png>] [--mask-expand 2]"
allowed-tools: Bash(python3:*)
---

Run:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/sprite/sprite-fix.py" $ARGUMENTS
```

Operating rules:

- **BETA**: see `sprite-fix.py` docstring for measured quality ceiling vs. web-UI direct RGBA.
- **Dependencies**: `pillow`, `numpy`, `scipy`. (`rembg` not required for sprite-fix itself.)
- **When to use each mode**:
  - Already have rembg output, just want to clean residual edges: `--clean-edges`
  - rembg failed to recognize closed interior holes (key bows, button thread holes): `--fill-holes`
  - Background is a specific solid color you put there via prompt (chroma key): `--chroma "#00FF00"`
  - Want better soft-edge fidelity than rembg alone: `--color-to-alpha "#FFFFFF" --hybrid-mask <rembg-output>`
- The `--color-to-alpha` standalone mode preserves more glow detail but introduces compression-noise artifacts at low alpha; `--hybrid-mask` combo is usually preferred.
- Forward `saved <path>` line verbatim.
