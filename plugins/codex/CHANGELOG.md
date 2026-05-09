# Changelog

## 1.1.0 — 2026-05-09

- **[Beta] Sprite pipeline**: three new commands for white-bg → transparent PNG
  workflows (`/codex:sprite-pipeline`, `/codex:sprite-fix`, `/codex:img-wait`).
  Reconstructs alpha locally from RGB output via `rembg` (isnet-general-use),
  GIMP-style color-to-alpha, or a hybrid combo. See `README.md` § Sprite
  pipeline for measured quality vs. ChatGPT web-UI direct RGBA. Extra deps:
  `pip install rembg onnxruntime scipy pillow numpy`.
- **`image-enqueue --transparent` flag**: opt-in instruction for codex agent
  to request `background=transparent` on the image_generation tool. Currently
  no-op because the tool spec hard-codes RGB output (codex#18944 tracking);
  forward-compatible — will activate automatically when upstream lands.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
