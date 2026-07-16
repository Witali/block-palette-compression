# DCTBS2 fixed-MCU image format

[Russian algorithm overview with layout diagrams](./docs/DCTBS2_ALGORITHM_ru.md)

DCTBS2 is an experimental, deterministic image format intended for direct
sampling on CPUs and GPUs. It stores independent 16×16 minimum coded units
(MCUs) at a fixed byte rate. A decoder can locate and reconstruct one pixel
without decoding the rest of the image or following an entropy stream.

## Color and transform layout

Each MCU contains luma and two chroma components:

- Y at 0.75–2 bpp: one orthonormal 16×16 DCT;
- Y at 3–9 bpp: four independent orthonormal 8×8 DCTs;
- Cb: one orthonormal 8×16 DCT;
- Cr: one orthonormal 8×16 DCT.

Cb and Cr use horizontal 4:2:2 subsampling. Source pixels outside a partial
edge MCU are extended by repeating the nearest valid pixel.

The supported rates include the four MCU modes and all five higher-rate
16/24/32/40/48-byte modes from the preserved reference converter. The high-rate
modes divide their Y allocation equally between four 8×8 records. This
localizes ringing from strong edges without changing the fixed MCU size or
the 4:2:2 random-access layout. Each high-rate Y block receives 16, 24, 32, 40,
or 48 bytes at 3, 4.5, 6, 7.5, or 9 bpp respectively.

| Preset | Bytes/MCU | Y | Cb | Cr |
| ---: | ---: | ---: | ---: | ---: |
| 0.75 bpp | 24 | 12 | 6 | 6 |
| 1 bpp | 32 | 16 | 8 | 8 |
| 1.5 bpp | 48 | 24 | 12 | 12 |
| 2 bpp | 64 | 32 | 16 | 16 |
| 3 bpp | 96 | 64 | 16 | 16 |
| 4.5 bpp | 144 | 96 | 24 | 24 |
| 6 bpp | 192 | 128 | 32 | 32 |
| 7.5 bpp | 240 | 160 | 40 | 40 |
| 9 bpp | 288 | 192 | 48 | 48 |

The actual whole-file bpp can be slightly higher for non-multiple-of-16 image
dimensions because the edge MCUs are stored at their complete fixed size.

## 64-byte header

All multi-byte integers are unsigned little-endian values.

| Offset | Bytes | Field |
| ---: | ---: | --- |
| 0 | 8 | `DCTBS2\0\0` magic |
| 8 | 4 | version (`2`) |
| 12 | 4 | mode code |
| 16 | 4 | width |
| 20 | 4 | height |
| 24 | 4 | MCU columns |
| 28 | 4 | MCU rows |
| 32 | 4 | bytes per MCU |
| 36 | 4 | Y bytes per MCU |
| 40 | 4 | Cb bytes per MCU |
| 44 | 4 | Cr bytes per MCU |
| 48 | 4 | JPEG-style quality value (1–100) |
| 52 | 4 | flags; bit 0 means quality was selected automatically; bit 1 selects four 8×8 Y records; bit 2 enables a DCT prototype library; bits 8–11 select coefficient coding |
| 56 | 4 | payload bytes |
| 60 | 4 | number of quality candidates, or prototype-library bytes when flag bit 2 is set |

## Component record

Every component record starts with one byte. In legacy and grouped records its
high nibble selects one of four fixed coefficient scans (low-frequency,
horizontal, vertical, or diagonal). Bits 0–2 select the quantizer multiplier
1, 2, 4, 8, 16, 32, 64, or 128. The legacy coding then stores a signed 10-bit
DC coefficient followed by as many signed 6-bit AC coefficients as fit in the
fixed component record. Unused tail bits are zero. A split-luma MCU places its
four Y records in top-left, top-right, bottom-left, bottom-right order before
Cb and Cr.

The quantization step is reconstructed from the stored quality, the component
dimensions, the fixed JPEG luma/chroma table, and the per-component multiplier.
No runtime codebook or previous block is required.

Grouped coefficient coding uses signed 5-bit AC mantissas and two or three
3-bit binary scale indices. The scale groups are reconstructed from the fixed
component size and coding flag, so their parsing remains bounded and does not
depend on another MCU.

Adaptive skip codings retain grouped coding as a per-record fallback. When bit
3 of the first byte is set, the high nibble instead selects one of eight fixed
frequency scans and the payload after the signed 10-bit DC is a bounded token
sequence. Each token stores a signed coefficient followed by a 2-bit skip; the
next scan index is `current + skip + 1`. Skip-RLE uses signed 6-bit values for
all tokens. Dual-scale skip uses signed 6-bit coarse tokens followed by signed
4-bit fine tokens. Fine tokens use multiplier 1 when the main multiplier is
1, 2, or 4, and multiplier 2 otherwise. The record size alone determines the
token split, so direct addressing is unchanged.

The encoder evaluates the grouped and skip candidates and writes the skip form
only when it reduces coefficient error. Defaults follow the final fixed-rate
experiments: skip-RLE at 0.75 bpp; dual-scale skip at 1, 1.5, and 2 bpp; and
dual-scale skip for the 16- and 24-byte high-rate component records (3 and 4.5
bpp). At 6, 7.5, and 9 bpp the encoder evaluates both grouped coding and the
masked-tail coding described below, reconstructs both complete RGB images, and
writes the lower-error file. A tie keeps grouped coding. This file-level guard
prevents the masked representation from reducing RGB PSNR. Low-rate chroma
keeps grouped coding; high-rate split-luma files may use adaptive skip for both
luma and chroma records.

Masked-tail 8x8 records begin with a 64-bit little-endian word. Bits 0 through
61 are an explicit AC mask: bit 0 selects `DCT[1]` (the first AC coefficient),
bit 61 selects `DCT[62]`, and DC never has a mask bit. Bits 62 and 63 select the
shared multiplier 1, 2, 4, or 8. The value stream after the mask is packed
least-significant bit first and starts with a separately stored signed DC.

If the mask contains `M` set bits and the record has an AC capacity of `N`, the
remaining `N - M` slots are an implicit contiguous tail at
`DCT[64 - (N - M)] ... DCT[63]`. Explicit mask positions must precede that tail,
so a record can never store the same coefficient twice. Explicit values are
written in increasing coefficient-position order, followed by the tail values.
The fixed layouts are:

| Record bytes | DC bits | AC bits | AC capacity |
| ---: | ---: | ---: | ---: |
| 16 | 10 | 6 | 9 |
| 24 | 9 | 7 | 17 |
| 32 | 8 | 8 | 23 |
| 40 | 8 | 8 | 31 |
| 48 | 10 | 8 | 38 |

Coding ID 6 uses masked-tail records for eligible 8x8 components and the
ordinary three-group signed-5 representation for other component dimensions.
Prototype libraries deliberately fall back to coding ID 2 because their
references occupy fields that masked-tail records do not expose.

Coefficient coding identifiers are:

| ID | Coding |
| ---: | --- |
| 0 | legacy signed-6 |
| 1 | grouped signed-5, two equal groups |
| 2 | grouped signed-5, three front-loaded groups |
| 3 | grouped ID 1 plus adaptive skip-RLE |
| 4 | grouped ID 1 plus adaptive dual-scale skip |
| 5 | grouped ID 2 plus adaptive dual-scale skip |
| 6 | 8x8 explicit AC mask plus implicit high-frequency tail; ID 2 fallback for other dimensions |

## Optional DCT prototype library

The encoder can cluster the Y, Cb, and Cr coefficient vectors across one image
into separate deterministic prototype libraries. Each component then stores a
quantized residual relative to either zero or one prototype. The decoded
coefficient vector is simply `prototype + residual`.

With one to three prototypes, the two otherwise unused high bits of the
component profile nibble store a reference from 0 through 3. The lower two
bits still select the four coefficient scans, so this compact mode preserves
the complete baseline coefficient budget. Experimental libraries with four or
more entries use the final AC mantissa as a wider unsigned reference and
therefore store one fewer residual coefficient.

Separately versioned sidecar libraries preserve every baseline MCU bit while
supporting up to 63 prototypes. They store one fixed-width, directly addressed
index per participating component outside the MCU payload. Index zero selects
the raw component and indices 1 through N select a prototype, so 16 prototypes
need 5 bits and 32 prototypes need 6 bits. Sidecar indices do not change the
baseline component-record interpretation.

Spectral-split library versions give the prototype and local residual different
roles without changing the four existing significance scans. For an AC budget
of N positions and split fraction F, the local record keeps the first
`N - high_count` positions of its selected scan and uses its remaining slots
for positions beginning at N, where
`high_count = min(round(N * F), scan_length - N)`. DC remains a local residual.
The prototype record retains the ordinary low-significance-rank prefix. The
current selected experimental profile uses `F = 0.25`.

The library is appended after all fixed-size MCU records. Its 32-byte header is:

| Offset | Bytes | Field |
| ---: | ---: | --- |
| 0 | 8 | `DCTLIB1\0` magic |
| 8 | 4 | version; see below |
| 12 | 4 | Y prototype count |
| 16 | 4 | Cb prototype count |
| 20 | 4 | Cr prototype count |
| 24 | 4 | bytes per Y prototype record |
| 28 | 4 | complete library bytes including this header |

Versions 1 and 2 are the original tail- and header-reference layouts. Versions
3, 4, and 5 use header references with spectral split fractions 0.25, 0.5, and
1. Versions 6, 7, 8, and 9 use sidecar references with split fractions 0,
0.25, 0.5, and 1 respectively.

For versions 6 through 9, byte-aligned Y, Cb, and Cr sidecar streams immediately
follow the 32-byte header. Indices are packed least-significant bit first. The
stream length is `ceil(reference_count * ceil(log2(prototype_count + 1)) / 8)`.
The prototype records follow all three streams in Y, Cb, Cr order. For other
versions the prototype records begin immediately after the header.

Every
prototype uses the ordinary component-record representation, the image quality,
and the file's coefficient coding. The counts are bounded by 3 in compact mode
by the unsigned mantissa range in tail-reference mode, and by 63 in sidecar
mode.

## Random access

For coordinate `(x, y)`:

```text
mcu_x     = x / 16
mcu_y     = y / 16
mcu_index = mcu_y * mcu_columns + mcu_x
mcu_byte  = 64 + mcu_index * bytes_per_mcu
```

The decoder reads this one MCU. In a split-luma file it selects and reconstructs
only the Y record identified by `(x mod 16) / 8` and `(y mod 16) / 8`, then
samples it at `(x mod 8, y mod 8)`. In a legacy or low-rate file it samples the
single 16×16 Y record.
Cb/Cr are sampled at `((x mod 16) / 2, y mod 16)`, after which the three
samples are converted to RGB. All loops are bounded by 16×16, 8×8, and 8×16
transform dimensions. A library file additionally reads at most one bounded
index and one bounded prototype record per component. The sidecar bit address
is computed from the component block ordinal and fixed index width. There are
no references to other MCUs, and the prototype address is computed directly
from the index and fixed record size. This remains suitable for a read-only GPU
buffer or texture.

High-rate DCTBS2 v2 files written before the split-luma flag was introduced
remain valid: an unset bit 1 always means one 16×16 Y record, including for a
3, 4.5, or 6 bpp layout.

## JPEG DCT import

The browser page can transcode grayscale and three-component YCbCr JPEG files
without using decoded RGB pixels as encoder input. The CPU parser decodes the
baseline or progressive Huffman scans and dequantizes the source 8×8 DCT
blocks. The importer deterministically reconstructs component samples, adapts
JPEG subsampling to 4:2:2, and transforms those Y/Cb/Cr planes into the
selected 16×16 or split 8×8 fixed MCU layout. There is no RGB conversion in
this path. The resulting file uses the same one-MCU coordinate lookup as a
regular DCTBS2 encode. The page uses the selected quantization quality directly
and disables the RGB-based automatic quality search while this one-pass import
mode is active.
