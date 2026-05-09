#!/usr/bin/env python3
"""sprite-fix [BETA] — local post-processing for ChatGPT-generated white-bg images.

═════════════════════════════════════════════════════════════════════════════
QUALITY DISCLAIMER (read this before relying on output)
─────────────────────────────────────────────────────────────────────────────
  ChatGPT subscription path (codex CLI) outputs RGB-only PNGs even when prompted
  for transparent backgrounds. This module reconstructs an alpha channel
  AFTER the fact, which has a hard mathematical ceiling:

  Soft glows / antialiased edges / luminous halos that exist as RGBA in the
  original (e.g. ChatGPT web UI direct output) cannot be perfectly recovered
  from a flattened RGB-on-white PNG. White-foreground vs white-background
  pixels are indistinguishable in RGB.

  Measured on a 5-element decorative sprite-sheet (gold leaf + snow + vines):
    rembg isnet-general-use  —  semi-transparent: 14.1%   (vs GT 25.7%)
    color-to-alpha (GIMP)    —  semi-transparent:  9.4%   (vs GT 25.7%)
    hybrid (rembg + c2a)     —  semi-transparent: 18.1%   (vs GT 25.7%)
    ── ground truth (web-UI direct RGBA) ──────────  25.7%
       (full opacity 6.7% — only path with non-zero opaque ratio)

  In practice: rembg edges look softer than GT, c2a preserves more glow but
  adds compression-noise artifacts in low-alpha regions, hybrid is the best
  compromise. None matches a model-direct RGBA output.

  Recommended workflow for fairy-tale book sprites:
    1. Critical sprites (titles, drop-caps): use ChatGPT web-UI manually
    2. Bulk dividers / page numbers: this pipeline (good-enough automation)
    3. Or: keep white-bg PNGs, hand them to web-UI for "remove background"

═════════════════════════════════════════════════════════════════════════════

Algorithms:
  --clean-edges      Border-flood-fill removes residual white pixels still
                     touching the canvas border (rembg edge bleed).
  --fill-holes       Flag connected white regions NOT touching border as
                     transparent (rembg fails on closed interior holes such
                     as key bows or button thread holes).
  --chroma <hex>     Replace exact color globally with alpha=0 (use after
                     prompting model to draw holes/background in chroma key).
  --color-to-alpha <hex>
                     GIMP-style color→alpha. Solves α s.t.
                     bg*(1-α) + fg*α = pixel. Best for soft glows but
                     introduces noise artifacts at low α (mitigated with
                     ε-clamp); standalone often noisier than hybrid.
  --hybrid-mask <rembg-output> --color-to-alpha <hex>
                     Recommended for decorative sprites: rembg supplies the
                     foreground silhouette (no background noise leakage),
                     c2a fills α inside the silhouette (preserves soft edges).
                     +2 px dilation (--mask-expand) gives c2a room to taper.
"""
import argparse
import sys
import numpy as np
from PIL import Image


def clean_edges(arr, color_thresh=240, alpha_thresh=200):
    from scipy.ndimage import label
    candidate = (arr[..., :3] >= color_thresh).all(axis=-1) & (arr[..., 3] >= alpha_thresh)
    labeled, _ = label(candidate)
    border_labels = set(labeled[0, :].tolist()) | set(labeled[-1, :].tolist()) | \
                    set(labeled[:, 0].tolist()) | set(labeled[:, -1].tolist())
    border_labels.discard(0)
    mask = np.isin(labeled, list(border_labels))
    arr[mask, 3] = 0
    return int(mask.sum())


def chroma_key(arr, hex_color, tol=10):
    target = np.array([int(hex_color[i:i+2], 16) for i in (1, 3, 5)])
    diff = np.abs(arr[..., :3].astype(int) - target).max(axis=-1)
    mask = diff <= tol
    arr[mask, 3] = 0
    return int(mask.sum())


def fill_holes(arr, color_thresh=240, alpha_thresh=200):
    from scipy.ndimage import label
    candidate = (arr[..., :3] >= color_thresh).all(axis=-1) & (arr[..., 3] >= alpha_thresh)
    labeled, n = label(candidate)
    border_labels = set(labeled[0, :].tolist()) | set(labeled[-1, :].tolist()) | \
                    set(labeled[:, 0].tolist()) | set(labeled[:, -1].tolist())
    border_labels.discard(0)
    interior_mask = np.zeros_like(candidate)
    for lbl in range(1, n + 1):
        if lbl in border_labels:
            continue
        interior_mask |= (labeled == lbl)
    arr[interior_mask, 3] = 0
    return int(interior_mask.sum())


def color_to_alpha(input_path, output_path, hex_color):
    target = np.array([int(hex_color[i:i+2], 16) for i in (1, 3, 5)], dtype=np.float32) / 255.0
    im = Image.open(input_path).convert("RGB")
    arr = np.array(im).astype(np.float32) / 255.0
    diff = arr - target
    denom = np.where(arr < target, target, 1 - target)
    alpha_per = np.abs(diff) / np.maximum(denom, 1e-10)
    alpha = np.clip(alpha_per.max(axis=-1), 0, 1)
    # Low-α clamp suppresses purple-noise artifacts from PNG-compression jitter
    # being amplified by 1/α reverse-mix.
    alpha = np.where(alpha < 0.05, 0.0, alpha)
    safe_a = np.maximum(alpha[..., None], 0.05)
    rgb_orig = (arr - target * (1 - alpha[..., None])) / safe_a
    rgb_orig = np.clip(rgb_orig, 0, 1)
    rgb_orig[alpha == 0] = 0
    out = np.concatenate([rgb_orig, alpha[..., None]], axis=-1)
    Image.fromarray((out * 255).astype(np.uint8), "RGBA").save(output_path)
    return int((alpha < 1.0).sum())


def hybrid_alpha(input_path, mask_path, output_path, hex_color="#FFFFFF", expand=2):
    """rembg silhouette × color-to-alpha gradient — best-quality option for
    decorative gold/snow/vine sprites in our measurements."""
    from scipy.ndimage import binary_dilation
    target = np.array([int(hex_color[i:i+2], 16) for i in (1, 3, 5)], dtype=np.float32) / 255.0
    rgb_im = Image.open(input_path).convert("RGB")
    arr = np.array(rgb_im).astype(np.float32) / 255.0
    mask_im = Image.open(mask_path).convert("RGBA")
    mask_alpha = np.array(mask_im.getchannel("A"))
    fg_mask = mask_alpha > 0
    fg_mask = binary_dilation(fg_mask, iterations=expand)
    diff = arr - target
    denom = np.where(arr < target, target, 1 - target)
    alpha_per = np.abs(diff) / np.maximum(denom, 1e-10)
    alpha_c2a = np.clip(alpha_per.max(axis=-1), 0, 1)
    alpha = np.where(fg_mask, alpha_c2a, 0.0)
    safe_a = np.maximum(alpha[..., None], 0.05)
    rgb_orig = (arr - target * (1 - alpha[..., None])) / safe_a
    rgb_orig = np.clip(rgb_orig, 0, 1)
    rgb_orig[~fg_mask] = 0
    out = np.concatenate([rgb_orig, alpha[..., None]], axis=-1)
    Image.fromarray((out * 255).astype(np.uint8), "RGBA").save(output_path)
    return int((alpha > 0).sum()), int((alpha == 1.0).sum())


def main():
    ap = argparse.ArgumentParser(
        description="sprite-fix [BETA] — local alpha reconstruction for ChatGPT RGB output. "
                    "See module docstring for quality limits."
    )
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--clean-edges", action="store_true")
    ap.add_argument("--fill-holes", action="store_true")
    ap.add_argument("--chroma", help="hex color like #00FF00")
    ap.add_argument("--color-to-alpha", help="hex color (e.g. #FFFFFF) for GIMP-style color→alpha")
    ap.add_argument("--hybrid-mask", help="rembg RGBA output path; pair with --color-to-alpha for best quality")
    ap.add_argument("--mask-expand", type=int, default=2, help="px to dilate rembg mask (default 2)")
    ap.add_argument("--color-thresh", type=int, default=240)
    ap.add_argument("--alpha-thresh", type=int, default=200)
    ap.add_argument("--tol", type=int, default=10)
    args = ap.parse_args()

    if args.hybrid_mask and args.color_to_alpha:
        n, full = hybrid_alpha(args.input, args.hybrid_mask, args.output, args.color_to_alpha, args.mask_expand)
        print(f"hybrid (rembg-mask + c2a {args.color_to_alpha}): {n} fg-px, {full} fully-opaque")
        print(f"saved {args.output}")
        return

    if args.color_to_alpha:
        n = color_to_alpha(args.input, args.output, args.color_to_alpha)
        print(f"color-to-alpha {args.color_to_alpha}: {n} px partial/transparent")
        print(f"saved {args.output}")
        return

    im = Image.open(args.input).convert("RGBA")
    arr = np.array(im)
    if args.chroma:
        n = chroma_key(arr, args.chroma, tol=args.tol)
        print(f"chroma {args.chroma}: cleared {n} px")
    if args.clean_edges:
        n = clean_edges(arr, args.color_thresh, args.alpha_thresh)
        print(f"clean-edges: cleared {n} border-connected px")
    if args.fill_holes:
        n = fill_holes(arr, args.color_thresh, args.alpha_thresh)
        print(f"fill-holes: cleared {n} interior-hole px")

    Image.fromarray(arr).save(args.output)
    print(f"saved {args.output}")


if __name__ == "__main__":
    main()
