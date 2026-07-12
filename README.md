# Block Palette Compression

An experimental browser codec for BPAL block-palette images. A BPAL image uses
one shared color palette and a small table of shared-palette indices in every
block. Pixels store only indices into their block's local table.

The project contains:

- [`block-palette.html`](./block-palette.html) — CPU/WebGL2 encoder, preview,
  settings search, PNG export, and BPAL download;
- [`bpal-viewer.html`](./bpal-viewer.html) — BPAL and regular image viewer;
- [`cube.html`](./cube.html) — WebGL cube with optional BPAL double indexing in
  the fragment shader;
- [`cube-bpal-sampler.html`](./cube-bpal-sampler.html) — programmable BPAL
  mipmapping with nearest, bilinear, trilinear, and anisotropic filtering.

Detailed documentation:

- [codec and implementation](./BLOCK_PALETTE_README.md)
  ([Russian](./BLOCK_PALETTE_README_ru.md));
- [BPAL v3 file format](./BLOCK_PALETTE_FORMAT.md)
  ([Russian](./BLOCK_PALETTE_FORMAT_ru.md)).

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
