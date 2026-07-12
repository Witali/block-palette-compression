# BPAL v3

[Russian version](./BLOCK_PALETTE_FORMAT_ru.md)

`BPAL` is a compact block-palette image format. All multibit values are written
from the most significant bit to the least significant bit. The current encoder
stores the shared palette explicitly. The decoder also supports legacy vector
palettes and version 1 files.

## v3 header

The first 4 bytes are the ASCII magic value `BPAL`. They are followed by an
80-bit header field:

| Bit offset | Size | Value |
| ---: | ---: | --- |
| 0 | 4 | Format version; `3` for v3 |
| 4 | 24 | Width minus 1 |
| 28 | 24 | Height minus 1 |
| 52 | 3 | `log2(block size) - 1` |
| 55 | 2 | `log2(colors per block) - 1` |
| 57 | 4 | `log2(shared palette colors) - 1` |
| 61 | 1 | Color format: `0` for RGB565, `1` for RGB888 |
| 62 | 1 | Palette model: `0` for explicit, `1` for the legacy vector model |
| 63 | 9 | Zero in new files; vector count minus 1 in the legacy model |
| 72 | 1 | Zero in new files; legacy model space: `0` for RGB, `1` for OKLab |
| 73 | 7 | Reserved; zero in v3 |

The complete v3 service header is 14 bytes: 4 magic bytes and 10 bytes of bit
fields.

## Payload

The following sections are written immediately after the header without
intermediate alignment:

1. Every shared-palette color, using 16 or 24 bits per color. Legacy files with
   bit 62 set store the start and end color of each vector instead.
2. Block palettes in block row order. Each index uses
   `log2(shared palette color count)` bits.
3. Local indices for every pixel in image row order. Each index uses
   `log2(colors per block)` bits.

Legacy vector-palette colors are reconstructed by linear interpolation in the
RGB or OKLab space recorded in the header. Each vector first receives
`floor(color count / vector count)` colors, and the remainder is distributed
one at a time among the first vectors. Both endpoints are included in the
resulting sequence.

Only the final byte of the file is padded with zero bits when necessary. The
alpha channel is not stored; the decoded image is treated as fully opaque.

## v1 compatibility

The v1 header after the magic value is 64 bits long and ends with two zero
reserved bits. Version 1 always stores the palette explicitly. Its block-index
and pixel-index layouts match v2.

The v2 header is also 80 bits long, but its final 8 bits are reserved and zero.
Version 2 vector palettes are always interpolated in RGB. The v3 decoder can
read files produced by both earlier versions.
