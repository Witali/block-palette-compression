#include "bpal5_cuda.h"

#include <cuda_runtime.h>

#include <cstdio>
#include <cstring>
#include <vector>

namespace {

__device__ uint32_t read_bits_at(const uint8_t *bytes, uint64_t bit_offset, uint32_t bit_count) {
    uint32_t value = 0u;
    for (uint32_t bit = 0u; bit < bit_count; ++bit) {
        const uint64_t position = bit_offset + bit;
        value = (value << 1u) |
            ((bytes[position >> 3u] >> (7u - static_cast<uint32_t>(position & 7u))) & 1u);
    }
    return value;
}

__device__ uint32_t read_u32_be(const uint8_t *bytes) {
    return (static_cast<uint32_t>(bytes[0]) << 24u) |
        (static_cast<uint32_t>(bytes[1]) << 16u) |
        (static_cast<uint32_t>(bytes[2]) << 8u) |
        bytes[3];
}

__device__ uint32_t unpack_rgb565(uint32_t value) {
    const uint32_t red5 = value >> 11u & 31u;
    const uint32_t green6 = value >> 5u & 63u;
    const uint32_t blue5 = value & 31u;
    const uint32_t red = (red5 * 255u + 15u) / 31u;
    const uint32_t green = (green6 * 255u + 31u) / 63u;
    const uint32_t blue = (blue5 * 255u + 15u) / 31u;
    return red | green << 8u | blue << 16u | 0xff000000u;
}

__device__ uint32_t sample_bpal_pixel(const uint8_t *bytes, uint32_t x, uint32_t y) {
    const uint32_t width = read_bits_at(bytes, 36u, 24u) + 1u;
    const uint32_t block_size = 1u << (read_bits_at(bytes, 84u, 3u) + 1u);
    const uint32_t local_bits = read_bits_at(bytes, 87u, 2u) + 1u;
    const uint32_t global_bits = read_bits_at(bytes, 89u, 4u) + 1u;
    const uint32_t color_bits = read_bits_at(bytes, 93u, 1u) != 0u ? 24u : 16u;
    const uint32_t palette_bits = read_bits_at(bytes, 105u, 3u);
    const uint32_t packed = read_bits_at(bytes, 108u, 4u) & 1u;
    const uint32_t local_count = 1u << local_bits;
    const uint32_t global_count = 1u << global_bits;
    const uint32_t palette_count = 1u << palette_bits;
    const uint32_t blocks_x = (width + block_size - 1u) / block_size;
    const uint32_t height = read_bits_at(bytes, 60u, 24u) + 1u;
    const uint32_t blocks_y = (height + block_size - 1u) / block_size;
    const uint64_t block_count = static_cast<uint64_t>(blocks_x) * blocks_y;
    const uint32_t section_bytes = packed != 0u ? read_u32_be(bytes + 14u) : 0u;
    const uint64_t selector_offset = packed != 0u
        ? static_cast<uint64_t>(14u + section_bytes) * 8u
        : 112u + static_cast<uint64_t>(palette_count) * global_count * color_bits;
    const uint64_t block_palette_offset = selector_offset + block_count * palette_bits;
    const uint64_t pixel_offset = block_palette_offset + block_count * local_count * global_bits;
    const uint64_t block = static_cast<uint64_t>(y / block_size) * blocks_x + x / block_size;
    const uint32_t palette = read_bits_at(bytes, selector_offset + block * palette_bits, palette_bits);
    const uint32_t local = local_count == block_size * block_size
        ? y % block_size * block_size + x % block_size
        : read_bits_at(bytes, pixel_offset + (static_cast<uint64_t>(y) * width + x) * local_bits, local_bits);
    const uint32_t global = read_bits_at(
        bytes,
        block_palette_offset + (block * local_count + local) * global_bits,
        global_bits
    );

    if (packed == 0u) {
        const uint32_t color = read_bits_at(
            bytes,
            112u + (static_cast<uint64_t>(palette) * global_count + global) * color_bits,
            color_bits
        );
        return color_bits == 16u
            ? unpack_rgb565(color)
            : (color >> 16u) | (color & 0xff00u) | (color & 255u) << 16u | 0xff000000u;
    }

    const uint32_t directory_offset = 18u;
    const uint32_t records_offset = directory_offset + palette_count * 4u;
    const uint32_t record_offset = records_offset + read_u32_be(bytes + directory_offset + palette * 4u);
    if (bytes[record_offset] == 0u) {
        const uint32_t stride = color_bits / 8u;
        const uint32_t entry = record_offset + 1u + global * stride;
        return color_bits == 16u
            ? unpack_rgb565(static_cast<uint32_t>(bytes[entry]) << 8u | bytes[entry + 1u])
            : static_cast<uint32_t>(bytes[entry]) |
                static_cast<uint32_t>(bytes[entry + 1u]) << 8u |
                static_cast<uint32_t>(bytes[entry + 2u]) << 16u |
                0xff000000u;
    }
    const uint32_t red_bits = bytes[record_offset] & 15u;
    const uint32_t green_bits = bytes[record_offset + 1u] >> 4u;
    const uint32_t blue_bits = bytes[record_offset + 1u] & 15u;
    const uint64_t residual = static_cast<uint64_t>(record_offset + 5u) * 8u +
        static_cast<uint64_t>(global) * (red_bits + green_bits + blue_bits);
    const uint32_t red = bytes[record_offset + 2u] + read_bits_at(bytes, residual, red_bits);
    const uint32_t green = bytes[record_offset + 3u] + read_bits_at(bytes, residual + red_bits, green_bits);
    const uint32_t blue = bytes[record_offset + 4u] +
        read_bits_at(bytes, residual + red_bits + green_bits, blue_bits);
    return red | green << 8u | blue << 16u | 0xff000000u;
}

__global__ void sample_bpal_kernel(
    const uint8_t *bytes,
    uint32_t width,
    uint32_t height,
    uint32_t *pixels
) {
    const uint32_t pixel = blockIdx.x * blockDim.x + threadIdx.x;
    if (pixel < width * height) {
        pixels[pixel] = sample_bpal_pixel(bytes, pixel % width, pixel / width);
    }
}

int fail(const char *message) {
    std::fprintf(stderr, "test_cuda_roundtrip: %s\n", message);
    return 1;
}

int run_roundtrip(
    const std::vector<uint8_t> &source,
    uint32_t width,
    uint32_t height,
    uint32_t palette_color_bits,
    bool require_packed_palettes
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
    uint8_t *device_bytes = nullptr;
    uint32_t *device_pixels = nullptr;
    std::vector<uint32_t> gpu_pixels(pixel_count);
    char error[512];
    int result = 1;

    bpal5_default_encode_options(&options);
    if (!bpal5_apply_quality_preset("3", &options)) {
        return fail("preset 3 is unavailable");
    }
    options.kmeans_iterations = 4u;
    options.refinement_passes = 2u;
    options.palette_color_bits = palette_color_bits;

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
        parsed.palette_color_bits != palette_color_bits) {
        result = fail("CUDA BPAL round-trip metadata mismatch");
        goto cleanup;
    }
    if (require_packed_palettes && (bytes[13] & 1u) == 0u) {
        result = fail("test input did not select packed palettes");
        goto cleanup;
    }

    if (cudaMalloc(&device_bytes, byte_count) != cudaSuccess ||
        cudaMalloc(&device_pixels, pixel_count * sizeof(uint32_t)) != cudaSuccess ||
        cudaMemcpy(device_bytes, bytes, byte_count, cudaMemcpyHostToDevice) != cudaSuccess) {
        result = fail("could not allocate CUDA random-access buffers");
        goto cleanup;
    }
    sample_bpal_kernel<<<static_cast<unsigned int>((pixel_count + 255u) / 256u), 256u>>>(
        device_bytes,
        width,
        height,
        device_pixels
    );
    if (cudaGetLastError() != cudaSuccess || cudaDeviceSynchronize() != cudaSuccess ||
        cudaMemcpy(
            gpu_pixels.data(),
            device_pixels,
            pixel_count * sizeof(uint32_t),
            cudaMemcpyDeviceToHost
        ) != cudaSuccess ||
        std::memcmp(gpu_pixels.data(), decoded, pixel_count * sizeof(uint32_t)) != 0) {
        result = fail("CUDA direct pixel sampling differs from full decode");
        goto cleanup;
    }

    for (size_t pixel = 0u; pixel < pixel_count; ++pixel) {
        for (size_t channel = 0u; channel < 3u; ++channel) {
            const int difference = static_cast<int>(source[pixel * 3u + channel]) -
                static_cast<int>(decoded[pixel * 4u + channel]);
            decoded_error += static_cast<uint64_t>(difference * difference);
        }
    }
    if (decoded_error != stats.final_error) {
        result = fail("CUDA-reported error differs from decoded BPAL error");
        goto cleanup;
    }

    std::printf(
        "CUDA RGB%u roundtrip ok: %zu bytes, error %llu -> %llu, %u/%u passes, %s\n",
        palette_color_bits,
        byte_count,
        static_cast<unsigned long long>(stats.initial_error),
        static_cast<unsigned long long>(stats.final_error),
        stats.accepted_refinement_passes,
        stats.requested_refinement_passes,
        stats.device_name
    );
    result = 0;

cleanup:
    cudaFree(device_bytes);
    cudaFree(device_pixels);
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
    std::vector<uint8_t> narrow_source(pixel_count * 3u);
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
        narrow_source[pixel * 3u] = static_cast<uint8_t>(64u + (x + y) % 16u);
        narrow_source[pixel * 3u + 1u] = static_cast<uint8_t>(96u + (x * 3u + y) % 16u);
        narrow_source[pixel * 3u + 2u] = static_cast<uint8_t>(128u + (x + y * 5u) % 16u);
    }
    return run_roundtrip(source, width, height, 24u, false) != 0 ||
        run_roundtrip(source, width, height, 16u, false) != 0 ||
        run_roundtrip(narrow_source, width, height, 24u, true) != 0;
}
