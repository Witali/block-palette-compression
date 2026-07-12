# Block Palette Compression

An experimental browser codec for BPAL block-palette images. A BPAL image uses
one shared color palette and a small table of shared-palette indices in every
block. Pixels store only indices into their block's local table.

[Open the live demo on GitHub Pages.](https://witali.github.io/block-palette-compression/)

## How BPAL works

The image is split into fixed-size blocks. A pixel stores a compact local slot,
the block table maps that slot to an index in the shared image palette, and the
shared palette provides the final RGB color.

![BPAL double indexing from image blocks to the final RGB color](./docs/images/bpal-double-indexing.svg)

The file uses a single tightly packed bitstream. Header fields, palette colors,
block-table indices, and pixel indices begin immediately after one another;
only the final byte may need zero padding.

![Tightly packed BPAL v3 header and payload](./docs/images/bpal-bitstream-layout.svg)

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
- [BPAL v3 file format](./BLOCK_PALETTE_FORMAT.md)
  ([Russian](./BLOCK_PALETTE_FORMAT_ru.md));
- [reproducible BPAL/BC/ASTC texture codec benchmark](./benchmark/README.md).

## Run

Node.js is the only requirement. No package installation is needed.

```powershell
npm start
```

Open <http://127.0.0.1:8000/>.

## Test

```powershell
npm test
```

The tests cover palette quantization, block encoding, tightly packed BPAL
files, legacy format compatibility, texture atlas decoding, settings search,
and WebGL2 fallback behavior.
