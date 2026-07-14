#ifndef BPAL5_ENCODE_INTERNAL_H
#define BPAL5_ENCODE_INTERNAL_H

#include "bpal5.h"

#ifdef __cplusplus
extern "C" {
#endif

int bpal5_prepare_rgb_image_internal(
    const uint8_t *rgb,
    uint32_t width,
    uint32_t height,
    const bpal5_encode_options *options,
    bpal5_image *output,
    double *block_clustering_milliseconds,
    char *error,
    size_t error_size
);

#ifdef __cplusplus
}
#endif

#endif
