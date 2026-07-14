# CUDA BPAL settings search versus ASTC on texture datasets

Generated: `2026-07-14T17:54:10.158136+00:00`.

## Conclusion

Across the overlapping aggregate PSNR range, CUDA BPAL with per-image `--find-settings` uses **10.83% more payload rate** than ASTC `-medium` according to the Bjontegaard delta-rate calculation.

## Methodology

- Corpus: 200 images: ambientcg 55, dtd 100, kylberg 45.
- Selection: deterministic stratified sample by SHA-256 image ID.
- ambientCG previews and duplicate DirectX normal maps were excluded; NormalGL was retained.
- Every input was normalized once to RGB8. Sixteen-bit displacement maps were scaled by `round(value / 257)`.
- BPAL used the CUDA encoder with `--find-settings` independently for every image and target bitrate.
- BPAL used the closest-bpp fallback for 27/1,600 searches with empty preset ranges (dtd 27; target 8: 27); selected rates were 6.5860..9.3980 bpp.
- ASTC used linear LDR mode and `-medium` quality.
- PSNR is calculated from pooled RGB squared error in the stored uint8 domain.
- Payload bpp excludes the 14-byte BPAL and 16-byte ASTC headers.
- Only mip level 0 was tested.

## Aggregate rate-distortion

| Codec | Target/pair | Payload bpp | File bpp | RGB PSNR | Encode time | Decode time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BPAL CUDA find 1.5 bpp | 1.500 | 1.4380 | 1.4381 | 28.103 dB | 33s | 3s |
| ASTC 10x8 | 1.600 | 1.6036 | 1.6037 | 31.237 dB | 36s | 22s |
| BPAL CUDA find 2 bpp | 2.000 | 2.0755 | 2.0756 | 30.127 dB | 45s | 3s |
| ASTC 8x8 | 2.000 | 2.0022 | 2.0023 | 32.215 dB | 34s | 23s |
| BPAL CUDA find 2.5 bpp | 2.500 | 2.5749 | 2.5750 | 31.524 dB | 48s | 3s |
| ASTC 8x6 | 2.667 | 2.6737 | 2.6738 | 33.573 dB | 29s | 22s |
| BPAL CUDA find 3 bpp | 3.000 | 3.2965 | 3.2966 | 33.410 dB | 49s | 3s |
| ASTC 8x5 | 3.200 | 3.2066 | 3.2067 | 34.521 dB | 26s | 23s |
| BPAL CUDA find 4 bpp | 4.000 | 4.1378 | 4.1379 | 36.125 dB | 1m 05s | 3s |
| ASTC 6x5 | 4.267 | 4.2822 | 4.2823 | 36.273 dB | 27s | 24s |
| BPAL CUDA find 5 bpp | 5.000 | 4.6787 | 4.6788 | 36.668 dB | 40s | 3s |
| ASTC 5x5 | 5.120 | 5.1352 | 5.1353 | 37.520 dB | 28s | 24s |
| BPAL CUDA find 6 bpp | 6.000 | 6.4443 | 6.4444 | 39.524 dB | 1m 11s | 4s |
| ASTC 5x4 | 6.400 | 6.4107 | 6.4108 | 39.161 dB | 26s | 24s |
| BPAL CUDA find 8 bpp | 8.000 | 7.9149 | 7.9150 | 40.447 dB | 4m 29s | 4s |
| ASTC 4x4 | 8.000 | 8.0036 | 8.0037 | 40.906 dB | 26s | 24s |

## Paired operating points

| BPAL target | ASTC block | BPAL bpp | ASTC bpp | BPAL PSNR | ASTC PSNR | PSNR delta |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.5 | 10x8 | 1.4380 | 1.6036 | 28.103 dB | 31.237 dB | -3.134 dB |
| 2 | 8x8 | 2.0755 | 2.0022 | 30.127 dB | 32.215 dB | -2.088 dB |
| 2.5 | 8x6 | 2.5749 | 2.6737 | 31.524 dB | 33.573 dB | -2.050 dB |
| 3 | 8x5 | 3.2965 | 3.2066 | 33.410 dB | 34.521 dB | -1.110 dB |
| 4 | 6x5 | 4.1378 | 4.2822 | 36.125 dB | 36.273 dB | -0.149 dB |
| 5 | 5x5 | 4.6787 | 5.1352 | 36.668 dB | 37.520 dB | -0.852 dB |
| 6 | 5x4 | 6.4443 | 6.4107 | 39.524 dB | 39.161 dB | +0.363 dB |
| 8 | 4x4 | 7.9149 | 8.0036 | 40.447 dB | 40.906 dB | -0.459 dB |

## Bjontegaard delta rate by subset

Negative values favor BPAL; positive values favor ASTC.

| Subset | Images | BPAL delta rate vs ASTC |
| --- | ---: | ---: |
| All selected texture images | 200 | +10.83% |
| dtd | 100 | +32.50% |
| kylberg | 45 | +41.76% |
| ambientcg | 55 | +5.77% |

## PBR map classes

| Map class | Images | BPAL delta rate vs ASTC |
| --- | ---: | ---: |
| ambient-occlusion | 5 | +1.11% |
| color | 12 | -1.14% |
| displacement | 12 | +29.69% |
| metalness | 1 | n/a |
| normal | 12 | +4.80% |
| opacity | 1 | -32.74% |
| roughness | 12 | +10.06% |

## Normal-map angular error

| BPAL target | ASTC block | BPAL mean | ASTC mean | BPAL p95 | ASTC p95 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.5 | 10x8 | 8.438° | 6.480° | 29.750° | 24.500° |
| 2 | 8x8 | 7.043° | 5.902° | 25.750° | 22.500° |
| 2.5 | 8x6 | 6.081° | 5.165° | 22.500° | 19.750° |
| 3 | 8x5 | 5.296° | 4.753° | 18.250° | 18.000° |
| 4 | 6x5 | 4.063° | 3.898° | 14.750° | 15.000° |
| 5 | 5x5 | 3.824° | 3.377° | 13.500° | 13.000° |
| 6 | 5x4 | 2.614° | 2.716° | 10.500° | 10.500° |
| 8 | 4x4 | 2.089° | 2.122° | 9.500° | 8.250° |

## Most frequently selected BPAL settings

This table verifies that the CUDA encoder searched and selected settings per image.

| Target | Settings | Images |
| ---: | --- | ---: |
| 1.5 | `B4/L2/P2xG8/RGB24` | 200 |
| 2 | `B16/L4/P2xG128/RGB24` | 152 |
| 2 | `B4/L2/P2xG128/RGB24` | 32 |
| 2 | `B64/L4/P2xG16/RGB24` | 15 |
| 2 | `B32/L4/P2xG64/RGB24` | 1 |
| 2.5 | `B8/L4/P32xG64/RGB24` | 137 |
| 2.5 | `B8/L4/P32xG256/RGB24` | 35 |
| 2.5 | `B32/L4/P32xG64/RGB24` | 25 |
| 2.5 | `B16/L4/P32xG128/RGB24` | 3 |
| 3 | `B32/L8/P64xG64/RGB24` | 96 |
| 3 | `B16/L8/P64xG128/RGB24` | 54 |
| 3 | `B64/L8/P64xG32/RGB24` | 39 |
| 3 | `B16/L4/P64xG128/RGB24` | 11 |
| 4 | `B32/L16/P16xG128/RGB24` | 97 |
| 4 | `B8/L8/P16xG256/RGB24` | 54 |
| 4 | `B8/L8/P16xG128/RGB24` | 43 |
| 4 | `B64/L16/P16xG64/RGB24` | 6 |
| 5 | `B32/L16/P64xG128/RGB24` | 91 |
| 5 | `B16/L16/P64xG256/RGB24` | 58 |
| 5 | `B8/L8/P64xG256/RGB24` | 31 |
| 5 | `B64/L16/P64xG64/RGB24` | 15 |
| 5 | `B16/L8/P64xG128/RGB24` | 5 |
| 6 | `B8/L16/P32xG128/RGB24` | 163 |
| 6 | `B8/L16/P32xG1024/RGB24` | 37 |
| 8 | `B4/L8/P64xG256/RGB24` | 143 |
| 8 | `B16/L16/P64xG256/RGB24` | 35 |
| 8 | `B4/L8/P64xG1024/RGB24` | 14 |
| 8 | `B8/L16/P64xG1024/RGB24` | 6 |
| 8 | `B8/L8/P64xG256/RGB24` | 2 |

## Tools

- **bpal5cudaenc:** `bpal5cudaenc BPAL v5, CUDA runtime 13.3, 1 device(s)` (`native/bpal5_simd/build-cuda/bpal5cudaenc.exe`)
- **bpal5dec:** `bpal5dec BPAL v5 (AVX2 runtime backend)` (`native/bpal5_simd/build-cuda/bpal5dec.exe`)
- **astcenc:** `astcenc v5.6.0, 64-bit avx2+popcnt+f16c` (`.benchmark-tools/astcenc-5.6.0/bin/astcenc-avx2.exe`)

## Limitations

- ASTC encoding ran on the CPU; BPAL settings search and refinement ran on CUDA.
- Timing includes process startup and file I/O and is not a GPU sampling benchmark.
- BPAL targets retain preset-specific palette counts, so subset curves can contain dominated points; BD-rate removes dominated points.
- RGB PSNR is not perceptually linear. Normal maps additionally use angular error.
- Alpha, HDR, mip-chain generation, and runtime texture filtering were not tested.
