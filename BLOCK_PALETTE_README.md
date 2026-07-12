# Block-palette image compression

[Russian version](./BLOCK_PALETTE_README_ru.md)

This project implements an experimental codec that combines one shared image
palette with a small local palette in every rectangular block. The interactive
version is available on [`block-palette.html`](./block-palette.html).

The codec is intended for exploring the tradeoff between size, quality, and
decoding cost. The result can be saved in the compact custom BPAL format or
exported as a regular PNG for comparison.

By default, the page uses 8×8 blocks, eight colors per block, and a shared
256-color palette. This is a quality-oriented profile.

## Codec concept

The image is divided into blocks of 4×4, 8×8, 16×16, 32×32, or 64×64 pixels.
One shared palette is built for the entire image, while each block stores only
a small number of indices into it. Every pixel then references a color in its
block's local palette.

For example, with four colors per block:

- a pixel's local index occupies 2 bits;
- the block stores four indices into the shared palette;
- with a 256-color shared palette, each such index occupies 8 bits.

Supported settings:

| Parameter | Values |
| --- | --- |
| Block size | 4, 8, 16, 32, or 64 pixels |
| Colors per block | 2, 4, 8, or 16 |
| Shared palette colors | 8, 16, 32, 64, 128, 256, 1024, or 4096 |
| Color format | RGB565, 16 bits; RGB888, 24 bits |
| Search color space | OKLab or RGB |
| Clustering method | K-means, uniformly initialized K-means, or K-medians |
| Dithering | none, Bayer 2×2, Bayer 4×4, or Floyd–Steinberg |
| Execution | CPU or WebGL2 |

## Size calculation

Let:

- `W`, `H` be the image width and height;
- `S` be the block size;
- `L` be the local palette color count;
- `G` be the shared palette color count;
- `C` be 16 or 24 bits per color.

The payload then consists of three parts:

```text
shared palette = G × C bits

block palettes = ceil(W / S) × ceil(H / S) × L × log2(G) bits
pixels = W × H × log2(L) bits
```

The 14-byte BPAL v3 header is added to this sum. The sections are written as a
single bitstream without byte alignment; only the final byte of the file is
padded with zeros.

The page shows the size of every section, the effective number of bits per
pixel, the ratio to uncompressed RGB, and RMSE per color channel.

## Building the shared palette

Every shared-palette color is stored explicitly. Colors are selected by
weighted clustering in RGB or OKLab. The **Accuracy — diversity** slider changes
the weight of rare colors: toward accuracy, average error has more influence;
toward diversity, rare hues receive more influence.

Regular K-means assigns colors using squared Euclidean distance and recomputes
each center as a weighted mean. The uniformly initialized variant places the
initial points on a uniform three-dimensional grid within the image's color
range in the selected space, then snaps them to the nearest distinct source
colors. After initialization, it behaves like regular K-means. K-medians uses
Manhattan (`L1`) distance and independently recomputes each of the center's
three coordinates as a weighted median. Regular K-means remains the default.

For large images, the shared palette is built from a uniform sample of at most
32,768 opaque pixels.

## Selecting block colors

For every block, the codec chooses `L` indices from the shared palette. The
selection considers both color frequency and the total error across all pixels
in the block. This reduces visible steps along high-contrast boundaries, where
a rare but important shade might otherwise be omitted from the local palette.

The error is calculated from the mean coordinates of each source-pixel color
group in the selected space, rather than from already rounded shared-palette
colors. After the initial selection, the codec refines the continuous centers
of the color groups, checks nearby shared-palette colors, and performs up to
four replacements when they reproduce the original block more accurately.
Consequently, a local palette can contain a compromise shade that was not the
nearest color for any individual pixel but reduces the block's total error.

If direct pixel matching used fewer than `L` colors, the remaining entries are
not duplicated. The codec fills them with distinct nearby shared-palette colors
based on the source colors in that block, distributing the additional entries
among its color groups according to their frequency.

After the local palette is selected, every pixel is replaced by its nearest
color in the selected color space.

With the default profile, the bundled images produce the following RMSE per
channel. The CPU and WebGL2 implementations produce identical values:

| Image | RMSE |
| --- | ---: |
| `stone-texture-small.jpg` | 5.86 |
| `landscape-alaska.jpg` | 4.07 |
| `clipart-apple.jpg` | 4.08 |

## Dithering

Bayer 2×2 and Bayer 4×4 apply ordered threshold patterns. The Floyd–Steinberg
implementation diffuses error only within the current block. Error does not
cross a boundary because the neighboring block has a different local palette;
carrying error between such palettes produced large rectangular artifacts.

## CPU and WebGL2

The CPU implementation runs the entire pipeline in a background Worker. The
WebGL2 variant parallelizes shared-palette pixel assignment and final block
encoding in fragment shaders. Palette construction and local-color selection
remain on the CPU.

Floyd–Steinberg depends on previously processed neighboring pixels, so in this
mode WebGL2 accelerates the independent stages while error diffusion runs on
the CPU. If `OffscreenCanvas` or WebGL2 is unavailable, or the image exceeds
GPU limits, the codec automatically falls back to the CPU.

## Automatic settings search

The **Find settings** button builds a reduced copy of the image and tests 20
predefined combinations of block, local-palette, and shared-palette settings.
BPAL size and RMSE are measured for every candidate.

Settings that are simultaneously worse than another candidate in both size and
error are removed. A balanced point is selected from the remaining Pareto
front, and the full image is then encoded with those settings. The selected
clustering method, color space, and dithering mode remain unchanged during the
search.

## Preview and comparison

The page shows the source and reconstructed images side by side. Their
viewports scroll in sync. Holding `Ctrl` while turning the mouse wheel changes
the zoom of both images simultaneously. The block grid can be disabled, and
clicking the result displays the selected block's local palette and its mapping
to the shared palette.

The page also displays:

- the shared palette exactly as reconstructed;
- local and shared color indices;
- processing time and the stages that were actually accelerated;
- the complete size calculation for the resulting BPAL file.

## BPAL sampler for 3D

The separate [`cube-bpal-sampler.html`](./cube-bpal-sampler.html) page uploads
BPAL as a set of indexed GPU atlases and reconstructs colors in the fragment
shader. During upload, it builds up to 16 independent mip levels for the source
image. Every level has its own local block palettes but uses the original BPAL
shared palette.

The page provides four rendering modes:

- nearest texel and nearest mip level;
- bilinear filtering of the selected mip level;
- trilinear blending of two adjacent mip levels;
- limited 2×, 4×, or 8× anisotropic filtering.

LOD is calculated in the fragment shader from the texture-coordinate `dFdx`
and `dFdy` values. Before interpolation, palette colors are converted from sRGB
to linear RGB; after lighting, the result is encoded back to sRGB. A bilinear
sample decodes four BPAL texels and a trilinear sample decodes eight, so the
anisotropic mode is considerably more expensive and is intended primarily for
quality and performance evaluation.

## BPAL format

BPAL v3 begins with the `BPAL` magic value and a version number. Header bit
fields contain the image dimensions, block parameters, index widths, and color
format. New files store the shared palette explicitly. For compatibility, the
decoder continues to read BPAL v1 files and BPAL v2/v3 vector palettes.

The exact header and payload layouts are documented in
[`BLOCK_PALETTE_FORMAT.md`](./BLOCK_PALETTE_FORMAT.md).

BPAL does not store an alpha channel: the decoded image is treated as fully
opaque.

## Running the demo

The page requires a local HTTP server because images and Worker scripts are
loaded through `fetch()`:

```powershell
python -m http.server 8000
```

Then open:

```text
http://127.0.0.1:8000/block-palette.html
```

Run the automated tests with:

```powershell
npm test
```

The tests cover bit-layout calculations, block and palette sizes, RGB565,
dithering, per-block Floyd–Steinberg isolation, BPAL v1/v2/v3 compatibility,
the optimizer, and WebGL2-to-CPU fallback.

## Main files

- [`block-palette.html`](./block-palette.html) — experiment interface;
- [`cube-bpal-sampler.html`](./cube-bpal-sampler.html) — 3D demonstration of
  programmable BPAL mipmapping and filtering;
- [`src/pages/block-palette-page.js`](./src/pages/block-palette-page.js) — page
  and preview controls;
- [`src/palette/block-palette-codec.js`](./src/palette/block-palette-codec.js) —
  main CPU codec;
- [`src/palette/block-palette-webgl-codec.js`](./src/palette/block-palette-webgl-codec.js) —
  WebGL2 acceleration;
- [`src/palette/block-palette-format.js`](./src/palette/block-palette-format.js) —
  BPAL reading and writing;
- [`src/palette/block-palette-optimizer.js`](./src/palette/block-palette-optimizer.js) —
  Pareto-front settings search;
- [`tests/block-palette-codec.test.js`](./tests/block-palette-codec.test.js) and
  adjacent tests — automated codec verification.
