# Dependency setup

The repository includes a Windows setup script that prepares the dependencies
used by the browser project and CUDA command-line development. It keeps CUDA
inside the repository, so the setup does not require administrator rights and
does not replace the installed NVIDIA display driver.

## Prerequisites

- 64-bit Windows and Windows PowerShell 5.1 or newer;
- Node.js available on `PATH` for the web application and JavaScript tests;
- Visual Studio 2022 or 2026 with the Desktop development with C++ workload
  when compiling the native C or CUDA programs.

The project has no npm package dependencies. Visual Studio and Node.js are
system prerequisites and are not downloaded by the script.

## Quick start

From the repository root:

```powershell
.\setup.ps1
```

If the current execution policy blocks local scripts, use a process-scoped
override:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

The script checks Node.js and calls `tools/setup-local-cuda.ps1`. Repeated runs
are safe: existing CUDA archives are reused only after their SHA-256 hashes
match the official NVIDIA manifest.

## Downloaded CUDA components

The local toolchain contains the components needed to compile and run custom
CUDA kernels:

- `cuda_nvcc` — CUDA compiler and binary tools;
- `cuda_crt` — device compilation headers;
- `cuda_cudart` — CUDA Runtime headers, libraries, and DLLs;
- `cccl` — CUB, Thrust, and CUDA C++ standard-library headers;
- `libnvvm` — the NVVM compiler backend.

Files are stored under `tools/cuda`:

```text
tools/cuda/
|-- archives/          Downloaded and SHA-256-verified ZIP files
|-- extracted/         Per-package extraction directories
|-- toolkit/v13.3/     Unified local CUDA toolkit
`-- redistrib_*.json   NVIDIA redistributable manifest
```

The generated directory is ignored by Git. The setup does not download the
display driver, optional CUDA math libraries such as cuBLAS or cuFFT, or Nsight
profilers. Add those packages only if a program starts using them.

## Environment variables

By default, setup writes these variables for the current Windows user:

- `CUDA_PATH`;
- `CUDA_PATH_V13_3`;
- the local CUDA `bin` directory at the front of user `PATH`.

Open a new terminal after setup, then verify the compiler:

```powershell
nvcc --version
```

To keep the environment unchanged and use explicit paths instead:

```powershell
.\setup.ps1 -NoUserEnvironment
.\tools\cuda\toolkit\v13.3\bin\nvcc.exe --version
```

## Options

| Option | Effect |
| --- | --- |
| `-SkipCuda` | Check Node.js only; useful for browser-only development. |
| `-NoUserEnvironment` | Download CUDA without changing user environment variables. |
| `-CudaRelease <version>` | Select the NVIDIA redistributable manifest release. |
| `-CudaToolkitVersion <version>` | Select the local toolkit directory and environment-variable suffix. |

`CudaRelease` and `CudaToolkitVersion` must describe the same CUDA release
family. For the pinned defaults they are `13.3.1` and `13.3`.

## CUDA validation

Run compilation from an x64 Visual Studio Developer PowerShell so `nvcc` can
find the MSVC host compiler:

```powershell
nvcc -std=c++17 -arch=native tools\cuda-smoke-test.cu -o cuda-smoke-test.exe
.\cuda-smoke-test.exe
```

A successful run prints the detected NVIDIA GPU and `value=42`.

## Build the CUDA texture compressor

Run CMake from an x64 Visual Studio Developer PowerShell after setup:

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

The resulting `bpal5cudaenc` program reads JPEG, PNG, TGA, BMP, PSD, GIF, HDR,
PIC, and binary PNM images through the vendored `stb_image` loader and writes
BPAL v5 textures. No separate image-library installation is required. See the
[native command-line tools guide](../native/bpal5_simd/README.md) for all
encoder settings, presets, CUDA pipeline details, and benchmarking.

## Build the CUDA DCTBS2 tool

The DCTBS2 encoder, decoder, and random-access pixel sampler can be compiled
without CMake. From the repository root run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File native\dct_cuda\build.ps1
.\.tmp\dctcuda-build\dctcuda.exe --version
```

The build script locates the Visual Studio C++ environment and either `nvcc`
on `PATH` or the project-local CUDA compiler. See the
[CUDA DCTBS2 command-line guide](../native/dct_cuda/README.md) for usage and
the JavaScript compatibility check.
