#include "bpal5_simd_internal.h"

#include <immintrin.h>
#include <limits.h>

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
        uint32_t lanes[8];
        uint32_t lane;

        _mm256_storeu_si256((__m256i *)lanes, distances);
        for (lane = 0; lane < 8u; ++lane) {
            if (lanes[lane] < best_distance) {
                best_distance = lanes[lane];
                best_index = index + lane;
            }
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
