#include "bpal5.h"
#include "image_loader.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void print_usage(const char *program) {
    fprintf(stderr,
        "Usage: %s input-image output.bpal [options]\n"
        "Input: JPEG, PNG, TGA, BMP, PSD, GIF, HDR, PIC, PNM\n"
        "Options:\n"
        "  --preset BPP      Quality preset: 1.5,2,2.5,3,4,5,6,8\n"
        "  --find-settings   Find minimum-RMSE settings in the preset bpp range\n"
        "  --block N          Block size: 2,4,8,16,32,64 (default 16)\n"
        "  --local N          Colors per block: 2,4,8,16; <= block pixels (default 8)\n"
        "  --global N         Colors per shared palette: 2..4096 power of two (default 32)\n"
        "  --palettes N       Shared palettes: 1..128 power of two (default 1)\n"
        "  --rgb565           Store shared colors as RGB565 (default RGB888)\n"
        "  --scalar           Store one 8-bit scalar per shared color\n"
        "  --iterations N     K-means iterations, 1..64 (default 8)\n"
        "  --refine N         Refinement passes, 0..16 (default 4)\n"
        "  --threads N        Worker threads, 1..256 (default 4)\n"
        "  --no-simd          Disable AVX2 acceleration\n",
        program
    );
}

static int parse_u32(const char *text, uint32_t *value) {
    char *end = NULL;
    const unsigned long parsed = strtoul(text, &end, 10);
    if (text[0] == '\0' || end == NULL || *end != '\0' || parsed > UINT32_MAX) {
        return 0;
    }
    *value = (uint32_t)parsed;
    return 1;
}

static int find_best_settings(
    const uint8_t *rgb,
    uint32_t width,
    uint32_t height,
    const char *preset_name,
    bpal5_encode_options *options,
    bpal5_image *output,
    bpal5_encode_stats *output_stats,
    char *error,
    size_t error_size
) {
    bpal5_encode_options candidates[BPAL5_FIND_SETTINGS_MAX_CANDIDATES];
    const size_t candidate_count = bpal5_find_settings_candidates(
        options,
        candidates,
        BPAL5_FIND_SETTINGS_MAX_CANDIDATES
    );
    double target_bpp;
    double minimum_bpp;
    double maximum_bpp;
    double best_bpp = 0.0;
    uint64_t best_error = UINT64_MAX;
    uint64_t best_payload_bits = 0u;
    size_t closest_index = candidate_count;
    double closest_bpp = 0.0;
    double closest_distance = INFINITY;
    size_t index;
    int found = 0;

    if (!bpal5_quality_preset_range(preset_name, &target_bpp, &minimum_bpp, &maximum_bpp)) {
        (void)snprintf(error, error_size, "Invalid preset for settings search");
        return 0;
    }
    fprintf(
        stderr,
        "Finding settings for target %.3f bpp (preset %s), allowed range %.3f..%.3f bpp (%zu candidates)\n",
        target_bpp,
        preset_name,
        minimum_bpp,
        maximum_bpp,
        candidate_count
    );
    for (index = 0u; index < candidate_count; ++index) {
        const uint64_t payload_bits = bpal5_estimate_payload_bits(&candidates[index], width, height);
        const double bpp = (double)payload_bits / ((double)width * height);
        const double distance = fabs(bpp - target_bpp);
        bpal5_image candidate_image;
        bpal5_encode_stats candidate_stats;
        double mse;
        double rmse;
        double psnr;
        int better;

        if (distance < closest_distance ||
            (distance == closest_distance && bpp < closest_bpp)) {
            closest_index = index;
            closest_bpp = bpp;
            closest_distance = distance;
        }
        if (bpp < minimum_bpp || bpp > maximum_bpp) {
            fprintf(stderr, "  %zu/%zu: %.3f bpp, outside range\n", index + 1u, candidate_count, bpp);
            continue;
        }
        memset(&candidate_image, 0, sizeof(candidate_image));
        memset(&candidate_stats, 0, sizeof(candidate_stats));
        if (!bpal5_encode_rgb_with_stats(
                rgb,
                width,
                height,
                &candidates[index],
                &candidate_image,
                &candidate_stats,
                error,
                error_size)) {
            bpal5_image_free(output);
            return 0;
        }
        mse = (double)candidate_stats.final_error / ((double)width * height * 3.0);
        rmse = sqrt(mse);
        psnr = mse == 0.0 ? INFINITY : 10.0 * log10((255.0 * 255.0) / mse);
        fprintf(
            stderr,
            "  %zu/%zu: %.3f bpp, block %u, local %u, global %u, RGB%u, "
            "RMSE %.6f, PSNR %.4f dB\n",
            index + 1u,
            candidate_count,
            bpp,
            candidates[index].block_size,
            candidates[index].local_color_count,
            candidates[index].global_color_count,
            candidates[index].channel_mode == BPAL5_CHANNEL_SCALAR
                ? 888u
                : (candidates[index].palette_color_bits == 16u ? 565u : 888u),
            rmse,
            psnr
        );
        better = !found || candidate_stats.final_error < best_error;
        if (!better && candidate_stats.final_error == best_error) {
            const double distance = fabs(bpp - target_bpp);
            const double best_distance = fabs(best_bpp - target_bpp);
            better = distance < best_distance ||
                (distance == best_distance && payload_bits < best_payload_bits);
        }
        if (better) {
            bpal5_image_free(output);
            *output = candidate_image;
            memset(&candidate_image, 0, sizeof(candidate_image));
            *options = candidates[index];
            *output_stats = candidate_stats;
            best_error = candidate_stats.final_error;
            best_payload_bits = payload_bits;
            best_bpp = bpp;
            found = 1;
        }
        bpal5_image_free(&candidate_image);
    }
    if (!found && closest_index < candidate_count) {
        bpal5_image candidate_image;
        bpal5_encode_stats candidate_stats;

        memset(&candidate_image, 0, sizeof(candidate_image));
        memset(&candidate_stats, 0, sizeof(candidate_stats));
        fprintf(
            stderr,
            "No candidate inside the preset range; using closest candidate %.3f bpp\n",
            closest_bpp
        );
        if (!bpal5_encode_rgb_with_stats(
                rgb,
                width,
                height,
                &candidates[closest_index],
                &candidate_image,
                &candidate_stats,
                error,
                error_size)) {
            bpal5_image_free(output);
            return 0;
        }
        *output = candidate_image;
        *options = candidates[closest_index];
        *output_stats = candidate_stats;
        best_error = candidate_stats.final_error;
        best_payload_bits = bpal5_estimate_payload_bits(options, width, height);
        best_bpp = closest_bpp;
        found = 1;
    }
    if (!found) {
        (void)snprintf(
            error,
            error_size,
            "No settings produced %.3f..%.3f bpp",
            minimum_bpp,
            maximum_bpp
        );
        return 0;
    }
    fprintf(
        stderr,
        "Selected %.3f bpp for target %.3f bpp with RMSE %.6f and PSNR %.4f dB\n",
        best_bpp,
        target_bpp,
        sqrt((double)best_error / ((double)width * height * 3.0)),
        best_error == 0u
            ? INFINITY
            : 10.0 * log10((255.0 * 255.0) /
                ((double)best_error / ((double)width * height * 3.0)))
    );
    return 1;
}

int main(int argc, char **argv) {
    bpal5_encode_options options;
    bpal5_image image;
    bpal5_encode_stats stats;
    uint8_t *rgb = NULL;
    uint32_t width = 0;
    uint32_t height = 0;
    char error[512];
    const char *preset_name = NULL;
    int argument;
    int find_settings = 0;
    int result = 1;

    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        printf("bpal5enc BPAL v%u (%s runtime backend)\n", BPAL5_VERSION, bpal5_simd_backend(1));
        return 0;
    }
    if (argc < 3) {
        print_usage(argv[0]);
        return 2;
    }
    bpal5_default_encode_options(&options);
    memset(&image, 0, sizeof(image));
    memset(&stats, 0, sizeof(stats));

    for (argument = 3; argument < argc; ++argument) {
        if (strcmp(argv[argument], "--preset") == 0) {
            if (++argument >= argc || !bpal5_apply_quality_preset(argv[argument], &options)) {
                fprintf(stderr, "Invalid value for --preset; expected 1.5, 2, 2.5, 3, 4, 5, 6, or 8\n");
                return 2;
            }
            preset_name = argv[argument];
        }
    }

    for (argument = 3; argument < argc; ++argument) {
        const char *name = argv[argument];
        uint32_t *target = NULL;
        if (strcmp(name, "--preset") == 0) {
            ++argument;
            continue;
        }
        if (strcmp(name, "--find-settings") == 0) {
            find_settings = 1;
            continue;
        }
        if (strcmp(name, "--rgb565") == 0) {
            options.palette_color_bits = 16u;
            continue;
        }
        if (strcmp(name, "--scalar") == 0) {
            options.channel_mode = BPAL5_CHANNEL_SCALAR;
            continue;
        }
        if (strcmp(name, "--no-simd") == 0) {
            options.use_simd = 0;
            continue;
        }
        if (strcmp(name, "--block") == 0) {
            target = &options.block_size;
        } else if (strcmp(name, "--local") == 0) {
            target = &options.local_color_count;
        } else if (strcmp(name, "--global") == 0) {
            target = &options.global_color_count;
        } else if (strcmp(name, "--palettes") == 0) {
            target = &options.palette_count;
        } else if (strcmp(name, "--iterations") == 0) {
            target = &options.kmeans_iterations;
        } else if (strcmp(name, "--refine") == 0) {
            target = &options.refinement_passes;
        } else if (strcmp(name, "--threads") == 0) {
            target = &options.thread_count;
        } else {
            fprintf(stderr, "Unknown option: %s\n", name);
            print_usage(argv[0]);
            return 2;
        }
        if (++argument >= argc || !parse_u32(argv[argument], target)) {
            fprintf(stderr, "Invalid value for %s\n", name);
            return 2;
        }
    }
    if (options.thread_count == 0u || options.thread_count > 256u) {
        fprintf(stderr, "Invalid value for --threads; expected 1..256\n");
        return 2;
    }
    if (options.local_color_count > options.block_size * options.block_size) {
        fprintf(stderr, "Invalid --local value: colors per block cannot exceed block pixels\n");
        return 2;
    }
    if (find_settings && preset_name == NULL) {
        fprintf(stderr, "--find-settings requires --preset BPP\n");
        return 2;
    }

    if (!bpal5_image_read_rgb(argv[1], &rgb, &width, &height, error, sizeof(error))) {
        fprintf(stderr, "bpal5enc: %s\n", error);
        goto cleanup;
    }
    if (find_settings
        ? !find_best_settings(
            rgb,
            width,
            height,
            preset_name,
            &options,
            &image,
            &stats,
            error,
            sizeof(error))
        : !bpal5_encode_rgb_with_stats(
            rgb,
            width,
            height,
            &options,
            &image,
            &stats,
            error,
            sizeof(error))) {
        fprintf(stderr, "bpal5enc: %s\n", error);
        goto cleanup;
    }
    if (!bpal5_save_file(argv[2], &image, error, sizeof(error))) {
        fprintf(stderr, "bpal5enc: %s\n", error);
        goto cleanup;
    }

    printf(
        "Encoded %ux%u image to BPAL v5: block %u, local %u, %u x %u shared colors, "
        "RGB%u, %s, refinement %u, %u threads, %s, MSE %.6f, RMSE %.6f, PSNR %.4f dB, CPU stages %.3f ms "
        "(clusters %.3f, palettes %.3f, blocks %.3f, refine %.3f)\n",
        width,
        height,
        options.block_size,
        options.local_color_count,
        options.palette_count,
        options.global_color_count,
        image.palette_color_bits == 16u ? 565u : 888u,
        options.channel_mode == BPAL5_CHANNEL_SCALAR
            ? "scalar8"
            : "rgb",
        options.refinement_passes,
        options.thread_count,
        bpal5_simd_backend(options.use_simd),
        (double)stats.final_error / ((double)width * height * 3.0),
        sqrt((double)stats.final_error / ((double)width * height * 3.0)),
        stats.final_error == 0u
            ? INFINITY
            : 10.0 * log10((255.0 * 255.0) /
                ((double)stats.final_error / ((double)width * height * 3.0))),
        stats.block_clustering_milliseconds +
            stats.palette_building_milliseconds +
            stats.block_encoding_milliseconds +
            stats.refinement_milliseconds,
        stats.block_clustering_milliseconds,
        stats.palette_building_milliseconds,
        stats.block_encoding_milliseconds,
        stats.refinement_milliseconds
    );
    result = 0;

cleanup:
    bpal5_image_pixels_free(rgb);
    bpal5_image_free(&image);
    return result;
}
