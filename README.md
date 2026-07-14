# Block Palette Compression

An experimental browser codec for BPAL block-palette images. A BPAL image uses
one or more shared color palettes and a small table of palette-local color
indices in every block. Pixels store only indices into their block's table.

[Open the live demo on GitHub Pages.](https://witali.github.io/block-palette-compression/)

## How BPAL works

The image is split into fixed-size blocks. A pixel stores a compact local slot,
the block table maps that slot to an index in a shared image palette, and the
block's palette selector chooses which shared palette provides the final RGB
color. BPAL v5 supports 1, 2, 4, 8, 16, 32, 64, or 128 shared palettes, using
0 to 7 selector bits per block.

![BPAL indexing from image blocks to the final RGB color](./docs/images/bpal-double-indexing.svg)

The file uses a single tightly packed bitstream. Header fields, palette colors,
block-table indices, and pixel indices begin immediately after one another;
only the final byte may need zero padding.

![Tightly packed BPAL header and payload](./docs/images/bpal-bitstream-layout.svg)

## Multi-palette BPAL v5

The multi-palette encoder groups blocks by content before quantizing their
colors. Each block is described by the mean and standard deviation of its
colors in RGB or OKLab, deterministic clustering assigns the block to one of
the requested palettes, and every cluster receives its own explicitly stored
shared palette. A block then stores a `log2(palette count)`-bit selector in
addition to its local color table, while pixels keep the same compact local
indices as in the single-palette format.

BPAL v5 extends this model to 1, 2, 4, 8, 16, 32, 64, or 128 shared palettes. The
encoder UI exposes the palette count, reports clustering and palette-building
progress, and shows all reconstructed palettes. BPAL/BPLM serialization, the
viewer, mip generation, the WebGL cube demos, and the compact WebGL2 shader
path all preserve the per-block palette selectors. Decoders remain compatible
with BPAL v1-v4.

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

The project contains:

- [`block-palette.html`](https://witali.github.io/block-palette-compression/block-palette.html) — CPU/WebGL2 encoder, preview,
  settings search, PNG export, and BPAL download;
- [`bpal-viewer.html`](https://witali.github.io/block-palette-compression/bpal-viewer.html) — BPAL and regular image viewer;
- [`cube.html`](https://witali.github.io/block-palette-compression/cube.html) — WebGL cube with optional BPAL double indexing in
  the fragment shader;
- [`cube-bpal-sampler.html`](https://witali.github.io/block-palette-compression/cube-bpal-sampler.html) — programmable BPAL
  mipmapping with nearest, bilinear, trilinear, and anisotropic filtering.

Detailed documentation:

- [codec and implementation](./BLOCK_PALETTE_README.md)
  ([Russian](./BLOCK_PALETTE_README_ru.md));
- [BPAL v5 file format](./BLOCK_PALETTE_FORMAT.md)
  ([Russian](./BLOCK_PALETTE_FORMAT_ru.md));
- [standalone BPAL v5 C/SIMD encoder and decoder](./native/bpal5_simd/README.md);
- [reproducible BPAL/BC/ASTC texture codec benchmark](./benchmark/README.md).

## Run

Node.js is the only requirement. No package installation is needed.

```powershell
npm start
```

Open <http://127.0.0.1:8000/>.

`npm start` regenerates `assets/bpal/manifest.json` from the bundled `.bpal`
and `.bplm` files before starting the server. The GitHub Pages workflow runs
the same generator before uploading the site artifact, so the viewer catalog
does not need to be maintained by hand.

## Install as an app

The GitHub Pages site is an installable Progressive Web App. Supporting
browsers can install it from their address bar or application menu. The app
shell is available offline after the service worker finishes installing;
large images and BPAL/BPLM examples are cached only after they are opened.

HTML navigations use the network first so deployments remain fresh, with a
cached page as the offline fallback. Static resources return from the cache
immediately and are refreshed in the background.

When installed by a Chromium-based desktop browser, the PWA registers as a
handler for `.bpal` and `.bplm` files. Opening either file type from the
operating system launches BPAL Viewer and passes the selected file to it. On
platforms without the File Handling API, the viewer's file picker and drag and
drop support remain available.

## Test

```powershell
npm test
```

The tests cover palette quantization, block encoding, tightly packed BPAL
files, legacy format compatibility, texture atlas decoding, settings search,
and WebGL2 fallback behavior.
