#include "bpal5.h"
#include "bpal5_encode_internal.h"
#include "bpal5_simd_internal.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#if defined(BPAL5_HAVE_OPENMP)
#include <omp.h>
#endif

#define BPAL5_MAX_DIMENSION (1u << 24)
#define BPAL5_MAX_SAMPLE_PIXELS 32768u
#define BPAL5_BLOCK_DESCRIPTOR_COMPONENTS 6u

typedef struct bit_reader {
    const uint8_t *bytes;
    size_t byte_count;
    uint64_t bit_offset;
} bit_reader;

typedef struct bit_writer {
    uint8_t *bytes;
    size_t byte_count;
    uint64_t bit_offset;
} bit_writer;

typedef struct encode_preset {
    const char *name;
    double bits_per_pixel;
    uint32_t block_size;
    uint32_t local_color_count;
    uint32_t global_color_count;
    uint32_t palette_count;
} encode_preset;

typedef struct search_profile {
    uint32_t block_size;
    uint32_t local_color_count;
    uint32_t global_color_count;
} search_profile;

static const encode_preset QUALITY_PRESETS[] = {
    { "1.5", 1.5, 4u, 2u, 8u, 2u },
    { "2", 2.0, 4u, 2u, 128u, 2u },
    { "2.5", 2.5, 8u, 4u, 64u, 32u },
    { "3", 3.0, 8u, 4u, 256u, 64u },
    { "4", 4.0, 8u, 8u, 128u, 16u },
    { "5", 5.0, 16u, 16u, 256u, 64u },
    { "6", 6.0, 8u, 16u, 128u, 32u },
    { "8", 8.0, 4u, 8u, 256u, 64u },
};

static const search_profile FIND_SETTINGS_PROFILES[] = {
    { 4u, 16u, 4096u },
    { 4u, 16u, 1024u },
    { 4u, 8u, 1024u },
    { 8u, 16u, 1024u },
    { 8u, 8u, 256u },
    { 8u, 4u, 256u },
    { 16u, 16u, 256u },
    { 16u, 8u, 128u },
    { 16u, 4u, 128u },
    { 16u, 2u, 64u },
    { 32u, 16u, 128u },
    { 32u, 8u, 64u },
    { 32u, 4u, 64u },
    { 32u, 2u, 32u },
    { 64u, 16u, 64u },
    { 64u, 8u, 32u },
    { 64u, 4u, 16u },
    { 64u, 2u, 8u },
};

static void set_error(char *error, size_t error_size, const char *message) {
    if (error != NULL && error_size > 0) {
        (void)snprintf(error, error_size, "%s", message);
    }
}

static void set_error_path(char *error, size_t error_size, const char *message, const char *path) {
    if (error != NULL && error_size > 0) {
        (void)snprintf(error, error_size, "%s: %s", message, path != NULL ? path : "(null)");
    }
}

static int is_power_of_two(uint32_t value) {
    return value != 0u && (value & (value - 1u)) == 0u;
}

static uint32_t integer_log2(uint32_t value) {
    uint32_t bits = 0;
    while (value > 1u) {
        value >>= 1u;
        ++bits;
    }
    return bits;
}

static int uses_direct_pixel_colors(uint32_t block_size, uint32_t local_color_count) {
    return local_color_count == block_size * block_size;
}

static uint32_t pack_rgba(uint8_t red, uint8_t green, uint8_t blue) {
    return (uint32_t)red | ((uint32_t)green << 8u) | ((uint32_t)blue << 16u) | 0xff000000u;
}

static uint8_t color_red(uint32_t color) {
    return (uint8_t)(color & 255u);
}

static uint8_t color_green(uint32_t color) {
    return (uint8_t)((color >> 8u) & 255u);
}

static uint8_t color_blue(uint32_t color) {
    return (uint8_t)((color >> 16u) & 255u);
}

static uint32_t color_distance(uint8_t red, uint8_t green, uint8_t blue, uint32_t color) {
    const int dr = (int)red - (int)color_red(color);
    const int dg = (int)green - (int)color_green(color);
    const int db = (int)blue - (int)color_blue(color);
    return (uint32_t)(dr * dr + dg * dg + db * db);
}

static uint16_t pack_rgb565(uint32_t color) {
    const uint32_t red = ((uint32_t)color_red(color) * 31u + 127u) / 255u;
    const uint32_t green = ((uint32_t)color_green(color) * 63u + 127u) / 255u;
    const uint32_t blue = ((uint32_t)color_blue(color) * 31u + 127u) / 255u;
    return (uint16_t)((red << 11u) | (green << 5u) | blue);
}

static uint32_t unpack_rgb565(uint16_t value) {
    const uint32_t red5 = ((uint32_t)value >> 11u) & 31u;
    const uint32_t green6 = ((uint32_t)value >> 5u) & 63u;
    const uint32_t blue5 = (uint32_t)value & 31u;
    const uint8_t red = (uint8_t)((red5 * 255u + 15u) / 31u);
    const uint8_t green = (uint8_t)((green6 * 255u + 31u) / 63u);
    const uint8_t blue = (uint8_t)((blue5 * 255u + 15u) / 31u);
    return pack_rgba(red, green, blue);
}

static uint32_t quantize_color(uint32_t color, uint32_t palette_color_bits) {
    return palette_color_bits == 16u ? unpack_rgb565(pack_rgb565(color)) : color;
}

static int checked_multiply_size(size_t left, size_t right, size_t *result) {
    if (left != 0u && right > SIZE_MAX / left) {
        return 0;
    }
    *result = left * right;
    return 1;
}

static int bit_read(bit_reader *reader, uint32_t bit_count, uint32_t *value) {
    uint32_t result = 0;
    uint32_t bit;

    if (bit_count > 32u || reader->bit_offset + bit_count > (uint64_t)reader->byte_count * 8u) {
        return 0;
    }
    for (bit = 0; bit < bit_count; ++bit) {
        const size_t byte_index = (size_t)(reader->bit_offset >> 3u);
        const uint32_t bit_in_byte = 7u - (uint32_t)(reader->bit_offset & 7u);
        result = (result << 1u) | ((reader->bytes[byte_index] >> bit_in_byte) & 1u);
        ++reader->bit_offset;
    }
    *value = result;
    return 1;
}

static int bit_write(bit_writer *writer, uint32_t value, uint32_t bit_count) {
    uint32_t remaining = bit_count;

    if (bit_count > 32u || writer->bit_offset + bit_count > (uint64_t)writer->byte_count * 8u) {
        return 0;
    }
    if (bit_count < 32u && value >= (1u << bit_count)) {
        return 0;
    }

    while (remaining != 0u) {
        const size_t byte_index = (size_t)(writer->bit_offset >> 3u);
        const uint32_t used_bits = (uint32_t)(writer->bit_offset & 7u);
        const uint32_t available_bits = 8u - used_bits;
        const uint32_t chunk_bits = remaining < available_bits ? remaining : available_bits;
        const uint32_t value_shift = remaining - chunk_bits;
        const uint32_t byte_shift = available_bits - chunk_bits;
        const uint32_t mask = (1u << chunk_bits) - 1u;
        const uint32_t chunk = (value >> value_shift) & mask;
        writer->bytes[byte_index] |= (uint8_t)(chunk << byte_shift);
        writer->bit_offset += chunk_bits;
        remaining -= chunk_bits;
    }
    return 1;
}

static int bit_write_u8_values(
    bit_writer *writer,
    const uint8_t *values,
    size_t value_count,
    uint32_t bit_count,
    uint32_t value_limit
) {
    size_t index = 0u;

    if (bit_count == 0u) {
        for (index = 0u; index < value_count; ++index) {
            if (values[index] >= value_limit) {
                return 0;
            }
        }
        return 1;
    }
    while (index < value_count) {
        const size_t remaining = value_count - index;
        const size_t values_per_word = 32u / bit_count;
        const size_t chunk_count = remaining < values_per_word ? remaining : values_per_word;
        uint32_t packed = 0u;
        size_t chunk;

        for (chunk = 0u; chunk < chunk_count; ++chunk) {
            const uint32_t value = values[index + chunk];
            if (value >= value_limit) {
                return 0;
            }
            packed = (packed << bit_count) | value;
        }
        if (!bit_write(writer, packed, (uint32_t)chunk_count * bit_count)) {
            return 0;
        }
        index += chunk_count;
    }
    return 1;
}

static int bit_write_u16_values(
    bit_writer *writer,
    const uint16_t *values,
    size_t value_count,
    uint32_t bit_count,
    uint32_t value_limit
) {
    size_t index = 0u;

    while (index < value_count) {
        const size_t remaining = value_count - index;
        const size_t values_per_word = 32u / bit_count;
        const size_t chunk_count = remaining < values_per_word ? remaining : values_per_word;
        uint32_t packed = 0u;
        size_t chunk;

        for (chunk = 0u; chunk < chunk_count; ++chunk) {
            const uint32_t value = values[index + chunk];
            if (value >= value_limit) {
                return 0;
            }
            packed = (packed << bit_count) | value;
        }
        if (!bit_write(writer, packed, (uint32_t)chunk_count * bit_count)) {
            return 0;
        }
        index += chunk_count;
    }
    return 1;
}

static int calculate_file_size(const bpal5_image *image, size_t *total_bytes) {
    const uint64_t palette_bits = (uint64_t)image->palette_count * image->global_color_count * image->palette_color_bits;
    const uint64_t selector_bits = (uint64_t)image->block_count * image->palette_index_bits;
    const uint64_t block_bits = (uint64_t)image->block_count * image->local_color_count * image->global_index_bits;
    const uint64_t pixel_bits = uses_direct_pixel_colors(image->block_size, image->local_color_count)
        ? 0u
        : (uint64_t)image->width * image->height * image->local_index_bits;
    const uint64_t payload_bits = palette_bits + selector_bits + block_bits + pixel_bits;
    const uint64_t bytes = BPAL5_HEADER_BYTES + (payload_bits + 7u) / 8u;

    if (bytes > SIZE_MAX) {
        return 0;
    }
    *total_bytes = (size_t)bytes;
    return 1;
}

static int validate_image_metadata(const bpal5_image *image, char *error, size_t error_size) {
    const uint64_t block_count = (uint64_t)image->blocks_x * image->blocks_y;

    if (image->width == 0u || image->width > BPAL5_MAX_DIMENSION ||
        image->height == 0u || image->height > BPAL5_MAX_DIMENSION) {
        set_error(error, error_size, "BPAL dimensions are out of range");
        return 0;
    }
    if (!is_power_of_two(image->block_size) || image->block_size < 2u || image->block_size > 64u) {
        set_error(error, error_size, "BPAL block size must be a power of two from 2 to 64");
        return 0;
    }
    if (!is_power_of_two(image->local_color_count) || image->local_color_count < 2u ||
        image->local_color_count > 16u || image->local_color_count > image->global_color_count ||
        image->local_color_count > image->block_size * image->block_size) {
        set_error(error, error_size, "BPAL local color count is out of range");
        return 0;
    }
    if (!is_power_of_two(image->global_color_count) || image->global_color_count < 2u ||
        image->global_color_count > 4096u) {
        set_error(error, error_size, "BPAL global color count is out of range");
        return 0;
    }
    if (!is_power_of_two(image->palette_count) || image->palette_count > 128u) {
        set_error(error, error_size, "BPAL palette count must be a power of two from 1 to 128");
        return 0;
    }
    if (image->palette_color_bits != 16u && image->palette_color_bits != 24u) {
        set_error(error, error_size, "BPAL palette color depth must be 16 or 24 bits");
        return 0;
    }
    if (image->blocks_x != (image->width + image->block_size - 1u) / image->block_size ||
        image->blocks_y != (image->height + image->block_size - 1u) / image->block_size ||
        block_count != image->block_count || block_count > UINT32_MAX) {
        set_error(error, error_size, "BPAL block metadata is inconsistent");
        return 0;
    }
    if (image->local_index_bits != integer_log2(image->local_color_count) ||
        image->global_index_bits != integer_log2(image->global_color_count) ||
        image->palette_index_bits != integer_log2(image->palette_count)) {
        set_error(error, error_size, "BPAL index bit counts are inconsistent");
        return 0;
    }
    return 1;
}

static int validate_image_data(const bpal5_image *image, char *error, size_t error_size) {
    size_t block_entries;
    size_t pixel_count;
    size_t index;

    if (image->palette_rgba == NULL || image->block_palette_selectors == NULL ||
        image->block_palette_indices == NULL || image->pixel_indices == NULL) {
        set_error(error, error_size, "BPAL image arrays are missing");
        return 0;
    }
    if (!checked_multiply_size((size_t)image->block_count, image->local_color_count, &block_entries) ||
        !checked_multiply_size((size_t)image->width, image->height, &pixel_count)) {
        set_error(error, error_size, "BPAL image arrays are too large");
        return 0;
    }
    for (index = 0; index < image->block_count; ++index) {
        if (image->block_palette_selectors[index] >= image->palette_count) {
            set_error(error, error_size, "Invalid BPAL block palette selector");
            return 0;
        }
    }
    for (index = 0; index < block_entries; ++index) {
        if (image->block_palette_indices[index] >= image->global_color_count) {
            set_error(error, error_size, "Invalid BPAL block color index");
            return 0;
        }
    }
    for (index = 0; index < pixel_count; ++index) {
        if (image->pixel_indices[index] >= image->local_color_count) {
            set_error(error, error_size, "Invalid BPAL pixel index");
            return 0;
        }
    }
    return 1;
}

static int allocate_image_arrays(bpal5_image *image, char *error, size_t error_size) {
    size_t palette_count;
    size_t block_indices_count;
    size_t pixel_count;

    if (!checked_multiply_size((size_t)image->palette_count, image->global_color_count, &palette_count) ||
        !checked_multiply_size((size_t)image->block_count, image->local_color_count, &block_indices_count) ||
        !checked_multiply_size((size_t)image->width, image->height, &pixel_count)) {
        set_error(error, error_size, "BPAL image arrays are too large");
        return 0;
    }

    image->palette_rgba = (uint32_t *)calloc(palette_count, sizeof(uint32_t));
    image->block_palette_selectors = (uint8_t *)calloc(image->block_count, sizeof(uint8_t));
    image->block_palette_indices = (uint16_t *)calloc(block_indices_count, sizeof(uint16_t));
    image->pixel_indices = (uint8_t *)calloc(pixel_count, sizeof(uint8_t));
    if (image->palette_rgba == NULL || image->block_palette_selectors == NULL ||
        image->block_palette_indices == NULL || image->pixel_indices == NULL) {
        set_error(error, error_size, "Out of memory allocating BPAL image");
        bpal5_image_free(image);
        return 0;
    }
    return 1;
}

void bpal5_default_encode_options(bpal5_encode_options *options) {
    if (options == NULL) {
        return;
    }
    options->block_size = 16u;
    options->local_color_count = 8u;
    options->global_color_count = 32u;
    options->palette_count = 1u;
    options->palette_color_bits = 24u;
    options->kmeans_iterations = 8u;
    options->refinement_passes = 4u;
    options->thread_count = 4u;
    options->use_simd = 1;
}

int bpal5_apply_quality_preset(const char *name, bpal5_encode_options *options) {
    size_t index;

    if (name == NULL || options == NULL) {
        return 0;
    }
    for (index = 0; index < sizeof(QUALITY_PRESETS) / sizeof(QUALITY_PRESETS[0]); ++index) {
        const encode_preset *preset = &QUALITY_PRESETS[index];
        if (strcmp(name, preset->name) == 0) {
            options->block_size = preset->block_size;
            options->local_color_count = preset->local_color_count;
            options->global_color_count = preset->global_color_count;
            options->palette_count = preset->palette_count;
            options->palette_color_bits = 24u;
            options->refinement_passes = 4u;
            return 1;
        }
    }
    return 0;
}

int bpal5_quality_preset_range(
    const char *name,
    double *target_bits_per_pixel,
    double *minimum_bits_per_pixel,
    double *maximum_bits_per_pixel
) {
    const size_t preset_count = sizeof(QUALITY_PRESETS) / sizeof(QUALITY_PRESETS[0]);
    size_t index;

    if (name == NULL || target_bits_per_pixel == NULL ||
        minimum_bits_per_pixel == NULL || maximum_bits_per_pixel == NULL) {
        return 0;
    }
    for (index = 0; index < preset_count; ++index) {
        const encode_preset *preset = &QUALITY_PRESETS[index];
        double previous;
        double next;

        if (strcmp(name, preset->name) != 0) {
            continue;
        }
        previous = index > 0u
            ? QUALITY_PRESETS[index - 1u].bits_per_pixel
            : preset->bits_per_pixel - (QUALITY_PRESETS[index + 1u].bits_per_pixel - preset->bits_per_pixel);
        next = index + 1u < preset_count
            ? QUALITY_PRESETS[index + 1u].bits_per_pixel
            : preset->bits_per_pixel + (preset->bits_per_pixel - QUALITY_PRESETS[index - 1u].bits_per_pixel);
        *target_bits_per_pixel = preset->bits_per_pixel;
        *minimum_bits_per_pixel = (previous + preset->bits_per_pixel) / 2.0;
        *maximum_bits_per_pixel = (next + preset->bits_per_pixel) / 2.0;
        return 1;
    }
    return 0;
}

size_t bpal5_find_settings_candidates(
    const bpal5_encode_options *baseline,
    bpal5_encode_options *candidates,
    size_t capacity
) {
    static const uint32_t palette_counts[] = { 2u, 16u, 32u, 64u };
    static const uint32_t palette_color_bits[] = { 16u, 24u };
    const size_t profile_count = sizeof(FIND_SETTINGS_PROFILES) / sizeof(FIND_SETTINGS_PROFILES[0]);
    size_t count = 0u;
    size_t palette_index;
    size_t color_bits_index;
    size_t profile_index;

    if (baseline == NULL || candidates == NULL || capacity == 0u) {
        return 0u;
    }
    candidates[count++] = *baseline;
    for (palette_index = 0u;
         palette_index < sizeof(palette_counts) / sizeof(palette_counts[0]);
         ++palette_index) {
        for (color_bits_index = 0u;
             color_bits_index < sizeof(palette_color_bits) / sizeof(palette_color_bits[0]);
             ++color_bits_index) {
            for (profile_index = 0u; profile_index <= profile_count && count < capacity; ++profile_index) {
                bpal5_encode_options candidate = *baseline;
                size_t candidate_index;
                int duplicate = 0;

                candidate.palette_count = palette_counts[palette_index];
                candidate.palette_color_bits = palette_color_bits[color_bits_index];
                if (profile_index < profile_count) {
                    const search_profile *profile = &FIND_SETTINGS_PROFILES[profile_index];
                    candidate.block_size = profile->block_size;
                    candidate.local_color_count = profile->local_color_count;
                    candidate.global_color_count = profile->global_color_count;
                }
                for (candidate_index = 0u; candidate_index < count; ++candidate_index) {
                    const bpal5_encode_options *existing = &candidates[candidate_index];
                    if (candidate.block_size == existing->block_size &&
                        candidate.local_color_count == existing->local_color_count &&
                        candidate.global_color_count == existing->global_color_count &&
                        candidate.palette_count == existing->palette_count &&
                        candidate.palette_color_bits == existing->palette_color_bits) {
                        duplicate = 1;
                        break;
                    }
                }
                if (!duplicate) {
                    candidates[count++] = candidate;
                }
            }
        }
    }
    return count;
}

uint64_t bpal5_estimate_payload_bits(
    const bpal5_encode_options *options,
    uint32_t width,
    uint32_t height
) {
    uint64_t blocks_x;
    uint64_t blocks_y;
    uint64_t block_count;
    uint64_t pixel_count;

    if (options == NULL || width == 0u || height == 0u ||
        !is_power_of_two(options->block_size) ||
        !is_power_of_two(options->local_color_count) ||
        !is_power_of_two(options->global_color_count) ||
        !is_power_of_two(options->palette_count)) {
        return 0u;
    }
    blocks_x = ((uint64_t)width + options->block_size - 1u) / options->block_size;
    blocks_y = ((uint64_t)height + options->block_size - 1u) / options->block_size;
    block_count = blocks_x * blocks_y;
    pixel_count = (uint64_t)width * height;
    return (uint64_t)options->palette_count * options->global_color_count * options->palette_color_bits +
        block_count * integer_log2(options->palette_count) +
        block_count * options->local_color_count * integer_log2(options->global_color_count) +
        (uses_direct_pixel_colors(options->block_size, options->local_color_count)
            ? 0u
            : pixel_count * integer_log2(options->local_color_count));
}

int bpal5_rate_guard_accept(
    uint64_t candidate_error,
    double candidate_bits_per_pixel,
    uint64_t baseline_error,
    double baseline_bits_per_pixel
) {
    const double rate_penalty = 15.0;
    double quality_gain;
    double rate_cost;

    if (candidate_bits_per_pixel <= 0.0 || baseline_bits_per_pixel <= 0.0 ||
        candidate_error > baseline_error) {
        return 0;
    }
    if (baseline_error == 0u) {
        return candidate_error == 0u &&
            candidate_bits_per_pixel <= baseline_bits_per_pixel;
    }
    if (candidate_error == 0u) {
        return 1;
    }
    quality_gain = 10.0 * log10((double)baseline_error / (double)candidate_error);
    rate_cost = rate_penalty * log(candidate_bits_per_pixel / baseline_bits_per_pixel);
    return quality_gain + 1e-12 >= rate_cost;
}

void bpal5_image_free(bpal5_image *image) {
    if (image == NULL) {
        return;
    }
    free(image->palette_rgba);
    free(image->block_palette_selectors);
    free(image->block_palette_indices);
    free(image->pixel_indices);
    memset(image, 0, sizeof(*image));
}

void bpal5_free(void *memory) {
    free(memory);
}

int bpal5_parse(
    const uint8_t *bytes,
    size_t byte_count,
    bpal5_image *output,
    char *error,
    size_t error_size
) {
    bit_reader reader;
    bpal5_image image;
    uint32_t version;
    uint32_t width_minus_one;
    uint32_t height_minus_one;
    uint32_t block_exponent_minus_one;
    uint32_t local_bits_minus_one;
    uint32_t global_bits_minus_one;
    uint32_t color_depth_flag;
    uint32_t palette_mode;
    uint32_t ignored_vector_count;
    uint32_t ignored_color_space;
    uint32_t reserved;
    size_t expected_bytes;
    size_t index;
    size_t palette_entries;
    size_t block_entries;
    size_t pixel_count;

    if (output == NULL || bytes == NULL) {
        set_error(error, error_size, "Invalid BPAL parse arguments");
        return 0;
    }
    memset(output, 0, sizeof(*output));
    memset(&image, 0, sizeof(image));

    if (byte_count < BPAL5_HEADER_BYTES || memcmp(bytes, "BPAL", 4u) != 0) {
        set_error(error, error_size, "Invalid or truncated BPAL file");
        return 0;
    }

    reader.bytes = bytes;
    reader.byte_count = byte_count;
    reader.bit_offset = 32u;
    if (!bit_read(&reader, 4u, &version) || version != BPAL5_VERSION ||
        !bit_read(&reader, 24u, &width_minus_one) ||
        !bit_read(&reader, 24u, &height_minus_one) ||
        !bit_read(&reader, 3u, &block_exponent_minus_one) ||
        !bit_read(&reader, 2u, &local_bits_minus_one) ||
        !bit_read(&reader, 4u, &global_bits_minus_one) ||
        !bit_read(&reader, 1u, &color_depth_flag) ||
        !bit_read(&reader, 1u, &palette_mode) ||
        !bit_read(&reader, 9u, &ignored_vector_count) ||
        !bit_read(&reader, 1u, &ignored_color_space) ||
        !bit_read(&reader, 3u, &image.palette_index_bits) ||
        !bit_read(&reader, 4u, &reserved)) {
        set_error(error, error_size, "Truncated BPAL v5 header");
        return 0;
    }
    (void)ignored_vector_count;
    (void)ignored_color_space;
    if (palette_mode != 0u) {
        set_error(error, error_size, "C decoder supports explicit BPAL v5 palettes only");
        return 0;
    }
    if (reserved != 0u) {
        set_error(error, error_size, "Unsupported BPAL v5 flags");
        return 0;
    }

    image.width = width_minus_one + 1u;
    image.height = height_minus_one + 1u;
    image.block_size = 1u << (block_exponent_minus_one + 1u);
    image.local_index_bits = local_bits_minus_one + 1u;
    image.global_index_bits = global_bits_minus_one + 1u;
    image.local_color_count = 1u << image.local_index_bits;
    image.global_color_count = 1u << image.global_index_bits;
    image.palette_count = 1u << image.palette_index_bits;
    image.palette_color_bits = color_depth_flag != 0u ? 24u : 16u;
    image.blocks_x = (image.width + image.block_size - 1u) / image.block_size;
    image.blocks_y = (image.height + image.block_size - 1u) / image.block_size;
    if ((uint64_t)image.blocks_x * image.blocks_y > UINT32_MAX) {
        set_error(error, error_size, "BPAL block count is too large");
        return 0;
    }
    image.block_count = image.blocks_x * image.blocks_y;

    if (!validate_image_metadata(&image, error, error_size) ||
        !calculate_file_size(&image, &expected_bytes)) {
        bpal5_image_free(&image);
        return 0;
    }
    if (byte_count != expected_bytes) {
        set_error(error, error_size, "BPAL file size does not match its header");
        bpal5_image_free(&image);
        return 0;
    }
    if (!allocate_image_arrays(&image, error, error_size)) {
        return 0;
    }

    palette_entries = (size_t)image.palette_count * image.global_color_count;
    for (index = 0; index < palette_entries; ++index) {
        uint32_t value;
        if (image.palette_color_bits == 16u) {
            if (!bit_read(&reader, 16u, &value)) {
                set_error(error, error_size, "Truncated BPAL palette");
                bpal5_image_free(&image);
                return 0;
            }
            image.palette_rgba[index] = unpack_rgb565((uint16_t)value);
        } else {
            uint32_t red;
            uint32_t green;
            uint32_t blue;
            if (!bit_read(&reader, 8u, &red) || !bit_read(&reader, 8u, &green) || !bit_read(&reader, 8u, &blue)) {
                set_error(error, error_size, "Truncated BPAL palette");
                bpal5_image_free(&image);
                return 0;
            }
            image.palette_rgba[index] = pack_rgba((uint8_t)red, (uint8_t)green, (uint8_t)blue);
        }
    }

    for (index = 0; index < image.block_count; ++index) {
        uint32_t value;
        if (!bit_read(&reader, image.palette_index_bits, &value) || value >= image.palette_count) {
            set_error(error, error_size, "Invalid BPAL block palette selector");
            bpal5_image_free(&image);
            return 0;
        }
        image.block_palette_selectors[index] = (uint8_t)value;
    }

    block_entries = (size_t)image.block_count * image.local_color_count;
    for (index = 0; index < block_entries; ++index) {
        uint32_t value;
        if (!bit_read(&reader, image.global_index_bits, &value) || value >= image.global_color_count) {
            set_error(error, error_size, "Invalid BPAL block color index");
            bpal5_image_free(&image);
            return 0;
        }
        image.block_palette_indices[index] = (uint16_t)value;
    }

    pixel_count = (size_t)image.width * image.height;
    if (uses_direct_pixel_colors(image.block_size, image.local_color_count)) {
        uint32_t y;
        uint32_t x;

        for (y = 0u; y < image.height; ++y) {
            for (x = 0u; x < image.width; ++x) {
                image.pixel_indices[(size_t)y * image.width + x] = (uint8_t)(
                    (y % image.block_size) * image.block_size + x % image.block_size
                );
            }
        }
    } else {
        for (index = 0; index < pixel_count; ++index) {
            uint32_t value;
            if (!bit_read(&reader, image.local_index_bits, &value) || value >= image.local_color_count) {
                set_error(error, error_size, "Invalid BPAL pixel index");
                bpal5_image_free(&image);
                return 0;
            }
            image.pixel_indices[index] = (uint8_t)value;
        }
    }

    *output = image;
    return 1;
}

int bpal5_serialize(
    const bpal5_image *image,
    uint8_t **bytes,
    size_t *byte_count,
    char *error,
    size_t error_size
) {
    bit_writer writer;
    uint8_t *output;
    size_t output_size;
    size_t palette_entries;
    size_t block_entries;
    size_t pixel_count;
    size_t index;

    if (bytes == NULL || byte_count == NULL || image == NULL) {
        set_error(error, error_size, "Invalid BPAL serialize arguments");
        return 0;
    }
    *bytes = NULL;
    *byte_count = 0;
    if (!validate_image_metadata(image, error, error_size) ||
        !calculate_file_size(image, &output_size) ||
        !validate_image_data(image, error, error_size)) {
        return 0;
    }

    output = (uint8_t *)calloc(output_size, 1u);
    if (output == NULL) {
        set_error(error, error_size, "Out of memory serializing BPAL");
        return 0;
    }
    memcpy(output, "BPAL", 4u);
    writer.bytes = output;
    writer.byte_count = output_size;
    writer.bit_offset = 32u;

    if (!bit_write(&writer, BPAL5_VERSION, 4u) ||
        !bit_write(&writer, image->width - 1u, 24u) ||
        !bit_write(&writer, image->height - 1u, 24u) ||
        !bit_write(&writer, integer_log2(image->block_size) - 1u, 3u) ||
        !bit_write(&writer, image->local_index_bits - 1u, 2u) ||
        !bit_write(&writer, image->global_index_bits - 1u, 4u) ||
        !bit_write(&writer, image->palette_color_bits == 24u ? 1u : 0u, 1u) ||
        !bit_write(&writer, 0u, 1u) ||
        !bit_write(&writer, 0u, 9u) ||
        !bit_write(&writer, 0u, 1u) ||
        !bit_write(&writer, image->palette_index_bits, 3u) ||
        !bit_write(&writer, 0u, 4u)) {
        set_error(error, error_size, "Could not write BPAL v5 header");
        free(output);
        return 0;
    }

    palette_entries = (size_t)image->palette_count * image->global_color_count;
    for (index = 0; index < palette_entries; ++index) {
        const uint32_t color = image->palette_rgba[index];
        if (image->palette_color_bits == 16u) {
            if (!bit_write(&writer, pack_rgb565(color), 16u)) {
                set_error(error, error_size, "Could not write BPAL RGB565 palette");
                free(output);
                return 0;
            }
        } else if (!bit_write(&writer, color_red(color), 8u) ||
                   !bit_write(&writer, color_green(color), 8u) ||
                   !bit_write(&writer, color_blue(color), 8u)) {
            set_error(error, error_size, "Could not write BPAL RGB888 palette");
            free(output);
            return 0;
        }
    }

    if (!bit_write_u8_values(
            &writer,
            image->block_palette_selectors,
            image->block_count,
            image->palette_index_bits,
            image->palette_count)) {
        set_error(error, error_size, "Invalid BPAL block palette selector");
        free(output);
        return 0;
    }

    block_entries = (size_t)image->block_count * image->local_color_count;
    if (uses_direct_pixel_colors(image->block_size, image->local_color_count)) {
        uint32_t block_y;
        uint32_t block_x;

        for (block_y = 0u; block_y < image->blocks_y; ++block_y) {
            for (block_x = 0u; block_x < image->blocks_x; ++block_x) {
                const uint32_t block = block_y * image->blocks_x + block_x;
                const size_t block_offset = (size_t)block * image->local_color_count;
                const uint16_t padding_index = image->block_palette_indices[block_offset];
                uint32_t local_y;
                uint32_t local_x;

                for (local_y = 0u; local_y < image->block_size; ++local_y) {
                    for (local_x = 0u; local_x < image->block_size; ++local_x) {
                        const uint32_t x = block_x * image->block_size + local_x;
                        const uint32_t y = block_y * image->block_size + local_y;
                        uint16_t global_index = padding_index;

                        if (x < image->width && y < image->height) {
                            const size_t pixel = (size_t)y * image->width + x;
                            const uint8_t local_index = image->pixel_indices[pixel];
                            global_index = image->block_palette_indices[block_offset + local_index];
                        }
                        if (!bit_write(&writer, global_index, image->global_index_bits)) {
                            set_error(error, error_size, "Invalid BPAL direct block color index");
                            free(output);
                            return 0;
                        }
                    }
                }
            }
        }
    } else if (!bit_write_u16_values(
                   &writer,
                   image->block_palette_indices,
                   block_entries,
                   image->global_index_bits,
                   image->global_color_count)) {
        set_error(error, error_size, "Invalid BPAL block color index");
        free(output);
        return 0;
    }

    pixel_count = (size_t)image->width * image->height;
    if (!uses_direct_pixel_colors(image->block_size, image->local_color_count) &&
        !bit_write_u8_values(
            &writer,
            image->pixel_indices,
            pixel_count,
            image->local_index_bits,
            image->local_color_count)) {
        set_error(error, error_size, "Invalid BPAL pixel index");
        free(output);
        return 0;
    }

    *bytes = output;
    *byte_count = output_size;
    return 1;
}

int bpal5_load_file(
    const char *path,
    bpal5_image *output,
    char *error,
    size_t error_size
) {
    FILE *file = NULL;
    long length;
    uint8_t *bytes;
    int result;

#if defined(_MSC_VER)
    if (fopen_s(&file, path, "rb") != 0) {
        file = NULL;
    }
#else
    file = fopen(path, "rb");
#endif
    if (file == NULL) {
        set_error_path(error, error_size, "Could not open BPAL input", path);
        return 0;
    }
    if (fseek(file, 0, SEEK_END) != 0 || (length = ftell(file)) < 0 || fseek(file, 0, SEEK_SET) != 0) {
        set_error(error, error_size, "Could not determine BPAL file size");
        fclose(file);
        return 0;
    }
    bytes = (uint8_t *)malloc((size_t)length);
    if (bytes == NULL && length != 0) {
        set_error(error, error_size, "Out of memory reading BPAL file");
        fclose(file);
        return 0;
    }
    if (fread(bytes, 1, (size_t)length, file) != (size_t)length) {
        set_error(error, error_size, "Could not read BPAL file");
        free(bytes);
        fclose(file);
        return 0;
    }
    fclose(file);
    result = bpal5_parse(bytes, (size_t)length, output, error, error_size);
    free(bytes);
    return result;
}

int bpal5_save_file(
    const char *path,
    const bpal5_image *image,
    char *error,
    size_t error_size
) {
    FILE *file = NULL;
    uint8_t *bytes = NULL;
    size_t byte_count = 0;

    if (!bpal5_serialize(image, &bytes, &byte_count, error, error_size)) {
        return 0;
    }
#if defined(_MSC_VER)
    if (fopen_s(&file, path, "wb") != 0) {
        file = NULL;
    }
#else
    file = fopen(path, "wb");
#endif
    if (file == NULL) {
        set_error_path(error, error_size, "Could not open BPAL output", path);
        free(bytes);
        return 0;
    }
    if (fwrite(bytes, 1, byte_count, file) != byte_count) {
        set_error(error, error_size, "Could not write BPAL output");
        free(bytes);
        fclose(file);
        return 0;
    }
    free(bytes);
    fclose(file);
    return 1;
}

int bpal5_decode_rgba(
    const bpal5_image *image,
    int use_simd,
    uint8_t **rgba,
    size_t *rgba_size,
    char *error,
    size_t error_size
) {
    size_t pixel_count;
    size_t byte_count;
    uint32_t *output;
    bpal5_expand_fn expand;
    uint32_t block_y;
    uint32_t block_x;

    if (rgba == NULL || rgba_size == NULL ||
        !validate_image_metadata(image, error, error_size) ||
        !validate_image_data(image, error, error_size)) {
        return 0;
    }
    *rgba = NULL;
    *rgba_size = 0;
    if (!checked_multiply_size((size_t)image->width, image->height, &pixel_count) ||
        !checked_multiply_size(pixel_count, 4u, &byte_count)) {
        set_error(error, error_size, "Decoded image is too large");
        return 0;
    }
    output = (uint32_t *)malloc(byte_count);
    if (output == NULL) {
        set_error(error, error_size, "Out of memory decoding BPAL");
        return 0;
    }
    expand = bpal5_select_expand(use_simd);

    for (block_y = 0; block_y < image->blocks_y; ++block_y) {
        const uint32_t start_y = block_y * image->block_size;
        const uint32_t end_y = start_y + image->block_size < image->height
            ? start_y + image->block_size
            : image->height;

        for (block_x = 0; block_x < image->blocks_x; ++block_x) {
            const uint32_t start_x = block_x * image->block_size;
            const uint32_t end_x = start_x + image->block_size < image->width
                ? start_x + image->block_size
                : image->width;
            const uint32_t span = end_x - start_x;
            const uint32_t block_index = block_y * image->blocks_x + block_x;
            const uint32_t palette_base = image->block_palette_selectors[block_index] * image->global_color_count;
            uint32_t local_rgba[16];
            uint32_t local_index;
            uint32_t y;

            for (local_index = 0; local_index < image->local_color_count; ++local_index) {
                const uint16_t global_index = image->block_palette_indices[
                    (size_t)block_index * image->local_color_count + local_index
                ];
                local_rgba[local_index] = image->palette_rgba[palette_base + global_index];
            }
            for (y = start_y; y < end_y; ++y) {
                const size_t pixel = (size_t)y * image->width + start_x;
                expand(local_rgba, image->pixel_indices + pixel, output + pixel, span);
            }
        }
    }

    *rgba = (uint8_t *)output;
    *rgba_size = byte_count;
    return 1;
}

static void describe_blocks(const uint8_t *rgb, const bpal5_image *image, float *descriptors) {
    uint32_t block_y;
    uint32_t block_x;

    for (block_y = 0; block_y < image->blocks_y; ++block_y) {
        for (block_x = 0; block_x < image->blocks_x; ++block_x) {
            const uint32_t start_x = block_x * image->block_size;
            const uint32_t start_y = block_y * image->block_size;
            const uint32_t end_x = start_x + image->block_size < image->width ? start_x + image->block_size : image->width;
            const uint32_t end_y = start_y + image->block_size < image->height ? start_y + image->block_size : image->height;
            const uint32_t block_index = block_y * image->blocks_x + block_x;
            double sums[3] = {0.0, 0.0, 0.0};
            double squares[3] = {0.0, 0.0, 0.0};
            uint32_t count = 0;
            uint32_t y;
            uint32_t x;
            uint32_t channel;

            for (y = start_y; y < end_y; ++y) {
                for (x = start_x; x < end_x; ++x) {
                    const uint8_t *pixel = rgb + ((size_t)y * image->width + x) * 3u;
                    for (channel = 0; channel < 3u; ++channel) {
                        sums[channel] += pixel[channel];
                        squares[channel] += (double)pixel[channel] * pixel[channel];
                    }
                    ++count;
                }
            }
            for (channel = 0; channel < 3u; ++channel) {
                const double mean = sums[channel] / count;
                const double variance = squares[channel] / count - mean * mean;
                descriptors[(size_t)block_index * 6u + channel] = (float)mean;
                descriptors[(size_t)block_index * 6u + 3u + channel] = (float)sqrt(variance > 0.0 ? variance : 0.0);
            }
        }
    }
}

static double descriptor_distance(const float *left, const float *right) {
    double distance = 0.0;
    uint32_t component;
    for (component = 0; component < BPAL5_BLOCK_DESCRIPTOR_COMPONENTS; ++component) {
        const double difference = (double)left[component] - right[component];
        distance += difference * difference;
    }
    return distance;
}

static int assign_block_palettes(
    const uint8_t *rgb,
    bpal5_image *image,
    char *error,
    size_t error_size
) {
    const uint32_t cluster_count = image->palette_count < image->block_count
        ? image->palette_count
        : image->block_count;
    float *descriptors;
    float *centroids;
    uint32_t *centroid_sources;
    uint32_t centroid_count;
    uint32_t iteration;

    if (image->palette_count == 1u) {
        memset(image->block_palette_selectors, 0, image->block_count);
        return 1;
    }
    descriptors = (float *)malloc((size_t)image->block_count * 6u * sizeof(float));
    centroids = (float *)calloc((size_t)cluster_count * 6u, sizeof(float));
    centroid_sources = (uint32_t *)calloc(cluster_count, sizeof(uint32_t));
    if (descriptors == NULL || centroids == NULL || centroid_sources == NULL) {
        set_error(error, error_size, "Out of memory clustering BPAL blocks");
        free(descriptors);
        free(centroids);
        free(centroid_sources);
        return 0;
    }
    describe_blocks(rgb, image, descriptors);
    memcpy(centroids, descriptors, 6u * sizeof(float));
    centroid_sources[0] = 0u;

    for (centroid_count = 1u; centroid_count < cluster_count; ++centroid_count) {
        uint32_t best_block = 0u;
        double best_distance = -1.0;
        uint32_t block;

        for (block = 0; block < image->block_count; ++block) {
            double nearest = 1.0e300;
            uint32_t centroid;
            int already_selected = 0;
            for (centroid = 0; centroid < centroid_count; ++centroid) {
                if (centroid_sources[centroid] == block) {
                    already_selected = 1;
                    break;
                }
                {
                    const double distance = descriptor_distance(
                        descriptors + (size_t)block * 6u,
                        centroids + (size_t)centroid * 6u
                    );
                    if (distance < nearest) {
                        nearest = distance;
                    }
                }
            }
            if (!already_selected && nearest > best_distance) {
                best_distance = nearest;
                best_block = block;
            }
        }
        centroid_sources[centroid_count] = best_block;
        memcpy(
            centroids + (size_t)centroid_count * 6u,
            descriptors + (size_t)best_block * 6u,
            6u * sizeof(float)
        );
    }

    for (iteration = 0; iteration < 8u; ++iteration) {
        double *sums = (double *)calloc((size_t)cluster_count * 6u, sizeof(double));
        uint32_t *counts = (uint32_t *)calloc(cluster_count, sizeof(uint32_t));
        uint32_t block;
        if (sums == NULL || counts == NULL) {
            set_error(error, error_size, "Out of memory refining block clusters");
            free(sums);
            free(counts);
            free(descriptors);
            free(centroids);
            free(centroid_sources);
            return 0;
        }
        for (block = 0; block < image->block_count; ++block) {
            uint32_t best_cluster = 0u;
            double best_distance = descriptor_distance(descriptors + (size_t)block * 6u, centroids);
            uint32_t cluster;
            uint32_t component;
            for (cluster = 1u; cluster < cluster_count; ++cluster) {
                const double distance = descriptor_distance(
                    descriptors + (size_t)block * 6u,
                    centroids + (size_t)cluster * 6u
                );
                if (distance < best_distance) {
                    best_distance = distance;
                    best_cluster = cluster;
                }
            }
            image->block_palette_selectors[block] = (uint8_t)best_cluster;
            ++counts[best_cluster];
            for (component = 0; component < 6u; ++component) {
                sums[(size_t)best_cluster * 6u + component] += descriptors[(size_t)block * 6u + component];
            }
        }
        for (block = 0; block < cluster_count; ++block) {
            uint32_t component;
            if (counts[block] == 0u) {
                continue;
            }
            for (component = 0; component < 6u; ++component) {
                centroids[(size_t)block * 6u + component] = (float)(
                    sums[(size_t)block * 6u + component] / counts[block]
                );
            }
        }
        free(sums);
        free(counts);
    }

    free(descriptors);
    free(centroids);
    free(centroid_sources);
    return 1;
}

static uint8_t *sample_palette_pixels(
    const uint8_t *rgb,
    const bpal5_image *image,
    uint32_t palette_index,
    uint32_t *sample_count,
    char *error,
    size_t error_size
) {
    uint64_t total = 0;
    uint32_t block;
    uint64_t stride;
    uint64_t seen = 0;
    uint32_t stored = 0;
    uint8_t *sample;

    for (block = 0; block < image->block_count; ++block) {
        if (image->block_palette_selectors[block] == palette_index) {
            const uint32_t block_x = block % image->blocks_x;
            const uint32_t block_y = block / image->blocks_x;
            const uint32_t width = (block_x + 1u) * image->block_size < image->width
                ? image->block_size
                : image->width - block_x * image->block_size;
            const uint32_t height = (block_y + 1u) * image->block_size < image->height
                ? image->block_size
                : image->height - block_y * image->block_size;
            total += (uint64_t)width * height;
        }
    }
    if (total == 0u) {
        *sample_count = 0u;
        return NULL;
    }
    stride = (total + BPAL5_MAX_SAMPLE_PIXELS - 1u) / BPAL5_MAX_SAMPLE_PIXELS;
    sample = (uint8_t *)malloc((size_t)((total + stride - 1u) / stride) * 3u);
    if (sample == NULL) {
        set_error(error, error_size, "Out of memory sampling palette pixels");
        return NULL;
    }

    for (block = 0; block < image->block_count; ++block) {
        if (image->block_palette_selectors[block] == palette_index) {
            const uint32_t block_x = block % image->blocks_x;
            const uint32_t block_y = block / image->blocks_x;
            const uint32_t start_x = block_x * image->block_size;
            const uint32_t start_y = block_y * image->block_size;
            const uint32_t end_x = start_x + image->block_size < image->width ? start_x + image->block_size : image->width;
            const uint32_t end_y = start_y + image->block_size < image->height ? start_y + image->block_size : image->height;
            uint32_t y;
            uint32_t x;
            for (y = start_y; y < end_y; ++y) {
                for (x = start_x; x < end_x; ++x) {
                    if (seen % stride == 0u) {
                        const uint8_t *pixel = rgb + ((size_t)y * image->width + x) * 3u;
                        sample[(size_t)stored * 3u] = pixel[0];
                        sample[(size_t)stored * 3u + 1u] = pixel[1];
                        sample[(size_t)stored * 3u + 2u] = pixel[2];
                        ++stored;
                    }
                    ++seen;
                }
            }
        }
    }
    *sample_count = stored;
    return sample;
}

static int build_one_palette(
    const uint8_t *sample,
    uint32_t sample_count,
    uint32_t *palette,
    uint32_t color_count,
    uint32_t color_bits,
    uint32_t iterations,
    bpal5_nearest_fn nearest,
    char *error,
    size_t error_size
) {
    const uint32_t active_count = sample_count < color_count ? sample_count : color_count;
    uint32_t *nearest_distances;
    uint64_t *red_sums;
    uint64_t *green_sums;
    uint64_t *blue_sums;
    uint32_t *counts;
    uint32_t centroid;
    uint32_t iteration;

    if (sample_count == 0u) {
        uint32_t index;
        for (index = 0; index < color_count; ++index) {
            palette[index] = pack_rgba(0u, 0u, 0u);
        }
        return 1;
    }

    nearest_distances = (uint32_t *)malloc((size_t)sample_count * sizeof(uint32_t));
    red_sums = (uint64_t *)calloc(active_count, sizeof(uint64_t));
    green_sums = (uint64_t *)calloc(active_count, sizeof(uint64_t));
    blue_sums = (uint64_t *)calloc(active_count, sizeof(uint64_t));
    counts = (uint32_t *)calloc(active_count, sizeof(uint32_t));
    if (nearest_distances == NULL || red_sums == NULL || green_sums == NULL || blue_sums == NULL || counts == NULL) {
        set_error(error, error_size, "Out of memory building BPAL palette");
        free(nearest_distances);
        free(red_sums);
        free(green_sums);
        free(blue_sums);
        free(counts);
        return 0;
    }

    for (centroid = 0; centroid < sample_count; ++centroid) {
        nearest_distances[centroid] = UINT32_MAX;
    }
    palette[0] = pack_rgba(sample[0], sample[1], sample[2]);
    for (centroid = 1u; centroid < active_count; ++centroid) {
        uint32_t best_sample = 0u;
        uint32_t best_distance = 0u;
        uint32_t sample_index;
        const uint32_t previous = palette[centroid - 1u];

        for (sample_index = 0; sample_index < sample_count; ++sample_index) {
            const uint8_t *pixel = sample + (size_t)sample_index * 3u;
            const uint32_t distance = color_distance(pixel[0], pixel[1], pixel[2], previous);
            if (distance < nearest_distances[sample_index]) {
                nearest_distances[sample_index] = distance;
            }
            if (nearest_distances[sample_index] > best_distance) {
                best_distance = nearest_distances[sample_index];
                best_sample = sample_index;
            }
        }
        palette[centroid] = pack_rgba(
            sample[(size_t)best_sample * 3u],
            sample[(size_t)best_sample * 3u + 1u],
            sample[(size_t)best_sample * 3u + 2u]
        );
    }

    for (iteration = 0; iteration < iterations; ++iteration) {
        uint32_t sample_index;
        memset(red_sums, 0, (size_t)active_count * sizeof(uint64_t));
        memset(green_sums, 0, (size_t)active_count * sizeof(uint64_t));
        memset(blue_sums, 0, (size_t)active_count * sizeof(uint64_t));
        memset(counts, 0, (size_t)active_count * sizeof(uint32_t));

        for (sample_index = 0; sample_index < sample_count; ++sample_index) {
            const uint8_t *pixel = sample + (size_t)sample_index * 3u;
            const uint32_t cluster = nearest(palette, active_count, pixel[0], pixel[1], pixel[2]);
            red_sums[cluster] += pixel[0];
            green_sums[cluster] += pixel[1];
            blue_sums[cluster] += pixel[2];
            ++counts[cluster];
        }
        for (centroid = 0; centroid < active_count; ++centroid) {
            if (counts[centroid] != 0u) {
                palette[centroid] = pack_rgba(
                    (uint8_t)((red_sums[centroid] + counts[centroid] / 2u) / counts[centroid]),
                    (uint8_t)((green_sums[centroid] + counts[centroid] / 2u) / counts[centroid]),
                    (uint8_t)((blue_sums[centroid] + counts[centroid] / 2u) / counts[centroid])
                );
            }
        }
    }

    for (centroid = 0; centroid < active_count; ++centroid) {
        palette[centroid] = quantize_color(palette[centroid], color_bits);
    }
    for (centroid = active_count; centroid < color_count; ++centroid) {
        palette[centroid] = pack_rgba(0u, 0u, 0u);
    }
    free(nearest_distances);
    free(red_sums);
    free(green_sums);
    free(blue_sums);
    free(counts);
    return 1;
}

static int build_global_palettes(
    const uint8_t *rgb,
    bpal5_image *image,
    const bpal5_encode_options *options,
    bpal5_nearest_fn nearest,
    char *error,
    size_t error_size
) {
    int failures = 0;
    int palette_number;
#if defined(BPAL5_HAVE_OPENMP)
#pragma omp parallel for num_threads(options->thread_count) schedule(dynamic) reduction(+ : failures)
#endif
    for (palette_number = 0; palette_number < (int)image->palette_count; ++palette_number) {
        const uint32_t palette_index = (uint32_t)palette_number;
        uint32_t sample_count = 0u;
        char local_error[256] = {0};
        uint8_t *sample = sample_palette_pixels(
            rgb,
            image,
            palette_index,
            &sample_count,
            local_error,
            sizeof(local_error)
        );
        if (sample_count != 0u && sample == NULL) {
            ++failures;
            continue;
        }
        if (!build_one_palette(
                sample,
                sample_count,
                image->palette_rgba + (size_t)palette_index * image->global_color_count,
                image->global_color_count,
                image->palette_color_bits,
                options->kmeans_iterations,
                nearest,
                local_error,
                sizeof(local_error))) {
            free(sample);
            ++failures;
            continue;
        }
        free(sample);
    }
    if (failures != 0) {
        set_error(error, error_size, "Could not build one or more BPAL palettes");
    }
    return failures == 0;
}

typedef struct block_workspace {
    uint8_t *candidate_flags;
    uint16_t *candidates;
    uint32_t *best_distances;
    uint8_t *selected_flags;
    uint8_t *block_channels;
} block_workspace;

static void free_block_workspace(block_workspace *workspace) {
    free(workspace->candidate_flags);
    free(workspace->candidates);
    free(workspace->best_distances);
    free(workspace->selected_flags);
    free(workspace->block_channels);
    memset(workspace, 0, sizeof(*workspace));
}

static int allocate_block_workspace(const bpal5_image *image, block_workspace *workspace) {
    workspace->candidate_flags = (uint8_t *)malloc(image->global_color_count);
    workspace->candidates = (uint16_t *)malloc((size_t)image->global_color_count * sizeof(uint16_t));
    workspace->best_distances =
        (uint32_t *)malloc((size_t)image->block_size * image->block_size * sizeof(uint32_t));
    workspace->selected_flags = (uint8_t *)malloc(image->global_color_count);
    workspace->block_channels = (uint8_t *)malloc((size_t)image->block_size * image->block_size * 3u);
    return workspace->candidate_flags != NULL && workspace->candidates != NULL &&
        workspace->best_distances != NULL && workspace->selected_flags != NULL &&
        workspace->block_channels != NULL;
}

static uint64_t encode_blocks(
    const uint8_t *rgb,
    const bpal5_image *image,
    const uint32_t *palette,
    uint16_t *block_palette_indices,
    uint8_t *pixel_indices,
    bpal5_nearest_fn nearest,
    int use_simd,
    uint32_t thread_count,
    char *error,
    size_t error_size
) {
    uint32_t worker_count = thread_count;
    block_workspace *workspaces;
    uint64_t total_error = 0u;
    int64_t block_number;
    uint32_t worker;
    bpal5_block_score_fn score_candidate;
    bpal5_block_update_fn update_best;

#if !defined(BPAL5_HAVE_OPENMP)
    worker_count = 1u;
#endif
    workspaces = (block_workspace *)calloc(worker_count, sizeof(*workspaces));
    if (workspaces == NULL) {
        set_error(error, error_size, "Out of memory selecting block palettes");
        return UINT64_MAX;
    }
    for (worker = 0; worker < worker_count; ++worker) {
        if (!allocate_block_workspace(image, &workspaces[worker])) {
            set_error(error, error_size, "Out of memory selecting block palettes");
            for (worker = 0; worker < worker_count; ++worker) {
                free_block_workspace(&workspaces[worker]);
            }
            free(workspaces);
            return UINT64_MAX;
        }
    }
    bpal5_select_block_kernels(use_simd, &score_candidate, &update_best);

#if defined(BPAL5_HAVE_OPENMP)
#pragma omp parallel for num_threads(thread_count) schedule(static) reduction(+ : total_error)
#endif
    for (block_number = 0; block_number < (int64_t)image->block_count; ++block_number) {
        const uint32_t block = (uint32_t)block_number;
#if defined(BPAL5_HAVE_OPENMP)
        const uint32_t worker_index = (uint32_t)omp_get_thread_num();
#else
        const uint32_t worker_index = 0u;
#endif
        uint8_t *candidate_flags = workspaces[worker_index].candidate_flags;
        uint16_t *candidates = workspaces[worker_index].candidates;
        uint32_t *best_distances = workspaces[worker_index].best_distances;
        uint8_t *selected_flags = workspaces[worker_index].selected_flags;
        uint8_t *block_channels = workspaces[worker_index].block_channels;
        const uint32_t block_x = block % image->blocks_x;
        const uint32_t block_y = block / image->blocks_x;
        const uint32_t start_x = block_x * image->block_size;
        const uint32_t start_y = block_y * image->block_size;
        const uint32_t end_x = start_x + image->block_size < image->width ? start_x + image->block_size : image->width;
        const uint32_t end_y = start_y + image->block_size < image->height ? start_y + image->block_size : image->height;
        const uint32_t palette_base = image->block_palette_selectors[block] * image->global_color_count;
        const uint32_t *shared_palette = palette + palette_base;
        uint32_t candidate_count = 0u;
        uint32_t block_pixel_count = 0u;
        uint8_t *block_red = block_channels;
        uint8_t *block_green = block_red + (size_t)image->block_size * image->block_size;
        uint8_t *block_blue = block_green + (size_t)image->block_size * image->block_size;
        uint32_t y;
        uint32_t x;
        uint32_t slot;

        memset(candidate_flags, 0, image->global_color_count);
        memset(selected_flags, 0, image->global_color_count);
        for (y = start_y; y < end_y; ++y) {
            for (x = start_x; x < end_x; ++x) {
                const uint8_t *pixel = rgb + ((size_t)y * image->width + x) * 3u;
                block_red[block_pixel_count] = pixel[0];
                block_green[block_pixel_count] = pixel[1];
                block_blue[block_pixel_count] = pixel[2];
                const uint32_t global_index = nearest(
                    shared_palette,
                    image->global_color_count,
                    pixel[0],
                    pixel[1],
                    pixel[2]
                );
                if (candidate_flags[global_index] == 0u) {
                    candidate_flags[global_index] = 1u;
                    candidates[candidate_count++] = (uint16_t)global_index;
                }
                best_distances[block_pixel_count++] = UINT32_MAX;
            }
        }
        if (candidate_count < image->local_color_count) {
            uint32_t global_index;
            for (global_index = 0; global_index < image->global_color_count && candidate_count < image->local_color_count; ++global_index) {
                if (candidate_flags[global_index] == 0u) {
                    candidate_flags[global_index] = 1u;
                    candidates[candidate_count++] = (uint16_t)global_index;
                }
            }
        }

        for (slot = 0; slot < image->local_color_count; ++slot) {
            uint32_t best_candidate = candidates[0];
            uint64_t best_total = UINT64_MAX;
            uint32_t candidate_position;

            for (candidate_position = 0; candidate_position < candidate_count; ++candidate_position) {
                const uint32_t candidate = candidates[candidate_position];
                const uint32_t candidate_color = shared_palette[candidate];
                uint64_t candidate_total;

                if (selected_flags[candidate] != 0u) {
                    continue;
                }
                candidate_total = score_candidate(
                    block_red,
                    block_green,
                    block_blue,
                    best_distances,
                    block_pixel_count,
                    candidate_color
                );
                if (candidate_total < best_total) {
                    best_total = candidate_total;
                    best_candidate = candidate;
                }
            }

            selected_flags[best_candidate] = 1u;
            block_palette_indices[(size_t)block * image->local_color_count + slot] = (uint16_t)best_candidate;
            {
                const uint32_t selected_color = shared_palette[best_candidate];
                update_best(
                    block_red,
                    block_green,
                    block_blue,
                    best_distances,
                    block_pixel_count,
                    selected_color
                );
            }
        }

        {
            uint32_t local_palette[16];
            uint32_t position = 0u;
            for (slot = 0; slot < image->local_color_count; ++slot) {
                local_palette[slot] = shared_palette[
                    block_palette_indices[(size_t)block * image->local_color_count + slot]
                ];
            }
            for (y = start_y; y < end_y; ++y) {
                for (x = start_x; x < end_x; ++x) {
                    const size_t pixel_index = (size_t)y * image->width + x;
                    const uint32_t local_index = nearest(
                        local_palette,
                        image->local_color_count,
                        block_red[position],
                        block_green[position],
                        block_blue[position]
                    );
                    pixel_indices[pixel_index] = (uint8_t)local_index;
                    total_error += color_distance(
                        block_red[position],
                        block_green[position],
                        block_blue[position],
                        local_palette[local_index]
                    );
                    ++position;
                }
            }
        }
    }

    for (worker = 0; worker < worker_count; ++worker) {
        free_block_workspace(&workspaces[worker]);
    }
    free(workspaces);
    return total_error;
}

static int update_palette_centroids(
    const uint8_t *rgb,
    const bpal5_image *image,
    uint32_t *palette,
    char *error,
    size_t error_size
) {
    const size_t palette_entries = (size_t)image->palette_count * image->global_color_count;
    uint64_t *red_sums = (uint64_t *)calloc(palette_entries, sizeof(uint64_t));
    uint64_t *green_sums = (uint64_t *)calloc(palette_entries, sizeof(uint64_t));
    uint64_t *blue_sums = (uint64_t *)calloc(palette_entries, sizeof(uint64_t));
    uint32_t *counts = (uint32_t *)calloc(palette_entries, sizeof(uint32_t));
    uint32_t y;
    uint32_t x;
    size_t index;

    if (red_sums == NULL || green_sums == NULL || blue_sums == NULL || counts == NULL) {
        set_error(error, error_size, "Out of memory updating BPAL palette centroids");
        free(red_sums);
        free(green_sums);
        free(blue_sums);
        free(counts);
        return 0;
    }
    for (y = 0; y < image->height; ++y) {
        for (x = 0; x < image->width; ++x) {
            const size_t pixel = (size_t)y * image->width + x;
            const uint32_t block = (y / image->block_size) * image->blocks_x + x / image->block_size;
            const uint32_t local = image->pixel_indices[pixel];
            const uint32_t global = image->block_palette_indices[(size_t)block * image->local_color_count + local];
            const uint32_t palette_entry = image->block_palette_selectors[block] * image->global_color_count + global;
            const uint8_t *source = rgb + pixel * 3u;
            red_sums[palette_entry] += source[0];
            green_sums[palette_entry] += source[1];
            blue_sums[palette_entry] += source[2];
            ++counts[palette_entry];
        }
    }
    for (index = 0; index < palette_entries; ++index) {
        if (counts[index] != 0u) {
            palette[index] = quantize_color(pack_rgba(
                (uint8_t)((red_sums[index] + counts[index] / 2u) / counts[index]),
                (uint8_t)((green_sums[index] + counts[index] / 2u) / counts[index]),
                (uint8_t)((blue_sums[index] + counts[index] / 2u) / counts[index])
            ), image->palette_color_bits);
        }
    }
    free(red_sums);
    free(green_sums);
    free(blue_sums);
    free(counts);
    return 1;
}

int bpal5_prepare_rgb_image_internal(
    const uint8_t *rgb,
    uint32_t width,
    uint32_t height,
    const bpal5_encode_options *options,
    bpal5_image *output,
    double *block_clustering_milliseconds,
    char *error,
    size_t error_size
) {
    bpal5_image image;
    clock_t stage_started;

    if (output == NULL || rgb == NULL || options == NULL) {
        set_error(error, error_size, "Invalid BPAL encode arguments");
        return 0;
    }
    memset(output, 0, sizeof(*output));
    memset(&image, 0, sizeof(image));
    if (block_clustering_milliseconds != NULL) {
        *block_clustering_milliseconds = 0.0;
    }
    if (width == 0u || width > BPAL5_MAX_DIMENSION || height == 0u || height > BPAL5_MAX_DIMENSION ||
        !is_power_of_two(options->block_size) || options->block_size < 2u || options->block_size > 64u ||
        !is_power_of_two(options->local_color_count) || options->local_color_count < 2u || options->local_color_count > 16u ||
        options->local_color_count > options->block_size * options->block_size ||
        !is_power_of_two(options->global_color_count) || options->global_color_count < options->local_color_count || options->global_color_count > 4096u ||
        !is_power_of_two(options->palette_count) || options->palette_count > 128u ||
        (options->palette_color_bits != 16u && options->palette_color_bits != 24u) ||
        options->kmeans_iterations == 0u || options->kmeans_iterations > 64u || options->refinement_passes > 16u ||
        options->thread_count == 0u || options->thread_count > 256u) {
        set_error(error, error_size, "Invalid BPAL encoder settings");
        return 0;
    }

    image.width = width;
    image.height = height;
    image.block_size = options->block_size;
    image.blocks_x = (width + image.block_size - 1u) / image.block_size;
    image.blocks_y = (height + image.block_size - 1u) / image.block_size;
    if ((uint64_t)image.blocks_x * image.blocks_y > UINT32_MAX) {
        set_error(error, error_size, "BPAL block count is too large");
        return 0;
    }
    image.block_count = image.blocks_x * image.blocks_y;
    image.local_color_count = options->local_color_count;
    image.global_color_count = options->global_color_count;
    image.palette_count = options->palette_count;
    image.palette_color_bits = options->palette_color_bits;
    image.local_index_bits = integer_log2(image.local_color_count);
    image.global_index_bits = integer_log2(image.global_color_count);
    image.palette_index_bits = integer_log2(image.palette_count);

    if (!allocate_image_arrays(&image, error, error_size)) {
        return 0;
    }
    stage_started = clock();
    if (!assign_block_palettes(rgb, &image, error, error_size)) {
        bpal5_image_free(&image);
        return 0;
    }
    if (block_clustering_milliseconds != NULL) {
        *block_clustering_milliseconds =
            (double)(clock() - stage_started) * 1000.0 / CLOCKS_PER_SEC;
    }

    *output = image;
    return 1;
}

int bpal5_encode_rgb_with_stats(
    const uint8_t *rgb,
    uint32_t width,
    uint32_t height,
    const bpal5_encode_options *options_input,
    bpal5_image *output,
    bpal5_encode_stats *stats,
    char *error,
    size_t error_size
) {
    bpal5_encode_options defaults;
    const bpal5_encode_options *options = options_input;
    bpal5_image image;
    bpal5_nearest_fn nearest;
    uint64_t current_error;
    uint32_t pass;
    size_t palette_entries;
    size_t block_entries;
    size_t pixel_count;
    clock_t stage_started;

    if (stats != NULL) {
        memset(stats, 0, sizeof(*stats));
    }
    if (output == NULL || rgb == NULL) {
        set_error(error, error_size, "Invalid BPAL encode arguments");
        return 0;
    }
    if (options == NULL) {
        bpal5_default_encode_options(&defaults);
        options = &defaults;
    }
    if (!bpal5_prepare_rgb_image_internal(
            rgb,
            width,
            height,
            options,
            &image,
            stats != NULL ? &stats->block_clustering_milliseconds : NULL,
            error,
            error_size)) {
        return 0;
    }
    nearest = bpal5_select_nearest(options->use_simd);
    stage_started = clock();
    if (!build_global_palettes(rgb, &image, options, nearest, error, error_size)) {
        bpal5_image_free(&image);
        return 0;
    }
    if (stats != NULL) {
        stats->palette_building_milliseconds =
            (double)(clock() - stage_started) * 1000.0 / CLOCKS_PER_SEC;
    }
    stage_started = clock();
    current_error = encode_blocks(
        rgb,
        &image,
        image.palette_rgba,
        image.block_palette_indices,
        image.pixel_indices,
        nearest,
        options->use_simd,
        options->thread_count,
        error,
        error_size
    );
    if (current_error == UINT64_MAX) {
        bpal5_image_free(&image);
        return 0;
    }
    if (stats != NULL) {
        stats->initial_error = current_error;
        stats->block_encoding_milliseconds =
            (double)(clock() - stage_started) * 1000.0 / CLOCKS_PER_SEC;
    }

    palette_entries = (size_t)image.palette_count * image.global_color_count;
    block_entries = (size_t)image.block_count * image.local_color_count;
    pixel_count = (size_t)image.width * image.height;
    stage_started = clock();
    for (pass = 0; pass < options->refinement_passes; ++pass) {
        uint32_t *candidate_palette = (uint32_t *)malloc(palette_entries * sizeof(uint32_t));
        uint16_t *candidate_blocks = (uint16_t *)malloc(block_entries * sizeof(uint16_t));
        uint8_t *candidate_pixels = (uint8_t *)malloc(pixel_count);
        uint64_t candidate_error;

        if (candidate_palette == NULL || candidate_blocks == NULL || candidate_pixels == NULL) {
            set_error(error, error_size, "Out of memory refining BPAL encoding");
            free(candidate_palette);
            free(candidate_blocks);
            free(candidate_pixels);
            bpal5_image_free(&image);
            return 0;
        }
        memcpy(candidate_palette, image.palette_rgba, palette_entries * sizeof(uint32_t));
        if (!update_palette_centroids(rgb, &image, candidate_palette, error, error_size)) {
            free(candidate_palette);
            free(candidate_blocks);
            free(candidate_pixels);
            bpal5_image_free(&image);
            return 0;
        }
        candidate_error = encode_blocks(
            rgb,
            &image,
            candidate_palette,
            candidate_blocks,
            candidate_pixels,
            nearest,
            options->use_simd,
            options->thread_count,
            error,
            error_size
        );
        if (candidate_error == UINT64_MAX) {
            free(candidate_palette);
            free(candidate_blocks);
            free(candidate_pixels);
            bpal5_image_free(&image);
            return 0;
        }
        if (candidate_error >= current_error) {
            free(candidate_palette);
            free(candidate_blocks);
            free(candidate_pixels);
            break;
        }
        memcpy(image.palette_rgba, candidate_palette, palette_entries * sizeof(uint32_t));
        memcpy(image.block_palette_indices, candidate_blocks, block_entries * sizeof(uint16_t));
        memcpy(image.pixel_indices, candidate_pixels, pixel_count);
        current_error = candidate_error;
        free(candidate_palette);
        free(candidate_blocks);
        free(candidate_pixels);
    }
    if (stats != NULL) {
        stats->final_error = current_error;
        stats->refinement_milliseconds =
            (double)(clock() - stage_started) * 1000.0 / CLOCKS_PER_SEC;
    }

    *output = image;
    return 1;
}

int bpal5_encode_rgb(
    const uint8_t *rgb,
    uint32_t width,
    uint32_t height,
    const bpal5_encode_options *options,
    bpal5_image *output,
    char *error,
    size_t error_size
) {
    return bpal5_encode_rgb_with_stats(
        rgb,
        width,
        height,
        options,
        output,
        NULL,
        error,
        error_size
    );
}
