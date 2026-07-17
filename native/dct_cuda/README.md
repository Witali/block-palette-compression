# CUDA DCTBS2 command-line tool

The CUDA executable is the accelerated native backend. The canonical
command-line interface with the complete set of web encoder algorithms and
settings is [`tools/dctbs2-cli.js`](../../tools/dctbs2-cli.js); it imports the
same [`src/dct/dct-format.js`](../../src/dct/dct-format.js) module as the web
worker. Use `npm run dct -- --help` for that byte-identical JavaScript path.

`dctcuda` is a CUDA encoder and decoder for the same independently addressable
DCTBS2 v2 files used by `src/dct/dct-format.js`. The file remains a 64-byte
header followed by fixed 16x16 MCU records. Low-rate files use one 16x16 Y
transform; the 3 through 9 bpp modes use four independent 8x8 Y transforms
to localize ringing around strong edges. Every MCU contains independent Y, Cb,
and Cr coefficients, so decoding a pixel requires its own record only and
never a full-image reconstruction.

The decoder also accepts the optional clustered DCT prototype library written
by the JavaScript encoder. A component adds one directly indexed prototype to
its local residual before IDCT. The CUDA kernels read the fixed MCU plus at
most one Y, Cb, and Cr prototype; they never follow a reference to another MCU.
The original header-indexed layout supports three prototypes. New sidecar
layouts support 16 or 32 prototypes by storing a fixed-width, LSB-first index
stream separately from the MCU payload. The index position is calculated from
the MCU and component ordinal, so both full-image and single-pixel kernels keep
constant-time random access. Spectral sidecar layouts can put more low-ranked
coefficients in the prototype and use part of the local AC budget for later
positions in the codec's profile-specific significance scan.

New files set the zigzag-order flag in every rate and library mode. Profile 0
follows the standard alternating-diagonal 8x8 or 16x16 zigzag, while the older
significance profiles remain additional per-record candidates. This guarantees
that enabling zigzag does not remove a more accurate old grouped or skip traversal.

Files choose per record between grouped binary exponents and adaptive skip
coding. Grouped records store one three-bit exponent per group and five-bit
signed mantissas; the DC term keeps its own exponent and ten-bit signed value.
Skip-RLE stores signed-6 values with a two-bit forward skip. Dual-scale skip
adds a signed-4 fine group with multiplier 1 or 2. The default is skip-RLE at
0.75 bpp, dual-scale skip at 1, 1.5, and 2 bpp, and dual-scale skip for the
16- and 24-byte high-rate records. The 16/24/32/40/48-byte 8x8 layouts also
support an explicit AC mask whose bit zero selects zigzag AC1, bit one selects
zigzag AC2, and DC is separate. Unused value slots form an implicit contiguous
tail at the end of the zigzag. At
6 and 7.5 bpp the default `auto` mode compares this `masked-tail-8x8` layout
with the earlier `grouped-5-front` layout. At 9 bpp it also evaluates
`masked-tail-implicit2-48`: the two most frequent low-frequency positions,
`DCT[1]` and `DCT[8]`, are implicit, allowing 39 AC8 values in each 48-byte
8x8 record. Auto mode measures exact RGB error for the grouped and zigzag-mask
layouts and keeps only a strictly higher-quality result. A tie keeps grouped coding.
The decoder still accepts older grouped, masked-tail, and legacy records with the
zigzag flag unset.

The encoder runs RGB-to-YCbCr conversion, 4:2:0 downsampling, separable DCT,
profile selection, grouped/skip candidate evaluation, quantization, and packing
on the GPU. Both full-image decoding and single-pixel reconstruction use CUDA
kernels. The `pixel` command reads one
24-288 byte MCU record and, when present, the small prototype library. It does
not upload the other MCU records. For a split-luma record, the kernel
reconstructs only the selected 8x8 Y block. The decoder keeps compatibility
with earlier 4:2:2 files and selects their 8x16 chroma path from the header.

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

Supported presets are `0.75`, `1`, `1.5`, `2`, `3`, `4.5`, `6`, `7.5`, and `9`
nominal bpp. This includes all higher-rate 16/24/32/40/48-byte modes from the
preserved reference converter. Edge padding can make actual bpp higher for
dimensions that are not multiples of 16. List all layouts with:

```powershell
.\.tmp\dctcuda-build\dctcuda.exe presets
```

The CUDA encoder accepts the same coefficient-coding keys as the canonical
JavaScript encoder: `legacy`, `grouped-5-equal-2`, `grouped-5-front`,
`skip-rle-equal-2`, `dual-scale-skip-equal-2`, `dual-scale-skip-front`,
`masked-tail-8x8`, and `masked-tail-implicit2-48`. Pass one through
`--coefficient-coding` to force that representation.
The implicit-2 form applies its special record layout only to 48-byte 8x8
components and otherwise uses the grouped fallback.
The default `--coefficient-coding auto` keeps the lower-error RGB result.
Every newly encoded mode uses zigzag coefficient order. Skip modes use spare
record bits for additional 4-bit fine AC tail coefficients; the 48-byte
implicit-2 layout uses the former mask/padding bits for one more 8-bit AC slot.

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

Low-rate encodes use the fast adaptive Y/C component budget by default. Use
`--component-budget fixed`, `fast`, or `expanded` to control the exact
full-image RGB comparison. The selected Y, Cb, and Cr byte counts are stored in
the DCTBS2 header and do not change the fixed MCU size.

## Compatibility check

After building, run the bidirectional JavaScript/CUDA format test:

```powershell
node native\dct_cuda\tests\verify-js-compat.js `
  .\.tmp\dctcuda-build\dctcuda.exe
```

The test compares the complete nine-layout list and exercises every preset
in both directions. It encodes on CUDA and decodes in JavaScript, encodes in
JavaScript and decodes on CUDA, and compares CUDA single-pixel results with
`sampleDctFilePixel`. It also imports a real JPEG into a high-rate split-luma
file and verifies backward-compatible decoding of a legacy high-rate 16x16 Y,
4:2:2 chroma file. It also checks regular 16-entry and spectral 32-entry sidecar libraries.
CUDA full-image and single-pixel results must match JavaScript.
