# BPAL profile search

These scripts reproduce the staged 1.5–8 bpp search documented in the
[English report](../results/bpal-optimal-settings-1.5-to-8-bpp.md). The
[original Russian report](../results/bpal-optimal-settings-1.5-to-8-bpp_ru.md)
is preserved alongside it.

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

## Extended 1.5 and 8 bpp search

The range-edge study uses wider structural ranges, targeted 1024/4096-color
palettes, and a dynamic eight-worker queue for every crop stage:

```powershell
node benchmark/profile_search/extended.js screen --jobs 8
node benchmark/profile_search/extended.js validate --jobs 8
node benchmark/profile_search/extended.js policy --jobs 8
```

Its intermediate reports are written under
`benchmark/work/bpal-profile-search/extended/`.

## Full-resolution verification

The configured original and extended profiles are encoded on all eight
1024×1024 sources with four refinement passes. The command resumes any complete
RGBA outputs, can filter target budgets, and defaults to eight concurrent
Node.js processes:

```powershell
node benchmark/profile_search/full.js --jobs 8
node benchmark/profile_search/full.js --targets 1.5,8 --jobs 8
```

To validate every stored RGB MSE, calculate luminance SSIM, and record the PSNR
and SSIM winner for each target:

```powershell
python benchmark/profile_search/score.py --jobs 8
```

The final machine-readable report is written to
`benchmark/work/bpal-profile-search/full/report.json`.

## K-means versus source-snapped K-medoids

The centroid comparison uses the optimized 1.5, 2, 2.5, and 3 bpp profiles to
measure the quality and cost of constraining every palette center to an actual
source color. It defaults to eight concurrent Node.js processes:

```powershell
node benchmark/profile_search/compare_centers.js --jobs 8
node benchmark/profile_search/compare_centers.js --targets 1.5,2 --jobs 8
```

The script reports RGB MSE/PSNR, mean RGB bias, the share of active palette
entries found exactly in the source image, and elapsed time. The machine-readable
result is written to `benchmark/work/centroid-comparison/report.json`; the
methodology and reference results are documented in the
[centroid comparison report](../results/bpal-centroid-comparison.md).

## Lightweight validation

The scripts can be checked without running the expensive benchmark:

```powershell
node --check benchmark/profile_search/search.js
node --check benchmark/profile_search/extended.js
node --check benchmark/profile_search/full.js
node --check benchmark/profile_search/compare_centers.js
python -m py_compile benchmark/profile_search/score.py
```
