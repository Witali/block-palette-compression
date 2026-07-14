#include "bpal5_cuda.h"
#include "image_loader.h"

#include <cuda_runtime.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {

void print_usage(const char *program) {
    std::fprintf(
        stderr,
        "Usage: %s input-image output.bpal [options]\n"
        "Input: JPEG, PNG, TGA, BMP, PSD, GIF, HDR, PIC, PNM\n"
        "Options:\n"
        "  --preset BPP      Quality preset: 1.5,2,2.5,3,4,5,6,8\n"
        "  --device N        CUDA device ordinal (default 0)\n"
        "  --block N         Block size: 2,4,8,16,32,64 (default 16)\n"
        "  --local N         Colors per block: 2,4,8,16 (default 8)\n"
        "  --global N        Colors per shared palette: 2..4096 power of two (default 32)\n"
        "  --palettes N      Shared palettes: 1..128 power of two (default 1)\n"
        "  --rgb565          Store shared colors as RGB565 (default RGB888)\n"
        "  --iterations N    CPU palette K-means iterations, 1..64 (default 8)\n"
        "  --refine N        CUDA refinement passes, 0..16 (default 4)\n"
        "  --no-simd         Disable AVX2 during CPU palette initialization\n",
        program
    );
}

bool parse_u32(const char *text, uint32_t *value) {
    char *end = nullptr;
    const unsigned long parsed = std::strtoul(text, &end, 10);
    if (text[0] == '\0' || end == nullptr || *end != '\0' || parsed > UINT32_MAX) {
        return false;
    }
    *value = static_cast<uint32_t>(parsed);
    return true;
}

int print_version() {
    int runtime_version = 0;
    int device_count = 0;
    char error[512];
    const cudaError_t runtime_status = cudaRuntimeGetVersion(&runtime_version);
    if (runtime_status != cudaSuccess) {
        std::fprintf(stderr, "bpal5cudaenc: Cannot query CUDA runtime: %s\n", cudaGetErrorString(runtime_status));
        return 1;
    }
    if (!bpal5_cuda_device_count(&device_count, error, sizeof(error))) {
        std::fprintf(stderr, "bpal5cudaenc: %s\n", error);
        return 1;
    }
    std::printf(
        "bpal5cudaenc BPAL v%u, CUDA runtime %d.%d, %d device(s)\n",
        BPAL5_VERSION,
        runtime_version / 1000,
        (runtime_version % 1000) / 10,
        device_count
    );
    for (int device = 0; device < device_count; ++device) {
        cudaDeviceProp properties{};
        if (cudaGetDeviceProperties(&properties, device) == cudaSuccess) {
            std::printf("  [%d] %s (SM %d.%d)\n", device, properties.name, properties.major, properties.minor);
        }
    }
    return 0;
}

}  // namespace

int main(int argc, char **argv) {
    bpal5_encode_options options;
    bpal5_image image{};
    bpal5_cuda_encode_stats stats{};
    uint8_t *rgb = nullptr;
    uint32_t width = 0u;
    uint32_t height = 0u;
    uint32_t device = 0u;
    char error[512];
    int result = 1;

    if (argc == 2 && std::strcmp(argv[1], "--version") == 0) {
        return print_version();
    }
    if (argc == 2 && (std::strcmp(argv[1], "--help") == 0 || std::strcmp(argv[1], "-h") == 0)) {
        print_usage(argv[0]);
        return 0;
    }
    if (argc < 3) {
        print_usage(argv[0]);
        return 2;
    }

    bpal5_default_encode_options(&options);
    for (int argument = 3; argument < argc; ++argument) {
        if (std::strcmp(argv[argument], "--preset") == 0) {
            if (++argument >= argc || !bpal5_apply_quality_preset(argv[argument], &options)) {
                std::fprintf(stderr, "Invalid value for --preset; expected 1.5, 2, 2.5, 3, 4, 5, 6, or 8\n");
                return 2;
            }
        }
    }

    for (int argument = 3; argument < argc; ++argument) {
        const char *name = argv[argument];
        uint32_t *target = nullptr;
        if (std::strcmp(name, "--preset") == 0) {
            ++argument;
            continue;
        }
        if (std::strcmp(name, "--rgb565") == 0) {
            options.palette_color_bits = 16u;
            continue;
        }
        if (std::strcmp(name, "--no-simd") == 0) {
            options.use_simd = 0;
            continue;
        }
        if (std::strcmp(name, "--device") == 0) {
            target = &device;
        } else if (std::strcmp(name, "--block") == 0) {
            target = &options.block_size;
        } else if (std::strcmp(name, "--local") == 0) {
            target = &options.local_color_count;
        } else if (std::strcmp(name, "--global") == 0) {
            target = &options.global_color_count;
        } else if (std::strcmp(name, "--palettes") == 0) {
            target = &options.palette_count;
        } else if (std::strcmp(name, "--iterations") == 0) {
            target = &options.kmeans_iterations;
        } else if (std::strcmp(name, "--refine") == 0) {
            target = &options.refinement_passes;
        } else {
            std::fprintf(stderr, "Unknown option: %s\n", name);
            print_usage(argv[0]);
            return 2;
        }
        if (++argument >= argc || !parse_u32(argv[argument], target)) {
            std::fprintf(stderr, "Invalid value for %s\n", name);
            return 2;
        }
    }
    if (device > static_cast<uint32_t>(INT32_MAX)) {
        std::fprintf(stderr, "Invalid CUDA device ordinal\n");
        return 2;
    }

    if (!bpal5_image_read_rgb(argv[1], &rgb, &width, &height, error, sizeof(error))) {
        std::fprintf(stderr, "bpal5cudaenc: %s\n", error);
        goto cleanup;
    }
    if (!bpal5_encode_rgb_cuda(
            rgb,
            width,
            height,
            &options,
            static_cast<int>(device),
            &image,
            &stats,
            error,
            sizeof(error))) {
        std::fprintf(stderr, "bpal5cudaenc: %s\n", error);
        goto cleanup;
    }
    if (!bpal5_save_file(argv[2], &image, error, sizeof(error))) {
        std::fprintf(stderr, "bpal5cudaenc: %s\n", error);
        goto cleanup;
    }

    std::printf(
        "Encoded %ux%u image to BPAL v5: block %u, local %u, %u x %u shared colors, "
        "RGB%u, CUDA refinements %u/%u, MSE %.6f, CPU init %.3f ms "
        "(clusters %.3f, samples %.3f), CUDA setup %.3f ms, GPU %.3f ms "
        "(palettes %.3f, initial blocks %.3f, refine %.3f), %s\n",
        width,
        height,
        options.block_size,
        options.local_color_count,
        options.palette_count,
        options.global_color_count,
        options.palette_color_bits == 16u ? 565u : 888u,
        stats.accepted_refinement_passes,
        stats.requested_refinement_passes,
        static_cast<double>(stats.final_error) / (static_cast<double>(width) * height * 3.0),
        stats.cpu_initialization_milliseconds,
        stats.cpu_block_clustering_milliseconds,
        stats.cpu_sample_grouping_milliseconds,
        stats.cuda_setup_milliseconds,
        stats.gpu_milliseconds,
        stats.gpu_palette_building_milliseconds,
        stats.gpu_initial_encoding_milliseconds,
        stats.gpu_refinement_milliseconds,
        stats.device_name
    );
    result = 0;

cleanup:
    bpal5_image_pixels_free(rgb);
    bpal5_image_free(&image);
    return result;
}
