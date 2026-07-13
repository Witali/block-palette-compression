#include "ppm.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void set_error(char *error, size_t error_size, const char *message) {
    if (error != NULL && error_size > 0) {
        (void)snprintf(error, error_size, "%s", message);
    }
}

static int read_token(FILE *file, char *token, size_t token_size) {
    int character;
    size_t length = 0;

    do {
        character = fgetc(file);
        if (character == '#') {
            do {
                character = fgetc(file);
            } while (character != '\n' && character != EOF);
        }
    } while (character != EOF && isspace((unsigned char)character));

    if (character == EOF) {
        return 0;
    }

    while (character != EOF && !isspace((unsigned char)character)) {
        if (length + 1 >= token_size) {
            return 0;
        }
        token[length++] = (char)character;
        character = fgetc(file);
    }
    token[length] = '\0';
    return 1;
}

int bpal5_ppm_read(
    const char *path,
    uint8_t **rgb,
    uint32_t *width,
    uint32_t *height,
    char *error,
    size_t error_size
) {
    FILE *file = NULL;
    char token[64];
    unsigned long parsed_width;
    unsigned long parsed_height;
    unsigned long maximum;
    size_t byte_count;
    uint8_t *pixels = NULL;

    if (rgb == NULL || width == NULL || height == NULL) {
        set_error(error, error_size, "Invalid PPM output arguments");
        return 0;
    }

    *rgb = NULL;
#if defined(_MSC_VER)
    if (fopen_s(&file, path, "rb") != 0) {
        file = NULL;
    }
#else
    file = fopen(path, "rb");
#endif
    if (file == NULL) {
        set_error(error, error_size, "Could not open input PPM file");
        return 0;
    }

    if (!read_token(file, token, sizeof(token)) || strcmp(token, "P6") != 0 ||
        !read_token(file, token, sizeof(token))) {
        set_error(error, error_size, "Input must be a binary PPM P6 file");
        fclose(file);
        return 0;
    }
    parsed_width = strtoul(token, NULL, 10);
    if (!read_token(file, token, sizeof(token))) {
        set_error(error, error_size, "Missing PPM height");
        fclose(file);
        return 0;
    }
    parsed_height = strtoul(token, NULL, 10);
    if (!read_token(file, token, sizeof(token))) {
        set_error(error, error_size, "Missing PPM maximum channel value");
        fclose(file);
        return 0;
    }
    maximum = strtoul(token, NULL, 10);

    if (parsed_width == 0 || parsed_height == 0 || parsed_width > 0x1000000ul ||
        parsed_height > 0x1000000ul || maximum != 255ul) {
        set_error(error, error_size, "Unsupported PPM dimensions or channel depth");
        fclose(file);
        return 0;
    }
    if (parsed_width > SIZE_MAX / parsed_height || parsed_width * parsed_height > SIZE_MAX / 3u) {
        set_error(error, error_size, "PPM image is too large");
        fclose(file);
        return 0;
    }

    byte_count = (size_t)parsed_width * (size_t)parsed_height * 3u;
    pixels = (uint8_t *)malloc(byte_count);
    if (pixels == NULL) {
        set_error(error, error_size, "Out of memory reading PPM");
        fclose(file);
        return 0;
    }
    if (fread(pixels, 1, byte_count, file) != byte_count) {
        set_error(error, error_size, "Truncated PPM pixel data");
        free(pixels);
        fclose(file);
        return 0;
    }

    fclose(file);
    *rgb = pixels;
    *width = (uint32_t)parsed_width;
    *height = (uint32_t)parsed_height;
    return 1;
}

int bpal5_ppm_write_rgb(
    const char *path,
    const uint8_t *rgb,
    uint32_t width,
    uint32_t height,
    char *error,
    size_t error_size
) {
    FILE *file = NULL;
    const size_t byte_count = (size_t)width * (size_t)height * 3u;

#if defined(_MSC_VER)
    if (fopen_s(&file, path, "wb") != 0) {
        file = NULL;
    }
#else
    file = fopen(path, "wb");
#endif
    if (file == NULL) {
        set_error(error, error_size, "Could not open output PPM file");
        return 0;
    }
    if (fprintf(file, "P6\n%u %u\n255\n", width, height) < 0 ||
        fwrite(rgb, 1, byte_count, file) != byte_count) {
        set_error(error, error_size, "Could not write output PPM file");
        fclose(file);
        return 0;
    }
    fclose(file);
    return 1;
}

int bpal5_ppm_write_rgba(
    const char *path,
    const uint8_t *rgba,
    uint32_t width,
    uint32_t height,
    char *error,
    size_t error_size
) {
    const size_t pixel_count = (size_t)width * (size_t)height;
    uint8_t *rgb = (uint8_t *)malloc(pixel_count * 3u);
    size_t pixel;
    int result;

    if (rgb == NULL) {
        set_error(error, error_size, "Out of memory writing PPM");
        return 0;
    }
    for (pixel = 0; pixel < pixel_count; ++pixel) {
        rgb[pixel * 3u] = rgba[pixel * 4u];
        rgb[pixel * 3u + 1u] = rgba[pixel * 4u + 1u];
        rgb[pixel * 3u + 2u] = rgba[pixel * 4u + 2u];
    }
    result = bpal5_ppm_write_rgb(path, rgb, width, height, error, error_size);
    free(rgb);
    return result;
}
