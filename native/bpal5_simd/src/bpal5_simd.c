#include "bpal5.h"
#include "bpal5_simd_internal.h"

#include <limits.h>

#if defined(_MSC_VER) && (defined(_M_X64) || defined(_M_IX86))
#include <intrin.h>
#elif (defined(__x86_64__) || defined(__i386__)) && (defined(__GNUC__) || defined(__clang__))
#include <cpuid.h>
#endif

uint32_t bpal5_nearest_scalar(
    const uint32_t *palette_rgba,
    uint32_t color_count,
    uint8_t red,
    uint8_t green,
    uint8_t blue
) {
    uint32_t best_index = 0;
    uint32_t best_distance = UINT_MAX;
    uint32_t index;

    for (index = 0; index < color_count; ++index) {
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

void bpal5_expand_scalar(
    const uint32_t *local_rgba,
    const uint8_t *indices,
    uint32_t *output_rgba,
    size_t count
) {
    size_t index;

    for (index = 0; index < count; ++index) {
        output_rgba[index] = local_rgba[indices[index]];
    }
}

uint64_t bpal5_block_score_scalar(
    const uint8_t *red,
    const uint8_t *green,
    const uint8_t *blue,
    const uint32_t *best_distances,
    uint32_t count,
    uint32_t color_rgba
) {
    const int target_red = (int)(color_rgba & 255u);
    const int target_green = (int)((color_rgba >> 8u) & 255u);
    const int target_blue = (int)((color_rgba >> 16u) & 255u);
    uint64_t score = 0u;
    uint32_t index;
    for (index = 0u; index < count; ++index) {
        const int dr = (int)red[index] - target_red;
        const int dg = (int)green[index] - target_green;
        const int db = (int)blue[index] - target_blue;
        const uint32_t distance = (uint32_t)(dr * dr + dg * dg + db * db);
        score += distance < best_distances[index] ? distance : best_distances[index];
    }
    return score;
}

void bpal5_block_update_scalar(
    const uint8_t *red,
    const uint8_t *green,
    const uint8_t *blue,
    uint32_t *best_distances,
    uint32_t count,
    uint32_t color_rgba
) {
    const int target_red = (int)(color_rgba & 255u);
    const int target_green = (int)((color_rgba >> 8u) & 255u);
    const int target_blue = (int)((color_rgba >> 16u) & 255u);
    uint32_t index;
    for (index = 0u; index < count; ++index) {
        const int dr = (int)red[index] - target_red;
        const int dg = (int)green[index] - target_green;
        const int db = (int)blue[index] - target_blue;
        const uint32_t distance = (uint32_t)(dr * dr + dg * dg + db * db);
        if (distance < best_distances[index]) {
            best_distances[index] = distance;
        }
    }
}

int bpal5_cpu_has_avx2(void) {
#if defined(BPAL5_HAVE_AVX2_IMPL) && defined(_MSC_VER) && (defined(_M_X64) || defined(_M_IX86))
    int registers[4];
    unsigned __int64 xcr0;

    __cpuid(registers, 1);
    if ((registers[2] & (1 << 27)) == 0 || (registers[2] & (1 << 28)) == 0) {
        return 0;
    }
    xcr0 = _xgetbv(0);
    if ((xcr0 & 6u) != 6u) {
        return 0;
    }
    __cpuidex(registers, 7, 0);
    return (registers[1] & (1 << 5)) != 0;
#elif defined(BPAL5_HAVE_AVX2_IMPL) && (defined(__x86_64__) || defined(__i386__)) && (defined(__GNUC__) || defined(__clang__))
    unsigned int eax;
    unsigned int ebx;
    unsigned int ecx;
    unsigned int edx;
    uint32_t xcr0_low;
    uint32_t xcr0_high;

    if (!__get_cpuid(1, &eax, &ebx, &ecx, &edx)) {
        return 0;
    }
    if ((ecx & bit_OSXSAVE) == 0 || (ecx & bit_AVX) == 0) {
        return 0;
    }
    __asm__ volatile("xgetbv" : "=a"(xcr0_low), "=d"(xcr0_high) : "c"(0));
    if ((xcr0_low & 6u) != 6u) {
        return 0;
    }
    if (!__get_cpuid_count(7, 0, &eax, &ebx, &ecx, &edx)) {
        return 0;
    }
    return (ebx & bit_AVX2) != 0;
#else
    return 0;
#endif
}

const char *bpal5_simd_backend(int use_simd) {
    return use_simd && bpal5_cpu_has_avx2() ? "AVX2" : "scalar";
}

bpal5_nearest_fn bpal5_select_nearest(int use_simd) {
#if defined(BPAL5_HAVE_AVX2_IMPL)
    if (use_simd && bpal5_cpu_has_avx2()) {
        return bpal5_nearest_avx2;
    }
#else
    (void)use_simd;
#endif
    return bpal5_nearest_scalar;
}

bpal5_expand_fn bpal5_select_expand(int use_simd) {
#if defined(BPAL5_HAVE_AVX2_IMPL)
    if (use_simd && bpal5_cpu_has_avx2()) {
        return bpal5_expand_avx2;
    }
#else
    (void)use_simd;
#endif
    return bpal5_expand_scalar;
}

void bpal5_select_block_kernels(
    int use_simd,
    bpal5_block_score_fn *score,
    bpal5_block_update_fn *update
) {
#if defined(BPAL5_HAVE_AVX2_IMPL)
    if (use_simd && bpal5_cpu_has_avx2()) {
        *score = bpal5_block_score_avx2;
        *update = bpal5_block_update_avx2;
        return;
    }
#else
    (void)use_simd;
#endif
    *score = bpal5_block_score_scalar;
    *update = bpal5_block_update_scalar;
}
