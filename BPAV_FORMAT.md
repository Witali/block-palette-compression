# BPAV adaptive-block format

BPAV v1 is an experimental random-access side format for BPAL images. It lets
each 64x64 supertile select a 4x4, 8x8, 16x16, or 32x32 block layout while
retaining deterministic constant-time sampling by pixel coordinate.

The format is intended for offline encoding and GPU sampling. It does not use
trees, references to neighboring blocks, entropy streams, or data-dependent
loops.

## File layout

All integer header and directory fields are little-endian. Palette, block, and
pixel fields use the same most-significant-bit-first packing as BPAL v5. The
complete file is padded with zero bytes to a four-byte boundary.

| Section | Size |
| --- | ---: |
| Header | 32 bytes |
| Mode palettes | one `paletteCount * globalColorCount` table per used mode, section aligned to four bytes |
| Supertile directory | 4 bytes per 64x64 supertile |
| Block descriptors | byte-aligned stream per supertile |
| Pixel indices | dense raster stream |
| GPU padding | 0-3 zero bytes |

Each directory word stores the two-bit block-size mode in its high bits and a
30-bit byte offset into the block-descriptor stream in its low bits. A block
descriptor contains its shared-palette selector followed by its local palette's
global indices. Pixel indices remain dense and directly addressable by
`y * width + x`.

The header is:

| Offset | Type | Meaning |
| ---: | --- | --- |
| 0 | 4 bytes | `BPAV` magic |
| 4 | u8 | version (`1`) |
| 5 | u8 | supertile exponent (`6`) |
| 6 | u8 | local-index bits |
| 7 | u8 | global-index bits |
| 8 | u8 | palette-selector bits |
| 9 | u8 | palette color bits (`16` or `24`) |
| 10 | u8 | used-mode mask: B4, B8, B16, B32 |
| 11 | u8 | flags, currently zero |
| 12 | u32 | width |
| 16 | u32 | height |
| 20 | u32 | block-stream bytes |
| 24 | u32 | unpadded file bytes |
| 28 | u32 | reserved, currently zero |

## Coordinate lookup

Given integer `(x, y)`, a decoder performs these operations:

1. Calculate `tile = (y >> 6) * tilesX + (x >> 6)` and load its directory word.
2. Extract the block-size mode and block-stream byte offset.
3. Calculate the block number inside the supertile directly from `(x, y)`.
4. Load the dense pixel index and the selected block descriptor fields.
5. Load the color from the palette table belonging to the selected mode.

The operation count is independent of image content. The generic implementation
in `src/palette/adaptive-block-format.js` exposes `getPixel(x, y)`.
`src/palette/adaptive-block-webgl2.js` is the production WebGL2 path: it uploads
the aligned file as one `R32UI` word atlas, binds the parsed section offsets as
uniforms, and provides the GLSL ES 3.00 `bpavSample(ivec2)` helper. Packed fields
use one aligned word load, or two only when crossing a 32-bit boundary. The
fixed upper bound is eight word reads per pixel. Header values and section
offsets are uniforms and are not counted per pixel.

An encoder must keep legacy uniform BPAL when BPAV does not improve the chosen
rate-distortion point. The extra mode palettes make BPAV most useful for large
textures containing both smooth and detailed regions; it is generally not
beneficial for small images.
