#include "image_loader.h"

#include <stdio.h>

#define STBI_FAILURE_USERMSG
#define STB_IMAGE_IMPLEMENTATION
#if defined(_MSC_VER)
#pragma warning(push, 0)
#endif
#include "stb_image.h"
#if defined(_MSC_VER)
#pragma warning(pop)
#endif

int bpal5_image_read_rgb(
    const char *path,
    uint8_t **rgb,
    uint32_t *width,
    uint32_t *height,
    char *error,
    size_t error_size
) {
    int image_width = 0;
    int image_height = 0;
    int source_channels = 0;
    stbi_uc *pixels;

    if (path == NULL || rgb == NULL || width == NULL || height == NULL) {
        if (error != NULL && error_size != 0u) {
            (void)snprintf(error, error_size, "%s", "Invalid image input arguments");
        }
        return 0;
    }

    *rgb = NULL;
    *width = 0u;
    *height = 0u;
    pixels = stbi_load(path, &image_width, &image_height, &source_channels, STBI_rgb);
    if (pixels == NULL) {
        const char *reason = stbi_failure_reason();
        if (error != NULL && error_size != 0u) {
            (void)snprintf(
                error,
                error_size,
                "Could not load input image: %s",
                reason != NULL ? reason : "unknown image format or read error"
            );
        }
        return 0;
    }
    if (image_width <= 0 || image_height <= 0 ||
        (uint32_t)image_width > (1u << 24u) || (uint32_t)image_height > (1u << 24u)) {
        stbi_image_free(pixels);
        if (error != NULL && error_size != 0u) {
            (void)snprintf(error, error_size, "%s", "Unsupported image dimensions");
        }
        return 0;
    }

    *rgb = pixels;
    *width = (uint32_t)image_width;
    *height = (uint32_t)image_height;
    return 1;
}

void bpal5_image_pixels_free(uint8_t *pixels) {
    stbi_image_free(pixels);
}
