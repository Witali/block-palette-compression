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
4. Record at least 11 measured preset 5 runs per variant and compare their
   medians. Use shorter screening runs while rejecting early experiments.
5. Repeat a promising result in a fresh browser session.
6. Accept a change only when both sessions are faster by at least 2%, or when a
   smaller improvement is outside the observed run-to-run noise.
7. Verify the encoded dimensions, BPAL layout, decoded MSE, PSNR, and output
   indices. Require byte-identical BPAL output for RGB paths intended to match
   the existing algorithm.
8. Revert experiments that are slower, unstable, or reduce quality. Record the
   rejected result here without retaining its implementation.
9. Screen accepted changes on presets 1.5, 3, 5, and 8, covering small and
   large blocks and palettes. Run all presets from 1.5 through 8 before final
   acceptance.

Wall-clock time is the primary metric. A future extension of the harness can
use `EXT_disjoint_timer_query_webgl2` to separate shader work from JavaScript,
texture upload, and readback overhead.

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
| Specialize the global-assignment shader loop | >180,000 ms timeout (preset 1.5 first run) | 147.2 ms first run | Removed the compilation stall | Identical hashes, MSE, and PSNR | Accepted |
| Cache greedy-selection candidate distances | 5,145.5 ms | 4,500.1 ms | 12.5% faster | Identical hashes, MSE, and PSNR | Accepted |
| Adaptively cache refinement distances for 8+ selected colors | 4,500.1 ms | 2,978.8 ms | 33.8% faster | Identical hashes, MSE, and PSNR | Accepted |
| Collect block counts and color sums in one pass | 4,500.1 ms | 4,567.5 ms | 1.5% slower | Identical output | Rejected and reverted |
| Cache nearest and second-nearest selected colors | 2,978.8 ms | 2,971.6 ms | 0.24% faster, inside noise | Identical output | Rejected and reverted |
| Reuse the first selection-distance matrix in refinement | 2,978.8 ms | 3,174.8 ms | 6.6% slower | Identical output | Rejected and reverted |
| Retain render targets and readback buffers during a job | 2,978.8 ms | 3,342.8 ms | 12.2% slower | Identical output | Rejected and reverted |
| Store distance matrices in candidate-major order | 2,978.8 ms | 2,994.7 ms | 0.5% slower | Identical output | Rejected and reverted |
| Upload indices through `R16UI` textures | 80.6 ms / 1,076.8 ms (presets 1.5 / 8) | 84.6 ms / 1,083.9 ms | 5.0% / 0.7% slower in the confirming A/B session | Identical output | Rejected and reverted |
| Read assignments and indices from integer render targets | 68.3 ms / 3,060.4 ms (presets 1.5 / 5) | 82.9 ms / 3,181.4 ms | 21.4% / 4.0% slower | Identical output | Rejected and reverted |

The shader-specialization result is reported separately because the original
4096-iteration loop did not finish compiling within the timeout for the
smallest preset. Later experiments use the most recent accepted implementation
as their reference, so their percentages should not be added together.

## Final multi-preset validation

The final measurements used `assets/stone-texture-wic.jpg`, resized to 128 x 85,
Chrome 150, and ANGLE D3D11 on an NVIDIA GeForce RTX 5060 Ti. Preset 5 used two
warm-up runs and 11 measured runs. The other presets used one warm-up and five
measured runs. Times are medians in milliseconds.

| Preset | Total | Build shared palettes | Assign pixels | Build block palettes | Encode pixels | Refinement | MSE | PSNR (dB) | Encoded hash |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1.5 | 86.5 | 23.5 | 7.1 | 11.2 | 6.9 | 24.7 | 119.4724 | 27.3581 | `ab0eabdc` |
| 2 | 371.0 | 223.9 | 7.4 | 34.3 | 6.7 | 86.7 | 103.4061 | 27.9853 | `0c960111` |
| 2.5 | 325.9 | 83.1 | 7.2 | 52.6 | 6.7 | 155.4 | 47.8600 | 31.3311 | `4a5f33bd` |
| 3 | 865.0 | 238.4 | 9.4 | 111.9 | 7.1 | 472.1 | 47.2888 | 31.3832 | `e1cba0dd` |
| 4 | 649.4 | 206.7 | 6.8 | 97.8 | 6.6 | 325.0 | 15.2623 | 36.2946 | `dcdccc00` |
| 5 | 3,200.1 | 282.4 | 9.6 | 728.4 | 8.0 | 2,144.5 | 10.2181 | 38.0371 | `76595b7a` |
| 6 | 1,229.7 | 193.4 | 7.2 | 216.9 | 7.2 | 786.1 | 5.2409 | 40.9367 | `bc721d17` |
| 8 | 1,080.9 | 317.7 | 11.1 | 136.9 | 7.9 | 569.7 | 3.5390 | 42.6420 | `78f2ed84` |

Every measured run within each preset produced the same encoded-state hash,
decoded-pixel hash, MSE, PSNR, payload size, and selected algorithm. The final
preset 5 median is 37.8% lower than the original 5,145.5 ms reference. Its
block-palette construction fell from 1,111.1 to 728.4 ms, and refinement fell
from 3,746.3 to 2,144.5 ms.

## Reproducing the benchmark

From PowerShell in the repository root:

```powershell
$env:PORT=8127
npm start
```

Then open, for example:

```text
http://127.0.0.1:8127/tools/webgl2-compression-benchmark.html?preset=5&runs=11&warmup=2&side=128&refinement=4
```

Valid preset values are `1.5`, `2`, `2.5`, `3`, `4`, `5`, `6`, and `8`.
The page prints a JSON report with environment data, phase statistics, output
hashes, MSE, PSNR, payload size, and every measured run.

## Conclusion

The retained work addresses the actual dominant path rather than maximizing
GPU usage for its own sake. Shader specialization prevents pathological driver
compilation, while the two distance caches transfer the most effective
SIMD/CUDA reuse principle to the JavaScript block selector. Preset 5 is now
about 37.8% faster with byte-identical encoded state and decoded pixels.

The final preset 5 profile still spends about 89.8% of total time in block
palette construction and refinement. Global GPU assignment plus block encoding
take only 17.6 ms, or about 0.6%. Therefore further shader micro-optimization
cannot meet the 2% whole-job acceptance threshold. The next material project is
GPU-resident or parallel block-palette selection, but it requires deterministic
multi-pass reductions that WebGL2 does not provide directly. A CPU worker pool
or a later WebGPU compute implementation should be evaluated before adding that
complexity to this WebGL2 path.

## Completion criteria

- The fastest accepted WebGL2 path is the production default when supported.
- Unsupported devices continue to fall back safely.
- Preset 5 has a saved before/after benchmark with phase timings.
- Existing unit tests and browser compatibility checks pass.
- Accepted changes and rejected experiments are documented in the experiment
  log.
