# DCTBS2 command-line interface

`tools/dctbs2-cli.js` is the canonical command-line encoder. It requires
`src/dct/dct-format.js` directly instead of maintaining a second JavaScript
implementation. The web worker and CLI therefore use the same coefficient
selection, quantization, adaptive Y/C allocation, packing, prototype-library,
quality-search, JPEG DCT import, decoding, and coordinate-sampling code.

Run it through npm:

```powershell
npm run dct -- encode input.jpg output.dctbs2 `
  --preset 3 --quality 72 --component-budget fast

npm run dct -- decode output.dctbs2 preview.ppm
npm run dct -- info output.dctbs2
npm run dct -- pixel output.dctbs2 24 18
```

The encoder accepts JPEG, binary PPM P6, raw RGB24, and raw RGBA32. Raw input
requires `--width` and `--height`. Direct JPEG coefficient transfer is enabled
for JPEG input by default and falls back to the shared transform path when the
source sampling or selected DCTBS2 mode cannot be mapped directly. Disable it
with `--no-jpeg-dct-import` to encode the reconstructed RGB image instead.

Automatic quality selection uses the same search as the web page:

```powershell
npm run dct -- encode input.ppm output.dctbs2 `
  --preset 2 --auto-quality --component-budget expanded --progress
```

Every encoder allocation reserves at least 8 bytes separately for Cb and Cr.
The 0.75 bpp preset therefore uses `Y8 + Cb8 + Cr8`; larger presets keep their
existing total MCU size while adaptive candidates may redistribute the rest.

Prototype-library encoding exposes every setting supported by the shared
codec:

```powershell
npm run dct -- encode input.ppm output.dctbs2 `
  --preset 3 --quality 80 --dct-library `
  --library-size 32 --library-components y `
  --library-reference-coding sidecar `
  --library-frequency-split 0.25 `
  --library-cluster-samples 4096 --library-candidate-count 4
```

Use `npm run dct -- --help` for the complete option list. `--json` provides
machine-readable output for automation.

The native CUDA utility remains an accelerated backend for its supported
fixed-record operations. It is tested for file compatibility, but the
JavaScript CLI is the authoritative full-feature command-line frontend because
it cannot drift from the web implementation.
