# WebGL2 Compression Optimization Plan

## Objective

Improve the browser WebGL2 BPAL compression path by transferring the data-flow
and parallel-processing lessons that proved useful in the native SIMD and CUDA
encoders. Keep only changes that produce a repeatable wall-clock improvement
without reducing decoded quality or changing the requested BPAL layout.

The primary workload is quality preset 5 because it is the slowest researched
preset: 16x16 blocks, 16 local colors, 256 colors in each of 64 shared
palettes, RGB888 palette storage, and four refinement passes.

This plan targets WebGL2. WebGPU is a separate API and there is no API named
"WebGPU2" in this project.

## Acceptance protocol

Every optimization is tested independently against the most recent accepted
version.

1. Use the same source image and preset 5 settings for both variants.
2. Warm up shaders and the GPU before recording measurements.
3. Alternate reference and candidate runs to reduce temperature and scheduling
   bias.
4. Record at least 11 measured runs per variant and compare their medians.
5. Repeat a promising result in a fresh browser session.
6. Accept a change only when both sessions are faster by at least 2%, or when a
   smaller improvement is outside the observed run-to-run noise.
7. Verify the encoded dimensions, BPAL layout, decoded MSE, PSNR, and output
   indices. Require byte-identical BPAL output for RGB paths intended to match
   the existing algorithm.
8. Revert experiments that are slower, unstable, or reduce quality. Record the
   rejected result here without retaining its implementation.

Wall-clock time is the primary metric. When
`EXT_disjoint_timer_query_webgl2` is available, GPU time is also recorded to
separate shader work from JavaScript, texture upload, and readback overhead.

## Baseline and instrumentation

- Add a browser benchmark harness that invokes the real OffscreenCanvas
  WebGL2 compressor rather than a mocked Node.js path.
- Report total time and the major phases: palette construction, global
  assignment, block-palette selection, block encoding, refinement, texture
  upload, draw, and readback.
- Save the benchmark script and machine/browser details needed to reproduce a
  result.
- Keep benchmark-only resources outside production bundles where possible.

## Optimization stages

### 1. Persistent WebGL resources

Transfer the CUDA cache-lifetime approach to the browser:

- retain the OffscreenCanvas, WebGL2 context, compiled programs, uniform
  locations, framebuffers, and output textures across compression jobs;
- update changing palette and index data with `texSubImage2D` instead of
  deleting and recreating textures;
- reuse output buffers for repeated refinement passes;
- cache source textures until the source image changes.

This stage should reduce driver allocation, shader compilation, and redundant
CPU-to-GPU transfers without changing the algorithm.

### 2. Precomputed comparison colors

Transfer the SIMD per-block cache principle to shader inputs:

- precompute source comparison points once;
- upload separate exact RGB palette colors and RGB/OKLab comparison points;
- remove sRGB-to-OKLab conversion and `pow` calls from palette-search inner
  loops;
- reuse comparison textures through all refinement passes.

### 3. Structured integer textures

Transfer the CUDA aligned 32-bit RGB cache and compact native index layouts:

- use integer source and palette textures with `usampler2D` for the exact RGB
  path;
- store local indices in `R8UI` and global indices/selectors in `R16UI` when
  browser support is complete;
- arrange shared palettes as `globalColorCount x paletteCount` and block
  palettes as `localColorCount x blockCount` to remove division and modulo from
  hot shader loops;
- read compact integer outputs directly instead of unpacking normalized RGBA8.

Retain normalized RGBA8 fallbacks for incomplete WebGL2 implementations.

### 4. Specialized shader variants

- compile separate RGB and OKLab programs;
- specialize common global palette sizes and local color counts;
- remove uniform branches and 4096-iteration loops from smaller presets;
- use chunked minimum-reduction passes for 1024- and 4096-color palettes if a
  giant specialized shader is slower or fails to compile.

### 5. GPU-resident refinement

Transfer the CUDA rule that intermediate assignments remain on the GPU:

- keep global assignments, best distances, local indices, and reconstructed
  pixels in ping-pong textures;
- reduce reconstruction error on the GPU and read back only compact partial
  sums needed for the accept/reject decision;
- defer full pixel and index readback until the final accepted pass;
- investigate pixel-pack buffers and fences to overlap unavoidable readback.

WebGL2 lacks CUDA shared memory, compute shaders, and general-purpose atomic
accumulation, so reductions must use render passes or small CPU finalization.

### 6. Block-palette selection

Move the remaining JavaScript greedy selection to render passes only if the
earlier stages leave it dominant:

- compute block-pixel/candidate distances in parallel;
- maintain per-pixel best distances in textures;
- reduce candidate scores and preserve the current deterministic tie order;
- repeat for each local palette slot.

The retained result must match the current block-palette indices and quality.

### 7. Parallel shared-palette construction

The current browser codec builds independent shared palettes sequentially.
Evaluate two alternatives:

- a four-worker CPU pool, analogous to the native OpenMP path;
- WebGL2 k-means assignment and multi-pass centroid reduction.

Prefer the worker implementation if GPU reductions require extensions, lose
determinism, or spend more time on synchronization than they save. A future
WASM SIMD/threads implementation can be evaluated separately.

## Experiment log

| Experiment | Reference median | Candidate median | Change | Quality/output | Decision |
| --- | ---: | ---: | ---: | --- | --- |
| Baseline preset 5 | Pending | - | - | Pending | Pending |

## Completion criteria

- The fastest accepted WebGL2 path is the production default when supported.
- Unsupported devices continue to fall back safely.
- Preset 5 has a saved before/after benchmark with phase timings.
- Existing unit tests and browser compatibility checks pass.
- Accepted changes and rejected experiments are documented in the experiment
  log.
