# DCTBS2 versus BPAL and ASTC on 200 textures

Generated: `2026-07-15T12:58:18.628728+00:00`.

## Methodology

- Corpus: 200 deterministic 128x128 center crops; ambientcg 55, dtd 100, kylberg 45.
- RGB PSNR is pooled from exact squared error in the stored uint8 domain.
- Payload bpp excludes the DCTBS2, BPAL, and ASTC container headers.
- DCTBS2: best exact RGB error per image among quality 85, 92, 97, 100.
- BPAL: bpal5cudaenc --find-settings per image.
- ASTC: astcenc linear LDR -medium.
- Exact-rate estimates use linear pooled PSNR versus log2(payload bpp), no extrapolation.

## Exact payload-bpp comparison

Interpolated values are marked `~`; unavailable values are below the codec's supported rate range.

| Payload bpp | DCTBS2 PSNR | BPAL PSNR | DCT - BPAL | ASTC PSNR | DCT - ASTC |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0.75 | 24.581 dB | n/a | n/a | n/a | n/a |
| 1 | 25.514 dB | n/a | n/a | ~28.661 dB | -3.147 dB |
| 1.5 | 26.938 dB | ~27.042 dB | -0.104 dB | ~30.503 dB | -3.565 dB |
| 2 | 27.913 dB | ~28.268 dB | -0.355 dB | ~32.106 dB | -4.193 dB |
| 3 | 30.078 dB | ~32.341 dB | -2.264 dB | ~34.578 dB | -4.500 dB |
| 4.5 | 32.816 dB | ~36.596 dB | -3.780 dB | ~37.685 dB | -4.868 dB |
| 6 | 35.238 dB | ~39.538 dB | -4.300 dB | ~40.522 dB | -5.284 dB |

## Measured operating points

| Codec | Profile | Target/theoretical bpp | Measured payload bpp | Pooled RGB PSNR |
|:---|:---|---:|---:|---:|
| DCTBS2 | DCTBS2 0.75 bpp | 0.7500 | 0.7500 | 24.581 dB |
| DCTBS2 | DCTBS2 1 bpp | 1.0000 | 1.0000 | 25.514 dB |
| DCTBS2 | DCTBS2 1.5 bpp | 1.5000 | 1.5000 | 26.938 dB |
| DCTBS2 | DCTBS2 2 bpp | 2.0000 | 2.0000 | 27.913 dB |
| DCTBS2 | DCTBS2 3 bpp | 3.0000 | 3.0000 | 30.078 dB |
| DCTBS2 | DCTBS2 4.5 bpp | 4.5000 | 4.5000 | 32.816 dB |
| DCTBS2 | DCTBS2 6 bpp | 6.0000 | 6.0000 | 35.238 dB |
| BPAL | BPAL find 1.5 bpp | 1.5000 | 1.4711 | 26.959 dB |
| BPAL | BPAL find 2 bpp | 2.0000 | 2.1544 | 28.585 dB |
| BPAL | BPAL find 2.5 bpp | 2.5000 | 2.5762 | 30.898 dB |
| BPAL | BPAL find 3 bpp | 3.0000 | 3.3977 | 33.521 dB |
| BPAL | BPAL find 4 bpp | 4.0000 | 4.3676 | 36.373 dB |
| BPAL | BPAL find 5 bpp | 5.0000 | 5.2160 | 37.699 dB |
| BPAL | BPAL find 6 bpp | 6.0000 | 6.1400 | 39.840 dB |
| BPAL | BPAL find 8 bpp | 8.0000 | 7.8347 | 41.023 dB |
| ASTC | ASTC 12x12 | 0.8889 | 0.9453 | 28.427 dB |
| ASTC | ASTC 12x10 | 1.0667 | 1.1172 | 29.121 dB |
| ASTC | ASTC 10x10 | 1.2800 | 1.3203 | 29.875 dB |
| ASTC | ASTC 10x8 | 1.6000 | 1.6250 | 30.897 dB |
| ASTC | ASTC 8x8 | 2.0000 | 2.0000 | 32.106 dB |
| ASTC | ASTC 8x6 | 2.6667 | 2.7500 | 33.903 dB |
| ASTC | ASTC 8x5 | 3.2000 | 3.2500 | 35.199 dB |
| ASTC | ASTC 6x5 | 4.2667 | 4.4688 | 37.615 dB |
| ASTC | ASTC 5x5 | 5.1200 | 5.2812 | 39.289 dB |
| ASTC | ASTC 5x4 | 6.4000 | 6.5000 | 41.295 dB |

## Bjontegaard delta rate

Positive values mean DCTBS2 needs more payload rate for equal pooled PSNR.

- DCTBS2 versus BPAL: **+27.41%**.
- DCTBS2 versus ASTC: **+105.09%**.

## Dataset consistency

The 3 bpp columns use the same exact-rate interpolation as the aggregate table.

| Dataset | DCT vs BPAL BD-rate | DCT vs ASTC BD-rate | DCT 3 bpp | BPAL 3 bpp | ASTC 3 bpp |
|:---|---:|---:|---:|---:|---:|
| ambientcg | +62.93% | +155.88% | 29.935 dB | ~32.834 dB | ~33.811 dB |
| dtd | +31.17% | +93.27% | 29.541 dB | ~32.185 dB | ~34.207 dB |
| kylberg | +1.33% | +85.10% | 31.834 dB | ~32.098 dB | ~37.080 dB |

## Limitations

- BPAL has no encoder presets below 1.5 bpp; no BPAL values are extrapolated there.
- The minimum measured ASTC rate is its 12x12 block including block-grid padding; no ASTC value is extrapolated below it.
- Exact-rate BPAL and ASTC values are rate-distortion interpolation, not additional bitstreams encoded at an impossible block size.
- These are 128x128 crop results, not a full-resolution timing benchmark.
- Alpha, HDR, mip chains, texture filtering, and normal-map angular error are outside this comparison.

## Tools

- **bpal5cudaenc:** `bpal5cudaenc BPAL v5, CUDA runtime 13.3, 1 device(s)`
- **bpal5dec:** `bpal5dec BPAL v5 (AVX2 runtime backend)`
- **astcenc:** `astcenc v5.6.0, 64-bit avx2+popcnt+f16c`
