# BPAL weighted-center and source-color comparison

## Conclusion

The existing weighted K-means implementation already computes a center of mass:
each distinct RGB color is weighted by the number of source pixels that have
that color. A region with more pixels therefore pulls the cluster center more
strongly. Selecting the most frequent point directly would instead compute a
mode, not a center of mass, and would ignore the geometry of the other colors.

The added **K-medoids · source colors** mode keeps the density-aware weighted
center but snaps it to the nearest real source color assigned to the cluster.
The same constraint is applied during iterative refinement. This removes
synthetic averaged palette colors and can reduce visible hue substitution at
very low bit rates. It does not minimize squared error as well as K-means. The
project nevertheless uses K-medoids by default to prioritize source-color
fidelity; K-means remains available when minimum squared error is preferred.

On the eight-image test corpus, K-medoids made 100% of active palette entries
exact source colors at every tested rate. The PSNR cost was 0.011 dB at 1.5 bpp
and increased gradually to 0.084 dB at 3 bpp. Mean whole-image RGB bias improved
at 1.5 bpp but was slightly worse at the other rates. Consequently, K-medoids is
recommended when faithful dominant hues matter more than the lowest MSE and is
now the project default. Weighted K-means remains preferable for gradients and
PSNR and can still be selected explicitly.

## Results

| Target | Method | RGB PSNR | Mean RGB bias magnitude | Palette colors found in source | Mean elapsed time |
|---:|:---|---:|---:|---:|---:|
| 1.5 bpp | Weighted K-means | 27.215 dB | 0.1185 | 89.06% | 4,787 ms |
| 1.5 bpp | Source-snapped K-medoids | 27.205 dB | 0.1028 | 100.00% | 4,857 ms |
| 2 bpp | Weighted K-means | 30.895 dB | 0.0246 | 78.10% | 12,315 ms |
| 2 bpp | Source-snapped K-medoids | 30.844 dB | 0.0269 | 100.00% | 12,323 ms |
| 2.5 bpp | Weighted K-means | 33.572 dB | 0.0071 | 77.26% | 13,875 ms |
| 2.5 bpp | Source-snapped K-medoids | 33.500 dB | 0.0083 | 100.00% | 13,293 ms |
| 3 bpp | Weighted K-means | 34.111 dB | 0.0027 | 80.74% | 67,109 ms |
| 3 bpp | Source-snapped K-medoids | 34.028 dB | 0.0046 | 100.00% | 63,788 ms |

The elapsed times are per-process measurements while eight encodes run in
parallel. They show no systematic K-medoids slowdown, but they are not intended
as single-process throughput figures.

## Methodology

- Dataset: eight normalized 1024×1024 images from the CLIC 2020 Professional
  Validation corpus already used by the BPAL profile search.
- Profiles: the optimized 1.5, 2, 2.5, and 3 bpp RGB profiles.
- Encoder policy: no dithering, zero diversity, RGB888 palette entries, and four
  refinement passes.
- Parallelism: eight independent Node.js worker processes.
- PSNR: calculated from aggregate RGB MSE over the eight images.
- Mean RGB bias: magnitude of the corpus-average signed reconstruction error in
  the red, green, and blue channels. This detects a global tint but does not
  capture local hue shifts.
- Source-color ratio: active palette entries that exactly match at least one RGB
  color in the corresponding source image.

Reproduce the comparison from the repository root:

```powershell
node benchmark/profile_search/compare_centers.js --jobs 8
```

The detailed JSON report is generated at
`benchmark/work/centroid-comparison/report.json`.
