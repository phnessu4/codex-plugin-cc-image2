#!/usr/bin/env bash
# sprite-setup — install Python deps for the [Beta] sprite pipeline.
#
# Installs: rembg onnxruntime scipy pillow numpy
# The isnet-general-use model weight (~180 MB) is downloaded on first
# /codex:sprite-pipeline run, not here.

set -e

echo "Installing sprite pipeline Python dependencies..."
pip install rembg onnxruntime scipy pillow numpy

echo ""
echo "Verifying..."
python3 -c "import rembg, onnxruntime, scipy, PIL, numpy; print('All deps OK')"
echo ""
echo "Done. Run /codex:sprite-pipeline to generate your first sprite."
