#ifndef BPAL5_SIMD_INTERNAL_H
#define BPAL5_SIMD_INTERNAL_H

#include <stddef.h>
#include <stdint.h>

typedef uint32_t (*bpal5_nearest_fn)(
    const uint32_t *palette_rgba,
    uint32_t color_count,
    uint8_t red,
    uint8_t green,
    uint8_t blue
);

typedef void (*bpal5_expand_fn)(
    const uint32_t *local_rgba,
    const uint8_t *indices,
    uint32_t *output_rgba,
    size_t count
);

uint32_t bpal5_nearest_scalar(
    const uint32_t *palette_rgba,
    uint32_t color_count,
    uint8_t red,
    uint8_t green,
    uint8_t blue
);

typedef uint64_t (*bpal5_block_score_fn)(
    const uint8_t *red,
    const uint8_t *green,
    const uint8_t *blue,
    const uint32_t *best_distances,
    uint32_t count,
    uint32_t color_rgba
);

typedef void (*bpal5_block_update_fn)(
    const uint8_t *red,
    const uint8_t *green,
    const uint8_t *blue,
    uint32_t *best_distances,
    uint32_t count,
    uint32_t color_rgba
);

void bpal5_expand_scalar(
    const uint32_t *local_rgba,
    const uint8_t *indices,
    uint32_t *output_rgba,
    size_t count
);

#if defined(BPAL5_HAVE_AVX2_IMPL)
uint32_t bpal5_nearest_avx2(
    const uint32_t *palette_rgba,
    uint32_t color_count,
    uint8_t red,
    uint8_t green,
    uint8_t blue
);

uint64_t bpal5_block_score_scalar(
    const uint8_t *red,
    const uint8_t *green,
    const uint8_t *blue,
    const uint32_t *best_distances,
    uint32_t count,
    uint32_t color_rgba
);

void bpal5_block_update_scalar(
    const uint8_t *red,
    const uint8_t *green,
    const uint8_t *blue,
    uint32_t *best_distances,
    uint32_t count,
    uint32_t color_rgba
);

void bpal5_expand_avx2(
    const uint32_t *local_rgba,
    const uint8_t *indices,
    uint32_t *output_rgba,
    size_t count
);

uint64_t bpal5_block_score_avx2(
    const uint8_t *red,
    const uint8_t *green,
    const uint8_t *blue,
    const uint32_t *best_distances,
    uint32_t count,
    uint32_t color_rgba
);

void bpal5_block_update_avx2(
    const uint8_t *red,
    const uint8_t *green,
    const uint8_t *blue,
    uint32_t *best_distances,
    uint32_t count,
    uint32_t color_rgba
);
#endif

bpal5_nearest_fn bpal5_select_nearest(int use_simd);
bpal5_expand_fn bpal5_select_expand(int use_simd);
void bpal5_select_block_kernels(
    int use_simd,
    bpal5_block_score_fn *score,
    bpal5_block_update_fn *update
);

#endif
