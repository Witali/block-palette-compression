# CUDA BPAL settings search versus ASTC on texture datasets

Generated: `2026-07-14T20:27:36.232770+00:00`.

## Conclusion

Across the overlapping aggregate PSNR range, CUDA BPAL with per-image `--find-settings` uses **9.08% more payload rate** than ASTC `-medium` according to the Bjontegaard delta-rate calculation.

The legacy BPAL search measured +10.83%, so the expanded search with the rate
guard closes 1.75 percentage points of the aggregate gap. It also improves
every dataset subset: dtd +32.50% to +26.56%, Kylberg +41.76% to +38.41%, and
ambientCG +5.77% to +5.41%.

## Methodology

- Corpus: 200 images: ambientcg 55, dtd 100, kylberg 45.
- Selection: deterministic stratified sample by SHA-256 image ID.
- ambientCG previews and duplicate DirectX normal maps were excluded; NormalGL was retained.
- Every input was normalized once to RGB8. Sixteen-bit displacement maps were scaled by `round(value / 257)`.
- BPAL used the CUDA encoder with `--find-settings` independently for every image and target bitrate.
- The guarded curve is an exact replay of two complete 200-image, eight-target CUDA runs: the legacy-family result and the minimum-RMSE expanded result were selected with the production `15 * ln(rate ratio)` guard. A fresh 2048x2048 CLI check reproduced a guarded fallback decision, selected bpp, and PSNR exactly.
- Encode times in the tables come from the selected source records and are not end-to-end timings of the guarded search.
- BPAL used the closest-bpp fallback for 2/1,600 searches with empty preset ranges (dtd 2; target 8: 2); selected rates were 6.6460..6.7400 bpp.
- ASTC used linear LDR mode and `-medium` quality.
- PSNR is calculated from pooled RGB squared error in the stored uint8 domain.
- Payload bpp excludes the 14-byte BPAL and 16-byte ASTC headers.
- Only mip level 0 was tested.

## Aggregate rate-distortion

| Codec | Target/pair | Payload bpp | File bpp | RGB PSNR | Encode time | Decode time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BPAL CUDA find 1.5 bpp | 1.500 | 1.4649 | 1.4650 | 28.271 dB | 50s | 3s |
| ASTC 10x8 | 1.600 | 1.6036 | 1.6037 | 31.237 dB | 36s | 22s |
| BPAL CUDA find 2 bpp | 2.000 | 2.0751 | 2.0752 | 30.133 dB | 1m 44s | 3s |
| ASTC 8x8 | 2.000 | 2.0022 | 2.0023 | 32.215 dB | 34s | 23s |
| BPAL CUDA find 2.5 bpp | 2.500 | 2.5588 | 2.5589 | 31.621 dB | 2m 34s | 3s |
| ASTC 8x6 | 2.667 | 2.6737 | 2.6738 | 33.573 dB | 29s | 22s |
| BPAL CUDA find 3 bpp | 3.000 | 3.2945 | 3.2945 | 33.687 dB | 3m 28s | 3s |
| ASTC 8x5 | 3.200 | 3.2066 | 3.2067 | 34.521 dB | 26s | 23s |
| BPAL CUDA find 4 bpp | 4.000 | 4.1313 | 4.1313 | 36.128 dB | 2m 27s | 3s |
| ASTC 6x5 | 4.267 | 4.2822 | 4.2823 | 36.273 dB | 27s | 24s |
| BPAL CUDA find 5 bpp | 5.000 | 4.6909 | 4.6910 | 36.838 dB | 2m 17s | 3s |
| ASTC 5x5 | 5.120 | 5.1352 | 5.1353 | 37.520 dB | 28s | 24s |
| BPAL CUDA find 6 bpp | 6.000 | 6.4010 | 6.4010 | 39.538 dB | 2m 32s | 4s |
| ASTC 5x4 | 6.400 | 6.4107 | 6.4108 | 39.161 dB | 26s | 24s |
| BPAL CUDA find 8 bpp | 8.000 | 7.9249 | 7.9250 | 40.599 dB | 16m 40s | 4s |
| ASTC 4x4 | 8.000 | 8.0036 | 8.0037 | 40.906 dB | 26s | 24s |

## Paired operating points

| BPAL target | ASTC block | BPAL bpp | ASTC bpp | BPAL PSNR | ASTC PSNR | PSNR delta |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.5 | 10x8 | 1.4649 | 1.6036 | 28.271 dB | 31.237 dB | -2.967 dB |
| 2 | 8x8 | 2.0751 | 2.0022 | 30.133 dB | 32.215 dB | -2.082 dB |
| 2.5 | 8x6 | 2.5588 | 2.6737 | 31.621 dB | 33.573 dB | -1.952 dB |
| 3 | 8x5 | 3.2945 | 3.2066 | 33.687 dB | 34.521 dB | -0.833 dB |
| 4 | 6x5 | 4.1313 | 4.2822 | 36.128 dB | 36.273 dB | -0.146 dB |
| 5 | 5x5 | 4.6909 | 5.1352 | 36.838 dB | 37.520 dB | -0.682 dB |
| 6 | 5x4 | 6.4010 | 6.4107 | 39.538 dB | 39.161 dB | +0.377 dB |
| 8 | 4x4 | 7.9249 | 8.0036 | 40.599 dB | 40.906 dB | -0.307 dB |

## Bjontegaard delta rate by subset

Negative values favor BPAL; positive values favor ASTC.

| Subset | Images | BPAL delta rate vs ASTC |
| --- | ---: | ---: |
| All selected texture images | 200 | +9.08% |
| dtd | 100 | +26.56% |
| kylberg | 45 | +38.41% |
| ambientcg | 55 | +5.41% |

## PBR map classes

| Map class | Images | BPAL delta rate vs ASTC |
| --- | ---: | ---: |
| ambient-occlusion | 5 | +0.88% |
| color | 12 | -1.25% |
| displacement | 12 | +28.68% |
| metalness | 1 | n/a |
| normal | 12 | +4.65% |
| opacity | 1 | -32.86% |
| roughness | 12 | +9.92% |

## Normal-map angular error

| BPAL target | ASTC block | BPAL mean | ASTC mean | BPAL p95 | ASTC p95 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.5 | 10x8 | 8.438° | 6.480° | 29.750° | 24.500° |
| 2 | 8x8 | 7.043° | 5.902° | 25.750° | 22.500° |
| 2.5 | 8x6 | 6.079° | 5.165° | 22.500° | 19.750° |
| 3 | 8x5 | 5.296° | 4.753° | 18.250° | 18.000° |
| 4 | 6x5 | 4.062° | 3.898° | 14.750° | 15.000° |
| 5 | 5x5 | 3.824° | 3.377° | 13.500° | 13.000° |
| 6 | 5x4 | 2.614° | 2.716° | 10.500° | 10.500° |
| 8 | 4x4 | 2.089° | 2.122° | 9.500° | 8.250° |

## Most frequently selected BPAL settings

This table verifies that the CUDA encoder searched and selected settings per image.

| Target | Settings | Images |
| ---: | --- | ---: |
| 1.5 | `B4/L2/P2xG8/RGB24` | 165 |
| 1.5 | `B4/L2/P32xG8/RGB24` | 34 |
| 1.5 | `B4/L2/P16xG8/RGB24` | 1 |
| 2 | `B16/L4/P2xG128/RGB24` | 149 |
| 2 | `B4/L2/P2xG128/RGB24` | 26 |
| 2 | `B64/L4/P2xG16/RGB24` | 12 |
| 2 | `B4/L2/P2xG128/RGB16` | 6 |
| 2 | `B64/L4/P64xG16/RGB24` | 1 |
| 2.5 | `B8/L4/P32xG64/RGB24` | 100 |
| 2.5 | `B8/L4/P2xG256/RGB24` | 50 |
| 2.5 | `B8/L4/P32xG256/RGB24` | 23 |
| 2.5 | `B8/L4/P16xG64/RGB24` | 11 |
| 2.5 | `B8/L4/P64xG64/RGB24` | 7 |
| 3 | `B16/L8/P16xG128/RGB24` | 97 |
| 3 | `B16/L8/P64xG128/RGB24` | 44 |
| 3 | `B16/L8/P2xG128/RGB24` | 31 |
| 3 | `B16/L8/P32xG128/RGB24` | 9 |
| 3 | `B16/L8/P16xG128/RGB16` | 8 |
| 4 | `B32/L16/P16xG128/RGB24` | 93 |
| 4 | `B8/L8/P16xG256/RGB24` | 46 |
| 4 | `B8/L8/P16xG128/RGB24` | 42 |
| 4 | `B32/L16/P2xG128/RGB24` | 7 |
| 4 | `B8/L8/P32xG128/RGB24` | 4 |
| 5 | `B16/L16/P32xG256/RGB24` | 68 |
| 5 | `B16/L16/P64xG256/RGB24` | 55 |
| 5 | `B16/L16/P16xG256/RGB24` | 32 |
| 5 | `B32/L16/P64xG128/RGB24` | 22 |
| 5 | `B8/L8/P32xG256/RGB24` | 12 |
| 6 | `B8/L16/P32xG128/RGB24` | 137 |
| 6 | `B8/L16/P32xG1024/RGB24` | 32 |
| 6 | `B8/L16/P2xG1024/RGB24` | 16 |
| 6 | `B8/L16/P64xG128/RGB24` | 13 |
| 6 | `B8/L16/P2xG128/RGB24` | 1 |
| 8 | `B4/L8/P64xG256/RGB24` | 108 |
| 8 | `B4/L8/P32xG256/RGB24` | 20 |
| 8 | `B4/L8/P2xG1024/RGB24` | 20 |
| 8 | `B8/L16/P16xG1024/RGB24` | 18 |
| 8 | `B4/L8/P64xG1024/RGB24` | 14 |

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
