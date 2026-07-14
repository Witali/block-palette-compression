#include "bpal5.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fail(const char *message) {
    fprintf(stderr, "test_roundtrip: %s\n", message);
    return 1;
}

typedef struct preset_case {
    const char *name;
    uint32_t block_size;
    uint32_t local_color_count;
    uint32_t global_color_count;
    uint32_t palette_count;
} preset_case;

static int test_quality_presets(void) {
    static const preset_case cases[] = {
        { "1.5", 4u, 2u, 8u, 2u },
        { "2", 4u, 2u, 128u, 2u },
        { "2.5", 8u, 4u, 64u, 32u },
        { "3", 8u, 4u, 256u, 64u },
        { "4", 8u, 8u, 128u, 16u },
        { "5", 16u, 16u, 256u, 64u },
        { "6", 8u, 16u, 128u, 32u },
        { "8", 4u, 8u, 256u, 64u },
    };
    size_t index;

    for (index = 0; index < sizeof(cases) / sizeof(cases[0]); ++index) {
        bpal5_encode_options options;
        const preset_case *expected = &cases[index];

        bpal5_default_encode_options(&options);
        options.palette_color_bits = 16u;
        options.kmeans_iterations = 17u;
        options.refinement_passes = 0u;
        options.thread_count = 7u;
        options.use_simd = 0;
        if (!bpal5_apply_quality_preset(expected->name, &options) ||
            options.block_size != expected->block_size ||
            options.local_color_count != expected->local_color_count ||
            options.global_color_count != expected->global_color_count ||
            options.palette_count != expected->palette_count ||
            options.palette_color_bits != 24u ||
            options.kmeans_iterations != 17u ||
            options.refinement_passes != 4u ||
            options.thread_count != 7u ||
            options.use_simd != 0) {
            return fail("quality preset settings mismatch");
        }
    }

    {
        bpal5_encode_options options;
        bpal5_default_encode_options(&options);
        if (bpal5_apply_quality_preset("7", &options) ||
            options.block_size != 16u || options.local_color_count != 8u ||
            options.global_color_count != 32u || options.palette_count != 1u) {
            return fail("invalid quality preset was accepted or changed settings");
        }
    }
    {
        double target;
        double minimum;
        double maximum;

        if (!bpal5_quality_preset_range("3", &target, &minimum, &maximum) ||
            target != 3.0 || minimum != 2.75 || maximum != 3.5 ||
            !bpal5_quality_preset_range("1.5", &target, &minimum, &maximum) ||
            minimum != 1.25 || maximum != 1.75 ||
            !bpal5_quality_preset_range("8", &target, &minimum, &maximum) ||
            minimum != 7.0 || maximum != 9.0 ||
            bpal5_quality_preset_range("7", &target, &minimum, &maximum)) {
            return fail("quality preset bpp range mismatch");
        }
    }
    return 0;
}

static int test_find_settings_candidates(void) {
    bpal5_encode_options baseline;
    bpal5_encode_options candidates[BPAL5_FIND_SETTINGS_MAX_CANDIDATES];
    size_t count;
    size_t index;

    bpal5_default_encode_options(&baseline);
    count = bpal5_find_settings_candidates(
        &baseline,
        candidates,
        BPAL5_FIND_SETTINGS_MAX_CANDIDATES
    );
    if (count != BPAL5_FIND_SETTINGS_MAX_CANDIDATES ||
        memcmp(&baseline, &candidates[0], sizeof(baseline)) != 0) {
        return fail("settings search candidates mismatch");
    }
    for (index = 0u; index < count; ++index) {
        if (candidates[index].palette_color_bits != baseline.palette_color_bits) {
            return fail("settings search changed the palette color format");
        }
    }
    baseline.palette_color_bits = 16u;
    count = bpal5_find_settings_candidates(
        &baseline,
        candidates,
        BPAL5_FIND_SETTINGS_MAX_CANDIDATES
    );
    for (index = 0u; index < count; ++index) {
        if (candidates[index].palette_color_bits != 16u) {
            return fail("RGB565 settings search changed the palette color format");
        }
    }
    baseline.block_size = 2u;
    baseline.local_color_count = 2u;
    baseline.global_color_count = 8u;
    baseline.palette_count = 1u;
    baseline.palette_color_bits = 24u;
    if (bpal5_estimate_payload_bits(&baseline, 16u, 8u) != 512u) {
        return fail("settings search bpp estimate mismatch");
    }
    return 0;
}

int main(void) {
    const uint32_t width = 19u;
    const uint32_t height = 13u;
    const size_t pixel_count = (size_t)width * height;
    uint8_t *source = (uint8_t *)malloc(pixel_count * 3u);
    bpal5_encode_options options;
    bpal5_encode_stats stats;
    bpal5_image encoded;
    bpal5_image parsed;
    uint8_t *bytes = NULL;
    size_t byte_count = 0;
    uint8_t *scalar = NULL;
    uint8_t *simd = NULL;
    size_t scalar_size = 0;
    size_t simd_size = 0;
    char error[512];
    size_t pixel;
    int result = 1;

    if (test_quality_presets() != 0) {
        return 1;
    }
    if (test_find_settings_candidates() != 0) {
        return 1;
    }
    if (source == NULL) {
        return fail("out of memory");
    }
    memset(&encoded, 0, sizeof(encoded));
    memset(&parsed, 0, sizeof(parsed));
    memset(&stats, 0, sizeof(stats));
    for (pixel = 0; pixel < pixel_count; ++pixel) {
        const uint32_t x = (uint32_t)(pixel % width);
        const uint32_t y = (uint32_t)(pixel / width);
        source[pixel * 3u] = (uint8_t)((x * 17u + y * 3u) & 255u);
        source[pixel * 3u + 1u] = (uint8_t)((x * 5u + y * 23u) & 255u);
        source[pixel * 3u + 2u] = (uint8_t)((x * 13u + y * 11u) & 255u);
    }

    bpal5_default_encode_options(&options);
    options.block_size = 4u;
    options.local_color_count = 4u;
    options.global_color_count = 8u;
    options.palette_count = 4u;
    options.kmeans_iterations = 4u;
    options.refinement_passes = 2u;

    if (!bpal5_encode_rgb_with_stats(
            source,
            width,
            height,
            &options,
            &encoded,
            &stats,
            error,
            sizeof(error))) {
        fprintf(stderr, "%s\n", error);
        goto cleanup;
    }
    if (!bpal5_serialize(&encoded, &bytes, &byte_count, error, sizeof(error))) {
        fprintf(stderr, "%s\n", error);
        goto cleanup;
    }
    if (byte_count < BPAL5_HEADER_BYTES || memcmp(bytes, "BPAL", 4u) != 0 || (bytes[4] >> 4u) != BPAL5_VERSION) {
        result = fail("invalid serialized header");
        goto cleanup;
    }
    if (!bpal5_parse(bytes, byte_count, &parsed, error, sizeof(error))) {
        fprintf(stderr, "%s\n", error);
        goto cleanup;
    }
    if (parsed.width != width || parsed.height != height || parsed.palette_count != 4u ||
        parsed.global_color_count != 8u || parsed.local_color_count != 4u) {
        result = fail("parsed metadata mismatch");
        goto cleanup;
    }
    if (!bpal5_decode_rgba(&parsed, 0, &scalar, &scalar_size, error, sizeof(error)) ||
        !bpal5_decode_rgba(&parsed, 1, &simd, &simd_size, error, sizeof(error))) {
        fprintf(stderr, "%s\n", error);
        goto cleanup;
    }
    if (scalar_size != pixel_count * 4u || simd_size != scalar_size || memcmp(scalar, simd, scalar_size) != 0) {
        result = fail("scalar and SIMD decode results differ");
        goto cleanup;
    }
    {
        uint64_t decoded_error = 0u;
        for (pixel = 0; pixel < pixel_count; ++pixel) {
            size_t channel;
            for (channel = 0u; channel < 3u; ++channel) {
                const int difference = (int)source[pixel * 3u + channel] -
                    (int)scalar[pixel * 4u + channel];
                decoded_error += (uint64_t)(difference * difference);
            }
        }
        if (stats.final_error != decoded_error || stats.initial_error < stats.final_error) {
            result = fail("CPU encoder error statistics mismatch");
            goto cleanup;
        }
    }

    printf("roundtrip ok: %zu bytes, backend %s\n", byte_count, bpal5_simd_backend(1));
    result = 0;

cleanup:
    free(source);
    bpal5_free(bytes);
    bpal5_free(scalar);
    bpal5_free(simd);
    bpal5_image_free(&encoded);
    bpal5_image_free(&parsed);
    return result;
}
