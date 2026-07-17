# BPAL v5

[Russian version](./BLOCK_PALETTE_FORMAT_ru.md)

`BPAL` is a compact block-palette image format. All multibit values are written
from the most significant bit to the least significant bit. Version 5 supports
1, 2, 4, 8, 16, 32, 64, or 128 explicit shared palettes. Every image block
selects one shared palette and stores a small table of indices local to that
palette.

Each shared palette contains 2–256 power-of-two colors. Header encodings above
256 colors are invalid and must be rejected by current encoders and decoders.

The decoder accepts BPAL v5 files only. The image compressor writes explicit
palettes; the v5 vector-palette model remains readable.

## v5 header

The first 4 bytes are the ASCII magic value `BPAL`. They are followed by an
80-bit header field:

| Bit offset | Size | Value |
| ---: | ---: | --- |
| 0 | 4 | Format version; `5` for v5 |
| 4 | 24 | Width minus 1 |
| 28 | 24 | Height minus 1 |
| 52 | 3 | `log2(block size) - 1` |
| 55 | 2 | `log2(colors per block) - 1` |
| 57 | 4 | `log2(colors per shared palette) - 1` |
| 61 | 1 | Color format: `0` for RGB565, `1` for RGB888 |
| 62 | 1 | Palette model: `0` for explicit, `1` for the legacy vector model |
| 63 | 9 | Zero in new files; vector count minus 1 in the legacy model |
| 72 | 1 | Zero in new files; legacy model space: `0` for RGB, `1` for OKLab |
| 73 | 3 | `log2(shared palette count)`: from `0` through `7` |
| 76 | 2 | Channel mode: `0` for RGB, `1` for scalar8 |
| 78 | 2 | Flags; bit 0 enables independently packed explicit RGB palettes |

The complete v5 service header is 14 bytes: 4 magic bytes and 10 bytes of bit
fields. The value `7` represents 128 palettes and uses the last available
encoding of the existing 3-bit field; it does not enlarge the header.

Decoders reject unsupported channel-mode or flag values instead of interpreting
the payload incorrectly.

## Payload

Let `P` be the shared-palette count, `G` the color count in each shared
palette, and `L` the local color count in each block. The following sections
are written immediately after the header without intermediate alignment:

1. `P × G` colors, grouped by shared-palette index. Each RGB color uses 16 or
   24 bits. Each scalar8 entry uses 8 bits and is replicated to RGB during
   decode. Legacy vector files instead store the start and end color of each
   vector.
2. One shared-palette selector for every block in block-row order. A selector
   uses `log2(P)` bits; this section has zero bits when `P = 1`.
3. The `L` palette-local color indices of every block, in block-row order. Each
   index uses `log2(G)` bits.
4. When `L` is smaller than the number of pixels in a block, one local
   block-table index for every pixel in image-row order. Each index uses
   `log2(L)` bits. When `L` equals `blockSize²`, this section is omitted and
   block-table entry `localY × blockSize + localX` directly represents that
   pixel position.

Direct mapping has no separate header flag; the decoder derives it solely from
the block size and local color count.

For block `b` and pixel local slot `i`, the final color index in the flattened
palette array is:

```text
blockSelector[b] × G + blockPalette[b × L + i]
```

If `B` is the number of blocks, `N` the number of pixels, and `C` the bits per
stored color, the payload length before final padding is:

```text
P × G × C + B × log2(P) + B × L × log2(G)
  + (L = blockSize² ? 0 : N × log2(L))
```

Only the final byte of the file is padded with zero bits when necessary. The
alpha channel is not stored; the decoded image is treated as fully opaque.

## Independently packed explicit palettes

When header flag bit 0 is set, the raw explicit RGB palette array is replaced
by a byte-aligned palette section. The remaining selector, block-table, and
pixel sections start at the first byte after this section and retain their
existing fixed-width bit layout. Scalar8 palettes are already compact and
never use packed RGB records.

The packed section contains:

1. Its complete byte length as a 32-bit big-endian integer.
2. One 32-bit big-endian record offset for every shared palette. Offsets are
   relative to the first palette record.
3. `P` independent, byte-aligned palette records.

A record whose first byte is zero stores `G` raw RGB565 or RGB888 colors after
that byte. A delta record has this five-byte header:

| Byte | Value |
| ---: | --- |
| 0 | `0x80 | redResidualBits` |
| 1 | `greenResidualBits << 4 | blueResidualBits` |
| 2 | Red base |
| 3 | Green base |
| 4 | Blue base |

Each residual width is from 0 through 8. The header is followed by `G` RGB
residual triplets in palette-index order, packed most-significant bit first.
Each reconstructed channel is simply `base + residual`. A record ends at the
next byte boundary.

The encoder chooses raw or delta storage independently for every palette, then
uses the complete packed section only when it is smaller than the legacy raw
palette array after including the section length, directory, record tags, and
byte padding. Palette packing is therefore lossless and cannot enlarge a file.

For random access, a decoder reads the block selector and local/global indices
as before, then uses one directory entry to locate the selected palette record.
No previous block or palette must be decoded. The delta path uses only bounded
integer bit reads, masks, shifts, and additions, which maps directly to a GPU
shader or CUDA kernel.

## Vector palettes

Vector-palette colors are reconstructed by linear interpolation in the RGB or
OKLab space recorded in the v5 header. The vector model is only valid with one
shared palette.
