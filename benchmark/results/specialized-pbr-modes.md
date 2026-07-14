# Specialized BPAL PBR channel modes

Compared 31 scalar maps from the pinned ambientCG corpus (248 retained encodes).

The specialized encodes reuse each baseline `--find-settings` structural choice. This isolates the channel representation: scalar palette entries use 8 bits. Block selectors and pixel indices are unchanged.

Scalar BD-rate versus RGB BPAL at equal scalar PSNR: **-0.75%**.

## Scalar maps

| Target | RGB BPAL bpp | Scalar8 bpp | RGB PSNR | Scalar8 PSNR |
|---:|---:|---:|---:|---:|
| 1.5 | 1.438 | 1.438 | 31.118 | 31.118 |
| 2 | 2.069 | 2.068 | 34.180 | 34.180 |
| 2.5 | 2.545 | 2.524 | 35.950 | 35.950 |
| 3 | 3.287 | 3.252 | 40.308 | 40.308 |
| 4 | 4.106 | 4.096 | 45.188 | 45.188 |
| 5 | 4.629 | 4.559 | 46.499 | 46.499 |
| 6 | 6.361 | 6.280 | 50.083 | 50.083 |
| 8 | 7.453 | 7.334 | 49.299 | 49.299 |

## Rejected normal-map experiment

A separate 96-encode experiment on 12 NormalGL maps stored XY8 and reconstructed Z. It produced **+9.80% BD-rate** at equal angular error, so that format and its implementation were removed.

## Decode constraints

Scalar mode preserves deterministic O(1) random pixel access. A decoder reads the block selector, local color index, pixel index, and one independent palette entry, then replicates one byte. No neighboring block or variable-length stream is referenced.
