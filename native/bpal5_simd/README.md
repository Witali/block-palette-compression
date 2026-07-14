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

Decode it:

```sh
bpal5dec input.bpal output.ppm
```

All three programs accept `--version`. The CPU tools identify the runtime SIMD
backend, while the CUDA encoder lists the available devices.

Encoder options:

- `--preset BPP`: apply the researched quality settings for target bpp `1.5`,
  `2`, `2.5`, `3`, `4`, `5`, `6`, or `8`;
- `--block N`: block width and height, power of two from 2 to 64;
- `--local N`: colours in each block palette, power of two from 2 to 16;
- `--global N`: colours in each global palette, power of two from 2 to 4096;
- `--palettes N`: global palette count, power of two from 1 to 128;
- `--rgb565`: store global palette colours as RGB565 instead of RGB888;
- `--iterations N`: global k-means iteration limit;
- `--refine N`: iterative-refinement pass count;
- `--no-simd`: disable AVX2 even when the CPU supports it.

`bpal5cudaenc` accepts the same encoder options and adds `--device N`.
`--no-simd` is retained for command-line compatibility; current CUDA palette
initialization no longer calls the CPU nearest-colour SIMD backend.

Presets select RGB888, four refinement passes, and the following BPAL
structure. Explicit encoder options override the selected preset regardless of
their position on the command line.

| Preset | Block | Local colors | Shared colors | Palettes |
| ---: | ---: | ---: | ---: | ---: |
| 1.5 | 4 | 2 | 8 | 2 |
| 2 | 4 | 2 | 128 | 2 |
| 2.5 | 8 | 4 | 64 | 32 |
| 3 | 8 | 4 | 256 | 64 |
| 4 | 8 | 8 | 128 | 16 |
| 5 | 16 | 16 | 256 | 64 |
| 6 | 8 | 16 | 128 | 32 |
| 8 | 4 | 8 | 256 | 64 |

The encoder clusters blocks by their RGB mean and standard deviation, builds a
separate global palette for each cluster, chooses a compact palette for every
block, and then refines the result by comparing reconstructed colours with the
source pixels. Defaults are block size 16, 8 local colours, 32 global colours,
one global palette, RGB888, 8 k-means iterations, and 4 refinement passes.

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
  --build-dir native\bpal5_simd\build-cuda --preset 3 --refine 4
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
