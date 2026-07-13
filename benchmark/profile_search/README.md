# BPAL profile search

These scripts reproduce the staged 2–6 bpp search documented in
[`benchmark/results/bpal-optimal-settings-2-to-6-bpp.md`](../results/bpal-optimal-settings-2-to-6-bpp.md).

All generated JSON files and reconstructed RGBA images are written below
`benchmark/work/bpal-profile-search/`, which is intentionally ignored by Git.

## Prerequisites

- Node.js supported by the repository.
- Python with NumPy for SSIM scoring.
- The eight normalized 1024×1024 RGBA sources prepared by the texture benchmark
  under `benchmark/work/sources/<image-id>/source.rgba`.

Running `tools/texture_codec_benchmark.py` on the CLIC manifest prepares these
source files as part of its normal benchmark setup.

## Staged search

Run from the repository root:

```powershell
node benchmark/profile_search/search.js screen
node benchmark/profile_search/search.js validate
node benchmark/profile_search/search.js policy
```

The stages perform:

1. A 222-candidate structural screen on one 256×256 crop.
2. Cross-image validation of 22 finalists on four crops, including targeted
   1024-color global palettes.
3. An encoder-policy comparison covering RGB/OKLab, three clustering methods,
   diversity, and four dithering modes.

Intermediate reports are `screen-<source-id>.json`, `validate.json`, and
`policy.json` under the ignored work directory.

## Full-resolution verification

The final 15 profiles are encoded on all eight 1024×1024 sources with four
refinement passes. The command resumes any complete RGBA outputs and defaults
to eight concurrent Node.js processes:

```powershell
node benchmark/profile_search/full.js --jobs 8
```

To validate every stored RGB MSE, calculate luminance SSIM, and record the PSNR
and SSIM winner for each target:

```powershell
python benchmark/profile_search/score.py --jobs 8
```

The final machine-readable report is written to
`benchmark/work/bpal-profile-search/full/report.json`.

## Lightweight validation

The scripts can be checked without running the expensive benchmark:

```powershell
node --check benchmark/profile_search/search.js
node --check benchmark/profile_search/full.js
python -m py_compile benchmark/profile_search/score.py
```
