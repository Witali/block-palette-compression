#include "image_loader.h"

#include <stdint.h>
#include <stdio.h>

static int verify_image(const char *path, uint32_t expected_width, uint32_t expected_height) {
    uint8_t *rgb = NULL;
    uint32_t width = 0u;
    uint32_t height = 0u;
    uint64_t checksum = 0u;
    size_t byte_count;
    size_t index;
    char error[512];

    if (!bpal5_image_read_rgb(path, &rgb, &width, &height, error, sizeof(error))) {
        fprintf(stderr, "test_image_loader: %s: %s\n", path, error);
        return 0;
    }
    if (width != expected_width || height != expected_height) {
        fprintf(
            stderr,
            "test_image_loader: %s: expected %ux%u, got %ux%u\n",
            path,
            expected_width,
            expected_height,
            width,
            height
        );
        bpal5_image_pixels_free(rgb);
        return 0;
    }
    byte_count = (size_t)width * height * 3u;
    for (index = 0u; index < byte_count; ++index) {
        checksum += rgb[index];
    }
    bpal5_image_pixels_free(rgb);
    if (checksum == 0u) {
        fprintf(stderr, "test_image_loader: %s decoded to an empty RGB image\n", path);
        return 0;
    }
    return 1;
}

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "Usage: test_image_loader input.jpg input.png\n");
        return 2;
    }
    if (!verify_image(argv[1], 64u, 64u) || !verify_image(argv[2], 192u, 192u)) {
        return 1;
    }
    printf("JPEG and PNG image loading ok\n");
    return 0;
}
