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
        options.use_simd = 0;
        if (!bpal5_apply_quality_preset(expected->name, &options) ||
            options.block_size != expected->block_size ||
            options.local_color_count != expected->local_color_count ||
            options.global_color_count != expected->global_color_count ||
            options.palette_count != expected->palette_count ||
            options.palette_color_bits != 24u ||
            options.kmeans_iterations != 17u ||
            options.refinement_passes != 4u ||
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
    return 0;
}

int main(void) {
    const uint32_t width = 19u;
    const uint32_t height = 13u;
    const size_t pixel_count = (size_t)width * height;
    uint8_t *source = (uint8_t *)malloc(pixel_count * 3u);
    bpal5_encode_options options;
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
    if (source == NULL) {
        return fail("out of memory");
    }
    memset(&encoded, 0, sizeof(encoded));
    memset(&parsed, 0, sizeof(parsed));
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

    if (!bpal5_encode_rgb(source, width, height, &options, &encoded, error, sizeof(error))) {
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
