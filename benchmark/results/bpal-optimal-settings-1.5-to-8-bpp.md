# Optimal BPAL settings for 1.5–8 bpp

Research date: July 14, 2026.

The reproduction scripts and instructions are saved in [`benchmark/profile_search`](../profile_search/README.md).

## Conclusion

For the highest objective quality under a size constraint, use explicit palettes, RGB888, the RGB color space, K-means, diversity 0, no dithering, and four refinement passes. These parameters are the same across all eight selected modes; as the budget grows, the local color count changes first, followed by the allocation of overhead bits between the number and size of shared palettes.

The primary selection criterion was aggregate RGB PSNR at an actual payload bpp no greater than the target. SSIM was used as an additional metric. The 2.5, 4, and 8 bpp settings have close alternatives with slightly higher SSIM but slightly lower PSNR; they are listed in a separate table below.

The most important practical findings are:

- keep four refinement passes enabled: they improve reconstruction without increasing the BPAL file size;
- RGB888 outperformed RGB565 in every finalist;
- RGB outperformed OKLab when the objective was to maximize RGB PSNR;
- every tested dithering method reduced PSNR; dithering may still be subjectively useful against banding, but not for the selected criterion;
- shared palettes containing 1024 or 4096 colors provided no benefit and were substantially slower than variants using 8–256 colors;
- at 1.5–2 bpp, use 4×4 blocks with two local colors; at 2.5–3 bpp, use 8×8 blocks with four colors; at 4 bpp, use eight colors; at 5–6 bpp, use sixteen colors; at 8 bpp, the optimum returns to 4×4 blocks, now with eight local colors.

## Recommended settings

Common parameters for every row: `Explicit palettes`, `RGB`, `K-means`, `diversity = 0` (level 0 of 6), `No dithering`, `Refinement = 4`, `CPU`, and `RGB888`.

| Target bpp | Actual payload bpp | Block | Local colors | Colors per shared palette | Palette count | RGB PSNR, dB | Luma SSIM |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.5 | 1.437866 | 4×4 | 2 | 8 | 2 | 27.215 | 0.852337 |
| 2 | 1.943359 | 4×4 | 2 | 128 | 2 | 30.895 | 0.928238 |
| 2.5 | 2.500000 | 8×8 | 4 | 64 | 32 | 33.572 | 0.961853 |
| 3 | 2.968750 | 8×8 | 4 | 256 | 64 | 34.111 | 0.965245 |
| 4 | 3.984375 | 8×8 | 8 | 128 | 16 | 37.700 | 0.985998 |
| 5 | 4.898438 | 16×16 | 16 | 256 | 64 | 39.381 | 0.990455 |
| 6 | 5.921875 | 8×8 | 16 | 128 | 32 | 40.644 | 0.992723 |
| 8 | 7.750000 | 4×4 | 8 | 256 | 64 | 43.200 | 0.995860 |

An actual value below the target bpp is not an error: the available block, palette, and index sizes are discrete. The table selects the highest-PSNR configuration among the tested candidates that do not exceed the budget.

## If SSIM matters more than PSNR

In three modes, the highest tested SSIM did not coincide with the highest PSNR.

| Target bpp | Change from the main recommendation | Actual bpp | RGB PSNR, dB | PSNR change | Luma SSIM | SSIM change |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 2.5 | Replace K-means with K-medians | 2.500000 | 33.565 | −0.008 dB | 0.962017 | +0.000164 |
| 4 | Use 64 colors × 64 palettes instead of 128 colors × 16 palettes | 3.937500 | 37.637 | −0.063 dB | 0.986154 | +0.000156 |
| 8 | Replace K-means with K-medians | 7.750000 | 43.066 | −0.134 dB | 0.995866 | +0.000006 |

The differences are small. For one consistent, predictable configuration and maximum RGB PSNR, the main table remains the recommendation.

## Methodology

The study used a deterministic corpus of eight 1024×1024 center crops from CLIC 2020 Professional Validation photographs. Every image was evaluated in its stored 8-bit RGB representation without a transfer-function conversion.

The original 2–6 bpp study had four stages:

1. A fast structural screen of 222 configurations on one 256×256 crop. It tested block sizes 4, 8, 16, 32, and 64; 2, 4, 8, and 16 local colors; shared palettes with 8–256 colors; 1–128 palettes; and RGB565 versus RGB888.
2. Cross-image validation of 22 finalists on four crops, including targeted variants with 1024-color shared palettes.
3. Encoder-policy testing across RGB and OKLab; K-means, uniformly initialized K-means, and K-medians; diversity 0, 0.5, and 1; and no dithering, Bayer 2×2, Bayer 4×4, and Floyd–Steinberg.
4. Full-resolution validation of 15 profiles on all eight images with four refinement passes: 120 final encodes. Finalists were evaluated until close structural and policy results were resolved.

The 1.5 and 8 bpp extension added 419 completed encodes:

1. Structural screen: 141 configurations on one 256×256 crop. Palettes up to 256 colors were screened broadly, with 17 targeted 1024- and 4096-color variants added separately.
2. Cross-image validation of 20 structures on four crops: 80 encodes.
3. Testing of 55 structure-policy combinations on two crops: 110 encodes.
4. Full-resolution validation of 11 finalists on all eight images with four refinement passes: 88 encodes.

The two studies performed 981 tracked encodes in total. Every stage of the extended search, all full-resolution jobs, and SSIM calculation ran with eight concurrent worker processes or worker threads.

PSNR was calculated from the pooled RGB MSE across all eight images:

`PSNR = 10 × log10(255² / MSE)`.

SSIM was calculated on BT.709 luminance with an 11×11 Gaussian window and sigma 1.5; the result is the mean across the eight equally sized images.

For a 1024×1024 image, payload bpp was calculated as:

`log2(L) + (log2(P) + L × log2(G)) / B² + P × G × C / 1024²`,

where `B` is the block side length, `L` is the local color count, `G` is the number of colors per shared palette, `P` is the palette count, and `C` is 16 or 24 bits per color. The 14-byte BPAL v5 header is excluded from payload bpp; for a 1024×1024 image, it adds approximately 0.000107 bpp to the file size.

## Limitations

These are the best settings found within the tested search space and on this image corpus, not a mathematical proof of optimality for every image. The result depends on content and resolution because the relative cost of stored palettes changes with the pixel count. For substantially smaller images or specialized content—pixel art, UI assets, normal maps, and images with an alpha channel—the search should be repeated on a representative corpus. Alpha was not evaluated in this study.
