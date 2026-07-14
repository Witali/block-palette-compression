#include "bpal5.h"
#include "image_loader.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void print_usage(const char *program) {
    fprintf(stderr,
        "Usage: %s input-image output.bpal [options]\n"
        "Input: JPEG, PNG, TGA, BMP, PSD, GIF, HDR, PIC, PNM\n"
        "Options:\n"
        "  --preset BPP      Quality preset: 1.5,2,2.5,3,4,5,6,8\n"
        "  --block N          Block size: 2,4,8,16,32,64 (default 16)\n"
        "  --local N          Colors per block: 2,4,8,16 (default 8)\n"
        "  --global N         Colors per shared palette: 2..4096 power of two (default 32)\n"
        "  --palettes N       Shared palettes: 1..128 power of two (default 1)\n"
        "  --rgb565           Store shared colors as RGB565 (default RGB888)\n"
        "  --iterations N     K-means iterations, 1..64 (default 8)\n"
        "  --refine N         Refinement passes, 0..16 (default 4)\n"
        "  --threads N        Worker threads, 1..256 (default 4)\n"
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
    bpal5_encode_stats stats;
    uint8_t *rgb = NULL;
    uint32_t width = 0;
    uint32_t height = 0;
    char error[512];
    int argument;
    int result = 1;

    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        printf("bpal5enc BPAL v%u (%s runtime backend)\n", BPAL5_VERSION, bpal5_simd_backend(1));
        return 0;
    }
    if (argc < 3) {
        print_usage(argv[0]);
        return 2;
    }
    bpal5_default_encode_options(&options);
    memset(&image, 0, sizeof(image));
    memset(&stats, 0, sizeof(stats));

    for (argument = 3; argument < argc; ++argument) {
        if (strcmp(argv[argument], "--preset") == 0) {
            if (++argument >= argc || !bpal5_apply_quality_preset(argv[argument], &options)) {
                fprintf(stderr, "Invalid value for --preset; expected 1.5, 2, 2.5, 3, 4, 5, 6, or 8\n");
                return 2;
            }
        }
    }

    for (argument = 3; argument < argc; ++argument) {
        const char *name = argv[argument];
        uint32_t *target = NULL;
        if (strcmp(name, "--preset") == 0) {
            ++argument;
            continue;
        }
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
        } else if (strcmp(name, "--threads") == 0) {
            target = &options.thread_count;
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
    if (options.thread_count == 0u || options.thread_count > 256u) {
        fprintf(stderr, "Invalid value for --threads; expected 1..256\n");
        return 2;
    }

    if (!bpal5_image_read_rgb(argv[1], &rgb, &width, &height, error, sizeof(error))) {
        fprintf(stderr, "bpal5enc: %s\n", error);
        goto cleanup;
    }
    if (!bpal5_encode_rgb_with_stats(
            rgb,
            width,
            height,
            &options,
            &image,
            &stats,
            error,
            sizeof(error))) {
        fprintf(stderr, "bpal5enc: %s\n", error);
        goto cleanup;
    }
    if (!bpal5_save_file(argv[2], &image, error, sizeof(error))) {
        fprintf(stderr, "bpal5enc: %s\n", error);
        goto cleanup;
    }

    printf(
        "Encoded %ux%u image to BPAL v5: block %u, local %u, %u x %u shared colors, "
        "RGB%u, refinement %u, %u threads, %s, CPU stages %.3f ms "
        "(clusters %.3f, palettes %.3f, blocks %.3f, refine %.3f)\n",
        width,
        height,
        options.block_size,
        options.local_color_count,
        options.palette_count,
        options.global_color_count,
        options.palette_color_bits == 16u ? 565u : 888u,
        options.refinement_passes,
        options.thread_count,
        bpal5_simd_backend(options.use_simd),
        stats.block_clustering_milliseconds +
            stats.palette_building_milliseconds +
            stats.block_encoding_milliseconds +
            stats.refinement_milliseconds,
        stats.block_clustering_milliseconds,
        stats.palette_building_milliseconds,
        stats.block_encoding_milliseconds,
        stats.refinement_milliseconds
    );
    result = 0;

cleanup:
    bpal5_image_pixels_free(rgb);
    bpal5_image_free(&image);
    return result;
}
