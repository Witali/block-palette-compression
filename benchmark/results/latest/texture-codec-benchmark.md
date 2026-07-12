# Texture codec benchmark results

Generated: `2026-07-12T15:35:00.836618+00:00`.

All profiles use the same normalized RGBA8 source pixels. Only RGB is scored; 
the run contains mip level 0 only. PSNR is measured in the stored byte domain. 
SSIM uses BT.709 luminance and an 11x11 Gaussian window with sigma 1.5.

## Tools

- **node:** `v22.22.3`
- **texconv:** `Microsoft (R) DirectX Texture Converter [DirectXTex] Version 2026.5.8.1`
- **astcenc:** `astcenc v5.6.0, 64-bit avx2+popcnt+f16c`

## Dataset

- **Source:** [CLIC 2020 Professional Validation](https://archive.compression.cc/2021/tasks/index.html)
- **Archive:** [official download](https://storage.googleapis.com/clic_datasets/clic2020_professional_valid.zip)
- **SHA-256:** `e56568e20ead6bd215b313fed260d1c98b9ba863540039f00892ab67b1e39baf`
- **License:** [official license text](https://data.vision.ee.ethz.ch/cvl/clic/LICENSE_professional_2020.txt)

## Aggregate rate-distortion

| Profile | Payload bpp | File bpp | PSNR RGB (dB) | SSIM luma | Encode (ms) | Decode (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ASTC 8x8 medium | 2.0000 | 2.0001 | 33.943 | 0.956661 | 1157.3 | 1087.1 |
| BPAL 16x16 / 4 / 32 | 2.0789 | 2.0790 | 29.892 | 0.910741 | 5023.1 | 567.2 |
| BPAL 8x8 / 4 / 64 | 2.3765 | 2.3766 | 32.189 | 0.944657 | 7964.3 | 548.0 |
| ASTC 6x6 medium | 3.5695 | 3.5696 | 37.566 | 0.983309 | 914.7 | 1167.7 |
| BC1 uniform RGB | 4.0000 | 4.0010 | 35.640 | 0.976002 | 438.7 | 889.9 |
| BPAL 8x8 / 8 / 256 | 4.0059 | 4.0060 | 37.019 | 0.981078 | 36885.1 | 599.1 |
| ASTC 5x5 medium | 5.1300 | 5.1301 | 40.435 | 0.992565 | 1129.0 | 1328.5 |
| BPAL 8x8 / 16 / 256 | 6.0059 | 6.0060 | 38.866 | 0.985575 | 53378.5 | 631.4 |
| ASTC 4x4 medium | 8.0000 | 8.0001 | 43.889 | 0.996604 | 1369.1 | 1280.0 |
| BC7 max CPU | 8.0000 | 8.0011 | 44.135 | 0.996425 | 327437.1 | 1021.9 |

## Key comparisons

- **ASTC 8x8 medium vs BPAL 16x16 / 4 / 32:** +4.051 dB PSNR, +0.045921 SSIM, -0.0789 payload bpp.
- **BPAL 8x8 / 8 / 256 vs BC1 uniform RGB:** +1.379 dB PSNR, +0.005076 SSIM, +0.0059 payload bpp.
- **ASTC 6x6 medium vs BPAL 8x8 / 8 / 256:** +0.547 dB PSNR, +0.002231 SSIM, -0.4364 payload bpp.
- **ASTC 5x5 medium vs BPAL 8x8 / 16 / 256:** +1.569 dB PSNR, +0.006990 SSIM, -0.8759 payload bpp.
- **BC7 max CPU vs ASTC 4x4 medium:** +0.246 dB PSNR, -0.000179 SSIM, +0.0000 payload bpp.

Aggregate PSNR is calculated from total squared RGB error, not by averaging dB. 
Aggregate SSIM is weighted by source pixel count.

## Per-image results

| Image | Profile | Payload bpp | PSNR RGB (dB) | SSIM luma |
| --- | --- | ---: | ---: | ---: |
| clic-01-alexander-shustov-73 | BPAL 16x16 / 4 / 32 | 2.0789 | 24.969 | 0.861534 |
| clic-01-alexander-shustov-73 | BPAL 8x8 / 4 / 64 | 2.3765 | 27.186 | 0.910908 |
| clic-01-alexander-shustov-73 | ASTC 8x8 medium | 2.0000 | 29.750 | 0.947199 |
| clic-01-alexander-shustov-73 | ASTC 6x6 medium | 3.5695 | 33.395 | 0.980037 |
| clic-01-alexander-shustov-73 | BPAL 8x8 / 8 / 256 | 4.0059 | 32.001 | 0.968950 |
| clic-01-alexander-shustov-73 | BC1 uniform RGB | 4.0000 | 31.302 | 0.969347 |
| clic-01-alexander-shustov-73 | ASTC 5x5 medium | 5.1300 | 36.234 | 0.991138 |
| clic-01-alexander-shustov-73 | BPAL 8x8 / 16 / 256 | 6.0059 | 33.792 | 0.976015 |
| clic-01-alexander-shustov-73 | ASTC 4x4 medium | 8.0000 | 39.980 | 0.996741 |
| clic-01-alexander-shustov-73 | BC7 max CPU | 8.0000 | 40.459 | 0.996667 |
| clic-02-casey-fyfe-999 | BPAL 16x16 / 4 / 32 | 2.0789 | 36.658 | 0.941544 |
| clic-02-casey-fyfe-999 | BPAL 8x8 / 4 / 64 | 2.3765 | 38.360 | 0.959381 |
| clic-02-casey-fyfe-999 | ASTC 8x8 medium | 2.0000 | 37.782 | 0.933082 |
| clic-02-casey-fyfe-999 | ASTC 6x6 medium | 3.5695 | 41.026 | 0.977866 |
| clic-02-casey-fyfe-999 | BPAL 8x8 / 8 / 256 | 4.0059 | 42.313 | 0.986396 |
| clic-02-casey-fyfe-999 | BC1 uniform RGB | 4.0000 | 39.366 | 0.971524 |
| clic-02-casey-fyfe-999 | ASTC 5x5 medium | 5.1300 | 43.406 | 0.991310 |
| clic-02-casey-fyfe-999 | BPAL 8x8 / 16 / 256 | 6.0059 | 44.313 | 0.991739 |
| clic-02-casey-fyfe-999 | ASTC 4x4 medium | 8.0000 | 46.018 | 0.994869 |
| clic-02-casey-fyfe-999 | BC7 max CPU | 8.0000 | 46.074 | 0.994942 |
| clic-03-juskteez-vu-1041 | BPAL 16x16 / 4 / 32 | 2.0789 | 30.373 | 0.922174 |
| clic-03-juskteez-vu-1041 | BPAL 8x8 / 4 / 64 | 2.3765 | 32.266 | 0.944652 |
| clic-03-juskteez-vu-1041 | ASTC 8x8 medium | 2.0000 | 30.626 | 0.899667 |
| clic-03-juskteez-vu-1041 | ASTC 6x6 medium | 3.5695 | 34.850 | 0.966418 |
| clic-03-juskteez-vu-1041 | BPAL 8x8 / 8 / 256 | 4.0059 | 37.586 | 0.985003 |
| clic-03-juskteez-vu-1041 | BC1 uniform RGB | 4.0000 | 34.358 | 0.965443 |
| clic-03-juskteez-vu-1041 | ASTC 5x5 medium | 5.1300 | 38.726 | 0.988736 |
| clic-03-juskteez-vu-1041 | BPAL 8x8 / 16 / 256 | 6.0059 | 39.749 | 0.990967 |
| clic-03-juskteez-vu-1041 | ASTC 4x4 medium | 8.0000 | 42.558 | 0.996697 |
| clic-03-juskteez-vu-1041 | BC7 max CPU | 8.0000 | 42.624 | 0.995947 |
| clic-04-davide-ragusa-716 | BPAL 16x16 / 4 / 32 | 2.0789 | 33.489 | 0.949309 |
| clic-04-davide-ragusa-716 | BPAL 8x8 / 4 / 64 | 2.3765 | 35.675 | 0.963702 |
| clic-04-davide-ragusa-716 | ASTC 8x8 medium | 2.0000 | 39.559 | 0.979089 |
| clic-04-davide-ragusa-716 | ASTC 6x6 medium | 3.5695 | 42.319 | 0.989466 |
| clic-04-davide-ragusa-716 | BPAL 8x8 / 8 / 256 | 4.0059 | 40.696 | 0.985688 |
| clic-04-davide-ragusa-716 | BC1 uniform RGB | 4.0000 | 39.299 | 0.982951 |
| clic-04-davide-ragusa-716 | ASTC 5x5 medium | 5.1300 | 44.566 | 0.993911 |
| clic-04-davide-ragusa-716 | BPAL 8x8 / 16 / 256 | 6.0059 | 42.007 | 0.987837 |
| clic-04-davide-ragusa-716 | ASTC 4x4 medium | 8.0000 | 47.684 | 0.996921 |
| clic-04-davide-ragusa-716 | BC7 max CPU | 8.0000 | 48.117 | 0.997192 |
| clic-05-clem-onojeghuo-33741 | BPAL 16x16 / 4 / 32 | 2.0789 | 32.267 | 0.918568 |
| clic-05-clem-onojeghuo-33741 | BPAL 8x8 / 4 / 64 | 2.3765 | 34.421 | 0.951867 |
| clic-05-clem-onojeghuo-33741 | ASTC 8x8 medium | 2.0000 | 35.316 | 0.967353 |
| clic-05-clem-onojeghuo-33741 | ASTC 6x6 medium | 3.5695 | 38.460 | 0.985050 |
| clic-05-clem-onojeghuo-33741 | BPAL 8x8 / 8 / 256 | 4.0059 | 39.171 | 0.983550 |
| clic-05-clem-onojeghuo-33741 | BC1 uniform RGB | 4.0000 | 36.463 | 0.976365 |
| clic-05-clem-onojeghuo-33741 | ASTC 5x5 medium | 5.1300 | 40.694 | 0.991424 |
| clic-05-clem-onojeghuo-33741 | BPAL 8x8 / 16 / 256 | 6.0059 | 41.453 | 0.987495 |
| clic-05-clem-onojeghuo-33741 | ASTC 4x4 medium | 8.0000 | 43.755 | 0.995429 |
| clic-05-clem-onojeghuo-33741 | BC7 max CPU | 8.0000 | 44.343 | 0.995412 |
| clic-06-jeremy-cai-1174 | BPAL 16x16 / 4 / 32 | 2.0789 | 28.195 | 0.870866 |
| clic-06-jeremy-cai-1174 | BPAL 8x8 / 4 / 64 | 2.3765 | 31.153 | 0.930372 |
| clic-06-jeremy-cai-1174 | ASTC 8x8 medium | 2.0000 | 36.593 | 0.981362 |
| clic-06-jeremy-cai-1174 | ASTC 6x6 medium | 3.5695 | 39.843 | 0.991397 |
| clic-06-jeremy-cai-1174 | BPAL 8x8 / 8 / 256 | 4.0059 | 35.872 | 0.974761 |
| clic-06-jeremy-cai-1174 | BC1 uniform RGB | 4.0000 | 36.245 | 0.980209 |
| clic-06-jeremy-cai-1174 | ASTC 5x5 medium | 5.1300 | 42.286 | 0.995520 |
| clic-06-jeremy-cai-1174 | BPAL 8x8 / 16 / 256 | 6.0059 | 37.621 | 0.980605 |
| clic-06-jeremy-cai-1174 | ASTC 4x4 medium | 8.0000 | 45.566 | 0.997900 |
| clic-06-jeremy-cai-1174 | BC7 max CPU | 8.0000 | 45.362 | 0.997475 |
| clic-07-michael-durana-82941 | BPAL 16x16 / 4 / 32 | 2.0789 | 31.399 | 0.920278 |
| clic-07-michael-durana-82941 | BPAL 8x8 / 4 / 64 | 2.3765 | 33.287 | 0.952113 |
| clic-07-michael-durana-82941 | ASTC 8x8 medium | 2.0000 | 34.264 | 0.970389 |
| clic-07-michael-durana-82941 | ASTC 6x6 medium | 3.5695 | 37.772 | 0.987240 |
| clic-07-michael-durana-82941 | BPAL 8x8 / 8 / 256 | 4.0059 | 37.819 | 0.982081 |
| clic-07-michael-durana-82941 | BC1 uniform RGB | 4.0000 | 36.005 | 0.980713 |
| clic-07-michael-durana-82941 | ASTC 5x5 medium | 5.1300 | 40.431 | 0.993249 |
| clic-07-michael-durana-82941 | BPAL 8x8 / 16 / 256 | 6.0059 | 39.871 | 0.984516 |
| clic-07-michael-durana-82941 | ASTC 4x4 medium | 8.0000 | 43.847 | 0.996622 |
| clic-07-michael-durana-82941 | BC7 max CPU | 8.0000 | 43.878 | 0.996509 |
| clic-08-zugr-108 | BPAL 16x16 / 4 / 32 | 2.0789 | 32.206 | 0.901651 |
| clic-08-zugr-108 | BPAL 8x8 / 4 / 64 | 2.3765 | 35.034 | 0.944257 |
| clic-08-zugr-108 | ASTC 8x8 medium | 2.0000 | 38.637 | 0.975151 |
| clic-08-zugr-108 | ASTC 6x6 medium | 3.5695 | 41.841 | 0.988997 |
| clic-08-zugr-108 | BPAL 8x8 / 8 / 256 | 4.0059 | 40.211 | 0.982198 |
| clic-08-zugr-108 | BC1 uniform RGB | 4.0000 | 38.915 | 0.981469 |
| clic-08-zugr-108 | ASTC 5x5 medium | 5.1300 | 44.412 | 0.995234 |
| clic-08-zugr-108 | BPAL 8x8 / 16 / 256 | 6.0059 | 41.710 | 0.985428 |
| clic-08-zugr-108 | ASTC 4x4 medium | 8.0000 | 47.553 | 0.997651 |
| clic-08-zugr-108 | BC7 max CPU | 8.0000 | 47.661 | 0.997254 |

## Limitations

- This is a rate-distortion benchmark, not a GPU sampling benchmark.
- Command timings are cold wall times and include process startup and file I/O.
- BPAL, BC, and ASTC are optimized in the stored 8-bit value domain for this run.
- The default corpus is an eight-image deterministic subset of CLIC 2020.
- Alpha, HDR, normal-map angular error, and mip downsampling are not covered.
