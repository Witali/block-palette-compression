#ifndef BPAL5_CUDA_H
#define BPAL5_CUDA_H

#include "bpal5.h"

#ifdef __cplusplus
extern "C" {
#endif

#define BPAL5_CUDA_DEVICE_NAME_BYTES 256u

typedef struct bpal5_cuda_encode_stats {
    int device_ordinal;
    char device_name[BPAL5_CUDA_DEVICE_NAME_BYTES];
    uint32_t requested_refinement_passes;
    uint32_t accepted_refinement_passes;
    uint64_t initial_error;
    uint64_t final_error;
    double cuda_setup_milliseconds;
    double cpu_initialization_milliseconds;
    double cpu_block_clustering_milliseconds;
    double cpu_sample_grouping_milliseconds;
    double gpu_palette_building_milliseconds;
    double gpu_initial_encoding_milliseconds;
    double gpu_refinement_milliseconds;
    double gpu_milliseconds;
} bpal5_cuda_encode_stats;

int bpal5_cuda_device_count(int *count, char *error, size_t error_size);

int bpal5_encode_rgb_cuda(
    const uint8_t *rgb,
    uint32_t width,
    uint32_t height,
    const bpal5_encode_options *options,
    int device_ordinal,
    bpal5_image *output,
    bpal5_cuda_encode_stats *stats,
    char *error,
    size_t error_size
);

#ifdef __cplusplus
}
#endif

#endif
