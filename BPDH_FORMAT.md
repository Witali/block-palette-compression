# BPDH v1 hybrid BPAL/DCT format

`BPDH` stores opaque RGB images as independent `16x16` coding units. Every
unit selects either a sparse BPAL record or a JPEG-like 4:2:0 DCT record. All
multi-byte header integers are unsigned little-endian values. Packed payload
bits are written from most significant to least significant bit.

## Header

The fixed header is 48 bytes:

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 4 | ASCII magic `BPDH` |
| 4 | 1 | Version (`1`) |
| 5 | 1 | Mode flags: bit 0 BPAL present, bit 1 DCT present |
| 6 | 1 | Coding-unit exponent (`4`, meaning `16x16`) |
| 7 | 1 | Reserved; zero |
| 8 | 4 | Width |
| 12 | 4 | Height |
| 16 | 1 | `log2(local BPAL color count)` |
| 17 | 1 | `log2(colors per shared BPAL palette)` |
| 18 | 1 | `log2(shared BPAL palette count)` |
| 19 | 1 | Palette color width: `16` or `24` |
| 20 | 4 | Palette section byte length |
| 24 | 4 | Mode-map byte length |
| 28 | 4 | Sparse BPAL section byte length |
| 32 | 4 | Meaningful sparse BPAL bit length |
| 36 | 4 | Quantization-table byte length |
| 40 | 4 | DCT coefficient section byte length |
| 44 | 4 | Meaningful DCT coefficient bit length |

The sections follow in this order:

1. shared BPAL palette;
2. DCT quantization tables;
3. mode map;
4. sparse BPAL records;
5. sparse DCT records.

The BPAL and DCT bitstreams start at byte boundaries. Only the last byte of
each stream may contain zero padding.

## Modes

Mode `0` selects BPAL and mode `1` selects DCT. When both flags are set, the
mode map stores one bit per coding unit in raster order. When only one flag is
set, the map is omitted and every unit implicitly uses that mode.

The raw mixed-mode map costs `1/256 = 0.00390625 bpp` before edge padding.

## Sparse BPAL records

The palette section contains `P * G` RGB565 or RGB888 colors, where `P` is the
shared-palette count and `G` is the color count in each shared palette.

Only units whose mode is BPAL have a record. Each record contains:

1. one `log2(P)`-bit shared-palette selector;
2. `L` indices of `log2(G)` bits into that shared palette;
3. one `log2(L)`-bit local index for every real image pixel in the unit.

Edge units do not store indices for padded pixels. BPAL records are ordered by
their coding-unit raster position, skipping DCT units.

For image coordinate `(x, y)`, let `b` be its coding-unit index and `i` its
stored local index. The decoded palette entry is:

```text
palette[blockSelector[b] * G + blockPalette[b * L + i]]
```

## DCT records

The quantization-table section is present when any DCT unit exists. It contains
64 luma bytes followed by 64 chroma bytes in natural `8x8` order. Every entry
is nonzero.

A DCT unit contains six quantized `8x8` blocks:

1. Y at local `(0, 0)`;
2. Y at local `(8, 0)`;
3. Y at local `(0, 8)`;
4. Y at local `(8, 8)`;
5. one 4:2:0 Cb block;
6. one 4:2:0 Cr block.

Each coefficient block starts with an absolute signed DC coefficient. There is
no prediction from another coding unit. AC coefficients use JPEG zig-zag order.
For every nonzero AC coefficient the stream writes:

```text
0 bit, unsigned Exp-Golomb zero run, signed Exp-Golomb coefficient
```

One `1` bit terminates the block. Signed values map to unsigned values as
`1 -> 1`, `-1 -> 2`, `2 -> 3`, `-2 -> 4`, and so on. DCT records are ordered by
coding-unit raster position, skipping BPAL units.

## Deterministic pixel reconstruction

BPDH v1 defines integer reconstruction. A decoder must not calculate its basis
matrix with a platform `cos()` implementation. The normative matrix is
`round(C(u) * cos((2*x+1)*u*pi/16) * 16384)`:

```text
11585  16069  15137  13623  11585   9102   6270   3196
11585  13623   6270  -3196 -11585 -16069 -15137  -9102
11585   9102  -6270 -16069 -11585   3196  15137  13623
11585   3196 -15137  -9102  11585  13623  -6270 -16069
11585  -3196 -15137   9102  11585 -13623  -6270  16069
11585  -9102  -6270  16069 -11585  -3196  15137 -13623
11585 -13623   6270   3196 -11585  16069 -15137   9102
11585 -16069  15137 -13623  11585  -9102   6270  -3196
```

Define signed rounding division as:

```text
roundDivide(value, divisor) =
  floor((value + divisor/2) / divisor),                 value >= 0
  -floor((-value + divisor/2) / divisor),               value < 0
```

The inverse transform uses two passes. After multiplying a row by the matrix,
divide with `roundDivide(sum, 16384)`. After the column pass, divide with
`roundDivide(sum, 4 * 16384)` and add 128. Clamp every reconstructed component
sample to `0..255`.

4:2:0 samples are bilinearly reconstructed inside their own `16x16` coding
unit. The weights are integer quarters; interpolation never reads chroma from
a neighboring unit. YCbCr-to-RGB conversion uses scale 65536:

```text
R = Y + roundDivide( 91881 * (Cr - 128), 65536)
G = Y + roundDivide(-22554 * (Cb - 128) - 46802 * (Cr - 128), 65536)
B = Y + roundDivide(116130 * (Cb - 128), 65536)
```

Clamp final RGB components to `0..255`; alpha is always 255.

Consequently, a parsed BPDH image has a coordinate-local color algorithm:

1. calculate the `16x16` coding-unit index from `(x, y)`;
2. read its mode;
3. follow the BPAL double index or reconstruct only that unit's six DCT blocks;
4. select the local pixel and return opaque RGBA.

No random state, neighboring coding unit, previously decoded pixel, DC
predictor, or error-diffusion state affects the result. The JavaScript API
exposes this operation as `sampleBpdhPixel(decoded, x, y)`. Repeated samples
and full-image decoding therefore produce byte-identical RGBA values.

The coefficient stream is variable length, so a file must first be parsed to
locate its DCT records. Row or tile offset tables may be added by a later format
version if direct partial parsing becomes a requirement.

## Edge units

The encoder replicates the nearest real source pixel before transforming a
partial edge unit. Padding affects its coefficients, but decoded output and
quality metrics contain only coordinates inside the declared width and height.
