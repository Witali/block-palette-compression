# Unified texture codec benchmark

This benchmark compares BPAL against GPU texture formats using the same decoded
source pixels, metrics, and base mip level. The default corpus is a
deterministic eight-image subset of the official CLIC 2020 Professional
Validation dataset hosted by ETH Zurich for the Challenge on Learned Image
Compression.

Profiles included by default:

- BPAL at approximately 2.1, 2.4, 4, and 6 bits per pixel;
- BC1 and BC7 through Microsoft DirectXTex `texconv`;
- ASTC 8x8, 6x6, and 4x4 through Arm `astcenc`.

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
