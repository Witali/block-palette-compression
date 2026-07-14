# BPDI pattern-dictionary experiment

Research date: July 14, 2026.

## Conclusion

An exact pattern dictionary can reduce BPAL files while preserving every
decoded RGB value and retaining coordinate-level random access. Across all 42
images in the local CLIC 2020 Professional Validation corpus and three BPAL
presets, hybrid selection reduced the aggregate size by 5.97%. It selected
BPDI only when the candidate was smaller and retained BPAL otherwise, so none
of the 126 output files grew and the PSNR change was exactly 0.000 dB.

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

## Aggregate results

| Preset | Images | BPAL bytes | Best bytes | Change | Smaller files | Aggregate PSNR | PSNR change | Mean random access |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.5 | 42 | 16,452,505 | 14,833,299 | -9.84% | 31 | 26.713 dB | 0.000 dB | 583,097 pixels/s |
| 2.5 | 42 | 28,333,084 | 27,139,422 | -4.21% | 20 | 34.026 dB | 0.000 dB | 745,369 pixels/s |
| 4 | 42 | 45,328,451 | 42,764,594 | -5.66% | 27 | 37.977 dB | 0.000 dB | 579,046 pixels/s |
| **All** | **126** | **90,114,040** | **84,737,315** | **-5.97%** | **78** | — | **0.000 dB** | — |

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
- Random-access checkpoint interval: 64 blocks.
- Verification: 128 deterministic coordinate queries per image and preset,
  or 16,128 queries in total. Every returned RGBA pixel matched the BPAL
  baseline.
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
for every group of 64 blocks. To retrieve `(x, y)`, the accessor computes the
block number, reads its group checkpoint, scans at most 63 preceding tags, and
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
  --work-directory benchmark/work/pattern-dictionary-clic
```

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
- GPU sampling is not implemented for BPDI. A loader can either query BPDI
  directly or expand one requested tile into the existing BPAL index atlas;
  neither operation requires decoding the complete image.
