#include "bpal5.h"
#include "ppm.h"

#include <stdio.h>
#include <string.h>

static void print_usage(const char *program) {
    fprintf(stderr, "Usage: %s input.bpal output.ppm [--no-simd]\n", program);
}

int main(int argc, char **argv) {
    bpal5_image image;
    uint8_t *rgba = NULL;
    size_t rgba_size = 0;
    char error[512];
    int use_simd = 1;
    int result = 1;

    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        printf("bpal5dec BPAL v%u (%s runtime backend)\n", BPAL5_VERSION, bpal5_simd_backend(1));
        return 0;
    }
    if (argc < 3 || argc > 4) {
        print_usage(argv[0]);
        return 2;
    }
    if (argc == 4) {
        if (strcmp(argv[3], "--no-simd") != 0) {
            print_usage(argv[0]);
            return 2;
        }
        use_simd = 0;
    }
    memset(&image, 0, sizeof(image));

    if (!bpal5_load_file(argv[1], &image, error, sizeof(error))) {
        fprintf(stderr, "bpal5dec: %s\n", error);
        goto cleanup;
    }
    if (!bpal5_decode_rgba(&image, use_simd, &rgba, &rgba_size, error, sizeof(error))) {
        fprintf(stderr, "bpal5dec: %s\n", error);
        goto cleanup;
    }
    if (!bpal5_ppm_write_rgba(argv[2], rgba, image.width, image.height, error, sizeof(error))) {
        fprintf(stderr, "bpal5dec: %s\n", error);
        goto cleanup;
    }

    printf(
        "Decoded BPAL v5 %ux%u: block %u, local %u, %u x %u shared colors, RGB%u, %s\n",
        image.width,
        image.height,
        image.block_size,
        image.local_color_count,
        image.palette_count,
        image.global_color_count,
        image.palette_color_bits == 16u ? 565u : 888u,
        bpal5_simd_backend(use_simd)
    );
    result = 0;

cleanup:
    bpal5_free(rgba);
    bpal5_image_free(&image);
    return result;
}
