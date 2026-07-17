# Hybrid BPDH versus ASTC at a 4 bpp target

Generated: `2026-07-17T10:17:55.312637+00:00`.

## Methodology

- Corpus: 200 deterministic 128x128 center crops (ambientcg 55, dtd 100, kylberg 45).
- BPDH searched 5 BPAL parameter families and 12 DCT quality values per image. The selected serialized candidate has the lowest exact stored-byte RGB error at no more than 4 payload bpp.
- ASTC was encoded and decoded at every measured block footprint with `astcenc linear LDR -medium`. ASTC has no standard 2D footprint at exactly 4.0 bpp, so exact-rate values interpolate pooled quality between neighboring measured points.
- Payload bpp excludes the BPDH and ASTC container headers but includes real byte rounding and block-grid padding. RGB PSNR pools squared error over all images; luma SSIM is the arithmetic mean of per-image values.

## Result

| Codec / comparison | Payload bpp | RGB PSNR | Mean luma SSIM |
|:---|---:|---:|---:|
| BPDH, 4 bpp limit | 3.8915 measured | 36.043 dB | 0.982218 |
| ASTC at 4 bpp | 4.0000 interpolated | 36.611 dB | 0.984972 |
| BPDH - ASTC at the 4 bpp target | - | **-0.569 dB** | -0.002753 |
| ASTC at BPDH's measured 3.8915 bpp | 3.8915 interpolated | 36.362 dB | 0.984091 |
| BPDH - rate-matched ASTC | - | **-0.319 dB** | -0.001873 |

BPDH used 3.8915 bpp of its 4 bpp allowance. The target comparison therefore does not credit BPDH for unused bytes; the rate-matched row separately compares both codecs at BPDH's measured aggregate rate.

## Measured ASTC operating points

| Footprint | Theoretical bpp | Measured payload bpp | RGB PSNR | Mean luma SSIM |
|:---:|---:|---:|---:|---:|
| 8x8 | 2.0000 | 2.0000 | 32.106 dB | 0.955976 |
| 8x6 | 2.6667 | 2.7500 | 33.903 dB | 0.971353 |
| 8x5 | 3.2000 | 3.2500 | 35.199 dB | 0.979247 |
| 6x6 | 3.5556 | 3.7812 | 36.102 dB | 0.983172 |
| 6x5 | 4.2667 | 4.4688 | 37.615 dB | 0.988518 |

## BPDH mode usage

| Metric | Result |
|:---|---:|
| BPAL coding units | 5,729 (44.76%) |
| DCT coding units | 7,071 (55.24%) |
| Mixed BPAL+DCT images | 136 / 200 |
| Pure BPAL images | 10 / 200 |
| Pure DCT images | 54 / 200 |

## Dataset consistency

| Dataset | Images | BPDH bpp | BPDH PSNR | BPDH - ASTC at 4 bpp | BPDH - rate-matched ASTC |
|:---|---:|---:|---:|---:|---:|
| ambientcg | 55 | 3.8248 | 34.489 dB | -0.761 dB | -0.493 dB |
| dtd | 100 | 3.9122 | 36.541 dB | +0.096 dB | +0.319 dB |
| kylberg | 45 | 3.9269 | 37.500 dB | -2.513 dB | -2.224 dB |

## BPDH payload composition

| Section | Mean bytes / image | Share of payload |
|:---|---:|---:|
| Shared BPAL palettes | 591.4 | 7.42% |
| DCT quantization tables | 121.6 | 1.53% |
| BPAL/DCT mode map | 5.4 | 0.07% |
| Sparse BPAL records | 3280.4 | 41.16% |
| Sparse DCT records | 3970.9 | 49.82% |

## Selected BPDH parameter families

| BPAL family searched inside BPDH | Selected images |
|:---|---:|
| L16 / G64 / P4 / RGB888 | 128 |
| L8 / G32 / P8 / RGB888 | 61 |
| L8 / G32 / P16 / RGB888 | 8 |
| L4 / G16 / P16 / RGB888 | 3 |

## Process timings

Timings include process startup and file I/O and are included only as a reproducibility diagnostic, not as a runtime decoder comparison.

- BPDH selected-candidate encode: 364.2 ms/image; decode: 63.0 ms/image.
- ASTC 6x6 encode: 12.1 ms/image; decode: 12.1 ms/image.
- ASTC 6x5 encode: 12.2 ms/image; decode: 11.8 ms/image.

## Tools

- **node:** `v22.22.3` (`C:\Program Files\nodejs\node.exe`)
- **astcenc:** `astcenc v5.6.0, 64-bit avx2+popcnt+f16c` (`C:\Work\block-palette-compression\.benchmark-tools\astcenc-5.6.0\bin\astcenc-avx2.exe`)

## Limitations

- The exact 4 bpp ASTC result is an interpolation because ASTC exposes only discrete standard block footprints; both bracketing bitstreams were actually encoded and decoded.
- Results use 128x128 center crops and linear-LDR RGB error. They do not cover alpha, HDR, mip chains, texture filtering, or normal-map angular error.
- BPDH is the project's research JS encoder with fixed searched parameter families. A broader joint palette search may move its frontier.
- Encoder and decoder process timings are not comparable implementation-speed measurements: BPDH is JavaScript while astcenc is optimized native code.

## Reproduction

```text
python tools/hybrid_bpdh_astc_4bpp_benchmark.py --corpus-root .benchmark-corpus --astcenc .benchmark-tools/astcenc-5.6.0/bin/astcenc-avx2.exe
```
