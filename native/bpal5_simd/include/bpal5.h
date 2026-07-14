#ifndef BPAL5_H
#define BPAL5_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define BPAL5_VERSION 5u
#define BPAL5_HEADER_BYTES 14u
#define BPAL5_FIND_SETTINGS_MAX_CANDIDATES 19u

#define BPAL5_CHANNEL_RGB 0u
#define BPAL5_CHANNEL_SCALAR 1u

typedef struct bpal5_image {
    uint32_t width;
    uint32_t height;
    uint32_t block_size;
    uint32_t blocks_x;
    uint32_t blocks_y;
    uint32_t block_count;
    uint32_t local_color_count;
    uint32_t global_color_count;
    uint32_t palette_count;
    uint32_t palette_color_bits;
    uint32_t channel_mode;
    uint32_t local_index_bits;
    uint32_t global_index_bits;
    uint32_t palette_index_bits;
    uint32_t *palette_rgba;
    uint8_t *block_palette_selectors;
    uint16_t *block_palette_indices;
    uint8_t *pixel_indices;
} bpal5_image;

typedef struct bpal5_encode_options {
    uint32_t block_size;
    uint32_t local_color_count;
    uint32_t global_color_count;
    uint32_t palette_count;
    uint32_t palette_color_bits;
    uint32_t channel_mode;
    uint32_t kmeans_iterations;
    uint32_t refinement_passes;
    uint32_t thread_count;
    int use_simd;
} bpal5_encode_options;

typedef struct bpal5_encode_stats {
    uint64_t initial_error;
    uint64_t final_error;
    double block_clustering_milliseconds;
    double palette_building_milliseconds;
    double block_encoding_milliseconds;
    double refinement_milliseconds;
} bpal5_encode_stats;

void bpal5_default_encode_options(bpal5_encode_options *options);
int bpal5_apply_quality_preset(const char *name, bpal5_encode_options *options);
int bpal5_quality_preset_range(
    const char *name,
    double *target_bits_per_pixel,
    double *minimum_bits_per_pixel,
    double *maximum_bits_per_pixel
);
size_t bpal5_find_settings_candidates(
    const bpal5_encode_options *baseline,
    bpal5_encode_options *candidates,
    size_t capacity
);
uint64_t bpal5_estimate_payload_bits(
    const bpal5_encode_options *options,
    uint32_t width,
    uint32_t height
);
int bpal5_cpu_has_avx2(void);
const char *bpal5_simd_backend(int use_simd);

int bpal5_encode_rgb(
    const uint8_t *rgb,
    uint32_t width,
    uint32_t height,
    const bpal5_encode_options *options,
    bpal5_image *output,
    char *error,
    size_t error_size
);

int bpal5_encode_rgb_with_stats(
    const uint8_t *rgb,
    uint32_t width,
    uint32_t height,
    const bpal5_encode_options *options,
    bpal5_image *output,
    bpal5_encode_stats *stats,
    char *error,
    size_t error_size
);

int bpal5_decode_rgba(
    const bpal5_image *image,
    int use_simd,
    uint8_t **rgba,
    size_t *rgba_size,
    char *error,
    size_t error_size
);

int bpal5_decode_pixel_rgba(
    const bpal5_image *image,
    uint32_t x,
    uint32_t y,
    uint32_t *rgba,
    char *error,
    size_t error_size
);

int bpal5_parse(
    const uint8_t *bytes,
    size_t byte_count,
    bpal5_image *output,
    char *error,
    size_t error_size
);

int bpal5_serialize(
    const bpal5_image *image,
    uint8_t **bytes,
    size_t *byte_count,
    char *error,
    size_t error_size
);

int bpal5_load_file(
    const char *path,
    bpal5_image *output,
    char *error,
    size_t error_size
);

int bpal5_save_file(
    const char *path,
    const bpal5_image *image,
    char *error,
    size_t error_size
);

void bpal5_image_free(bpal5_image *image);
void bpal5_free(void *memory);

#ifdef __cplusplus
}
#endif

#endif
