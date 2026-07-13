#include "bpal5.h"
#include "ppm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void print_usage(const char *program) {
    fprintf(stderr,
        "Usage: %s input.ppm output.bpal [options]\n"
        "Options:\n"
        "  --block N          Block size: 2,4,8,16,32,64 (default 16)\n"
        "  --local N          Colors per block: 2,4,8,16 (default 8)\n"
        "  --global N         Colors per shared palette: 2..4096 power of two (default 32)\n"
        "  --palettes N       Shared palettes: 1..128 power of two (default 1)\n"
        "  --rgb565           Store shared colors as RGB565 (default RGB888)\n"
        "  --iterations N     K-means iterations, 1..64 (default 8)\n"
        "  --refine N         Refinement passes, 0..16 (default 4)\n"
        "  --no-simd          Disable AVX2 acceleration\n",
        program
    );
}

static int parse_u32(const char *text, uint32_t *value) {
    char *end = NULL;
    const unsigned long parsed = strtoul(text, &end, 10);
    if (text[0] == '\0' || end == NULL || *end != '\0' || parsed > UINT32_MAX) {
        return 0;
    }
    *value = (uint32_t)parsed;
    return 1;
}

int main(int argc, char **argv) {
    bpal5_encode_options options;
    bpal5_image image;
    uint8_t *rgb = NULL;
    uint32_t width = 0;
    uint32_t height = 0;
    char error[512];
    int argument;
    int result = 1;

    if (argc < 3) {
        print_usage(argv[0]);
        return 2;
    }
    bpal5_default_encode_options(&options);
    memset(&image, 0, sizeof(image));

    for (argument = 3; argument < argc; ++argument) {
        const char *name = argv[argument];
        uint32_t *target = NULL;
        if (strcmp(name, "--rgb565") == 0) {
            options.palette_color_bits = 16u;
            continue;
        }
        if (strcmp(name, "--no-simd") == 0) {
            options.use_simd = 0;
            continue;
        }
        if (strcmp(name, "--block") == 0) {
            target = &options.block_size;
        } else if (strcmp(name, "--local") == 0) {
            target = &options.local_color_count;
        } else if (strcmp(name, "--global") == 0) {
            target = &options.global_color_count;
        } else if (strcmp(name, "--palettes") == 0) {
            target = &options.palette_count;
        } else if (strcmp(name, "--iterations") == 0) {
            target = &options.kmeans_iterations;
        } else if (strcmp(name, "--refine") == 0) {
            target = &options.refinement_passes;
        } else {
            fprintf(stderr, "Unknown option: %s\n", name);
            print_usage(argv[0]);
            return 2;
        }
        if (++argument >= argc || !parse_u32(argv[argument], target)) {
            fprintf(stderr, "Invalid value for %s\n", name);
            return 2;
        }
    }

    if (!bpal5_ppm_read(argv[1], &rgb, &width, &height, error, sizeof(error))) {
        fprintf(stderr, "bpal5enc: %s\n", error);
        goto cleanup;
    }
    if (!bpal5_encode_rgb(rgb, width, height, &options, &image, error, sizeof(error))) {
        fprintf(stderr, "bpal5enc: %s\n", error);
        goto cleanup;
    }
    if (!bpal5_save_file(argv[2], &image, error, sizeof(error))) {
        fprintf(stderr, "bpal5enc: %s\n", error);
        goto cleanup;
    }

    printf(
        "Encoded %ux%u PPM to BPAL v5: block %u, local %u, %u x %u shared colors, RGB%u, refinement %u, %s\n",
        width,
        height,
        options.block_size,
        options.local_color_count,
        options.palette_count,
        options.global_color_count,
        options.palette_color_bits == 16u ? 565u : 888u,
        options.refinement_passes,
        bpal5_simd_backend(options.use_simd)
    );
    result = 0;

cleanup:
    free(rgb);
    bpal5_image_free(&image);
    return result;
}
