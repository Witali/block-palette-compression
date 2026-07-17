# Shared JavaScript codec runtime

Browser pages must not carry page-specific copies of encoder algorithms. All
encoding pages create workers through `src/encoders/codec-encoder-runtime.js`,
which owns the single canonical worker entry point for each file format:

| Format | Canonical worker | Canonical encoder algorithm |
| --- | --- | --- |
| BPAL | `src/palette/block-palette-worker.js` | `src/palette/block-palette-codec.js` |
| DCTBS2 | `src/dct/dct-worker.js` | `src/dct/dct-format.js` |
| BPDH | `src/hybrid/bpdh-worker.js` | `src/hybrid/bpdh-codec.js` |

The BPAL worker selects either the CPU backend or the optional
`block-palette-webgl-accelerator.js` backend from the request settings. The
accelerator feeds the same `BlockPaletteCodec.compressImage` pipeline; it is
not a second BPAL worker, codec, or page-specific encoder.

BPDH reuses the canonical BPAL encoder directly. Its `dct420.js` dependency is
the deterministic fixed-point transform and decoder required by the BPDH v1
bitstream, not another DCTBS2 file encoder.

`tests/js-codec-runtime.test.js` guards these boundaries. It fails when a page
starts a format worker directly, when another public encoder implementation is
introduced, or when separate CPU and WebGL BPAL worker files reappear.
