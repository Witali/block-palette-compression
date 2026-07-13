# BPAL v4

[Russian version](./BLOCK_PALETTE_FORMAT_ru.md)

`BPAL` is a compact block-palette image format. All multibit values are written
from the most significant bit to the least significant bit. Version 4 supports
1, 2, 4, or 8 explicit shared palettes. Every image block selects one shared
palette and stores a small table of indices local to that palette.

The decoder remains compatible with BPAL v1-v3 files and their legacy vector
palette model. The v4 encoder always writes explicit palettes.

## v4 header

The first 4 bytes are the ASCII magic value `BPAL`. They are followed by an
80-bit header field:

| Bit offset | Size | Value |
| ---: | ---: | --- |
| 0 | 4 | Format version; `4` for v4 |
| 4 | 24 | Width minus 1 |
| 28 | 24 | Height minus 1 |
| 52 | 3 | `log2(block size) - 1` |
| 55 | 2 | `log2(colors per block) - 1` |
| 57 | 4 | `log2(colors per shared palette) - 1` |
| 61 | 1 | Color format: `0` for RGB565, `1` for RGB888 |
| 62 | 1 | Palette model: `0` for explicit, `1` for the legacy vector model |
| 63 | 9 | Zero in new files; vector count minus 1 in the legacy model |
| 72 | 1 | Zero in new files; legacy model space: `0` for RGB, `1` for OKLab |
| 73 | 2 | `log2(shared palette count)`: `0`, `1`, `2`, or `3` |
| 75 | 5 | Reserved; zero in v4 |

The complete v4 service header is 14 bytes: 4 magic bytes and 10 bytes of bit
fields.

## Payload

Let `P` be the shared-palette count, `G` the color count in each shared
palette, and `L` the local color count in each block. The following sections
are written immediately after the header without intermediate alignment:

1. `P × G` colors, grouped by shared-palette index. Each color uses 16 or 24
   bits. Legacy vector files instead store the start and end color of each
   vector.
2. One shared-palette selector for every block in block-row order. A selector
   uses `log2(P)` bits; this section has zero bits when `P = 1`.
3. The `L` palette-local color indices of every block, in block-row order. Each
   index uses `log2(G)` bits.
4. One local block-table index for every pixel in image-row order. Each index
   uses `log2(L)` bits.

For block `b` and pixel local slot `i`, the final color index in the flattened
palette array is:

```text
blockSelector[b] × G + blockPalette[b × L + i]
```

If `B` is the number of blocks, `N` the number of pixels, and `C` the bits per
stored color, the payload length before final padding is:

```text
P × G × C + B × log2(P) + B × L × log2(G) + N × log2(L)
```

Only the final byte of the file is padded with zero bits when necessary. The
alpha channel is not stored; the decoded image is treated as fully opaque.

## Legacy compatibility

BPAL v1-v3 files implicitly contain one shared palette, so their selector width
is zero. The v1 header after the magic value is 64 bits long. The v2 and v3
headers are 80 bits long; v3 adds the vector color-space bit at offset 72.

Legacy vector-palette colors are reconstructed by linear interpolation in the
RGB or OKLab space recorded in the header. The vector model is only valid with
one shared palette.
