#include "bpal5_simd_internal.h"

#include <immintrin.h>
#include <limits.h>

static uint32_t horizontal_min_u32(__m256i values) {
    __m128i minimum = _mm_min_epu32(
        _mm256_castsi256_si128(values),
        _mm256_extracti128_si256(values, 1)
    );
    minimum = _mm_min_epu32(
        minimum,
        _mm_shuffle_epi32(minimum, _MM_SHUFFLE(1, 0, 3, 2))
    );
    minimum = _mm_min_epu32(
        minimum,
        _mm_shuffle_epi32(minimum, _MM_SHUFFLE(2, 3, 0, 1))
    );
    return (uint32_t)_mm_cvtsi128_si32(minimum);
}

static uint32_t first_matching_lane(__m256i values, uint32_t target) {
    const int mask = _mm256_movemask_ps(_mm256_castsi256_ps(
        _mm256_cmpeq_epi32(values, _mm256_set1_epi32((int)target))
    ));
#if defined(_MSC_VER)
    unsigned long lane;
    _BitScanForward(&lane, (unsigned long)mask);
    return (uint32_t)lane;
#else
    return (uint32_t)__builtin_ctz((unsigned int)mask);
#endif
}

static __m256i block_distances8(
    const uint8_t *red,
    const uint8_t *green,
    const uint8_t *blue,
    __m256i target_red,
    __m256i target_green,
    __m256i target_blue
) {
    const __m256i reds = _mm256_cvtepu8_epi32(_mm_loadl_epi64((const __m128i *)red));
    const __m256i greens = _mm256_cvtepu8_epi32(_mm_loadl_epi64((const __m128i *)green));
    const __m256i blues = _mm256_cvtepu8_epi32(_mm_loadl_epi64((const __m128i *)blue));
    const __m256i dr = _mm256_sub_epi32(reds, target_red);
    const __m256i dg = _mm256_sub_epi32(greens, target_green);
    const __m256i db = _mm256_sub_epi32(blues, target_blue);
    return _mm256_add_epi32(
        _mm256_add_epi32(_mm256_mullo_epi32(dr, dr), _mm256_mullo_epi32(dg, dg)),
        _mm256_mullo_epi32(db, db)
    );
}

static uint32_t horizontal_sum_u32(__m256i values) {
    __m128i sum = _mm_add_epi32(
        _mm256_castsi256_si128(values),
        _mm256_extracti128_si256(values, 1)
    );
    sum = _mm_hadd_epi32(sum, sum);
    sum = _mm_hadd_epi32(sum, sum);
    return (uint32_t)_mm_cvtsi128_si32(sum);
}

uint32_t bpal5_nearest_avx2(
    const uint32_t *palette_rgba,
    uint32_t color_count,
    uint8_t red,
    uint8_t green,
    uint8_t blue
) {
    const __m256i mask = _mm256_set1_epi32(255);
    const __m256i target_red = _mm256_set1_epi32((int)red);
    const __m256i target_green = _mm256_set1_epi32((int)green);
    const __m256i target_blue = _mm256_set1_epi32((int)blue);
    uint32_t best_index = 0;
    uint32_t best_distance = UINT_MAX;
    uint32_t index = 0;

    for (; index + 8u <= color_count; index += 8u) {
        const __m256i colors = _mm256_loadu_si256((const __m256i *)(palette_rgba + index));
        const __m256i reds = _mm256_and_si256(colors, mask);
        const __m256i greens = _mm256_and_si256(_mm256_srli_epi32(colors, 8), mask);
        const __m256i blues = _mm256_and_si256(_mm256_srli_epi32(colors, 16), mask);
        const __m256i dr = _mm256_sub_epi32(target_red, reds);
        const __m256i dg = _mm256_sub_epi32(target_green, greens);
        const __m256i db = _mm256_sub_epi32(target_blue, blues);
        const __m256i distances = _mm256_add_epi32(
            _mm256_add_epi32(_mm256_mullo_epi32(dr, dr), _mm256_mullo_epi32(dg, dg)),
            _mm256_mullo_epi32(db, db)
        );
        const uint32_t chunk_distance = horizontal_min_u32(distances);

        if (chunk_distance < best_distance) {
            best_distance = chunk_distance;
            best_index = index + first_matching_lane(distances, chunk_distance);
        }
    }

    for (; index < color_count; ++index) {
        const uint32_t color = palette_rgba[index];
        const int dr = (int)red - (int)(color & 255u);
        const int dg = (int)green - (int)((color >> 8) & 255u);
        const int db = (int)blue - (int)((color >> 16) & 255u);
        const uint32_t distance = (uint32_t)(dr * dr + dg * dg + db * db);

        if (distance < best_distance) {
            best_distance = distance;
            best_index = index;
        }
    }

    return best_index;
}

uint64_t bpal5_block_score_avx2(
    const uint8_t *red,
    const uint8_t *green,
    const uint8_t *blue,
    const uint32_t *best_distances,
    uint32_t count,
    uint32_t color_rgba
) {
    const __m256i target_red = _mm256_set1_epi32((int)(color_rgba & 255u));
    const __m256i target_green = _mm256_set1_epi32((int)((color_rgba >> 8u) & 255u));
    const __m256i target_blue = _mm256_set1_epi32((int)((color_rgba >> 16u) & 255u));
    __m256i score = _mm256_setzero_si256();
    uint32_t index = 0u;
    uint64_t result;

    for (; index + 8u <= count; index += 8u) {
        const __m256i distances = block_distances8(
            red + index,
            green + index,
            blue + index,
            target_red,
            target_green,
            target_blue
        );
        const __m256i best = _mm256_loadu_si256((const __m256i *)(best_distances + index));
        score = _mm256_add_epi32(score, _mm256_min_epu32(distances, best));
    }
    result = horizontal_sum_u32(score);
    if (index < count) {
        result += bpal5_block_score_scalar(
            red + index,
            green + index,
            blue + index,
            best_distances + index,
            count - index,
            color_rgba
        );
    }
    return result;
}

void bpal5_block_update_avx2(
    const uint8_t *red,
    const uint8_t *green,
    const uint8_t *blue,
    uint32_t *best_distances,
    uint32_t count,
    uint32_t color_rgba
) {
    const __m256i target_red = _mm256_set1_epi32((int)(color_rgba & 255u));
    const __m256i target_green = _mm256_set1_epi32((int)((color_rgba >> 8u) & 255u));
    const __m256i target_blue = _mm256_set1_epi32((int)((color_rgba >> 16u) & 255u));
    uint32_t index = 0u;

    for (; index + 8u <= count; index += 8u) {
        const __m256i distances = block_distances8(
            red + index,
            green + index,
            blue + index,
            target_red,
            target_green,
            target_blue
        );
        const __m256i best = _mm256_loadu_si256((const __m256i *)(best_distances + index));
        _mm256_storeu_si256(
            (__m256i *)(best_distances + index),
            _mm256_min_epu32(distances, best)
        );
    }
    if (index < count) {
        bpal5_block_update_scalar(
            red + index,
            green + index,
            blue + index,
            best_distances + index,
            count - index,
            color_rgba
        );
    }
}

void bpal5_expand_avx2(
    const uint32_t *local_rgba,
    const uint8_t *indices,
    uint32_t *output_rgba,
    size_t count
) {
    size_t index = 0;

    for (; index + 8u <= count; index += 8u) {
        const __m128i packed = _mm_loadl_epi64((const __m128i *)(indices + index));
        const __m256i offsets = _mm256_cvtepu8_epi32(packed);
        const __m256i colors = _mm256_i32gather_epi32((const int *)local_rgba, offsets, 4);

        _mm256_storeu_si256((__m256i *)(output_rgba + index), colors);
    }

    for (; index < count; ++index) {
        output_rgba[index] = local_rgba[indices[index]];
    }
}
