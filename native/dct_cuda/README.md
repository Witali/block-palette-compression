# CUDA DCTBS2 command-line tool

`dctcuda` is a CUDA encoder and decoder for the same independently addressable
DCTBS2 v2 files used by `src/dct/dct-format.js`. The file remains a 64-byte
header followed by fixed 16x16 MCU records. Every MCU contains independent Y,
Cb, and Cr coefficients, so decoding a pixel requires its own record only and
never a full-image reconstruction.

The encoder runs RGB-to-YCbCr conversion, 4:2:2 downsampling, separable DCT,
profile selection, and quantization on the GPU. Both full-image decoding and
single-pixel reconstruction use CUDA kernels. The `pixel` command reads one
24-64 byte MCU record from disk and uploads only that record to the GPU.

## Build on Windows

Install the repository dependencies with `setup.ps1`, then run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File native\dct_cuda\build.ps1
```

The script locates Visual Studio, uses `nvcc` from `PATH` or the project-local
CUDA toolchain, and writes `.tmp\dctcuda-build\dctcuda.exe`. Pass
`-Architecture sm_120` to create a GPU-specific binary instead of using the
locally detected architecture.

CMake 3.24 or newer is also supported:

```powershell
cmake -S native\dct_cuda -B .tmp\dctcuda-cmake -G Ninja `
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=native
cmake --build .tmp\dctcuda-cmake
```

## Commands

Encode an image at a fixed record size and quality:

```powershell
.\.tmp\dctcuda-build\dctcuda.exe encode input.png output.dctbs2 `
  --preset 1 --quality 72
```

Supported presets are `0.75`, `1`, `1.5`, `2`, `3`, `4.5`, and `6` nominal
bpp. This includes all higher-rate 16/24/32-byte modes from the preserved
reference converter. Edge padding can make actual bpp higher for dimensions
that are not multiples of 16. List all layouts with:

```powershell
.\.tmp\dctcuda-build\dctcuda.exe presets
```

Search all CUDA quality candidates and keep the one with the best full-image
RGB PSNR:

```powershell
.\.tmp\dctcuda-build\dctcuda.exe encode input.png output.dctbs2 `
  --preset 0.75 --find-settings
```

Decode to binary PPM P6, inspect the header, or reconstruct one pixel:

```powershell
.\.tmp\dctcuda-build\dctcuda.exe decode output.dctbs2 output.ppm
.\.tmp\dctcuda-build\dctcuda.exe info output.dctbs2
.\.tmp\dctcuda-build\dctcuda.exe pixel output.dctbs2 123 45
```

Use `--device N` on GPU commands to select a CUDA device. Run `--version` to
list visible devices and the CUDA runtime version.

## Compatibility check

After building, run the bidirectional JavaScript/CUDA format test:

```powershell
node native\dct_cuda\tests\verify-js-compat.js `
  .\.tmp\dctcuda-build\dctcuda.exe
```

The test compares the complete seven-layout list and exercises every preset
in both directions. It encodes on CUDA and decodes in JavaScript, encodes in
JavaScript and decodes on CUDA, and compares CUDA single-pixel results with
`sampleDctFilePixel`.
