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

void bpal5_expand_avx2(
    const uint32_t *local_rgba,
    const uint8_t *indices,
    uint32_t *output_rgba,
    size_t count
);
#endif

bpal5_nearest_fn bpal5_select_nearest(int use_simd);
bpal5_expand_fn bpal5_select_expand(int use_simd);

#endif
