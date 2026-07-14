# BPDI pattern-dictionary experiment

Research date: July 14, 2026.

## Conclusion

An exact pattern dictionary can reduce BPAL files while preserving every
decoded RGB value and retaining coordinate-level random access. Across all 42
images in the local CLIC 2020 Professional Validation corpus and three BPAL
presets, hybrid selection reduced the aggregate size by 5.97%. It selected
BPDI only when the candidate was smaller and retained BPAL otherwise, so none
of the 126 output files grew and the PSNR change was exactly 0.000 dB.

That 5.97% result is the compression ceiling with one offset checkpoint per 64
blocks. The GPU-oriented default now uses one checkpoint per 16 blocks. It
limits payload lookup to 15 preceding tags while retaining a 4.77% aggregate
saving. Its 85,817,469-byte hybrid output is still 269,345 bytes smaller than
BPDI v2 with the older 64-block directory.

BPDI v3 adds canonical first-use palette remapping, exact dictionary references
under the eight square-block symmetries, and bitmap-coded medium-density
deltas. Relative to BPDI v2, the changes reduced the same hybrid output by
1,349,499 bytes (1.568%) and made 11 additional files smaller. Bitmap deltas
provided 1,029,967 bytes of that reduction after canonical remapping;
transform references account for 52,714 bytes on their own. These modes reuse
an existing block tag, so ordinary dictionary tags do not grow.

The experiment is most effective at 1.5 bpp, where pixel-index patterns occupy
a large share of the file and use only two local symbols. The aggregate saving
at this rate was 9.84%, with 31 of 42 images becoming smaller. The 2.5 and 4
bpp profiles improved by 4.21% and 5.66% respectively.

## Compression-ceiling results

These results use a 64-block checkpoint interval.

| Preset | Images | BPAL bytes | Best bytes | Change | Smaller files | Aggregate PSNR | PSNR change | Mean random access |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.5 | 42 | 16,452,505 | 14,833,299 | -9.84% | 31 | 26.713 dB | 0.000 dB | 583,097 pixels/s |
| 2.5 | 42 | 28,333,084 | 27,139,422 | -4.21% | 20 | 34.026 dB | 0.000 dB | 745,369 pixels/s |
| 4 | 42 | 45,328,451 | 42,764,594 | -5.66% | 27 | 37.977 dB | 0.000 dB | 579,046 pixels/s |
| **All** | **126** | **90,114,040** | **84,737,315** | **-5.97%** | **78** | — | **0.000 dB** | — |

## GPU-default results

| Preset | Images | BPAL bytes | Best bytes | Change | Smaller files | Maximum preceding tags |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.5 | 42 | 16,452,505 | 15,612,561 | -5.11% | 23 | 15 |
| 2.5 | 42 | 28,333,084 | 27,265,176 | -3.77% | 19 | 15 |
| 4 | 42 | 45,328,451 | 42,939,732 | -5.27% | 26 | 15 |
| **All** | **126** | **90,114,040** | **85,817,469** | **-4.77%** | **68** | **15** |

## Offset-directory GPU audit

Directory sizes below include all 126 BPDI candidates before hybrid fallback.
Hybrid sizes include fallback to BPAL whenever the denser directory makes a
candidate larger. Since changing the checkpoint interval only adds 32-bit
directory entries, these are exact byte counts derived from the full CLIC run,
not estimates of payload compressibility.

| Checkpoint interval | Maximum preceding tags | Directory bytes | Hybrid bytes | Change vs BPAL | Selected BPDI files |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 64 | 63 | 537,900 | 84,737,315 | -5.97% | 78 |
| 32 | 31 | 1,075,200 | 85,111,107 | -5.55% | 75 |
| **16 (default)** | **15** | **2,149,812** | **85,817,469** | **-4.77%** | **68** |
| 8 | 7 | 4,298,976 | 86,796,807 | -3.68% | 49 |
| 4 | 3 | 8,597,368 | 87,662,486 | -2.72% | 31 |
| 2 | 1 | 17,194,140 | 88,593,655 | -1.69% | 19 |
| 1 | 0 | 34,387,732 | 89,570,208 | -0.60% | 9 |

The 16-block directory costs 0.2501 bytes per source block across the corpus,
versus 0.0626 at interval 64. A shader can use a fixed 15-iteration loop (or
unroll it), calculate each preceding payload length from its fixed-width tag,
and then decode only the requested block. Interval 8 is available for a
seven-iteration bound; a direct per-block offset is available through interval
1 but removes most of the compression benefit.

The lookup has a direct shader/CUDA translation:

```c
group = block_index >> 4;
first = group << 4;
payload_bit = directory[group];
for (i = 0; i < 15; ++i) {
    active = first + i < block_index;
    payload_bit += active ? block_payload_bits(first + i) : 0;
}
```

`block_payload_bits` reads one fixed-width tag. Only the extended dictionary
mode additionally reads its three-bit subtype from the same independent
payload. There is no data dependency on decoded pixels or neighboring blocks,
and the loop bound is identical for every lookup when compiled unrolled.

`src/palette/block-pattern-dictionary-webgl2.js` provides the corresponding
GLSL ES 3.00 helper, R32UI whole-file packing, layout uniforms, and a JavaScript
emulation of the packed lookup. Sparse edit positions use a fixed 12-step
binary search instead of a linear scan. Bitmap rank uses at most 128 bounded
32-bit slots for the largest supported 64x64 block; smaller blocks perform
active popcounts only for their available mask words.

The largest individual reductions were:

- 29.40% at 1.5 bpp for `jason-briscoe-149782.png`;
- 25.21% at 2.5 bpp for `jason-briscoe-149782.png`;
- 28.14% at 4 bpp for `jason-briscoe-149782.png`.

## Methodology

- Corpus: all 42 PNG files under
  `.benchmark-corpus/clic2020-professional-valid/`.
- Preprocessing: none; every image was encoded at its full stored dimensions.
- BPAL profiles: the researched 1.5, 2.5, and 4 bpp presets.
- Baseline encoder: `native/bpal5_simd/build-cuda/bpal5cudaenc.exe`, with four
  refinement passes selected by each preset.
- Dictionary limit: 64 patterns learned from a uniform sample of at most 8,192
  blocks.
- Compression-ceiling checkpoint interval: 64 blocks. GPU-default interval:
  16 blocks.
- Directory audit: exact recalculation from every full-run per-file block count;
  an actual 18-file CLIC pre-screen at interval 16 reproduced the calculated
  byte sizes and all 2,304 coordinate checks.
- Verification: 128 deterministic coordinate queries per image and preset,
  or 16,128 queries in total. Every returned RGBA pixel matched the BPAL
  baseline.
- GPU reference verification: 4,096 deterministic queries on a repository
  image and exhaustive transform/bitmap fixtures matched both the ordinary JS
  accessor and the R32UI-packed emulation. Chrome WebGL2/SwiftShader compiled,
  linked, and executed the fragment helper; all 288 rendered fixture pixels
  matched the JS accessor after framebuffer readback.
- Quality: the CUDA encoder's exact RGB MSE was used to calculate PSNR. BPDI
  reconstructs the BPAL indices exactly, so its MSE and PSNR are identical to
  the baseline by construction.

The ignored machine-readable report is written to
`benchmark/work/pattern-dictionary-clic/report.json` during reproduction.

## Format and random access

The experimental `BPDI` v3 format keeps the BPAL palette, per-block palette
selectors, and local-to-shared palette tables. It replaces only the linear
pixel-index stream. Active local palette slots are canonicalized by the raster
position of their first use, with reconstructed color used only as a stable
tie-breaker for unused slots. Equivalent index patterns therefore receive the
same symbol numbering even when their block palettes contain different colors.

Every block selects its cheapest exact representation:

1. raw local indices;
2. a dictionary pattern plus a sorted list of changed positions and values;
3. a dictionary pattern plus a changed-position bitmap and packed changed
   values;
4. a transformed dictionary pattern plus a three-bit dihedral transform and a
   sorted list of changed positions and values;
5. the first local index plus positions where the raster-order value changes.

The file stores a fixed-size tag for every block and one 32-bit payload offset
for every group of 16 blocks by default. To retrieve `(x, y)`, the accessor
computes the block number, reads its group checkpoint, scans at most 15
preceding tags, and
then reads only the target pattern and its local delta. It does not reconstruct
any other image block. Direct-color BPAL blocks remain directly addressable.
For a transformed reference, the target coordinate is mapped to the prototype
with a fixed switch over eight transforms before the same bounded delta scan.
For a bitmap delta, the accessor tests one mask bit and uses a rank/popcount of
the preceding bits to locate the changed value. Both operations stay inside
the target block and have a fixed upper bound determined by the block size.

Hybrid encoding serializes both the ordinary BPAL candidate and the BPDI
candidate in memory, then keeps the smaller one. The unified accessor reads
explicit-palette BPAL v5 and BPDI v3 through the same `getPixel(x, y)` API.

## Reproduction

Build the native CUDA tools and run from the repository root:

```powershell
npm run benchmark:patterns:clic
```

The explicit command used for this report was:

```powershell
node tools/pattern-dictionary-clic-benchmark.js `
  --presets 1.5,2.5,4 `
  --queries 128 `
  --max-dictionary 64 `
  --sample-limit 8192 `
  --checkpoint-log2 4 `
  --work-directory benchmark/work/pattern-dictionary-clic
```

Use `--checkpoint-log2 6` to reproduce the compression-ceiling table.

## Limitations and next experiments

- BPDI is an experimental side format and is not yet wired into the browser
  download and viewer UI.
- The coordinate accessor supports the explicit palettes written by the
  current encoder. It deliberately rejects legacy vector-palette BPAL files.
- The current farthest-pattern dictionary is inexpensive and deterministic,
  but is not globally optimal. K-modes refinement and tile-specific
  dictionaries may improve photographs.
- Encoder-side transform search evaluates eight prototype orientations and is
  slower than BPDI v2. Decoding adds only a fixed coordinate transform and does
  not read neighboring blocks.
- The JavaScript reference accessor counts bitmap bits directly. A GPU decoder
  can process the same bounded mask with word-level population-count
  instructions.
- Run deltas follow raster order. A small set of scan orders or left/top index
  predictors may provide additional exact compression without sacrificing
  block-local random access.
- The WebGL2 helper is a tested reference path and is not yet connected to the
  cube/viewer resource loaders or benchmarked on discrete GPU hardware.
