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
    {
        int found_rgb565 = 0;
        int found_rgb888 = 0;
        int found_palette_2 = 0;
        int found_palette_64 = 0;

        for (index = 0u; index < count; ++index) {
            found_rgb565 |= candidates[index].palette_color_bits == 16u;
            found_rgb888 |= candidates[index].palette_color_bits == 24u;
            found_palette_2 |= candidates[index].palette_count == 2u;
            found_palette_64 |= candidates[index].palette_count == 64u;
        }
        if (!found_rgb565 || !found_rgb888 || !found_palette_2 || !found_palette_64) {
            return fail("settings search did not span rate-distortion formats");
        }
    }
    for (index = 0u; index < count; ++index) {
        size_t other;
        for (other = index + 1u; other < count; ++other) {
            if (candidates[index].block_size == candidates[other].block_size &&
                candidates[index].local_color_count == candidates[other].local_color_count &&
                candidates[index].global_color_count == candidates[other].global_color_count &&
                candidates[index].palette_count == candidates[other].palette_count &&
                candidates[index].palette_color_bits == candidates[other].palette_color_bits) {
                return fail("settings search candidates are not unique");
            }
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
    baseline.block_size = 2u;
    baseline.local_color_count = 4u;
    baseline.global_color_count = 8u;
    if (bpal5_estimate_payload_bits(&baseline, 16u, 8u) != 576u) {
        return fail("direct block bpp estimate includes pixel indices");
    }
    if (!bpal5_rate_guard_accept(90u, 2.0, 100u, 2.0) ||
        !bpal5_rate_guard_accept(100u, 1.9, 100u, 2.0) ||
        bpal5_rate_guard_accept(100u, 2.1, 100u, 2.0) ||
        bpal5_rate_guard_accept(99u, 2.1, 100u, 2.0) ||
        !bpal5_rate_guard_accept(80u, 2.1, 100u, 2.0)) {
        return fail("settings search rate guard mismatch");
    }
    baseline.local_color_count = 2u;
    baseline.channel_mode = BPAL5_CHANNEL_SCALAR;
    if (bpal5_estimate_payload_bits(&baseline, 16u, 8u) != 384u) {
        return fail("scalar palette bpp estimate mismatch");
    }
    bpal5_default_encode_options(&baseline);
    baseline.channel_mode = BPAL5_CHANNEL_SCALAR;
    count = bpal5_find_settings_candidates(
        &baseline,
        candidates,
        BPAL5_FIND_SETTINGS_MAX_CANDIDATES
    );
    if (count != 77u) {
        return fail("scalar settings search contains redundant color formats");
    }
    for (index = 0u; index < count; ++index) {
        if (candidates[index].palette_color_bits != baseline.palette_color_bits) {
            return fail("scalar settings search changed an ignored color format");
        }
    }
    return 0;
}

static int test_specialized_channel_mode(uint32_t channel_mode, size_t expected_bytes) {
    const uint32_t width = 8u;
    const uint32_t height = 8u;
    const size_t pixel_count = (size_t)width * height;
    uint8_t source[8u * 8u * 3u];
    bpal5_encode_options options;
    bpal5_image encoded;
    bpal5_image parsed;
    uint8_t *bytes = NULL;
    uint8_t *decoded = NULL;
    size_t byte_count = 0u;
    size_t decoded_size = 0u;
    char error[512];
    size_t pixel;
    int result = 1;

    memset(&encoded, 0, sizeof(encoded));
    memset(&parsed, 0, sizeof(parsed));
    for (pixel = 0u; pixel < pixel_count; ++pixel) {
        const uint8_t red = (uint8_t)((pixel * 37u + 11u) & 255u);
        source[pixel * 3u] = red;
        source[pixel * 3u + 1u] = red;
        source[pixel * 3u + 2u] = red;
    }
    bpal5_default_encode_options(&options);
    options.block_size = 4u;
    options.local_color_count = 4u;
    options.global_color_count = 8u;
    options.palette_count = 1u;
    options.kmeans_iterations = 2u;
    options.refinement_passes = 0u;
    options.thread_count = 1u;
    options.channel_mode = channel_mode;
    options.palette_color_bits = 16u;
    if (!bpal5_encode_rgb(source, width, height, &options, &encoded, error, sizeof(error)) ||
        !bpal5_serialize(&encoded, &bytes, &byte_count, error, sizeof(error)) ||
        !bpal5_parse(bytes, byte_count, &parsed, error, sizeof(error)) ||
        !bpal5_decode_rgba(&parsed, 0, &decoded, &decoded_size, error, sizeof(error))) {
        fprintf(stderr, "%s\n", error);
        goto cleanup;
    }
    if (byte_count != expected_bytes || parsed.channel_mode != channel_mode ||
        parsed.palette_color_bits != 24u ||
        decoded_size != pixel_count * 4u) {
        result = fail("specialized channel metadata or size mismatch");
        goto cleanup;
    }
    for (pixel = 0u; pixel < pixel_count; ++pixel) {
        uint32_t random_pixel = 0u;
        const uint32_t x = (uint32_t)(pixel % width);
        const uint32_t y = (uint32_t)(pixel / width);
        if (!bpal5_decode_pixel_rgba(&parsed, x, y, &random_pixel, error, sizeof(error)) ||
            memcmp(&random_pixel, decoded + pixel * 4u, 4u) != 0) {
            result = fail("specialized O(1) pixel decode differs from full decode");
            goto cleanup;
        }
        if (channel_mode == BPAL5_CHANNEL_SCALAR &&
            (decoded[pixel * 4u] != decoded[pixel * 4u + 1u] ||
             decoded[pixel * 4u] != decoded[pixel * 4u + 2u])) {
            result = fail("scalar channel was not replicated");
            goto cleanup;
        }
    }
    if (channel_mode == BPAL5_CHANNEL_SCALAR) {
        bpal5_image invalid;
        uint32_t random_pixel = 0u;
        memset(&invalid, 0, sizeof(invalid));
        bytes[13] |= 1u;
        if (bpal5_parse(bytes, byte_count, &invalid, error, sizeof(error)) ||
            bpal5_sample_file_pixel_rgba(
                bytes,
                byte_count,
                0u,
                0u,
                &random_pixel,
                error,
                sizeof(error))) {
            bpal5_image_free(&invalid);
            result = fail("packed scalar file was not rejected");
            goto cleanup;
        }
        bytes[13] &= (uint8_t)~1u;
    }
    result = 0;

cleanup:
    bpal5_free(bytes);
    bpal5_free(decoded);
    bpal5_image_free(&encoded);
    bpal5_image_free(&parsed);
    return result;
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
    if (test_specialized_channel_mode(BPAL5_CHANNEL_SCALAR, 44u) != 0) {
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
    options.block_size = 2u;
    options.local_color_count = 8u;
    options.global_color_count = 8u;
    if (bpal5_encode_rgb(source, width, height, &options, &encoded, error, sizeof(error))) {
        result = fail("encoder accepted more block colors than block pixels");
        goto cleanup;
    }

    bpal5_default_encode_options(&options);
    options.block_size = 4u;
    options.local_color_count = 16u;
    options.global_color_count = 16u;
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
    if (byte_count != 371u || memcmp(bytes, "BPAL", 4u) != 0 ||
        (bytes[4] >> 4u) != BPAL5_VERSION || (bytes[13] & 0x0fu) != 0u) {
        result = fail("invalid serialized header");
        goto cleanup;
    }
    if (!bpal5_parse(bytes, byte_count, &parsed, error, sizeof(error))) {
        fprintf(stderr, "%s\n", error);
        goto cleanup;
    }
    if (parsed.width != width || parsed.height != height || parsed.palette_count != 4u ||
        parsed.global_color_count != 16u || parsed.local_color_count != 16u) {
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
    for (pixel = 0u; pixel < pixel_count; ++pixel) {
        uint32_t sampled;
        const uint32_t x = (uint32_t)(pixel % width);
        const uint32_t y = (uint32_t)(pixel / width);
        if (!bpal5_sample_file_pixel_rgba(
                bytes,
                byte_count,
                x,
                y,
                &sampled,
                error,
                sizeof(error)) ||
            memcmp(&sampled, scalar + pixel * 4u, sizeof(sampled)) != 0) {
            result = fail("direct pixel sampling differs from full decode");
            goto cleanup;
        }
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
