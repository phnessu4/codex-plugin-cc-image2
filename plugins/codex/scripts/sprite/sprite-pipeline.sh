#!/usr/bin/env bash
# sprite-pipeline [BETA] — one-shot codex enqueue → wait → rembg → fix → report.
#
# ═══════════════════════════════════════════════════════════════════════════
# QUALITY: Reconstructed alpha cannot match model-direct RGBA output.
#   Empirically rembg (isnet-general-use) preserves shapes well but loses ~12%
#   of the soft-glow detail visible in ChatGPT web-UI direct RGBA output.
#   Use --algorithm hybrid for slightly better edges (rembg silhouette + c2a
#   gradient inside).  See sprite-fix.py docstring for full numbers.
# ═══════════════════════════════════════════════════════════════════════════
#
# Usage:
#   sprite-pipeline --prompt-file <txt> --output <out.png>
#                   [--size 1536x1024] [--algorithm rembg|hybrid]
#                   [--no-keep-raw]
#
# Output:
#   <out>.raw.png   white-bg RGB original from codex (kept unless --no-keep-raw)
#   <out>           final RGBA sprite

set -e

# Locate plugin scripts: prefer CLAUDE_PLUGIN_ROOT (set when invoked via /codex:),
# fallback to script-relative for shell-direct invocation.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
  PLUGIN_SCRIPTS="$CLAUDE_PLUGIN_ROOT/scripts"
else
  PLUGIN_SCRIPTS="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
CC="$PLUGIN_SCRIPTS/codex-companion.mjs"
IMG_WAIT="$SCRIPT_DIR/img-wait"
SPRITE_FIX="$SCRIPT_DIR/sprite-fix.py"

PROMPT_FILE=""
OUTPUT=""
SIZE="1536x1024"
ALGO="rembg"
KEEP_RAW=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompt-file) PROMPT_FILE="$2"; shift 2;;
    --output|-o) OUTPUT="$2"; shift 2;;
    --size) SIZE="$2"; shift 2;;
    --algorithm) ALGO="$2"; shift 2;;
    --no-keep-raw) KEEP_RAW=0; shift;;
    -h|--help) sed -n '2,25p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 1;;
  esac
done

[ -n "$PROMPT_FILE" ] || { echo "missing --prompt-file" >&2; exit 1; }
[ -n "$OUTPUT" ] || { echo "missing --output" >&2; exit 1; }
[ -f "$PROMPT_FILE" ] || { echo "prompt file not found: $PROMPT_FILE" >&2; exit 1; }
command -v rembg >/dev/null 2>&1 || { echo "rembg not found — run /codex:sprite-setup to install deps" >&2; exit 1; }
python3 -c "import onnxruntime, scipy, PIL, numpy" 2>/dev/null || { echo "missing Python deps (onnxruntime/scipy/pillow/numpy) — run /codex:sprite-setup" >&2; exit 1; }

RAW="${OUTPUT%.png}.raw.png"

echo "[1/4] enqueue codex job (size=$SIZE)..."
JOB=$(node "$CC" image-enqueue --size "$SIZE" --output "$RAW" --prompt-file "$PROMPT_FILE" | grep -oE 'img_[a-z0-9_]+' | head -1)
[ -n "$JOB" ] || { echo "failed to enqueue" >&2; exit 2; }
echo "      job=$JOB"

echo "[2/4] waiting for image..."
"$IMG_WAIT" "$JOB" 5
[ -f "$RAW" ] || { echo "raw image missing: $RAW" >&2; exit 3; }

echo "[3/4] rembg -m isnet-general-use..."
TMP_REMBG="${OUTPUT%.png}.rembg.png"
rembg i -m isnet-general-use "$RAW" "$TMP_REMBG" 2>/dev/null

case "$ALGO" in
  rembg)
    echo "[4/4] post-process: clean-edges (no-op on isnet-general-use, kept as safety net)..."
    python3 "$SPRITE_FIX" --clean-edges "$TMP_REMBG" "$OUTPUT"
    rm -f "$TMP_REMBG";;
  hybrid)
    echo "[4/4] post-process: hybrid (rembg mask + color-to-alpha gradient)..."
    python3 "$SPRITE_FIX" --color-to-alpha '#FFFFFF' --hybrid-mask "$TMP_REMBG" --mask-expand 2 "$RAW" "$OUTPUT"
    rm -f "$TMP_REMBG";;
  *)
    echo "unknown --algorithm $ALGO (use rembg|hybrid)" >&2
    rm -f "$TMP_REMBG"
    exit 1;;
esac

python3 -c "
from PIL import Image
import numpy as np
im = Image.open('$OUTPUT')
print(f'\\nFinal: mode={im.mode}  size={im.size}  algorithm=$ALGO')
if im.mode == 'RGBA':
    a = np.array(im.getchannel('A'))
    print(f'alpha: 0={100*(a==0).sum()/a.size:.1f}%  255={100*(a==255).sum()/a.size:.1f}%  semi={100*((a>0)&(a<255)).sum()/a.size:.2f}%')
"

[ "$KEEP_RAW" = "0" ] && rm -f "$RAW"
echo "✅ done: $OUTPUT"
