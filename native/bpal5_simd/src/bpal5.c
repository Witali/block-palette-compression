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
#define BPAL5_FLAG_PACKED_PALETTES 1u
#define BPAL5_PACKED_PALETTE_HEADER_BYTES 4u
#define BPAL5_PACKED_PALETTE_DIRECTORY_ENTRY_BYTES 4u

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

typedef struct packed_palette_record {
    uint8_t base_red;
    uint8_t base_green;
    uint8_t base_blue;
    uint8_t red_bits;
    uint8_t green_bits;
    uint8_t blue_bits;
    size_t byte_count;
    int use_delta;
} packed_palette_record;

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

static uint32_t palette_storage_bits(const bpal5_image *image) {
    if (image->channel_mode == BPAL5_CHANNEL_SCALAR) {
        return 8u;
    }
    return image->palette_color_bits;
}

static void finalize_channel_palette(bpal5_image *image) {
    const size_t entries = (size_t)image->palette_count * image->global_color_count;
    size_t index;

    if (image->channel_mode == BPAL5_CHANNEL_SCALAR) {
        for (index = 0u; index < entries; ++index) {
            const uint8_t value = color_red(image->palette_rgba[index]);
            image->palette_rgba[index] = pack_rgba(value, value, value);
        }
    }
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

static int checked_add_size(size_t left, size_t right, size_t *result) {
    if (right > SIZE_MAX - left) {
        return 0;
    }
    *result = left + right;
    return 1;
}

static uint32_t bits_required_u8(uint32_t value) {
    uint32_t bits = 0u;
    while (value != 0u) {
        value >>= 1u;
        ++bits;
    }
    return bits;
}

static uint32_t read_u32_be(const uint8_t *bytes) {
    return ((uint32_t)bytes[0] << 24u) |
        ((uint32_t)bytes[1] << 16u) |
        ((uint32_t)bytes[2] << 8u) |
        (uint32_t)bytes[3];
}

static void write_u32_be(uint8_t *bytes, uint32_t value) {
    bytes[0] = (uint8_t)(value >> 24u);
    bytes[1] = (uint8_t)(value >> 16u);
    bytes[2] = (uint8_t)(value >> 8u);
    bytes[3] = (uint8_t)value;
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

static void calculate_packed_palette_record(
    const bpal5_image *image,
    uint32_t palette_index,
    packed_palette_record *record
) {
    const size_t palette_base = (size_t)palette_index * image->global_color_count;
    uint32_t minimum_red = 255u;
    uint32_t minimum_green = 255u;
    uint32_t minimum_blue = 255u;
    uint32_t maximum_red = 0u;
    uint32_t maximum_green = 0u;
    uint32_t maximum_blue = 0u;
    uint32_t color_index;
    size_t raw_bytes;
    size_t delta_bytes;
    uint64_t residual_bits;

    for (color_index = 0u; color_index < image->global_color_count; ++color_index) {
        const uint32_t color = quantize_color(
            image->palette_rgba[palette_base + color_index],
            image->palette_color_bits
        );
        const uint32_t red = color_red(color);
        const uint32_t green = color_green(color);
        const uint32_t blue = color_blue(color);
        if (red < minimum_red) minimum_red = red;
        if (green < minimum_green) minimum_green = green;
        if (blue < minimum_blue) minimum_blue = blue;
        if (red > maximum_red) maximum_red = red;
        if (green > maximum_green) maximum_green = green;
        if (blue > maximum_blue) maximum_blue = blue;
    }

    record->base_red = (uint8_t)minimum_red;
    record->base_green = (uint8_t)minimum_green;
    record->base_blue = (uint8_t)minimum_blue;
    record->red_bits = (uint8_t)bits_required_u8(maximum_red - minimum_red);
    record->green_bits = (uint8_t)bits_required_u8(maximum_green - minimum_green);
    record->blue_bits = (uint8_t)bits_required_u8(maximum_blue - minimum_blue);
    raw_bytes = 1u + (size_t)image->global_color_count * (image->palette_color_bits / 8u);
    residual_bits = (uint64_t)image->global_color_count *
        (record->red_bits + record->green_bits + record->blue_bits);
    delta_bytes = 5u + (size_t)((residual_bits + 7u) / 8u);
    record->use_delta = delta_bytes < raw_bytes;
    record->byte_count = record->use_delta ? delta_bytes : raw_bytes;
}

static int calculate_packed_palette_size(const bpal5_image *image, size_t *byte_count) {
    size_t total = BPAL5_PACKED_PALETTE_HEADER_BYTES;
    size_t directory_bytes;
    uint32_t palette_index;

    if (!checked_multiply_size(
            image->palette_count,
            BPAL5_PACKED_PALETTE_DIRECTORY_ENTRY_BYTES,
            &directory_bytes) ||
        !checked_add_size(total, directory_bytes, &total)) {
        return 0;
    }
    for (palette_index = 0u; palette_index < image->palette_count; ++palette_index) {
        packed_palette_record record;
        calculate_packed_palette_record(image, palette_index, &record);
        if (!checked_add_size(total, record.byte_count, &total)) {
            return 0;
        }
    }
    if (total > UINT32_MAX) {
        return 0;
    }
    *byte_count = total;
    return 1;
}

static int write_packed_palette_section(
    const bpal5_image *image,
    uint8_t *output,
    size_t output_size,
    size_t section_offset,
    size_t section_size
) {
    const size_t records_offset = section_offset + BPAL5_PACKED_PALETTE_HEADER_BYTES +
        (size_t)image->palette_count * BPAL5_PACKED_PALETTE_DIRECTORY_ENTRY_BYTES;
    size_t record_offset = records_offset;
    uint32_t palette_index;

    if (section_offset > output_size || section_size > output_size - section_offset ||
        records_offset > section_offset + section_size) {
        return 0;
    }
    write_u32_be(output + section_offset, (uint32_t)section_size);
    for (palette_index = 0u; palette_index < image->palette_count; ++palette_index) {
        const size_t palette_base = (size_t)palette_index * image->global_color_count;
        packed_palette_record record;
        uint32_t color_index;

        calculate_packed_palette_record(image, palette_index, &record);
        if (record_offset < records_offset || record_offset - records_offset > UINT32_MAX ||
            record.byte_count > section_offset + section_size - record_offset) {
            return 0;
        }
        write_u32_be(
            output + section_offset + BPAL5_PACKED_PALETTE_HEADER_BYTES +
                (size_t)palette_index * BPAL5_PACKED_PALETTE_DIRECTORY_ENTRY_BYTES,
            (uint32_t)(record_offset - records_offset)
        );

        if (!record.use_delta) {
            output[record_offset++] = 0u;
            for (color_index = 0u; color_index < image->global_color_count; ++color_index) {
                const uint32_t color = quantize_color(
                    image->palette_rgba[palette_base + color_index],
                    image->palette_color_bits
                );
                if (image->palette_color_bits == 16u) {
                    const uint16_t packed = pack_rgb565(color);
                    output[record_offset++] = (uint8_t)(packed >> 8u);
                    output[record_offset++] = (uint8_t)packed;
                } else {
                    output[record_offset++] = color_red(color);
                    output[record_offset++] = color_green(color);
                    output[record_offset++] = color_blue(color);
                }
            }
        } else {
            bit_writer residual_writer;
            output[record_offset] = (uint8_t)(0x80u | record.red_bits);
            output[record_offset + 1u] = (uint8_t)((record.green_bits << 4u) | record.blue_bits);
            output[record_offset + 2u] = record.base_red;
            output[record_offset + 3u] = record.base_green;
            output[record_offset + 4u] = record.base_blue;
            residual_writer.bytes = output;
            residual_writer.byte_count = output_size;
            residual_writer.bit_offset = (uint64_t)(record_offset + 5u) * 8u;
            for (color_index = 0u; color_index < image->global_color_count; ++color_index) {
                const uint32_t color = quantize_color(
                    image->palette_rgba[palette_base + color_index],
                    image->palette_color_bits
                );
                if (!bit_write(&residual_writer, color_red(color) - record.base_red, record.red_bits) ||
                    !bit_write(&residual_writer, color_green(color) - record.base_green, record.green_bits) ||
                    !bit_write(&residual_writer, color_blue(color) - record.base_blue, record.blue_bits)) {
                    return 0;
                }
            }
            record_offset += record.byte_count;
        }
    }
    return record_offset == section_offset + section_size;
}

static uint64_t non_palette_payload_bits(const bpal5_image *image) {
    const uint64_t selector_bits = (uint64_t)image->block_count * image->palette_index_bits;
    const uint64_t block_bits = (uint64_t)image->block_count * image->local_color_count * image->global_index_bits;
    const uint64_t pixel_bits = uses_direct_pixel_colors(image->block_size, image->local_color_count)
        ? 0u
        : (uint64_t)image->width * image->height * image->local_index_bits;
    return selector_bits + block_bits + pixel_bits;
}

static int calculate_file_size(const bpal5_image *image, size_t *total_bytes) {
    const uint64_t palette_bits =
        (uint64_t)image->palette_count * image->global_color_count * palette_storage_bits(image);
    const uint64_t payload_bits = palette_bits + non_palette_payload_bits(image);
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
        image->global_color_count > 256u) {
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
    if (image->channel_mode > BPAL5_CHANNEL_SCALAR) {
        set_error(error, error_size, "Unsupported BPAL channel mode");
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
    options->channel_mode = BPAL5_CHANNEL_RGB;
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
                candidate.palette_color_bits = baseline->channel_mode == BPAL5_CHANNEL_SCALAR
                    ? baseline->palette_color_bits
                    : palette_color_bits[color_bits_index];
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
                        candidate.palette_color_bits == existing->palette_color_bits &&
                        candidate.channel_mode == existing->channel_mode) {
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
        !is_power_of_two(options->palette_count) ||
        options->channel_mode > BPAL5_CHANNEL_SCALAR) {
        return 0u;
    }
    blocks_x = ((uint64_t)width + options->block_size - 1u) / options->block_size;
    blocks_y = ((uint64_t)height + options->block_size - 1u) / options->block_size;
    block_count = blocks_x * blocks_y;
    pixel_count = (uint64_t)width * height;
    {
        const uint32_t palette_bits = options->channel_mode == BPAL5_CHANNEL_SCALAR
            ? 8u
            : options->palette_color_bits;
        return (uint64_t)options->palette_count * options->global_color_count * palette_bits +
        block_count * integer_log2(options->palette_count) +
        block_count * options->local_color_count * integer_log2(options->global_color_count) +
        (uses_direct_pixel_colors(options->block_size, options->local_color_count)
            ? 0u
            : pixel_count * integer_log2(options->local_color_count));
    }
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

static int parse_packed_palette_section(
    const uint8_t *bytes,
    size_t byte_count,
    size_t section_offset,
    size_t section_size,
    bpal5_image *image,
    char *error,
    size_t error_size
) {
    const size_t directory_offset = section_offset + BPAL5_PACKED_PALETTE_HEADER_BYTES;
    const size_t records_offset = directory_offset +
        (size_t)image->palette_count * BPAL5_PACKED_PALETTE_DIRECTORY_ENTRY_BYTES;
    const size_t section_end = section_offset + section_size;
    uint32_t palette_index;

    if (section_size < BPAL5_PACKED_PALETTE_HEADER_BYTES +
            (size_t)image->palette_count * BPAL5_PACKED_PALETTE_DIRECTORY_ENTRY_BYTES ||
        section_offset > byte_count || section_size > byte_count - section_offset ||
        read_u32_be(bytes + section_offset) != section_size) {
        set_error(error, error_size, "Invalid packed BPAL palette section");
        return 0;
    }

    for (palette_index = 0u; palette_index < image->palette_count; ++palette_index) {
        const uint32_t relative_offset = read_u32_be(
            bytes + directory_offset +
                (size_t)palette_index * BPAL5_PACKED_PALETTE_DIRECTORY_ENTRY_BYTES
        );
        const uint32_t next_relative_offset = palette_index + 1u < image->palette_count
            ? read_u32_be(
                bytes + directory_offset +
                    (size_t)(palette_index + 1u) * BPAL5_PACKED_PALETTE_DIRECTORY_ENTRY_BYTES
            )
            : (uint32_t)(section_end - records_offset);
        const size_t record_offset = records_offset + relative_offset;
        const size_t record_end = records_offset + next_relative_offset;
        const size_t palette_base = (size_t)palette_index * image->global_color_count;
        uint32_t color_index;

        if ((palette_index == 0u && relative_offset != 0u) ||
            next_relative_offset <= relative_offset || record_offset >= section_end ||
            record_end > section_end) {
            set_error(error, error_size, "Invalid packed BPAL palette directory");
            return 0;
        }

        if (bytes[record_offset] == 0u) {
            const size_t expected_size = 1u +
                (size_t)image->global_color_count * (image->palette_color_bits / 8u);
            size_t cursor = record_offset + 1u;
            if (record_end - record_offset != expected_size) {
                set_error(error, error_size, "Invalid raw BPAL palette record");
                return 0;
            }
            for (color_index = 0u; color_index < image->global_color_count; ++color_index) {
                if (image->palette_color_bits == 16u) {
                    const uint16_t packed = (uint16_t)(((uint16_t)bytes[cursor] << 8u) | bytes[cursor + 1u]);
                    image->palette_rgba[palette_base + color_index] = unpack_rgb565(packed);
                    cursor += 2u;
                } else {
                    image->palette_rgba[palette_base + color_index] = pack_rgba(
                        bytes[cursor], bytes[cursor + 1u], bytes[cursor + 2u]
                    );
                    cursor += 3u;
                }
            }
        } else {
            bit_reader residual_reader;
            uint32_t red_bits;
            uint32_t green_bits;
            uint32_t blue_bits;
            uint32_t base_red;
            uint32_t base_green;
            uint32_t base_blue;
            uint64_t residual_bits;
            size_t expected_size;

            if (record_end - record_offset < 5u) {
                set_error(error, error_size, "Truncated delta BPAL palette record");
                return 0;
            }
            red_bits = bytes[record_offset] & 15u;
            green_bits = bytes[record_offset + 1u] >> 4u;
            blue_bits = bytes[record_offset + 1u] & 15u;
            base_red = bytes[record_offset + 2u];
            base_green = bytes[record_offset + 3u];
            base_blue = bytes[record_offset + 4u];
            residual_bits = (uint64_t)image->global_color_count *
                (red_bits + green_bits + blue_bits);
            expected_size = 5u + (size_t)((residual_bits + 7u) / 8u);
            if ((bytes[record_offset] & 0x70u) != 0u || (bytes[record_offset] & 0x80u) == 0u ||
                red_bits > 8u || green_bits > 8u || blue_bits > 8u ||
                record_end - record_offset != expected_size) {
                set_error(error, error_size, "Invalid delta BPAL palette record");
                return 0;
            }
            residual_reader.bytes = bytes;
            residual_reader.byte_count = record_end;
            residual_reader.bit_offset = (uint64_t)(record_offset + 5u) * 8u;
            for (color_index = 0u; color_index < image->global_color_count; ++color_index) {
                uint32_t red_delta;
                uint32_t green_delta;
                uint32_t blue_delta;
                if (!bit_read(&residual_reader, red_bits, &red_delta) ||
                    !bit_read(&residual_reader, green_bits, &green_delta) ||
                    !bit_read(&residual_reader, blue_bits, &blue_delta) ||
                    base_red + red_delta > 255u || base_green + green_delta > 255u ||
                    base_blue + blue_delta > 255u) {
                    set_error(error, error_size, "Invalid BPAL palette residual");
                    return 0;
                }
                image->palette_rgba[palette_base + color_index] = pack_rgba(
                    (uint8_t)(base_red + red_delta),
                    (uint8_t)(base_green + green_delta),
                    (uint8_t)(base_blue + blue_delta)
                );
            }
        }
    }
    return 1;
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
    int packed_palettes;
    size_t packed_palette_size = 0u;
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
        !bit_read(&reader, 2u, &image.channel_mode) ||
        !bit_read(&reader, 2u, &reserved)) {
        set_error(error, error_size, "Truncated BPAL v5 header");
        return 0;
    }
    (void)ignored_vector_count;
    (void)ignored_color_space;
    if (palette_mode != 0u) {
        set_error(error, error_size, "C decoder supports explicit BPAL v5 palettes only");
        return 0;
    }
    if ((reserved & ~BPAL5_FLAG_PACKED_PALETTES) != 0u) {
        set_error(error, error_size, "Unsupported BPAL v5 flags");
        return 0;
    }
    packed_palettes = (reserved & BPAL5_FLAG_PACKED_PALETTES) != 0u;
    if (packed_palettes && image.channel_mode != BPAL5_CHANNEL_RGB) {
        set_error(error, error_size, "Packed BPAL palettes require RGB channel mode");
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

    if (!validate_image_metadata(&image, error, error_size)) {
        bpal5_image_free(&image);
        return 0;
    }
    if (packed_palettes) {
        const uint64_t fixed_bits = non_palette_payload_bits(&image);
        uint64_t expected;
        if (byte_count < BPAL5_HEADER_BYTES + BPAL5_PACKED_PALETTE_HEADER_BYTES) {
            set_error(error, error_size, "Truncated packed BPAL palette section");
            return 0;
        }
        packed_palette_size = read_u32_be(bytes + BPAL5_HEADER_BYTES);
        expected = (uint64_t)BPAL5_HEADER_BYTES + packed_palette_size + (fixed_bits + 7u) / 8u;
        if (expected > SIZE_MAX) {
            set_error(error, error_size, "Packed BPAL file is too large");
            return 0;
        }
        expected_bytes = (size_t)expected;
    } else if (!calculate_file_size(&image, &expected_bytes)) {
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
    if (packed_palettes) {
        if (!parse_packed_palette_section(
                bytes,
                byte_count,
                BPAL5_HEADER_BYTES,
                packed_palette_size,
                &image,
                error,
                error_size)) {
            bpal5_image_free(&image);
            return 0;
        }
        reader.bit_offset = (uint64_t)(BPAL5_HEADER_BYTES + packed_palette_size) * 8u;
    } else {
        for (index = 0; index < palette_entries; ++index) {
            uint32_t value;
            if (image.channel_mode == BPAL5_CHANNEL_SCALAR) {
                if (!bit_read(&reader, 8u, &value)) {
                    set_error(error, error_size, "Truncated BPAL scalar palette");
                    bpal5_image_free(&image);
                    return 0;
                }
                image.palette_rgba[index] = pack_rgba((uint8_t)value, (uint8_t)value, (uint8_t)value);
            } else if (image.palette_color_bits == 16u) {
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
    size_t packed_palette_size = 0u;
    size_t raw_palette_bytes;
    int use_packed_palettes = 0;

    if (bytes == NULL || byte_count == NULL || image == NULL) {
        set_error(error, error_size, "Invalid BPAL serialize arguments");
        return 0;
    }
    *bytes = NULL;
    *byte_count = 0;
    if (!validate_image_metadata(image, error, error_size) ||
        !validate_image_data(image, error, error_size)) {
        return 0;
    }
    if (!checked_multiply_size(
            (size_t)image->palette_count * image->global_color_count,
            palette_storage_bits(image) / 8u,
            &raw_palette_bytes)) {
        set_error(error, error_size, "BPAL palette is too large");
        return 0;
    }
    if (image->channel_mode == BPAL5_CHANNEL_RGB) {
        if (!calculate_packed_palette_size(image, &packed_palette_size)) {
            set_error(error, error_size, "BPAL palette is too large");
            return 0;
        }
        use_packed_palettes = packed_palette_size < raw_palette_bytes;
    }
    if (use_packed_palettes) {
        const uint64_t bytes64 = (uint64_t)BPAL5_HEADER_BYTES + packed_palette_size +
            (non_palette_payload_bits(image) + 7u) / 8u;
        if (bytes64 > SIZE_MAX) {
            set_error(error, error_size, "BPAL file is too large");
            return 0;
        }
        output_size = (size_t)bytes64;
    } else if (!calculate_file_size(image, &output_size)) {
        set_error(error, error_size, "BPAL file is too large");
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
        !bit_write(&writer, image->channel_mode, 2u) ||
        !bit_write(
            &writer,
            use_packed_palettes ? BPAL5_FLAG_PACKED_PALETTES : 0u,
            2u)) {
        set_error(error, error_size, "Could not write BPAL v5 header");
        free(output);
        return 0;
    }

    palette_entries = (size_t)image->palette_count * image->global_color_count;
    if (use_packed_palettes) {
        if (!write_packed_palette_section(
                image,
                output,
                output_size,
                BPAL5_HEADER_BYTES,
                packed_palette_size)) {
            set_error(error, error_size, "Could not write packed BPAL palettes");
            free(output);
            return 0;
        }
        writer.bit_offset = (uint64_t)(BPAL5_HEADER_BYTES + packed_palette_size) * 8u;
    } else {
        for (index = 0; index < palette_entries; ++index) {
            const uint32_t color = image->palette_rgba[index];
            if (image->channel_mode == BPAL5_CHANNEL_SCALAR) {
                if (!bit_write(&writer, color_red(color), 8u)) {
                    set_error(error, error_size, "Could not write BPAL scalar palette");
                    free(output);
                    return 0;
                }
            } else if (image->palette_color_bits == 16u) {
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

static int read_bits_at(
    const uint8_t *bytes,
    size_t byte_count,
    uint64_t bit_offset,
    uint32_t bit_count,
    uint32_t *value
) {
    bit_reader reader;
    reader.bytes = bytes;
    reader.byte_count = byte_count;
    reader.bit_offset = bit_offset;
    return bit_read(&reader, bit_count, value);
}

int bpal5_sample_file_pixel_rgba(
    const uint8_t *bytes,
    size_t byte_count,
    uint32_t x,
    uint32_t y,
    uint32_t *rgba,
    char *error,
    size_t error_size
) {
    bit_reader header;
    uint32_t version;
    uint32_t width_minus_one;
    uint32_t height_minus_one;
    uint32_t block_exponent_minus_one;
    uint32_t local_bits_minus_one;
    uint32_t global_bits_minus_one;
    uint32_t color_depth_flag;
    uint32_t palette_mode;
    uint32_t ignored;
    uint32_t palette_index_bits;
    uint32_t channel_mode;
    uint32_t flags;
    uint32_t width;
    uint32_t height;
    uint32_t block_size;
    uint32_t local_index_bits;
    uint32_t global_index_bits;
    uint32_t local_color_count;
    uint32_t global_color_count;
    uint32_t palette_count;
    uint32_t blocks_x;
    uint32_t blocks_y;
    uint64_t block_count;
    uint64_t selector_offset;
    uint64_t block_palette_offset;
    uint64_t pixel_index_offset;
    uint64_t block_index;
    uint32_t palette_index;
    uint32_t local_index;
    uint32_t global_index;
    uint64_t color_index;
    size_t palette_section_size = 0u;
    int packed_palettes;

    if (bytes == NULL || rgba == NULL || byte_count < BPAL5_HEADER_BYTES ||
        memcmp(bytes, "BPAL", 4u) != 0) {
        set_error(error, error_size, "Invalid BPAL random-access arguments");
        return 0;
    }
    header.bytes = bytes;
    header.byte_count = byte_count;
    header.bit_offset = 32u;
    if (!bit_read(&header, 4u, &version) || version != BPAL5_VERSION ||
        !bit_read(&header, 24u, &width_minus_one) ||
        !bit_read(&header, 24u, &height_minus_one) ||
        !bit_read(&header, 3u, &block_exponent_minus_one) ||
        !bit_read(&header, 2u, &local_bits_minus_one) ||
        !bit_read(&header, 4u, &global_bits_minus_one) ||
        !bit_read(&header, 1u, &color_depth_flag) ||
        !bit_read(&header, 1u, &palette_mode) ||
        !bit_read(&header, 9u, &ignored) ||
        !bit_read(&header, 1u, &ignored) ||
        !bit_read(&header, 3u, &palette_index_bits) ||
        !bit_read(&header, 2u, &channel_mode) ||
        !bit_read(&header, 2u, &flags) || palette_mode != 0u ||
        channel_mode > BPAL5_CHANNEL_SCALAR ||
        (flags & ~BPAL5_FLAG_PACKED_PALETTES) != 0u ||
        ((flags & BPAL5_FLAG_PACKED_PALETTES) != 0u &&
         channel_mode != BPAL5_CHANNEL_RGB)) {
        set_error(error, error_size, "Unsupported BPAL random-access format");
        return 0;
    }
    width = width_minus_one + 1u;
    height = height_minus_one + 1u;
    block_size = 1u << (block_exponent_minus_one + 1u);
    local_index_bits = local_bits_minus_one + 1u;
    global_index_bits = global_bits_minus_one + 1u;
    local_color_count = 1u << local_index_bits;
    global_color_count = 1u << global_index_bits;
    palette_count = 1u << palette_index_bits;
    if (x >= width || y >= height || block_size < 2u || block_size > 64u ||
        local_color_count > 16u || global_color_count > 256u || palette_count > 128u) {
        set_error(error, error_size, "BPAL random-access coordinate or metadata is invalid");
        return 0;
    }
    blocks_x = (width + block_size - 1u) / block_size;
    blocks_y = (height + block_size - 1u) / block_size;
    block_count = (uint64_t)blocks_x * blocks_y;
    packed_palettes = (flags & BPAL5_FLAG_PACKED_PALETTES) != 0u;
    if (packed_palettes) {
        if (byte_count < BPAL5_HEADER_BYTES + BPAL5_PACKED_PALETTE_HEADER_BYTES) {
            set_error(error, error_size, "Truncated packed BPAL palette section");
            return 0;
        }
        palette_section_size = read_u32_be(bytes + BPAL5_HEADER_BYTES);
        if (palette_section_size < BPAL5_PACKED_PALETTE_HEADER_BYTES +
                (size_t)palette_count * BPAL5_PACKED_PALETTE_DIRECTORY_ENTRY_BYTES ||
            palette_section_size > byte_count - BPAL5_HEADER_BYTES) {
            set_error(error, error_size, "Invalid packed BPAL palette section");
            return 0;
        }
        selector_offset = (uint64_t)(BPAL5_HEADER_BYTES + palette_section_size) * 8u;
    } else {
        const uint32_t stored_color_bits = channel_mode == BPAL5_CHANNEL_SCALAR
            ? 8u
            : (color_depth_flag != 0u ? 24u : 16u);
        selector_offset = (uint64_t)BPAL5_HEADER_BYTES * 8u +
            (uint64_t)palette_count * global_color_count * stored_color_bits;
    }
    block_palette_offset = selector_offset + block_count * palette_index_bits;
    pixel_index_offset = block_palette_offset + block_count * local_color_count * global_index_bits;
    block_index = (uint64_t)(y / block_size) * blocks_x + x / block_size;
    if (!read_bits_at(
            bytes,
            byte_count,
            selector_offset + block_index * palette_index_bits,
            palette_index_bits,
            &palette_index) || palette_index >= palette_count) {
        set_error(error, error_size, "Invalid BPAL random-access palette selector");
        return 0;
    }
    if (local_color_count == block_size * block_size) {
        local_index = (y % block_size) * block_size + x % block_size;
    } else if (!read_bits_at(
                   bytes,
                   byte_count,
                   pixel_index_offset + ((uint64_t)y * width + x) * local_index_bits,
                   local_index_bits,
                   &local_index) || local_index >= local_color_count) {
        set_error(error, error_size, "Invalid BPAL random-access local index");
        return 0;
    }
    if (!read_bits_at(
            bytes,
            byte_count,
            block_palette_offset + (block_index * local_color_count + local_index) * global_index_bits,
            global_index_bits,
            &global_index) || global_index >= global_color_count) {
        set_error(error, error_size, "Invalid BPAL random-access global index");
        return 0;
    }
    color_index = (uint64_t)palette_index * global_color_count + global_index;

    if (!packed_palettes) {
        const uint32_t stored_color_bits = channel_mode == BPAL5_CHANNEL_SCALAR
            ? 8u
            : (color_depth_flag != 0u ? 24u : 16u);
        const uint64_t color_bit_offset = (uint64_t)BPAL5_HEADER_BYTES * 8u +
            color_index * stored_color_bits;
        uint32_t packed_color;
        if (!read_bits_at(
                bytes,
                byte_count,
                color_bit_offset,
                stored_color_bits,
                &packed_color)) {
            set_error(error, error_size, "Truncated BPAL random-access color");
            return 0;
        }
        if (channel_mode == BPAL5_CHANNEL_SCALAR) {
            *rgba = pack_rgba(
                (uint8_t)packed_color,
                (uint8_t)packed_color,
                (uint8_t)packed_color
            );
        } else if (color_depth_flag != 0u) {
            *rgba = pack_rgba(
                (uint8_t)(packed_color >> 16u),
                (uint8_t)(packed_color >> 8u),
                (uint8_t)packed_color
            );
        } else {
            *rgba = unpack_rgb565((uint16_t)packed_color);
        }
    } else {
        const size_t directory_offset = BPAL5_HEADER_BYTES + BPAL5_PACKED_PALETTE_HEADER_BYTES;
        const size_t records_offset = directory_offset +
            (size_t)palette_count * BPAL5_PACKED_PALETTE_DIRECTORY_ENTRY_BYTES;
        const size_t section_end = BPAL5_HEADER_BYTES + palette_section_size;
        const uint32_t relative = read_u32_be(
            bytes + directory_offset +
                (size_t)palette_index * BPAL5_PACKED_PALETTE_DIRECTORY_ENTRY_BYTES
        );
        const uint32_t next_relative = palette_index + 1u < palette_count
            ? read_u32_be(
                bytes + directory_offset +
                    (size_t)(palette_index + 1u) * BPAL5_PACKED_PALETTE_DIRECTORY_ENTRY_BYTES
            )
            : (uint32_t)(section_end - records_offset);
        const size_t record_offset = records_offset + relative;
        const size_t record_end = records_offset + next_relative;
        if (next_relative <= relative || record_offset >= section_end || record_end > section_end) {
            set_error(error, error_size, "Invalid BPAL random-access palette directory");
            return 0;
        }
        if (bytes[record_offset] == 0u) {
            const size_t stride = color_depth_flag != 0u ? 3u : 2u;
            const size_t entry = record_offset + 1u + (size_t)global_index * stride;
            if (record_end - record_offset != 1u + (size_t)global_color_count * stride ||
                entry > record_end || stride > record_end - entry) {
                set_error(error, error_size, "Truncated BPAL random-access palette record");
                return 0;
            }
            if (color_depth_flag != 0u) {
                *rgba = pack_rgba(bytes[entry], bytes[entry + 1u], bytes[entry + 2u]);
            } else {
                *rgba = unpack_rgb565((uint16_t)(((uint16_t)bytes[entry] << 8u) | bytes[entry + 1u]));
            }
        } else {
            uint32_t red_delta;
            uint32_t green_delta;
            uint32_t blue_delta;
            uint32_t red_bits;
            uint32_t green_bits;
            uint32_t blue_bits;
            uint32_t sum_bits;
            uint64_t residual_offset;
            if (record_offset + 5u > section_end) {
                set_error(error, error_size, "Truncated BPAL random-access delta palette");
                return 0;
            }
            red_bits = bytes[record_offset] & 15u;
            green_bits = bytes[record_offset + 1u] >> 4u;
            blue_bits = bytes[record_offset + 1u] & 15u;
            sum_bits = red_bits + green_bits + blue_bits;
            if ((bytes[record_offset] & 0xf0u) != 0x80u ||
                red_bits > 8u || green_bits > 8u || blue_bits > 8u ||
                record_end - record_offset != 5u +
                    (size_t)(((uint64_t)global_color_count * sum_bits + 7u) / 8u)) {
                set_error(error, error_size, "Invalid BPAL random-access delta palette");
                return 0;
            }
            residual_offset = (uint64_t)(record_offset + 5u) * 8u +
                (uint64_t)global_index * sum_bits;
            if (!read_bits_at(bytes, byte_count, residual_offset, red_bits, &red_delta) ||
                !read_bits_at(bytes, byte_count, residual_offset + red_bits, green_bits, &green_delta) ||
                !read_bits_at(bytes, byte_count, residual_offset + red_bits + green_bits, blue_bits, &blue_delta) ||
                bytes[record_offset + 2u] + red_delta > 255u ||
                bytes[record_offset + 3u] + green_delta > 255u ||
                bytes[record_offset + 4u] + blue_delta > 255u) {
                set_error(error, error_size, "Invalid BPAL random-access palette residual");
                return 0;
            }
            *rgba = pack_rgba(
                (uint8_t)(bytes[record_offset + 2u] + red_delta),
                (uint8_t)(bytes[record_offset + 3u] + green_delta),
                (uint8_t)(bytes[record_offset + 4u] + blue_delta)
            );
        }
    }
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

int bpal5_decode_pixel_rgba(
    const bpal5_image *image,
    uint32_t x,
    uint32_t y,
    uint32_t *rgba,
    char *error,
    size_t error_size
) {
    uint32_t block;
    uint32_t palette_base;
    uint32_t local;
    uint32_t global;

    if (rgba == NULL || !validate_image_metadata(image, error, error_size)) {
        return 0;
    }
    if (image->palette_rgba == NULL || image->block_palette_selectors == NULL ||
        image->block_palette_indices == NULL || image->pixel_indices == NULL) {
        set_error(error, error_size, "BPAL image arrays are missing");
        return 0;
    }
    if (x >= image->width || y >= image->height) {
        set_error(error, error_size, "BPAL pixel coordinate is out of range");
        return 0;
    }
    block = (y / image->block_size) * image->blocks_x + x / image->block_size;
    if (image->block_palette_selectors[block] >= image->palette_count) {
        set_error(error, error_size, "Invalid BPAL block palette selector");
        return 0;
    }
    palette_base = image->block_palette_selectors[block] * image->global_color_count;
    local = image->pixel_indices[(size_t)y * image->width + x];
    if (local >= image->local_color_count) {
        set_error(error, error_size, "Invalid BPAL pixel index");
        return 0;
    }
    global = image->block_palette_indices[(size_t)block * image->local_color_count + local];
    if (global >= image->global_color_count) {
        set_error(error, error_size, "Invalid BPAL block color index");
        return 0;
    }
    *rgba = image->palette_rgba[palette_base + global];
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
        !is_power_of_two(options->global_color_count) || options->global_color_count < options->local_color_count || options->global_color_count > 256u ||
        !is_power_of_two(options->palette_count) || options->palette_count > 128u ||
        (options->palette_color_bits != 16u && options->palette_color_bits != 24u) ||
        options->channel_mode > BPAL5_CHANNEL_SCALAR ||
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
    image.palette_color_bits = options->channel_mode == BPAL5_CHANNEL_SCALAR
        ? 24u
        : options->palette_color_bits;
    image.channel_mode = options->channel_mode;
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

static int bpal5_encode_rgb_prepared_with_stats(
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
    const uint8_t *prepared = rgb;
    uint8_t *owned = NULL;
    size_t pixel_count;
    size_t pixel;
    int result;

    if (options == NULL) {
        bpal5_default_encode_options(&defaults);
        options = &defaults;
    }
    if (rgb == NULL) {
        set_error(error, error_size, "Invalid BPAL encode arguments");
        return 0;
    }
    pixel_count = (size_t)width * height;
    if (options->channel_mode == BPAL5_CHANNEL_SCALAR) {
        if (pixel_count > SIZE_MAX / 3u) {
            set_error(error, error_size, "BPAL source image is too large");
            return 0;
        }
        owned = (uint8_t *)malloc(pixel_count * 3u);
        if (owned == NULL) {
            set_error(error, error_size, "Out of memory preparing BPAL channel mode");
            return 0;
        }
        for (pixel = 0u; pixel < pixel_count; ++pixel) {
            const uint8_t red = rgb[pixel * 3u];
            owned[pixel * 3u] = red;
            owned[pixel * 3u + 1u] = red;
            owned[pixel * 3u + 2u] = red;
        }
        prepared = owned;
    }
    result = bpal5_encode_rgb_prepared_with_stats(
        prepared,
        width,
        height,
        options,
        output,
        stats,
        error,
        error_size
    );
    free(owned);
    if (result) {
        finalize_channel_palette(output);
    }
    return result;
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
