#ifndef BPAL5_PPM_H
#define BPAL5_PPM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

int bpal5_ppm_read(
    const char *path,
    uint8_t **rgb,
    uint32_t *width,
    uint32_t *height,
    char *error,
    size_t error_size
);

int bpal5_ppm_write_rgb(
    const char *path,
    const uint8_t *rgb,
    uint32_t width,
    uint32_t height,
    char *error,
    size_t error_size
);

int bpal5_ppm_write_rgba(
    const char *path,
    const uint8_t *rgba,
    uint32_t width,
    uint32_t height,
    char *error,
    size_t error_size
);

#ifdef __cplusplus
}
#endif

#endif
