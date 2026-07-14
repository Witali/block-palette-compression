# BPAL v5 CPU/SIMD and CUDA tools

This directory provides three standalone command-line programs for the
explicit-palette variant of BPAL v5 used by this repository:

- `bpal5enc`: C11 CPU encoder with an optional AVX2 path;
- `bpal5cudaenc`: CUDA encoder that accelerates iterative refinement;
- `bpal5dec`: C11 CPU decoder with an optional AVX2 path.

The programs have no image-library dependency: input and output images use
binary PPM (`P6`).

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
bpal5enc input.ppm output.bpal --preset 3
```

Encode with CUDA refinement:

```sh
bpal5cudaenc input.ppm output.bpal --preset 3 --device 0
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
`--no-simd` controls the CPU initialization stage of the CUDA encoder.

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

## CUDA pipeline and quality guarantees

The CUDA encoder deliberately reuses the CPU encoder for block clustering and
initial global-palette construction. It then keeps the source image, palette,
block-local tables, and pixel indices on the GPU while CUDA kernels perform:

- exact RGB error measurement;
- shared-palette centroid accumulation and update;
- block-local palette selection;
- final pixel-index assignment.

Every candidate refinement pass is measured using the same integer RGB squared
error as the CPU encoder. A pass is accepted only when it lowers the error, so
CUDA refinement cannot reduce the quality of the initialized image. The CUDA
block search considers every colour in the selected shared palette; it can
therefore produce a slightly lower MSE than the CPU refinement search while
keeping the exact same BPAL file layout and size.

The summary printed by `bpal5cudaenc` separates CPU initialization time from
GPU time and reports accepted/requested passes, final MSE, and the selected
device. End-to-end acceleration depends on image and preset because initial
palette construction remains on the CPU.

To reproduce a wall-clock and decoded-quality comparison between both
encoders, use any binary RGB PPM input:

```powershell
python native\bpal5_simd\tests\benchmark_cuda.py input.ppm `
  --build-dir native\bpal5_simd\build-cuda --preset 3 --refine 4
```

The script reports mean and best encode time, output size, decoded MSE, PSNR,
and CUDA speedup. It uses only the Python standard library.

## API and compatibility

The reusable CPU API is declared in `include/bpal5.h`; the CUDA entry points
and timing statistics are declared in `include/bpal5_cuda.h`. The executables
are thin front ends around those libraries. CTest includes CPU and CUDA native
round-trip tests and a two-way C/JavaScript compatibility test when Node.js is
available. The CUDA test is reported as skipped when no CUDA device is present.

The decoder intentionally rejects BPAL vector-palette files. The current image
compressor emits explicit palettes, and explicit BPAL v5 is the format covered
by these tools. PPM has no alpha channel, so decoded output is RGB; the library
decoder returns RGBA with alpha set to 255.
