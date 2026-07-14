#ifndef BPAL5_IMAGE_LOADER_H
#define BPAL5_IMAGE_LOADER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

int bpal5_image_read_rgb(
    const char *path,
    uint8_t **rgb,
    uint32_t *width,
    uint32_t *height,
    char *error,
    size_t error_size
);

void bpal5_image_pixels_free(uint8_t *pixels);

#ifdef __cplusplus
}
#endif

#endif
