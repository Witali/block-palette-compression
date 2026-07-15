# Block Palette Compression

An experimental browser codec for BPAL block-palette images. A BPAL image uses
one or more shared color palettes and a small table of palette-local color
indices in every block. Pixels normally store indices into their block's table;
the indices are omitted when table entries map one-to-one to pixel positions.

[Open the live demo on GitHub Pages.](https://witali.github.io/block-palette-compression/)

## How BPAL works

The image is split into fixed-size blocks. Normally a pixel stores a compact
local slot, the block table maps that slot to an index in a shared image
palette, and the block's palette selector chooses which shared palette
provides the final RGB color. When the block has one color entry per pixel,
the table entries map directly to pixel positions and pixel indices are
omitted. BPAL v5 supports 1, 2, 4, 8, 16, 32, 64, or 128 shared palettes, using
0 to 7 selector bits per block.

![BPAL indexing from image blocks to the final RGB color](./docs/images/bpal-double-indexing.svg)

The file uses a single tightly packed bitstream. Header fields, palette colors,
block-table indices, and optional pixel indices begin immediately after one
another; only the final byte may need zero padding.

![Tightly packed BPAL header and payload](./docs/images/bpal-bitstream-layout.svg)

## Multi-palette BPAL v5

The multi-palette encoder groups blocks by content before quantizing their
colors. Each block is described by the mean and standard deviation of its
colors in RGB or OKLab, deterministic clustering assigns the block to one of
the requested palettes, and every cluster receives its own explicitly stored
shared palette. A block then stores a `log2(palette count)`-bit selector in
addition to its local color table, while pixels keep the same compact local
indices as in the single-palette format unless direct block colors apply.

BPAL v5 extends this model to 1, 2, 4, 8, 16, 32, 64, or 128 shared palettes. The
encoder UI exposes the palette count, reports clustering and palette-building
progress, and shows all reconstructed palettes. BPAL/BPLM serialization, the
viewer, mip generation, the WebGL cube demos, and the compact WebGL2 shader
path all preserve the per-block palette selectors. Decoders accept BPAL v5.

The bundled [32-palette landscape BPLM sample](./assets/bpal/landscape-alaska-bpal-v5.bplm)
uses BPAL v5 with 32 colors per shared palette, 8 local colors per 16x16 block,
and 11 stored mip levels. See the [multi-palette compressor screenshot](./docs/images/block-palette-html-2026-07-13-13_29_15.png)
for the encoded image, storage breakdown, selected block, and reconstructed
shared palettes.

## Iterative encoder refinement

After the initial block encoding, the CPU encoder performs up to four
rate-distortion refinement passes. Each pass moves every used shared-palette
color to the RGB mean of the source pixels that currently reference it, then
reselects the block-local colors and pixel indices. A candidate pass is kept
only when it reduces exact RGB mean squared error, and refinement stops early
after convergence. This changes encoding time and reconstructed quality but
does not add fields or bits to BPAL/BPLM files and does not affect decoding.
The compressor UI lets users select zero to four passes and defaults to one.

## Hybrid BPAL/DCT mode

The experimental BPDH v1 codec selects BPAL or 4:2:0 DCT independently for
each `16x16` coding unit. Its encoder evaluates real serialized rate and exact
decoded RGB squared error, then searches the supported rate-distortion mode
assignments at the requested payload bpp. Pure BPAL and pure DCT candidates
remain available when mixed-mode signaling is not worthwhile.

BPDH stores only the BPAL and DCT records selected by the mode map. DCT units
use absolute DC coefficients, fixed quantization tables, and deterministic
fixed-point reconstruction. `sampleBpdhPixel(decoded, x, y)` obtains a pixel
from its coding unit without depending on neighboring units or decode order.

![Hybrid BPAL/DCT compression page at a 1 bpp payload target](./docs/images/bpdh-hybrid-compression-page.png)

The Node.js API separates compression from serialization:

```js
const { compressHybridImage } = require("./src/hybrid/bpdh-codec.js");
const {
  encodeBpdhFile,
  decodeBpdhFile,
  sampleBpdhPixel,
} = require("./src/hybrid/bpdh-format.js");

const image = compressHybridImage(rgba, width, height, {
  mode: "auto",
  targetBitsPerPixel: 4,
});
const file = encodeBpdhFile(image);
const decoded = decodeBpdhFile(file);
const color = sampleBpdhPixel(decoded, x, y);
```

`tools/benchmark_bpdh_adapter.js` exposes matching raw-RGBA encode and decode
commands for benchmark automation.

The project contains:

- [`block-palette.html`](https://witali.github.io/block-palette-compression/block-palette.html) — CPU/WebGL2 encoder, preview,
  settings search, PNG export, and BPAL download;
- [`bpdh.html`](https://witali.github.io/block-palette-compression/bpdh.html) — hybrid BPAL/DCT encoder, mode-map preview,
  coordinate decoder, PNG export, and BPDH download;
- [`bpal-viewer.html`](https://witali.github.io/block-palette-compression/bpal-viewer.html) — BPAL, BPLM, BPDH, and regular image viewer;
- [`cube.html`](https://witali.github.io/block-palette-compression/cube.html) — WebGL cube with optional BPAL double indexing in
  the fragment shader;
- [`cube-bpal-sampler.html`](https://witali.github.io/block-palette-compression/cube-bpal-sampler.html) — programmable BPAL
  mipmapping with nearest, bilinear, trilinear, and anisotropic filtering.

Detailed documentation:

- [dependency setup](./docs/SETUP.md);
- [codec and implementation](./BLOCK_PALETTE_README.md)
  ([Russian](./BLOCK_PALETTE_README_ru.md));
- [BPAL v5 file format](./BLOCK_PALETTE_FORMAT.md)
  ([Russian](./BLOCK_PALETTE_FORMAT_ru.md));
- [BPDH v1 hybrid BPAL/DCT format](./BPDH_FORMAT.md);
- [hybrid BPAL/DCT research and benchmark plan](./docs/HYBRID_BPAL_DCT_PLAN.md);
- [standalone BPAL v5 CPU/SIMD and CUDA tools](./native/bpal5_simd/README.md);
- [reproducible BPAL/BC/ASTC texture codec benchmark](./benchmark/README.md).

## Setup

On Windows, the setup script checks Node.js and downloads a SHA-256-verified,
project-local CUDA 13.3 developer toolchain without changing the NVIDIA display
driver or requiring administrator rights:

```powershell
.\setup.ps1
```

Use `-SkipCuda` for browser-only development or `-NoUserEnvironment` to avoid
persisting `CUDA_PATH` and `PATH`. See the [dependency setup guide](./docs/SETUP.md)
for prerequisites, downloaded components, all parameters, and CUDA validation.

## Run

Node.js is the only requirement. No package installation is needed.

```powershell
npm start
```

Open <http://127.0.0.1:8000/>.

`npm start` regenerates `assets/bpal/manifest.json` and
`assets/bpdh/manifest.json` from the bundled `.bpal`, `.bplm`, and `.bpdh`
files before starting the server. The GitHub Pages workflow runs the same
generator before uploading the site artifact, so neither Image Viewer catalog
needs to be maintained by hand.

## Install as an app

The GitHub Pages site is an installable Progressive Web App. Supporting
browsers can install it from their address bar or application menu. The app
shell is available offline after the service worker finishes installing;
large images and BPAL/BPLM/BPDH examples are cached only after they are opened.

HTML navigations use the network first so deployments remain fresh, with a
cached page as the offline fallback. Static resources return from the cache
immediately and are refreshed in the background.

When installed by a Chromium-based desktop browser, the PWA registers as a
handler for `.bpal`, `.bplm`, and `.bpdh` files. Opening any of these file types from the
operating system launches Image Viewer and passes the selected file to it. On
platforms without the File Handling API, the viewer's file picker and drag and
drop support remain available.

On Android, install the PWA in Chrome, select a `.bpal`, `.bplm`, or `.bpdh` file in the
system file manager, and share it with BPAL. The service worker receives the
Web Share Target POST request, stores the file temporarily, and opens it in
Image Viewer. GitHub Pages does not need a server-side POST endpoint.

## Test

```powershell
npm test
```

The tests cover palette quantization, block encoding, tightly packed BPAL
files, BPAL v5 format validation, texture atlas decoding, settings search,
and WebGL2 fallback behavior.
