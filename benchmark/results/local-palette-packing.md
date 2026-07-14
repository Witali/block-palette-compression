# GPU-friendly local palette packing benchmark

## Result

The benchmark used **200 textures** and **1600 encoded operating points**.
Palette packing is lossless: every packed output was decoded alongside its byte-equivalent legacy representation.
All **1600 decoded pixel buffers were byte-identical**.

| Subset | Records | Legacy bytes | Packed bytes | Saved | File reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| all | 1600 | 1,028,694,147 | 1,025,550,443 | 3,143,704 | 0.306% |
| dtd | 800 | 100,250,186 | 99,429,608 | 820,578 | 0.819% |
| kylberg | 360 | 62,078,617 | 61,809,803 | 268,814 | 0.433% |
| ambientcg | 440 | 866,365,344 | 864,311,032 | 2,054,312 | 0.237% |

## By target rate

| Target | Legacy bpp | Packed bpp | File reduction | Packed files | Delta palettes |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.5 | 1.4381 | 1.4381 | 0.000% | 3/200 | 6 |
| 2 | 2.0756 | 2.0754 | 0.007% | 57/200 | 97 |
| 2.5 | 2.5750 | 2.5705 | 0.177% | 125/200 | 2812 |
| 3 | 3.2966 | 3.2871 | 0.287% | 128/200 | 5574 |
| 4 | 4.1379 | 4.1351 | 0.069% | 117/200 | 1218 |
| 5 | 4.6788 | 4.6559 | 0.488% | 146/200 | 6063 |
| 6 | 6.4444 | 6.4301 | 0.222% | 153/200 | 2932 |
| 8 | 7.9150 | 7.8696 | 0.573% | 193/200 | 7824 |

## Decoder constraints

- No entropy stream or dependency on a previous palette/block is used.
- Every palette has a 32-bit directory offset and an independent byte-aligned record.
- Each record is either raw RGB565/RGB888 or one RGB base plus three fixed residual widths.
- A pixel lookup reads one selector, one local index, one global index, one directory entry, and one palette record.
- Reconstruction uses only integer shifts, masks, additions, and bounded bit reads.
- The encoder keeps the legacy palette representation whenever directory/record metadata would increase the file.

## Methodology

- Deterministic stratified sample: 100 DTD, 45 Kylberg, and 55 ambientCG images.
- All eight CUDA `--find-settings` targets from 1.5 through 8 bpp.
- Full file size includes the 14-byte BPAL header and all packing metadata.
- Existing CUDA settings were reproduced for 1600/1600 records.
- JSONL resume reused 1600 records; 0 were encoded in this run.
- Quality is unchanged by construction and by byte-identical decoded output, so PSNR delta is exactly 0 dB.
