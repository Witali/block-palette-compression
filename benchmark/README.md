# Unified texture codec benchmark

This benchmark compares BPAL against GPU texture formats using the same decoded
source pixels, metrics, and base mip level. The default corpus is a
deterministic eight-image subset of the official CLIC 2020 Professional
Validation dataset hosted by ETH Zurich for the Challenge on Learned Image
Compression.

Profiles included by default:

- BPAL at approximately 2.1, 2.4, 4, and 6 bits per pixel;
- BPAL v5 at approximately 3.2 bits per pixel with 64 and 128 shared palettes,
  32 colors per shared palette, and 8 local colors per 16x16 block;
- a matching single-palette BPAL v5 control with the same block size, local
  color count, shared-palette size, and color format;
- BC1 and BC7 through Microsoft DirectXTex `texconv`;
- ASTC 8x8, 6x6, and 4x4 through Arm `astcenc`.

### Multi-palette profile selection

The 64-palette BPAL v5 profile was selected with a controlled 32-versus-64
palette run over the complete eight-image CLIC subset. Both candidates used
16x16 blocks, 8 local colors, 32 colors per shared palette, RGB888 storage,
and otherwise identical encoder settings. The 64-palette candidate reached
34.872 dB aggregate RGB PSNR and 0.973393 luma SSIM at 3.2266 payload bpp. The
32-palette candidate reached 34.639 dB and 0.971847 at 3.1992 bpp. Thus the
sixth selector bit bought +0.233 dB and +0.001546 SSIM for +0.0274 bpp, and
improved both quality metrics on every image in the corpus.

The 32-palette candidate remains available as an opt-in profile so the choice
can be reproduced:

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

## Run

```powershell
npm run benchmark:textures
```

By default the benchmark writes reusable intermediate files to
`benchmark/work/` and reports to `benchmark/results/latest/`. Both tool paths
can be overridden:

```powershell
python tools/texture_codec_benchmark.py `
  --texconv C:\path\to\texconv.exe `
  --astcenc C:\path\to\astcenc-avx2.exe
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
benchmark.
