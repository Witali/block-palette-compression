# GPU-friendly local palette packing benchmark

## Result

The benchmark used **60 textures** and **480 encoded operating points**.
Palette packing is lossless: every packed output was decoded alongside its byte-equivalent legacy representation.
All **480 decoded pixel buffers were byte-identical**.

| Subset | Records | Legacy bytes | Packed bytes | Saved | File reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| all | 480 | 379,371,095 | 378,332,505 | 1,038,590 | 0.274% |
| dtd | 160 | 20,743,725 | 20,545,711 | 198,014 | 0.955% |
| kylberg | 160 | 27,600,202 | 27,481,850 | 118,352 | 0.429% |
| ambientcg | 160 | 331,027,168 | 330,304,944 | 722,224 | 0.218% |

## By target rate

| Target | Legacy bpp | Packed bpp | File reduction | Packed files | Delta palettes |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.5 | 1.4380 | 1.4380 | 0.000% | 1/60 | 2 |
| 2 | 2.0697 | 2.0695 | 0.007% | 19/60 | 31 |
| 2.5 | 2.5606 | 2.5564 | 0.163% | 40/60 | 919 |
| 3 | 3.2859 | 3.2785 | 0.226% | 37/60 | 1709 |
| 4 | 4.1262 | 4.1237 | 0.060% | 38/60 | 397 |
| 5 | 4.6572 | 4.6364 | 0.446% | 42/60 | 1906 |
| 6 | 6.4265 | 6.4131 | 0.208% | 50/60 | 941 |
| 8 | 7.9406 | 7.9000 | 0.511% | 59/60 | 2477 |

## Decoder constraints

- No entropy stream or dependency on a previous palette/block is used.
- Every palette has a 32-bit directory offset and an independent byte-aligned record.
- Each record is either raw RGB565/RGB888 or one RGB base plus three fixed residual widths.
- A pixel lookup reads one selector, one local index, one global index, one directory entry, and one palette record.
- Reconstruction uses only integer shifts, masks, additions, and bounded bit reads.
- The encoder keeps the legacy palette representation whenever directory/record metadata would increase the file.

## Methodology

- 20 stratified images from each of DTD, Kylberg, and ambientCG.
- All eight CUDA `--find-settings` targets from 1.5 through 8 bpp.
- Full file size includes the 14-byte BPAL header and all packing metadata.
- Existing CUDA settings were reproduced for 480/480 records.
- Quality is unchanged by construction and by byte-identical decoded output, so PSNR delta is exactly 0 dB.
