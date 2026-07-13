# Texture codec benchmark results

Generated: `2026-07-13T15:08:48.559747+00:00`.

All profiles use the same normalized RGBA8 source pixels. Only RGB is scored; 
the run contains mip level 0 only. PSNR is measured in the stored byte domain. 
SSIM uses BT.709 luminance and an 11x11 Gaussian window with sigma 1.5.

## Tools

- **node:** `v22.22.3`
- **bpal5enc:** `bpal5enc BPAL v5 (AVX2 runtime backend)`
- **bpal5dec:** `bpal5dec BPAL v5 (AVX2 runtime backend)`
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
| BPAL 16x16 / 4 / 32 | 2.0789 | 2.0790 | 29.948 | 0.910826 | 15020.9 | 571.8 |
| BPAL 8x8 / 4 / 64 | 2.3765 | 2.3766 | 32.239 | 0.944744 | 25805.5 | 577.6 |
| BPAL C/SIMD v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 3.1571 | 31.860 | 0.929299 | 5503.4 | 125.7 |
| BPAL v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 3.1571 | 32.142 | 0.939392 | 17647.5 | 591.6 |
| BPAL v5 16x16 / 8 local / 32 palettes x 32 colors | 3.1992 | 3.1993 | 34.772 | 0.972216 | 38576.1 | 626.2 |
| BPAL C/SIMD v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 3.2267 | 34.733 | 0.971205 | 9795.8 | 116.3 |
| BPAL v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 3.2267 | 35.049 | 0.973903 | 44510.1 | 605.7 |
| BPAL C/SIMD v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 3.2775 | 34.998 | 0.972900 | 11180.4 | 117.2 |
| BPAL v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 3.2775 | 35.315 | 0.975272 | 53476.9 | 622.8 |
| ASTC 6x6 medium | 3.5695 | 3.5696 | 37.566 | 0.983309 | 914.7 | 1167.7 |
| BC1 uniform RGB | 4.0000 | 4.0010 | 35.640 | 0.976002 | 438.7 | 889.9 |
| BPAL 8x8 / 8 / 256 | 4.0059 | 4.0060 | 37.118 | 0.981338 | 114951.8 | 623.2 |
| ASTC 5x5 medium | 5.1300 | 5.1301 | 40.435 | 0.992565 | 1129.0 | 1328.5 |
| BPAL 8x8 / 16 / 256 | 6.0059 | 6.0060 | 39.008 | 0.985827 | 200551.8 | 654.8 |
| ASTC 4x4 medium | 8.0000 | 8.0001 | 43.889 | 0.996604 | 1369.1 | 1280.0 |
| BC7 max CPU | 8.0000 | 8.0011 | 44.135 | 0.996425 | 327437.1 | 1021.9 |

## Key comparisons

- **ASTC 8x8 medium vs BPAL 16x16 / 4 / 32:** +3.995 dB PSNR, +0.045835 SSIM, -0.0789 payload bpp.
- **BPAL v5 16x16 / 8 local / 64 palettes x 32 colors vs BPAL v5 16x16 / 8 local / 1 palette x 32 colors:** +2.907 dB PSNR, +0.034511 SSIM, +0.0696 payload bpp.
- **BPAL v5 16x16 / 8 local / 128 palettes x 32 colors vs BPAL v5 16x16 / 8 local / 64 palettes x 32 colors:** +0.266 dB PSNR, +0.001369 SSIM, +0.0508 payload bpp.
- **BPAL v5 16x16 / 8 local / 64 palettes x 32 colors vs BPAL v5 16x16 / 8 local / 32 palettes x 32 colors:** +0.277 dB PSNR, +0.001687 SSIM, +0.0273 payload bpp.
- **BPAL C/SIMD v5 16x16 / 8 local / 64 palettes x 32 colors vs BPAL C/SIMD v5 16x16 / 8 local / 1 palette x 32 colors:** +2.873 dB PSNR, +0.041905 SSIM, +0.0696 payload bpp.
- **BPAL C/SIMD v5 16x16 / 8 local / 128 palettes x 32 colors vs BPAL C/SIMD v5 16x16 / 8 local / 64 palettes x 32 colors:** +0.265 dB PSNR, +0.001695 SSIM, +0.0508 payload bpp.
- **BPAL v5 16x16 / 8 local / 64 palettes x 32 colors vs BPAL C/SIMD v5 16x16 / 8 local / 64 palettes x 32 colors:** +0.316 dB PSNR, +0.002698 SSIM, +0.0000 payload bpp.
- **ASTC 6x6 medium vs BPAL v5 16x16 / 8 local / 64 palettes x 32 colors:** +2.517 dB PSNR, +0.009406 SSIM, +0.3429 payload bpp.
- **BC1 uniform RGB vs BPAL v5 16x16 / 8 local / 64 palettes x 32 colors:** +0.591 dB PSNR, +0.002100 SSIM, +0.7734 payload bpp.
- **BPAL 8x8 / 8 / 256 vs BC1 uniform RGB:** +1.478 dB PSNR, +0.005336 SSIM, +0.0059 payload bpp.
- **ASTC 6x6 medium vs BPAL 8x8 / 8 / 256:** +0.448 dB PSNR, +0.001971 SSIM, -0.4364 payload bpp.
- **ASTC 5x5 medium vs BPAL 8x8 / 16 / 256:** +1.427 dB PSNR, +0.006739 SSIM, -0.8759 payload bpp.
- **BC7 max CPU vs ASTC 4x4 medium:** +0.246 dB PSNR, -0.000179 SSIM, +0.0000 payload bpp.

Aggregate PSNR is calculated from total squared RGB error, not by averaging dB. 
Aggregate SSIM is weighted by source pixel count.

## Per-image results

| Image | Profile | Payload bpp | PSNR RGB (dB) | SSIM luma |
| --- | --- | ---: | ---: | ---: |
| clic-01-alexander-shustov-73 | BPAL 16x16 / 4 / 32 | 2.0789 | 25.033 | 0.859795 |
| clic-01-alexander-shustov-73 | BPAL 8x8 / 4 / 64 | 2.3765 | 27.254 | 0.910214 |
| clic-01-alexander-shustov-73 | ASTC 8x8 medium | 2.0000 | 29.750 | 0.947199 |
| clic-01-alexander-shustov-73 | ASTC 6x6 medium | 3.5695 | 33.395 | 0.980037 |
| clic-01-alexander-shustov-73 | BPAL v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 27.002 | 0.902138 |
| clic-01-alexander-shustov-73 | BPAL v5 16x16 / 8 local / 32 palettes x 32 colors | 3.1992 | 29.476 | 0.952101 |
| clic-01-alexander-shustov-73 | BPAL v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 29.746 | 0.954517 |
| clic-01-alexander-shustov-73 | BPAL v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 30.031 | 0.957168 |
| clic-01-alexander-shustov-73 | BPAL C/SIMD v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 26.935 | 0.891011 |
| clic-01-alexander-shustov-73 | BPAL C/SIMD v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 29.507 | 0.950442 |
| clic-01-alexander-shustov-73 | BPAL C/SIMD v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 29.768 | 0.953608 |
| clic-01-alexander-shustov-73 | BPAL 8x8 / 8 / 256 | 4.0059 | 32.122 | 0.969374 |
| clic-01-alexander-shustov-73 | BC1 uniform RGB | 4.0000 | 31.302 | 0.969347 |
| clic-01-alexander-shustov-73 | ASTC 5x5 medium | 5.1300 | 36.234 | 0.991138 |
| clic-01-alexander-shustov-73 | BPAL 8x8 / 16 / 256 | 6.0059 | 33.984 | 0.976666 |
| clic-01-alexander-shustov-73 | ASTC 4x4 medium | 8.0000 | 39.980 | 0.996741 |
| clic-01-alexander-shustov-73 | BC7 max CPU | 8.0000 | 40.459 | 0.996667 |
| clic-02-casey-fyfe-999 | BPAL 16x16 / 4 / 32 | 2.0789 | 36.708 | 0.942675 |
| clic-02-casey-fyfe-999 | BPAL 8x8 / 4 / 64 | 2.3765 | 38.413 | 0.959377 |
| clic-02-casey-fyfe-999 | ASTC 8x8 medium | 2.0000 | 37.782 | 0.933082 |
| clic-02-casey-fyfe-999 | ASTC 6x6 medium | 3.5695 | 41.026 | 0.977866 |
| clic-02-casey-fyfe-999 | BPAL v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 38.356 | 0.963184 |
| clic-02-casey-fyfe-999 | BPAL v5 16x16 / 8 local / 32 palettes x 32 colors | 3.1992 | 41.212 | 0.982319 |
| clic-02-casey-fyfe-999 | BPAL v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 41.359 | 0.982903 |
| clic-02-casey-fyfe-999 | BPAL v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 41.485 | 0.983246 |
| clic-02-casey-fyfe-999 | BPAL C/SIMD v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 38.210 | 0.951038 |
| clic-02-casey-fyfe-999 | BPAL C/SIMD v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 41.179 | 0.981840 |
| clic-02-casey-fyfe-999 | BPAL C/SIMD v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 41.314 | 0.982437 |
| clic-02-casey-fyfe-999 | BPAL 8x8 / 8 / 256 | 4.0059 | 42.387 | 0.986685 |
| clic-02-casey-fyfe-999 | BC1 uniform RGB | 4.0000 | 39.366 | 0.971524 |
| clic-02-casey-fyfe-999 | ASTC 5x5 medium | 5.1300 | 43.406 | 0.991310 |
| clic-02-casey-fyfe-999 | BPAL 8x8 / 16 / 256 | 6.0059 | 44.373 | 0.991827 |
| clic-02-casey-fyfe-999 | ASTC 4x4 medium | 8.0000 | 46.018 | 0.994869 |
| clic-02-casey-fyfe-999 | BC7 max CPU | 8.0000 | 46.074 | 0.994942 |
| clic-03-juskteez-vu-1041 | BPAL 16x16 / 4 / 32 | 2.0789 | 30.442 | 0.922082 |
| clic-03-juskteez-vu-1041 | BPAL 8x8 / 4 / 64 | 2.3765 | 32.291 | 0.944983 |
| clic-03-juskteez-vu-1041 | ASTC 8x8 medium | 2.0000 | 30.626 | 0.899667 |
| clic-03-juskteez-vu-1041 | ASTC 6x6 medium | 3.5695 | 34.850 | 0.966418 |
| clic-03-juskteez-vu-1041 | BPAL v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 33.014 | 0.963561 |
| clic-03-juskteez-vu-1041 | BPAL v5 16x16 / 8 local / 32 palettes x 32 colors | 3.1992 | 35.926 | 0.978294 |
| clic-03-juskteez-vu-1041 | BPAL v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 36.191 | 0.979293 |
| clic-03-juskteez-vu-1041 | BPAL v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 36.454 | 0.980080 |
| clic-03-juskteez-vu-1041 | BPAL C/SIMD v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 32.567 | 0.954975 |
| clic-03-juskteez-vu-1041 | BPAL C/SIMD v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 35.700 | 0.977513 |
| clic-03-juskteez-vu-1041 | BPAL C/SIMD v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 35.976 | 0.978168 |
| clic-03-juskteez-vu-1041 | BPAL 8x8 / 8 / 256 | 4.0059 | 37.641 | 0.985199 |
| clic-03-juskteez-vu-1041 | BC1 uniform RGB | 4.0000 | 34.358 | 0.965443 |
| clic-03-juskteez-vu-1041 | ASTC 5x5 medium | 5.1300 | 38.726 | 0.988736 |
| clic-03-juskteez-vu-1041 | BPAL 8x8 / 16 / 256 | 6.0059 | 39.805 | 0.991072 |
| clic-03-juskteez-vu-1041 | ASTC 4x4 medium | 8.0000 | 42.558 | 0.996697 |
| clic-03-juskteez-vu-1041 | BC7 max CPU | 8.0000 | 42.624 | 0.995947 |
| clic-04-davide-ragusa-716 | BPAL 16x16 / 4 / 32 | 2.0789 | 33.563 | 0.949423 |
| clic-04-davide-ragusa-716 | BPAL 8x8 / 4 / 64 | 2.3765 | 35.699 | 0.963737 |
| clic-04-davide-ragusa-716 | ASTC 8x8 medium | 2.0000 | 39.559 | 0.979089 |
| clic-04-davide-ragusa-716 | ASTC 6x6 medium | 3.5695 | 42.319 | 0.989466 |
| clic-04-davide-ragusa-716 | BPAL v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 34.755 | 0.959551 |
| clic-04-davide-ragusa-716 | BPAL v5 16x16 / 8 local / 32 palettes x 32 colors | 3.1992 | 39.825 | 0.984850 |
| clic-04-davide-ragusa-716 | BPAL v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 40.173 | 0.986228 |
| clic-04-davide-ragusa-716 | BPAL v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 40.470 | 0.987261 |
| clic-04-davide-ragusa-716 | BPAL C/SIMD v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 34.585 | 0.958636 |
| clic-04-davide-ragusa-716 | BPAL C/SIMD v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 39.885 | 0.985163 |
| clic-04-davide-ragusa-716 | BPAL C/SIMD v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 40.166 | 0.986119 |
| clic-04-davide-ragusa-716 | BPAL 8x8 / 8 / 256 | 4.0059 | 40.750 | 0.985782 |
| clic-04-davide-ragusa-716 | BC1 uniform RGB | 4.0000 | 39.299 | 0.982951 |
| clic-04-davide-ragusa-716 | ASTC 5x5 medium | 5.1300 | 44.566 | 0.993911 |
| clic-04-davide-ragusa-716 | BPAL 8x8 / 16 / 256 | 6.0059 | 42.070 | 0.987951 |
| clic-04-davide-ragusa-716 | ASTC 4x4 medium | 8.0000 | 47.684 | 0.996921 |
| clic-04-davide-ragusa-716 | BC7 max CPU | 8.0000 | 48.117 | 0.997192 |
| clic-05-clem-onojeghuo-33741 | BPAL 16x16 / 4 / 32 | 2.0789 | 32.297 | 0.918838 |
| clic-05-clem-onojeghuo-33741 | BPAL 8x8 / 4 / 64 | 2.3765 | 34.457 | 0.952021 |
| clic-05-clem-onojeghuo-33741 | ASTC 8x8 medium | 2.0000 | 35.316 | 0.967353 |
| clic-05-clem-onojeghuo-33741 | ASTC 6x6 medium | 3.5695 | 38.460 | 0.985050 |
| clic-05-clem-onojeghuo-33741 | BPAL v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 34.994 | 0.941264 |
| clic-05-clem-onojeghuo-33741 | BPAL v5 16x16 / 8 local / 32 palettes x 32 colors | 3.1992 | 37.233 | 0.975673 |
| clic-05-clem-onojeghuo-33741 | BPAL v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 37.401 | 0.976652 |
| clic-05-clem-onojeghuo-33741 | BPAL v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 37.548 | 0.977474 |
| clic-05-clem-onojeghuo-33741 | BPAL C/SIMD v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 34.267 | 0.924625 |
| clic-05-clem-onojeghuo-33741 | BPAL C/SIMD v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 37.026 | 0.974309 |
| clic-05-clem-onojeghuo-33741 | BPAL C/SIMD v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 37.204 | 0.975696 |
| clic-05-clem-onojeghuo-33741 | BPAL 8x8 / 8 / 256 | 4.0059 | 39.241 | 0.983760 |
| clic-05-clem-onojeghuo-33741 | BC1 uniform RGB | 4.0000 | 36.463 | 0.976365 |
| clic-05-clem-onojeghuo-33741 | ASTC 5x5 medium | 5.1300 | 40.694 | 0.991424 |
| clic-05-clem-onojeghuo-33741 | BPAL 8x8 / 16 / 256 | 6.0059 | 41.543 | 0.987595 |
| clic-05-clem-onojeghuo-33741 | ASTC 4x4 medium | 8.0000 | 43.755 | 0.995429 |
| clic-05-clem-onojeghuo-33741 | BC7 max CPU | 8.0000 | 44.343 | 0.995412 |
| clic-06-jeremy-cai-1174 | BPAL 16x16 / 4 / 32 | 2.0789 | 28.228 | 0.870682 |
| clic-06-jeremy-cai-1174 | BPAL 8x8 / 4 / 64 | 2.3765 | 31.186 | 0.930227 |
| clic-06-jeremy-cai-1174 | ASTC 8x8 medium | 2.0000 | 36.593 | 0.981362 |
| clic-06-jeremy-cai-1174 | ASTC 6x6 medium | 3.5695 | 39.843 | 0.991397 |
| clic-06-jeremy-cai-1174 | BPAL v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 31.076 | 0.924121 |
| clic-06-jeremy-cai-1174 | BPAL v5 16x16 / 8 local / 32 palettes x 32 colors | 3.1992 | 32.796 | 0.955135 |
| clic-06-jeremy-cai-1174 | BPAL v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 33.093 | 0.957513 |
| clic-06-jeremy-cai-1174 | BPAL v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 33.364 | 0.959468 |
| clic-06-jeremy-cai-1174 | BPAL C/SIMD v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 30.735 | 0.914820 |
| clic-06-jeremy-cai-1174 | BPAL C/SIMD v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 32.755 | 0.953783 |
| clic-06-jeremy-cai-1174 | BPAL C/SIMD v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 33.046 | 0.955973 |
| clic-06-jeremy-cai-1174 | BPAL 8x8 / 8 / 256 | 4.0059 | 35.983 | 0.975036 |
| clic-06-jeremy-cai-1174 | BC1 uniform RGB | 4.0000 | 36.245 | 0.980209 |
| clic-06-jeremy-cai-1174 | ASTC 5x5 medium | 5.1300 | 42.286 | 0.995520 |
| clic-06-jeremy-cai-1174 | BPAL 8x8 / 16 / 256 | 6.0059 | 37.765 | 0.980970 |
| clic-06-jeremy-cai-1174 | ASTC 4x4 medium | 8.0000 | 45.566 | 0.997900 |
| clic-06-jeremy-cai-1174 | BC7 max CPU | 8.0000 | 45.362 | 0.997475 |
| clic-07-michael-durana-82941 | BPAL 16x16 / 4 / 32 | 2.0789 | 31.474 | 0.920963 |
| clic-07-michael-durana-82941 | BPAL 8x8 / 4 / 64 | 2.3765 | 33.342 | 0.952662 |
| clic-07-michael-durana-82941 | ASTC 8x8 medium | 2.0000 | 34.264 | 0.970389 |
| clic-07-michael-durana-82941 | ASTC 6x6 medium | 3.5695 | 37.772 | 0.987240 |
| clic-07-michael-durana-82941 | BPAL v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 33.485 | 0.932966 |
| clic-07-michael-durana-82941 | BPAL v5 16x16 / 8 local / 32 palettes x 32 colors | 3.1992 | 36.486 | 0.979417 |
| clic-07-michael-durana-82941 | BPAL v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 36.843 | 0.982218 |
| clic-07-michael-durana-82941 | BPAL v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 37.069 | 0.983417 |
| clic-07-michael-durana-82941 | BPAL C/SIMD v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 32.730 | 0.917202 |
| clic-07-michael-durana-82941 | BPAL C/SIMD v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 36.469 | 0.978582 |
| clic-07-michael-durana-82941 | BPAL C/SIMD v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 36.734 | 0.980644 |
| clic-07-michael-durana-82941 | BPAL 8x8 / 8 / 256 | 4.0059 | 37.916 | 0.982322 |
| clic-07-michael-durana-82941 | BC1 uniform RGB | 4.0000 | 36.005 | 0.980713 |
| clic-07-michael-durana-82941 | ASTC 5x5 medium | 5.1300 | 40.431 | 0.993249 |
| clic-07-michael-durana-82941 | BPAL 8x8 / 16 / 256 | 6.0059 | 40.002 | 0.984700 |
| clic-07-michael-durana-82941 | ASTC 4x4 medium | 8.0000 | 43.847 | 0.996622 |
| clic-07-michael-durana-82941 | BC7 max CPU | 8.0000 | 43.878 | 0.996509 |
| clic-08-zugr-108 | BPAL 16x16 / 4 / 32 | 2.0789 | 32.251 | 0.902150 |
| clic-08-zugr-108 | BPAL 8x8 / 4 / 64 | 2.3765 | 35.087 | 0.944733 |
| clic-08-zugr-108 | ASTC 8x8 medium | 2.0000 | 38.637 | 0.975151 |
| clic-08-zugr-108 | ASTC 6x6 medium | 3.5695 | 41.841 | 0.988997 |
| clic-08-zugr-108 | BPAL v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 34.377 | 0.928353 |
| clic-08-zugr-108 | BPAL v5 16x16 / 8 local / 32 palettes x 32 colors | 3.1992 | 37.855 | 0.969935 |
| clic-08-zugr-108 | BPAL v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 38.170 | 0.971899 |
| clic-08-zugr-108 | BPAL v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 38.549 | 0.974062 |
| clic-08-zugr-108 | BPAL C/SIMD v5 16x16 / 8 local / 1 palette x 32 colors | 3.1570 | 34.169 | 0.922087 |
| clic-08-zugr-108 | BPAL C/SIMD v5 16x16 / 8 local / 64 palettes x 32 colors | 3.2266 | 37.755 | 0.968005 |
| clic-08-zugr-108 | BPAL C/SIMD v5 16x16 / 8 local / 128 palettes x 32 colors | 3.2773 | 38.099 | 0.970552 |
| clic-08-zugr-108 | BPAL 8x8 / 8 / 256 | 4.0059 | 40.314 | 0.982546 |
| clic-08-zugr-108 | BC1 uniform RGB | 4.0000 | 38.915 | 0.981469 |
| clic-08-zugr-108 | ASTC 5x5 medium | 5.1300 | 44.412 | 0.995234 |
| clic-08-zugr-108 | BPAL 8x8 / 16 / 256 | 6.0059 | 41.859 | 0.985833 |
| clic-08-zugr-108 | ASTC 4x4 medium | 8.0000 | 47.553 | 0.997651 |
| clic-08-zugr-108 | BC7 max CPU | 8.0000 | 47.661 | 0.997254 |

## Limitations

- This is a rate-distortion benchmark, not a GPU sampling benchmark.
- Command timings are cold wall times and include process startup and file I/O.
- BPAL, BC, and ASTC are optimized in the stored 8-bit value domain for this run.
- The default corpus is an eight-image deterministic subset of CLIC 2020.
- Alpha, HDR, normal-map angular error, and mip downsampling are not covered.
