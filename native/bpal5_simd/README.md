# BPAL v5 C/SIMD tools

`bpal5enc` and `bpal5dec` are standalone C11 command-line programs for the
explicit-palette variant of BPAL v5 used by this repository. The programs have
no image-library dependency: input and output images use binary PPM (`P6`).

The implementation reads and writes the same continuous, MSB-first bit stream
as `src/palette/block-palette-format.js`, including multi-palette selectors.
It uses AVX2 for nearest-colour searches and pixel reconstruction on supported
x86-64 CPUs. AVX2 is selected at runtime; the same binary automatically falls
back to scalar C when AVX2 is unavailable. Pass `--no-simd` to force the scalar
path.

## Build

With CMake and a C11 compiler:

```sh
cmake -S native/bpal5_simd -B native/bpal5_simd/build -DCMAKE_BUILD_TYPE=Release
cmake --build native/bpal5_simd/build --config Release
ctest --test-dir native/bpal5_simd/build -C Release --output-on-failure
```

On Windows, run the commands from an x64 Visual Studio Developer PowerShell.
On Linux, GCC and Clang builds link the standard math library automatically.

## Usage

Encode an RGB image:

```sh
bpal5enc input.ppm output.bpal --block 16 --local 8 --global 32 --palettes 4
```

Decode it:

```sh
bpal5dec input.bpal output.ppm
```

Encoder options:

- `--block N`: block width and height, power of two from 2 to 64;
- `--local N`: colours in each block palette, power of two from 2 to 16;
- `--global N`: colours in each global palette, power of two from 2 to 4096;
- `--palettes N`: global palette count, power of two from 1 to 128;
- `--rgb565`: store global palette colours as RGB565 instead of RGB888;
- `--iterations N`: global k-means iteration limit;
- `--refine N`: iterative-refinement pass count;
- `--no-simd`: disable AVX2 even when the CPU supports it.

The encoder clusters blocks by their RGB mean and standard deviation, builds a
separate global palette for each cluster, chooses a compact palette for every
block, and then refines the result by comparing reconstructed colours with the
source pixels. Defaults are block size 16, 8 local colours, 32 global colours,
one global palette, RGB888, 8 k-means iterations, and 4 refinement passes.

## API and compatibility

The reusable API is declared in `include/bpal5.h`; the two executables are thin
front ends around that library. CTest includes a native round-trip test and a
two-way C/JavaScript compatibility test when Node.js is available.

The decoder intentionally rejects BPAL vector-palette files. The current image
compressor emits explicit palettes, and explicit BPAL v5 is the format covered
by these tools. PPM has no alpha channel, so decoded output is RGB; the library
decoder returns RGBA with alpha set to 255.
