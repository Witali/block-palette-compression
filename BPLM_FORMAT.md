# BPLM v1 file format

BPLM stores a BPAL base image and a precomputed mip chain. All levels use the
single global palette embedded in the base BPAL stream.

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

The header is followed by one complete BPAL v3 file. Its palette, dimensions,
index widths, and base-level data define the whole BPLM image.

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

Its payload contains the packed global-palette indices of every block palette,
followed by packed local indices for every pixel.

When the local color count equals the number of pixels in a block, local
indexing cannot reduce storage. Such a level is stored in direct mode: its
payload contains only one packed global-palette index per pixel. This always
applies to `1×1` blocks and can apply earlier, for example to a `2×2` block
with four available colors.
