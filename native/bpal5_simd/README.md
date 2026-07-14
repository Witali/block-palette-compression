# BPAL v5 CPU/SIMD and CUDA tools

This directory provides three standalone command-line programs for the
explicit-palette variant of BPAL v5 used by this repository:

- `bpal5enc`: C11 CPU encoder with an optional AVX2 path;
- `bpal5cudaenc`: CUDA encoder that accelerates iterative refinement;
- `bpal5dec`: C11 CPU decoder with an optional AVX2 path.

The encoders use a vendored copy of `stb_image` 2.30 and accept JPEG, PNG, TGA,
BMP, PSD, GIF, HDR, PIC, and binary PNM images without an external image DLL.
Input is converted to RGB; alpha and animation are not stored by BPAL. The
decoder writes binary PPM (`P6`).

The implementation reads and writes the same continuous, MSB-first bit stream
as `src/palette/block-palette-format.js`, including multi-palette selectors.
When `--local` equals `--block × --block`, block-table entries map directly to
pixel positions and no pixel-index stream is stored.
It uses AVX2 for nearest-colour searches and pixel reconstruction on supported
x86-64 CPUs. AVX2 is selected at runtime; the same binary automatically falls
back to scalar C when AVX2 is unavailable. Pass `--no-simd` to force the scalar
path.

## Build the CPU tools

With CMake and a C11 compiler:

```sh
cmake -S native/bpal5_simd -B native/bpal5_simd/build -DCMAKE_BUILD_TYPE=Release
cmake --build native/bpal5_simd/build --config Release
ctest --test-dir native/bpal5_simd/build -C Release --output-on-failure
```

On Windows, run the commands from an x64 Visual Studio Developer PowerShell.
On Linux, GCC and Clang builds link the standard math library automatically.

Pass `-DBPAL5_BUILD_CUDA=OFF` when a CUDA compiler is installed but only the
CPU tools are required.

## Build the CUDA encoder on Windows

First prepare the project-local CUDA toolkit from the repository root:

```powershell
.\setup.ps1
```

Open an x64 Visual Studio Developer PowerShell, then configure a CUDA build.
The explicit compiler path also works after setup was run with
`-NoUserEnvironment`:

```powershell
$cuda = (Resolve-Path tools\cuda\toolkit\v13.3).Path
$env:PATH = "$cuda\bin;$env:PATH"
cmake -S native\bpal5_simd -B native\bpal5_simd\build-cuda -G Ninja `
  -DCMAKE_BUILD_TYPE=Release `
  -DCMAKE_CUDA_COMPILER="$cuda\bin\nvcc.exe" `
  -DCMAKE_CUDA_ARCHITECTURES=native
cmake --build native\bpal5_simd\build-cuda
ctest --test-dir native\bpal5_simd\build-cuda --output-on-failure
```

`native` creates code for the GPU in the build machine. Set an explicit CMake
CUDA architecture list when producing binaries for other GPU generations.

## Usage

Encode an RGB image:

```sh
bpal5enc input.jpg output.bpal --preset 3
```

Encode with CUDA refinement:

```sh
bpal5cudaenc input.png output.bpal --preset 3 --device 0
```

Encode a single-channel PBR map:

```sh
bpal5cudaenc roughness.png roughness.bpal --preset 3 --find-settings --scalar
```

Search the preset's bpp range and keep the highest-quality result:

```sh
bpal5enc input.jpg output.bpal --preset 3 --find-settings
bpal5cudaenc input.png output.bpal --preset 3 --find-settings --device 0
```

Decode it:

```sh
bpal5dec input.bpal output.ppm
```

All three programs accept `--version`. The CPU tools identify the runtime SIMD
backend, while the CUDA encoder lists the available devices.

Encoder options:

- `--preset BPP`: apply the researched quality settings for target bpp `1.5`,
  `2`, `2.5`, `3`, `4`, `5`, `6`, or `8`;
- `--find-settings`: test the shared structural profiles, palette counts 2,
  16, 32, and 64, and both RGB565 and RGB888 inside the selected preset's bpp
  range; this option requires `--preset`;
- `--block N`: block width and height, power of two from 2 to 64;
- `--local N`: colours in each block palette, power of two from 2 to 16 and no
  greater than `--block × --block`;
- `--global N`: colours in each global palette, power of two from 2 to 4096;
- `--palettes N`: global palette count, power of two from 1 to 128;
- `--rgb565`: store global palette colours as RGB565 instead of RGB888;
- `--scalar`: store one 8-bit value for each shared-palette entry and replicate
  it to RGB during decode;
- `--iterations N`: global k-means iteration limit;
- `--refine N`: iterative-refinement pass count;
- `--threads N`: CPU encoder worker count from 1 to 256 (default 4);
- `--no-simd`: disable AVX2 even when the CPU supports it.

`--threads` applies to `bpal5enc`; CMake enables the parallel path when the C
compiler provides OpenMP. Without OpenMP, the CPU encoder uses one worker.
`bpal5cudaenc` accepts the other encoder options and adds `--device N`.
`--no-simd` is retained for command-line compatibility; current CUDA palette
initialization no longer calls the CPU nearest-colour SIMD backend.

Settings search uses the same profiles and midpoint ranges as the web tool.
The range for a preset is bounded by `(previous + current) / 2` and
`(current + next) / 2`; the missing neighbour at either end is extrapolated.
Only profiles whose calculated full-image payload bpp is inside that range
are encoded. The current command-line settings are included as the baseline
candidate. The search first finds the minimum-RMSE result in both the expanded
candidate set and the legacy family that keeps the preset palette count and
color format. The expanded result is accepted only when its PSNR gain is at
least `15 * ln(expanded_bpp / legacy_bpp)`; this rate guard avoids spending a
large number of bits for a marginal quality gain. Ties in RMSE are resolved by
distance from the target bpp and then by smaller payload size. Search output
states the requested target bpp and its allowed range, then reports bpp, RMSE,
and PSNR for every eligible candidate.
If discrete palette overhead leaves the range empty for a small image, the
candidate closest to the target bpp is encoded and reported as a fallback.
Candidate encodes reuse the same process, including its initialized CUDA
runtime and driver caches.

`--iterations`, `--refine`, `--threads`, and `--no-simd` remain common to all
search candidates. `--palettes`, `--rgb565`, `--block`, `--local`, and
`--global` customize the baseline and legacy family; the expanded candidates
deliberately vary palette count, color format, and structural fields. Without
`--find-settings`, all explicit options continue to override the preset
normally.

### Scalar PBR channel mode

The `scalar` channel mode changes only shared-palette storage.
All block selectors, block-local palette indices, and per-pixel indices retain
the regular BPAL layout. Header bits 76-77 identify RGB (`0`) or scalar (`1`).
The final two bits are format flags; bit 0 selects independent packed RGB
palette records. Existing unpacked RGB files therefore remain byte-compatible.

A scalar palette entry occupies 8 bits instead of RGB888's 24 bits. Encoding
uses the source red channel and decoding replicates the stored byte to red,
green, and blue. This is intended for ambient-occlusion, height,
displacement, metalness, opacity, and roughness maps whose RGB channels carry
the same value. Scalar entries retain all eight bits even when `--rgb565` is
present; RGB565 quantization applies only to RGB channel mode.

`bpal5_decode_pixel_rgba` exposes direct coordinate lookup. It performs one
block calculation, reads one selector, one local index, one block-palette
index, and one shared-palette entry. It never visits another pixel or block.
Consequently scalar mode retains deterministic O(1) random pixel access and
requires no variable-length or inter-block state on a GPU.

Packed palette records are used only in RGB mode and only when their complete
section, including its directory and record tags, is smaller than the raw
palette array. Scalar8 palettes remain raw because their one-byte entries are
already more compact than the RGB record representation.

Presets select RGB888, four refinement passes, and the following BPAL
structure. Explicit encoder options override the selected preset regardless of
their position on the command line.

| Preset | Search range (bpp) | Block | Local colors | Shared colors | Palettes |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.5 | 1.25–1.75 | 4 | 2 | 8 | 2 |
| 2 | 1.75–2.25 | 4 | 2 | 128 | 2 |
| 2.5 | 2.25–2.75 | 8 | 4 | 64 | 32 |
| 3 | 2.75–3.50 | 8 | 4 | 256 | 64 |
| 4 | 3.50–4.50 | 8 | 8 | 128 | 16 |
| 5 | 4.50–5.50 | 16 | 16 | 256 | 64 |
| 6 | 5.50–7.00 | 8 | 16 | 128 | 32 |
| 8 | 7.00–9.00 | 4 | 8 | 256 | 64 |

The encoder clusters blocks by their RGB mean and standard deviation, builds a
separate global palette for each cluster, chooses a compact palette for every
block, and then refines the result by comparing reconstructed colours with the
source pixels. Defaults are block size 16, 8 local colours, 32 global colours,
one global palette, RGB888, 8 k-means iterations, and 4 refinement passes.
The CPU encoder uses four worker threads by default.

`stb_image.h` and its license are stored in `third_party/stb`. The accompanying
README records the pinned upstream commit and SHA-256 hash for reproducible
offline builds.

## CUDA pipeline and quality guarantees

The CUDA encoder keeps block-descriptor clustering on the CPU, but moves the
expensive global-palette construction and initial block encoding to CUDA. CUDA
context initialization runs concurrently with CPU block clustering and palette
sample grouping, hiding most or all of that remaining CPU work. The compact
RGB24 input, block selectors, and packed palette samples cross the PCIe
boundary once. A CUDA kernel expands RGB24 into an aligned 32-bit RGB cache,
after which the palettes and index arrays stay on the GPU while kernels
perform:

- farthest-first global-palette seeding;
- global-palette k-means assignment and centroid updates;
- initial block-local palette selection and pixel assignment;
- shared-palette centroid accumulation and update;
- block-local palette selection;
- final pixel-index assignment.

Block-local palette selection processes every local slot in one kernel. It
first finds the same nearest-colour candidate set and preserves the same tie
order as the CPU encoder. Candidate flags, per-pixel nearest colours,
per-block best distances, and selected colours stay in shared memory instead
of repeatedly writing a full-image scratch array to global GPU memory. The
only per-pass GPU-to-CPU value is the 64-bit candidate error needed for early
termination; final palette and index arrays are downloaded once.

Every candidate refinement pass is measured using the same integer RGB squared
error as the CPU encoder. A pass is accepted only when it lowers the error, so
CUDA refinement cannot reduce the quality of the initialized image. GPU
farthest-first seeding, k-means rounding, candidate order, and RGB565
quantization match the CPU implementation. The validation image produced
byte-identical CPU and CUDA BPAL files for every preset from 1.5 through 8 bpp
and for RGB565.

The summary printed by `bpal5cudaenc` reports CPU block clustering and sample
grouping, CUDA setup, GPU palette construction, initial block encoding,
refinement, accepted/requested passes, final MSE, and the selected device.
CPU preparation overlaps CUDA setup, so those reported stage times do not sum
to wall-clock time.

To reproduce a wall-clock and decoded-quality comparison between both
encoders, use any binary RGB PPM input:

```powershell
python native\bpal5_simd\tests\benchmark_cuda.py input.ppm `
  --build-dir native\bpal5_simd\build-cuda --preset 3 --refine 4 --threads 4
```

The script reports mean and best encode time, output size, decoded MSE, PSNR,
the detailed CUDA stage breakdown, and CUDA speedup. It uses only the Python
standard library.

The packed BPAL serializer also batches aligned `uint8_t` and `uint16_t`
indices into 32-bit words before emitting the continuous MSB-first stream.
This preserves the format while avoiding one writer call per individual bit
or index. Reproduce its isolated timing with:

```powershell
cmake --build native\bpal5_simd\build-cuda --target bpal5_serialize_benchmark
native\bpal5_simd\build-cuda\bpal5_serialize_benchmark.exe input.bpal 2000
```

### Optimization validation

On an RTX 5060 Ti, a 330x512 PPM with preset 3 and four refinement passes first
showed this pre-migration CPU profile: 22 ms block clustering, 246 ms global
palette construction, and 51 ms initial block encoding. Palette construction
was 77% of the 319 ms CPU initialization phase.

After moving palette seeding, k-means, and initial block encoding to CUDA, a
representative run reported 20.8 ms of overlapping CPU preparation, 5.6 ms of
GPU palette construction, 0.7 ms of GPU initial block encoding, and 3.8 ms of
GPU refinement. Ten measured process runs produced the following result:

| Measurement | Before GPU palette construction | After | Speedup |
| --- | ---: | ---: | ---: |
| CPU initialization work | 319.055 ms | 20.824 ms | 15.322x |
| Full CUDA process, mean | 430.667 ms | 126.489 ms | 3.405x |
| Current CPU vs CUDA process, mean | 535.638 ms | 126.489 ms | 4.235x |
| BPAL serialization, mean | 0.873 ms | 0.308 ms | 2.84x |

CUDA driver/context startup remains the largest single stage in a fresh
process (roughly 80-105 ms on this system). It overlaps CPU preparation but
cannot be eliminated inside a one-image command. Consequently, very short
low-bpp jobs such as preset 1.5 can still be faster on the CPU; a persistent or
batch encoder could amortize startup across multiple images.

#### CPU preset 5 optimization

Preset 5 was used for CPU optimization because it was the slowest tested
preset. The retained implementation applies the CUDA data-flow ideas that are
also effective on a CPU: each block is read once into separate red, green, and
blue channel arrays; candidate scoring and best-distance updates operate on
eight pixels at a time with AVX2; the nearest-colour reduction stays in SIMD
registers; and independent global palettes and blocks are distributed across
OpenMP workers. Each worker owns its block scratch buffers, so the hot loop has
no shared mutable workspace.

On the 330x512 validation PPM with preset 5 and four refinement passes, the
following paired medians isolated each retained change:

| Change | Before | After | Speedup |
| --- | ---: | ---: | ---: |
| AVX2 nearest-colour register reduction | 1471.912 ms | 1347.830 ms | 1.092x |
| Per-block RGB channel cache | 1362.806 ms | 939.036 ms | 1.451x |
| AVX2 block candidate scoring | 938.848 ms | 376.405 ms | 2.494x |
| Parallel global palettes, 8 workers | 371.032 ms | 264.117 ms | 1.405x |
| Parallel blocks, 8 workers | 263.658 ms | 107.087 ms | 2.462x |

The complete default four-worker encoder improved from 1475.605 ms to
127.886 ms, or 11.538x. Worker-count scaling, measured with alternating runs,
was 378.744 ms at one worker, 210.633 ms at two, 131.914 ms at four, and
111.741 ms at eight. All variants produced the same SHA-256 BPAL digest.

Two CUDA-inspired layouts were measured and rejected: 32-byte-aligned global
palette loads were 1.9% slower, and expanding the entire RGB24 image into a
packed 32-bit cache was 15.2% slower. They remain useful on the GPU, where
coalescing and shared-memory access dominate, but added unpacking or allocation
cost on this CPU.

With the default four CPU workers, 15 process runs measured 133.295 ms mean for
SIMD and 139.948 ms for CUDA. CUDA itself used only 12.386 ms mean on the GPU,
but fresh-process setup made the CPU 1.050x faster end to end for this image.
Both encoders produced byte-identical 144,902-byte output with MSE 4.1524 and
PSNR 41.9478 dB.

To compare two CPU builds with alternating order and exact-output validation:

```powershell
python native\bpal5_simd\tests\benchmark_cpu_variants.py input.ppm `
  old\bpal5enc.exe new\bpal5enc.exe --preset 5 --refine 4 --threads 4
```

## API and compatibility

The reusable CPU API is declared in `include/bpal5.h`; the CUDA entry points
and timing statistics are declared in `include/bpal5_cuda.h`. The executables
are thin front ends around those libraries. CTest includes CPU and CUDA native
round-trip tests and a two-way C/JavaScript compatibility test when Node.js is
available. The CUDA test is reported as skipped when no CUDA device is present.

The decoder intentionally rejects BPAL vector-palette files. The current image
compressor emits explicit palettes, and explicit BPAL v5 is the format covered
by these tools. BPAL command-line encoding is RGB-only, so input alpha is
discarded. The library decoder returns RGBA with alpha set to 255, while the
command-line decoder writes RGB PPM.
