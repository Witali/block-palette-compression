# DCTBS2 fixed-MCU image format

DCTBS2 is an experimental, deterministic image format intended for direct
sampling on CPUs and GPUs. It stores independent 16×16 minimum coded units
(MCUs) at a fixed byte rate. A decoder can locate and reconstruct one pixel
without decoding the rest of the image or following an entropy stream.

## Color and transform layout

Each MCU contains three components:

- Y: one orthonormal 16×16 DCT;
- Cb: one orthonormal 8×16 DCT;
- Cr: one orthonormal 8×16 DCT.

Cb and Cr use horizontal 4:2:2 subsampling. Source pixels outside a partial
edge MCU are extended by repeating the nearest valid pixel.

The supported rates include the four MCU modes and all three higher-rate
16/24/32-byte modes from the preserved reference converter. The reference
uses four 8×8 luma records for those higher rates, so their byte budgets give
two thirds of the MCU to luma. DCTBS2 v2 keeps its single 16×16 luma transform
and 4:2:2 random-access layout, but preserves that Y-heavy allocation.

| Preset | Bytes/MCU | Y | Cb | Cr |
| ---: | ---: | ---: | ---: | ---: |
| 0.75 bpp | 24 | 12 | 6 | 6 |
| 1 bpp | 32 | 16 | 8 | 8 |
| 1.5 bpp | 48 | 24 | 12 | 12 |
| 2 bpp | 64 | 32 | 16 | 16 |
| 3 bpp | 96 | 64 | 16 | 16 |
| 4.5 bpp | 144 | 96 | 24 | 24 |
| 6 bpp | 192 | 128 | 32 | 32 |

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
| 52 | 4 | flags; bit 0 means quality was selected automatically |
| 56 | 4 | payload bytes |
| 60 | 4 | number of quality candidates measured by the encoder |

## Component record

Every component starts with one byte. Its high nibble selects one of four
fixed coefficient scans (low-frequency, horizontal, vertical, or diagonal).
Its low nibble selects the quantizer multiplier 1, 2, 4, or 8. Remaining
values are a signed 10-bit DC coefficient followed by as many signed 6-bit AC
coefficients as fit in the fixed component record. Unused tail bits are zero.

The quantization step is reconstructed from the stored quality, the component
dimensions, the fixed JPEG luma/chroma table, and the per-component multiplier.
No runtime codebook or previous block is required.

## Random access

For coordinate `(x, y)`:

```text
mcu_x     = x / 16
mcu_y     = y / 16
mcu_index = mcu_y * mcu_columns + mcu_x
mcu_byte  = 64 + mcu_index * bytes_per_mcu
```

The decoder reads this one MCU, reconstructs Y at `(x mod 16, y mod 16)` and
Cb/Cr at `((x mod 16) / 2, y mod 16)`, then converts the three samples to RGB.
All loops are bounded by the fixed 16×16 and 8×16 transform dimensions. There
are no data-dependent references to other MCUs.
