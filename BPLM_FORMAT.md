# BPLM v1 file format

BPLM stores a complete BPAL base image and a precomputed mip chain. All levels
share the 1, 2, 4, 8, 16, 32, or 64 palettes embedded in the base BPAL stream.

All multi-byte integers in BPLM headers are unsigned and little-endian. Index
payloads are packed most-significant bit first, as in BPAL.

## Container header (12 bytes)

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 4 | ASCII magic `BPLM` |
| 4 | 1 | Version (`1`) |
| 5 | 1 | Mip count, including the base image |
| 6 | 2 | Reserved, must be zero |
| 8 | 4 | Embedded BPAL byte length |

The header is followed by one complete BPAL file. Its palettes, dimensions,
index widths, and base-level data define the whole BPLM image. Current encoders
write BPAL v5; readers also accept embedded BPAL v1-v4 data.

## Additional mip levels

Each additional level starts with a 16-byte header:

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 4 | Width |
| 4 | 4 | Height |
| 8 | 2 | Block size |
| 10 | 2 | Reserved, must be zero |
| 12 | 4 | Packed payload byte length |

Width and height are each halved from the preceding level, with a minimum of
one pixel. Block size is also halved, down to `1×1`.

For a regular level, the number of local block colors is:

```text
min(base local color count, block size × block size)
```

Its payload contains, without intermediate alignment:

1. one shared-palette selector per block, using `log2(shared palette count)`
   bits;
2. the palette-local color indices of every block table;
3. the local block-table index of every pixel.

When the local color count equals the number of pixels in a block, local
indexing cannot reduce storage. Such a level is stored in direct mode: every
pixel stores one absolute index into the flattened shared palettes. Its width
is `log2(shared palette count) + log2(colors per shared palette)` bits.

With one shared palette the selector width is zero, so both regular and direct
payloads are byte-for-byte compatible with the original BPLM v1 layout. The
BPLM container version therefore remains `1`.
