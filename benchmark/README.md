# Unified texture codec benchmark

This benchmark compares BPAL against GPU texture formats using the same decoded
source pixels, metrics, and base mip level. The default corpus is a
deterministic eight-image subset of the official CLIC 2020 Professional
Validation dataset hosted by ETH Zurich for the Challenge on Learned Image
Compression.

Profiles included by default:

- BPAL at approximately 2.1, 2.4, 4, and 6 bits per pixel;
- BPAL v5 at approximately 3.2 bits per pixel with 32, 64, and 128 shared palettes,
  32 colors per shared palette, and 8 local colors per 16x16 block;
- a matching single-palette BPAL v5 control with the same block size, local
  color count, shared-palette size, and color format;
- matching single-, 64-, and 128-palette profiles encoded and decoded by the
  standalone C11 implementation with runtime AVX2 dispatch;
- BC1 and BC7 through Microsoft DirectXTex `texconv`;
- ASTC 8x8, 6x6, 5x5, and 4x4 through Arm `astcenc`.

### Multi-palette profile selection

The 64-palette BPAL v5 profile was selected with a controlled 32-versus-64
palette run over the complete eight-image CLIC subset. Both candidates used
16x16 blocks, 8 local colors, 32 colors per shared palette, RGB888 storage,
and otherwise identical encoder settings. The 64-palette candidate reached
35.049 dB aggregate RGB PSNR and 0.973903 luma SSIM at 3.2266 payload bpp. The
32-palette candidate reached 34.772 dB and 0.972216 at 3.1992 bpp. Thus the
sixth selector bit bought +0.277 dB and +0.001687 SSIM for +0.0273 bpp, and
improved both quality metrics on every image in the corpus.

The 32-palette candidate remains in the default comparison so the choice can
be reproduced directly:

```powershell
python tools/texture_codec_benchmark.py `
  --profiles bpal-v5-mp32,bpal-v5-mp64 `
  --output-dir benchmark/work/multi-palette-selection
```

The benchmark reports:

- exact artifact size and file bits per source pixel;
- codec payload size without DDS/ASTC/BPAL headers;
- RGB PSNR in the stored 8-bit domain;
- luminance SSIM with an 11x11 Gaussian window and sigma 1.5;
- cold command-line encode and decode time.

All BPAL profiles request up to four iterative-refinement passes. The setting
is written explicitly into every result record, and resume mode reruns a BPAL
record when its effective encoder settings differ from the current profile.

Compared with the previous zero-refinement run, refinement raised aggregate
PSNR from 34.872 to 35.049 dB for 64 palettes and from 35.063 to 35.315 dB for
128 palettes without changing their 3.2266 and 3.2773 payload bpp rates.

### Native C/SIMD comparison

At 64 palettes, the C/SIMD implementation reached 34.733 dB and 0.971205 SSIM,
versus 35.049 dB and 0.973903 for the JavaScript quality-oriented encoder at
the same 3.2266 payload bpp. Its aggregate cold encode time was 9.796 seconds
instead of 44.510 seconds (4.54x faster), and decode time was 0.116 instead of
0.606 seconds (5.21x faster). At 128 palettes, the corresponding speedups were
4.78x for encoding and 5.31x for decoding, with a 0.317 dB PSNR difference.
The native rows therefore measure a faster independent encoder, not merely a
SIMD rewrite that produces byte-identical output.

Only RGB is scored. Every current corpus image is opaque because BPAL does not
store alpha. The run is intentionally limited to mip level 0 so every codec is
measured against exactly the same source pixels. Mip-chain quality should be a
separate benchmark because it also depends on the downsampling filter.

## Setup

Install Python dependencies:

```powershell
python -m pip install -r benchmark/requirements.txt
```

Download the pinned official Windows reference tools:

```powershell
powershell -ExecutionPolicy Bypass -File tools/setup-texture-benchmark.ps1
```

The setup script downloads:

- Arm astcenc 5.6.0;
- Microsoft DirectXTex texconv 2026.5.8.1 (`may2026`).

Downloads are verified with SHA-256 and stored under `.benchmark-tools/`, which
is excluded from Git.

Download the official CLIC corpus separately:

```powershell
powershell -ExecutionPolicy Bypass -File tools/setup-texture-benchmark-corpus.ps1
```

The 129 MB archive and extracted images are stored only under
`.benchmark-corpus/`, which is excluded from Git. The repository stores the
official URL, license URL, checksum, deterministic selection rule, and result
tables, but not the dataset itself.

Download the pinned texture-specific datasets separately:

```powershell
powershell -ExecutionPolicy Bypass -File tools/setup-texture-datasets.ps1
```

The texture suite is defined in `benchmark/texture-datasets.json` and contains:

- all 5,640 images from Describable Textures Dataset r1.0.1;
- the 240-image, six-class lossless subset of Kylberg Texture Dataset v1.0;
- 12 ambientCG materials as lossless 2K PNG PBR packs, spanning bricks, wood,
  metal, fabric, rock, ground, concrete, tiles, leather, grass, painted plaster,
  and marble.

Every archive has a pinned byte size and SHA-256 digest. The setup script is
idempotent, verifies existing downloads before using them, checks the extracted
image count, and leaves all dataset files under the Git-ignored
`.benchmark-corpus/` directory. DTD is supplied for research purposes, Kylberg
requires its dataset report to be cited, and the selected ambientCG assets are
CC0 1.0 Universal. Review the source links in the manifest before distributing
any dataset files.

### CUDA settings search versus ASTC

Build `bpal5cudaenc` and run the default deterministic 200-image sample with:

```powershell
python tools/cuda_astc_texture_benchmark.py
```

The sample contains 100 DTD images stratified across all 47 classes, 45
Kylberg images stratified across all six classes, and all 55 selected ambientCG
PBR maps except previews and the duplicate DirectX normal-map variants. Within
each class, images are ordered by the SHA-256 of their stable ID. Use
`--sample-count 0` to run the complete downloaded corpus instead.

The benchmark compares eight CUDA BPAL `--find-settings` targets from 1.5 to
8 bpp against the closest standard ASTC block rates. Progress is appended to
`benchmark/work/cuda-astc-textures/records.jsonl`, so an interrupted run can be
resumed with the same command. The generated Markdown report is written to
`benchmark/results/cuda-astc-textures.md`.
Aggregates use measured payload bpp. The report also counts searches that had
to select the closest candidate because a small image had no profile inside a
preset's nominal bpp range.

All inputs are normalized to RGB8 before either encoder sees them. In
particular, 16-bit displacement maps are scaled by `round(value / 257)` instead
of being clipped by a generic image-mode conversion. The report uses pooled
RGB PSNR, exact payload sizes, Bjontegaard delta rate, and angular error for
normal maps.

### Scalar PBR palette benchmark

After the CUDA/ASTC run, compare scalar8 palette storage with the exact
structural settings selected by the RGB BPAL baseline:

```powershell
python tools/specialized_pbr_benchmark.py `
  --baseline-records benchmark/work/cuda-astc-textures/records.jsonl `
  --source-dir benchmark/work/cuda-astc-textures/sources `
  --encoder native/bpal5_simd/build-cuda/bpal5cudaenc.exe `
  --decoder native/bpal5_simd/build-cuda/bpal5dec.exe
```

This covers all 31 ambientCG ambient-occlusion, displacement, metalness,
opacity, and roughness maps at eight rates. Reusing the baseline's selected
block structure isolates the storage change: decoded scalar values and PSNR
must remain identical, while measured payload bpp may decrease. Records are
resumable under `benchmark/work/specialized-pbr/`; the tracked report is
`benchmark/results/specialized-pbr-modes.md`.

### Local palette packing

After building `native/bpal5_simd/build-local/bpal5cudaenc.exe`, compare the
GPU-friendly independent palette records against the byte-equivalent legacy
layout on a stratified 60-texture sample:

```powershell
python tools/local_palette_packing_benchmark.py
```

The benchmark covers all eight CUDA `--find-settings` targets, includes every
directory and record byte in file-size totals, and verifies byte-identical
decoded output for packed and legacy files.

## Run

Build the native C/SIMD codec first:

```powershell
cmake -S native/bpal5_simd -B native/bpal5_simd/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build native/bpal5_simd/build
```

```powershell
npm run benchmark:textures
```

By default the benchmark writes reusable intermediate files to
`benchmark/work/` and reports to `benchmark/results/latest/`. Both tool paths
can be overridden:

```powershell
python tools/texture_codec_benchmark.py `
  --texconv C:\path\to\texconv.exe `
  --astcenc C:\path\to\astcenc-avx2.exe `
  --bpal5enc C:\path\to\bpal5enc.exe `
  --bpal5dec C:\path\to\bpal5dec.exe
```

The default CLIC subset first keeps images of at least 1024x1024, sorts their
relative paths by SHA-256, and takes the first eight. It then uses a
deterministic 1024x1024 center crop. This avoids hand-picking favorable images
and keeps a complete run practical. Run the small repository-local material
corpus instead with:

```powershell
python tools/texture_codec_benchmark.py --corpus benchmark/corpus.json
```

Long runs can reuse completed records from an earlier JSON report. Missing
image/profile pairs are encoded normally:

```powershell
python tools/texture_codec_benchmark.py `
  --resume benchmark/results/latest/texture-codec-benchmark.json
```

Run metric unit tests with:

```powershell
npm run benchmark:textures:test
```

## Interpretation

File bpp and payload bpp are both shown because DDS and ASTC containers add a
fixed header. BPAL payload bpp excludes its 14-byte service header. For large
textures the distinction is small, but it matters for the 64x64 corpus image.

PSNR and SSIM are not interchangeable. PSNR measures average squared RGB error;
SSIM measures local luminance structure. Encoder settings can improve one while
slightly reducing the other. Results must be compared at similar payload bpp,
not by profile name alone.

Encode/decode timings are cold process timings and include executable startup
and file I/O. They are useful for repeatability checks, not as a GPU sampling
benchmark. The JavaScript adapter reads and writes raw RGBA, while the standalone
C tools use PPM RGB, so small I/O differences are included in their timings.
