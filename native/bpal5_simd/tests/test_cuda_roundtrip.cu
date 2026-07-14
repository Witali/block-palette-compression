#include "bpal5_cuda.h"

#include <cstdio>
#include <cstring>
#include <vector>

namespace {

int fail(const char *message) {
    std::fprintf(stderr, "test_cuda_roundtrip: %s\n", message);
    return 1;
}

int run_roundtrip(
    const std::vector<uint8_t> &source,
    uint32_t width,
    uint32_t height,
    uint32_t palette_color_bits,
    uint32_t channel_mode
) {
    const size_t pixel_count = static_cast<size_t>(width) * height;
    bpal5_encode_options options;
    bpal5_image encoded{};
    bpal5_image cpu_encoded{};
    bpal5_image parsed{};
    bpal5_cuda_encode_stats stats{};
    uint8_t *bytes = nullptr;
    uint8_t *cpu_bytes = nullptr;
    size_t byte_count = 0u;
    size_t cpu_byte_count = 0u;
    uint8_t *decoded = nullptr;
    size_t decoded_size = 0u;
    uint64_t decoded_error = 0u;
    char error[512];
    int result = 1;

    bpal5_default_encode_options(&options);
    if (!bpal5_apply_quality_preset("3", &options)) {
        return fail("preset 3 is unavailable");
    }
    options.kmeans_iterations = 4u;
    options.refinement_passes = 2u;
    options.palette_color_bits = palette_color_bits;
    options.channel_mode = channel_mode;

    if (!bpal5_encode_rgb_cuda(
            source.data(),
            width,
            height,
            &options,
            0,
            &encoded,
            &stats,
            error,
            sizeof(error))) {
        std::fprintf(stderr, "test_cuda_roundtrip: %s\n", error);
        goto cleanup;
    }
    if (stats.final_error > stats.initial_error ||
        stats.accepted_refinement_passes > stats.requested_refinement_passes ||
        stats.device_name[0] == '\0') {
        result = fail("invalid CUDA encode statistics");
        goto cleanup;
    }
    if (!bpal5_encode_rgb(
            source.data(),
            width,
            height,
            &options,
            &cpu_encoded,
            error,
            sizeof(error))) {
        std::fprintf(stderr, "test_cuda_roundtrip: %s\n", error);
        goto cleanup;
    }
    if (!bpal5_serialize(&encoded, &bytes, &byte_count, error, sizeof(error)) ||
        !bpal5_serialize(&cpu_encoded, &cpu_bytes, &cpu_byte_count, error, sizeof(error)) ||
        !bpal5_parse(bytes, byte_count, &parsed, error, sizeof(error)) ||
        !bpal5_decode_rgba(&parsed, 1, &decoded, &decoded_size, error, sizeof(error))) {
        std::fprintf(stderr, "test_cuda_roundtrip: %s\n", error);
        goto cleanup;
    }
    if (byte_count != cpu_byte_count || std::memcmp(bytes, cpu_bytes, byte_count) != 0) {
        result = fail("CPU and CUDA BPAL output differs");
        goto cleanup;
    }
    if (decoded_size != pixel_count * 4u || parsed.width != width || parsed.height != height ||
        parsed.block_size != 8u || parsed.local_color_count != 4u ||
        parsed.global_color_count != 256u || parsed.palette_count != 64u ||
        parsed.palette_color_bits != (channel_mode == BPAL5_CHANNEL_SCALAR ? 24u : palette_color_bits) ||
        parsed.channel_mode != channel_mode) {
        result = fail("CUDA BPAL round-trip metadata mismatch");
        goto cleanup;
    }

    for (size_t pixel = 0u; pixel < pixel_count; ++pixel) {
        uint32_t random_pixel = 0u;
        if (!bpal5_decode_pixel_rgba(
                &parsed,
                static_cast<uint32_t>(pixel % width),
                static_cast<uint32_t>(pixel / width),
                &random_pixel,
                error,
                sizeof(error)) ||
            std::memcmp(&random_pixel, decoded + pixel * 4u, 4u) != 0) {
            result = fail("CUDA specialized random pixel decode mismatch");
            goto cleanup;
        }
        for (size_t channel = 0u; channel < 3u; ++channel) {
            uint8_t expected = source[pixel * 3u + channel];
            if (channel_mode == BPAL5_CHANNEL_SCALAR) {
                expected = source[pixel * 3u];
            }
            const int difference = static_cast<int>(expected) -
                static_cast<int>(decoded[pixel * 4u + channel]);
            decoded_error += static_cast<uint64_t>(difference * difference);
        }
    }
    if (decoded_error != stats.final_error) {
        result = fail("CUDA-reported error differs from decoded BPAL error");
        goto cleanup;
    }

    std::printf(
        "CUDA RGB%u mode %u roundtrip ok: %zu bytes, error %llu -> %llu, %u/%u passes, %s\n",
        palette_color_bits,
        channel_mode,
        byte_count,
        static_cast<unsigned long long>(stats.initial_error),
        static_cast<unsigned long long>(stats.final_error),
        stats.accepted_refinement_passes,
        stats.requested_refinement_passes,
        stats.device_name
    );
    result = 0;

cleanup:
    bpal5_free(bytes);
    bpal5_free(cpu_bytes);
    bpal5_free(decoded);
    bpal5_image_free(&encoded);
    bpal5_image_free(&cpu_encoded);
    bpal5_image_free(&parsed);
    return result;
}

}  // namespace

int main() {
    constexpr uint32_t width = 64u;
    constexpr uint32_t height = 64u;
    const size_t pixel_count = static_cast<size_t>(width) * height;
    std::vector<uint8_t> source(pixel_count * 3u);
    char error[512];
    int device_count = 0;

    if (!bpal5_cuda_device_count(&device_count, error, sizeof(error)) || device_count == 0) {
        std::fprintf(stderr, "CUDA test skipped: %s\n", device_count == 0 ? "no CUDA device" : error);
        return 77;
    }
    for (size_t pixel = 0u; pixel < pixel_count; ++pixel) {
        const uint32_t x = static_cast<uint32_t>(pixel % width);
        const uint32_t y = static_cast<uint32_t>(pixel / width);
        source[pixel * 3u] = static_cast<uint8_t>((x * 17u + y * 3u) & 255u);
        source[pixel * 3u + 1u] = static_cast<uint8_t>((x * 5u + y * 23u) & 255u);
        source[pixel * 3u + 2u] = static_cast<uint8_t>(((x ^ y) * 31u + x * 2u) & 255u);
    }
    return run_roundtrip(source, width, height, 24u, BPAL5_CHANNEL_RGB) != 0 ||
        run_roundtrip(source, width, height, 16u, BPAL5_CHANNEL_RGB) != 0 ||
        run_roundtrip(source, width, height, 16u, BPAL5_CHANNEL_SCALAR) != 0;
}
