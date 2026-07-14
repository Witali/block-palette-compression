# BPAV adaptive-block texture experiment

Generated: 2026-07-14.

## Conclusion

The optional BPAV v1 supertile format reduced the aggregate file size by
**1.11%** at the same or lower RGB squared error than the best tested uniform
block-size candidate. The comparison includes every format byte. Twelve of the
200 images selected BPAV; the other 188 retained a uniform BPAL representation,
so the hybrid selection did not make any image larger or less accurate.

The gain is concentrated in large 2K PBR textures. None of the smaller DTD or
Kylberg images benefited after the additional palette and directory costs were
included.

## Methodology

- Corpus: the same deterministic 200-image selection as the CUDA BPAL versus
  ASTC benchmark: 100 DTD, 45 Kylberg, and all 55 selected ambientCG maps.
- Resolution: every candidate was encoded and scored at the full source
  resolution. No proxy or downscaled image was used for the reported result.
- Encoder: CUDA BPAL encoder, four refinement passes.
- Shared settings: four local colors, 64 global colors, 32 shared palettes,
  RGB888 palette storage.
- Uniform candidates: block sizes 4, 8, 16, and 32.
- Adaptive candidates: a 64x64 supertile independently selected B4, B8, B16,
  or B32 using a Lagrangian search over tile SSE and descriptor bytes.
- Uniform reference: for each image, the smallest uniform candidate whose SSE
  was no worse than its B8 candidate. This prevents an adaptive result from
  claiming savings that ordinary whole-image block-size selection already
  provides.
- Selection gate: BPAV was selected only when its aligned file was smaller than
  the uniform reference and its SSE was no greater.
- Size accounting: 32-byte header, one complete palette table per used mode,
  palette alignment, four-byte directory entry per supertile, byte alignment
  of every supertile descriptor stream, dense pixel-index stream, and final
  four-byte GPU alignment.

The experiment performed 800 full-resolution CUDA encodes. It also checked
4,096 independently addressed pixels per image (819,200 queries total) against
the corresponding full mixed reconstruction.

## Aggregate result

| Selection | Images | Bytes | Change | Pooled RGB PSNR |
| --- | ---: | ---: | ---: | ---: |
| Best qualifying uniform B4/B8/B16/B32 | 200 | 78,346,750 | baseline | 31.5742 dB |
| Uniform or BPAV, whichever passes the RD gate | 200 | 77,473,566 | **-1.1145%** | 31.5760 dB |

The selected files save 873,184 bytes and also reduce aggregate squared error
slightly; pooled PSNR increases by 0.0018 dB. The small pooled PSNR change is
expected because this operating point intentionally minimizes bytes while
requiring quality to be no worse, rather than maximizing quality at a fixed
rate.

## Result by dataset

| Dataset | Images | Uniform bytes | Selected bytes | Change | BPAV files |
| --- | ---: | ---: | ---: | ---: | ---: |
| DTD | 100 | 7,960,382 | 7,960,382 | 0.00% | 0 |
| Kylberg | 45 | 4,855,230 | 4,855,230 | 0.00% | 0 |
| ambientCG | 55 | 65,531,138 | 64,657,954 | **-1.33%** | 12 |
| **All** | **200** | **78,346,750** | **77,473,566** | **-1.11%** | **12** |

## Selected adaptive files

| Image | Size change | PSNR change |
| --- | ---: | ---: |
| Bricks060 AmbientOcclusion | -0.54% | +0.0313 dB |
| Bricks060 Displacement | -0.53% | +0.0273 dB |
| Bricks060 NormalGL | -0.36% | +0.0345 dB |
| Fabric019 Opacity | -3.69% | +0.0205 dB |
| Ground037 AmbientOcclusion | -1.22% | +0.0237 dB |
| Marble012 NormalGL | -16.33% | +0.0042 dB |
| Metal032 NormalGL | -16.33% | +0.0020 dB |
| Rock035 Displacement | -4.45% | +0.0171 dB |
| Tiles107 Color | -8.17% | +0.0094 dB |
| Tiles107 Displacement | -1.80% | +0.1001 dB |
| Tiles107 NormalGL | -7.92% | +0.0057 dB |
| Tiles107 Roughness | -6.23% | +0.3194 dB |

Across the selected files, the directory chose 307 B4, 5,520 B8, 2,609 B16,
and 3,852 B32 supertiles. The mixture confirms that the result is not merely a
different whole-image block size.

## Deterministic random access and GPU layout

Each 64x64 supertile has one 32-bit directory word containing a two-bit mode and
a 30-bit byte offset. Pixel lookup is:

1. calculate the supertile index directly from `(x, y)`;
2. read its mode and block-stream offset;
3. calculate the local block index with integer shifts/divisions;
4. read the dense local pixel index and selected block palette entries;
5. read the final mode-palette color.

There is no tree traversal, neighbor dependency, entropy state, or
data-dependent loop. The shader-equivalent reference path uses aligned 32-bit
loads and has a fixed upper bound of eight reads per pixel, including packed
fields that cross word boundaries. The complete synthetic format test compares
every coordinate with the selected uniform candidate and the GPU-reference
path.

## Tests

- Full `npm test` suite passed.
- BPAV RGB888 and RGB565 encode/open tests passed.
- Every pixel in a six-supertile edge-case image matched its selected B4/B8/B16/B32 candidate.
- The aligned-word GPU reference matched the scalar accessor for every pixel
  and never exceeded eight reads.
- Invalid modes, offsets, truncation, and nonzero alignment bytes were rejected.
- Repeated encoding produced byte-identical output.

## Limitations

- Only the 2.5-bpp settings family (L4, G64, P32, RGB888) was measured. Other
  local/global palette sizes need separate RD searches.
- The JavaScript implementation and aligned-word GPU reference establish the
  format and sampling algorithm. A production CUDA/GLSL kernel still needs
  integration and device-specific throughput profiling.
- A separate palette table is stored for every used mode. Sharing palette
  tables may improve small-image behavior but was not assumed in these results.
- BPAV is an experimental side format. The encoder should continue emitting
  ordinary BPAL whenever the adaptive RD gate does not pass.
