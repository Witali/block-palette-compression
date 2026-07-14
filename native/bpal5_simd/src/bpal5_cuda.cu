#include "bpal5_cuda.h"

#include <cuda_runtime.h>

#include <chrono>
#include <cstdio>
#include <cstring>
#include <limits>
#include <utility>

namespace {

constexpr unsigned int CUDA_THREADS = 256u;
constexpr unsigned int MAX_BLOCK_PIXELS = 64u * 64u;
constexpr unsigned int MAX_LOCAL_COLORS = 16u;

struct DeviceImageInfo {
    uint32_t width;
    uint32_t height;
    uint32_t block_size;
    uint32_t blocks_x;
    uint32_t block_count;
    uint32_t local_color_count;
    uint32_t global_color_count;
    uint32_t palette_color_bits;
    size_t pixel_count;
};

struct DeviceBuffers {
    uint8_t *rgb_bytes;
    uint32_t *rgb;
    uint8_t *selectors;
    uint8_t *current_pixels;
    uint8_t *candidate_pixels;
    uint16_t *current_blocks;
    uint16_t *candidate_blocks;
    uint32_t *current_palette;
    uint32_t *candidate_palette;
    uint32_t *counts;
    unsigned long long *red_sums;
    unsigned long long *green_sums;
    unsigned long long *blue_sums;
    unsigned long long *error_sum;
};

void set_message(char *error, size_t error_size, const char *message) {
    if (error != nullptr && error_size != 0u) {
        std::snprintf(error, error_size, "%s", message);
    }
}

void set_cuda_message(
    char *error,
    size_t error_size,
    const char *operation,
    cudaError_t status
) {
    if (error != nullptr && error_size != 0u) {
        std::snprintf(
            error,
            error_size,
            "%s: %s",
            operation,
            cudaGetErrorString(status)
        );
    }
}

void release_buffers(DeviceBuffers *buffers) {
    if (buffers == nullptr) {
        return;
    }
    cudaFree(buffers->rgb_bytes);
    cudaFree(buffers->rgb);
    cudaFree(buffers->selectors);
    cudaFree(buffers->current_pixels);
    cudaFree(buffers->candidate_pixels);
    cudaFree(buffers->current_blocks);
    cudaFree(buffers->candidate_blocks);
    cudaFree(buffers->current_palette);
    cudaFree(buffers->candidate_palette);
    cudaFree(buffers->counts);
    cudaFree(buffers->red_sums);
    cudaFree(buffers->green_sums);
    cudaFree(buffers->blue_sums);
    cudaFree(buffers->error_sum);
    std::memset(buffers, 0, sizeof(*buffers));
}

__device__ __forceinline__ uint32_t pack_rgba(
    uint8_t red,
    uint8_t green,
    uint8_t blue
) {
    return static_cast<uint32_t>(red) |
        (static_cast<uint32_t>(green) << 8u) |
        (static_cast<uint32_t>(blue) << 16u) |
        0xff000000u;
}

__device__ __forceinline__ uint32_t color_distance(
    uint8_t red,
    uint8_t green,
    uint8_t blue,
    uint32_t color
) {
    const int dr = static_cast<int>(red) - static_cast<int>(color & 255u);
    const int dg = static_cast<int>(green) - static_cast<int>((color >> 8u) & 255u);
    const int db = static_cast<int>(blue) - static_cast<int>((color >> 16u) & 255u);
    return static_cast<uint32_t>(dr * dr + dg * dg + db * db);
}

__device__ __forceinline__ uint32_t color_distance(uint32_t source, uint32_t color) {
    return color_distance(
        static_cast<uint8_t>(source & 255u),
        static_cast<uint8_t>((source >> 8u) & 255u),
        static_cast<uint8_t>((source >> 16u) & 255u),
        color
    );
}

__device__ __forceinline__ uint32_t quantize_color(uint32_t color, uint32_t bits) {
    if (bits != 16u) {
        return color;
    }
    const uint32_t red5 = ((color & 255u) * 31u + 127u) / 255u;
    const uint32_t green6 = (((color >> 8u) & 255u) * 63u + 127u) / 255u;
    const uint32_t blue5 = (((color >> 16u) & 255u) * 31u + 127u) / 255u;
    const uint32_t red = (red5 * 255u + 15u) / 31u;
    const uint32_t green = (green6 * 255u + 31u) / 63u;
    const uint32_t blue = (blue5 * 255u + 15u) / 31u;
    return pack_rgba(
        static_cast<uint8_t>(red),
        static_cast<uint8_t>(green),
        static_cast<uint8_t>(blue)
    );
}

__device__ __forceinline__ uint32_t block_for_pixel(
    size_t pixel,
    const DeviceImageInfo &info
) {
    const uint32_t x = static_cast<uint32_t>(pixel % info.width);
    const uint32_t y = static_cast<uint32_t>(pixel / info.width);
    return (y / info.block_size) * info.blocks_x + x / info.block_size;
}

__device__ __forceinline__ unsigned long long warp_sum(unsigned long long value) {
    for (int offset = 16; offset > 0; offset >>= 1) {
        value += __shfl_down_sync(0xffffffffu, value, offset);
    }
    return value;
}

__global__ void cache_rgb_kernel(
    const uint8_t *rgb_bytes,
    uint32_t *rgb,
    size_t pixel_count
) {
    const size_t pixel = static_cast<size_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (pixel < pixel_count) {
        const uint8_t *source = rgb_bytes + pixel * 3u;
        rgb[pixel] = pack_rgba(source[0], source[1], source[2]);
    }
}

__global__ void calculate_error_kernel(
    const uint32_t *rgb,
    DeviceImageInfo info,
    const uint8_t *selectors,
    const uint32_t *palette,
    const uint16_t *block_indices,
    const uint8_t *pixel_indices,
    unsigned long long *error_sum
) {
    const size_t pixel = static_cast<size_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    unsigned long long error = 0u;
    if (pixel < info.pixel_count) {
        const uint32_t block = block_for_pixel(pixel, info);
        const uint32_t local = pixel_indices[pixel];
        const uint32_t global = block_indices[
            static_cast<size_t>(block) * info.local_color_count + local
        ];
        const uint32_t palette_base =
            static_cast<uint32_t>(selectors[block]) * info.global_color_count;
        error = color_distance(rgb[pixel], palette[palette_base + global]);
    }
    error = warp_sum(error);
    if ((threadIdx.x & 31u) == 0u) {
        atomicAdd(error_sum, error);
    }
}

__global__ void accumulate_centroids_kernel(
    const uint32_t *rgb,
    DeviceImageInfo info,
    const uint8_t *selectors,
    const uint16_t *block_indices,
    const uint8_t *pixel_indices,
    unsigned long long *red_sums,
    unsigned long long *green_sums,
    unsigned long long *blue_sums,
    uint32_t *counts
) {
    const size_t pixel = static_cast<size_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (pixel >= info.pixel_count) {
        return;
    }
    const uint32_t block = block_for_pixel(pixel, info);
    const uint32_t local = pixel_indices[pixel];
    const uint32_t global = block_indices[
        static_cast<size_t>(block) * info.local_color_count + local
    ];
    const uint32_t palette_entry =
        static_cast<uint32_t>(selectors[block]) * info.global_color_count + global;
    const uint32_t source = rgb[pixel];
    atomicAdd(red_sums + palette_entry, static_cast<unsigned long long>(source & 255u));
    atomicAdd(green_sums + palette_entry, static_cast<unsigned long long>((source >> 8u) & 255u));
    atomicAdd(blue_sums + palette_entry, static_cast<unsigned long long>((source >> 16u) & 255u));
    atomicAdd(counts + palette_entry, 1u);
}

__global__ void finalize_centroids_kernel(
    uint32_t *palette,
    size_t palette_entries,
    uint32_t palette_color_bits,
    const unsigned long long *red_sums,
    const unsigned long long *green_sums,
    const unsigned long long *blue_sums,
    const uint32_t *counts
) {
    const size_t index = static_cast<size_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index >= palette_entries || counts[index] == 0u) {
        return;
    }
    const uint32_t count = counts[index];
    const uint8_t red = static_cast<uint8_t>((red_sums[index] + count / 2u) / count);
    const uint8_t green = static_cast<uint8_t>((green_sums[index] + count / 2u) / count);
    const uint8_t blue = static_cast<uint8_t>((blue_sums[index] + count / 2u) / count);
    palette[index] = quantize_color(pack_rgba(red, green, blue), palette_color_bits);
}

__global__ void select_block_palette_kernel(
    const uint32_t *rgb,
    DeviceImageInfo info,
    const uint8_t *selectors,
    const uint32_t *palette,
    uint16_t *block_indices
) {
    __shared__ unsigned long long shared_scores[CUDA_THREADS];
    __shared__ uint32_t shared_candidates[CUDA_THREADS];
    __shared__ uint32_t shared_best_distances[MAX_BLOCK_PIXELS];
    __shared__ uint32_t shared_selected[MAX_LOCAL_COLORS];

    const uint32_t block = blockIdx.x;
    const uint32_t block_x = block % info.blocks_x;
    const uint32_t block_y = block / info.blocks_x;
    const uint32_t start_x = block_x * info.block_size;
    const uint32_t start_y = block_y * info.block_size;
    const uint32_t end_x = min(start_x + info.block_size, info.width);
    const uint32_t end_y = min(start_y + info.block_size, info.height);
    const uint32_t block_width = end_x - start_x;
    const uint32_t block_pixel_count = block_width * (end_y - start_y);
    const uint32_t palette_base =
        static_cast<uint32_t>(selectors[block]) * info.global_color_count;

    for (uint32_t position = threadIdx.x; position < block_pixel_count; position += blockDim.x) {
        shared_best_distances[position] = UINT_MAX;
    }
    __syncthreads();

    for (uint32_t slot = 0u; slot < info.local_color_count; ++slot) {
        unsigned long long thread_score = ULLONG_MAX;
        uint32_t thread_candidate = UINT_MAX;

        for (uint32_t candidate = threadIdx.x;
             candidate < info.global_color_count;
             candidate += blockDim.x) {
            bool selected = false;
            for (uint32_t previous = 0u; previous < slot; ++previous) {
                if (shared_selected[previous] == candidate) {
                    selected = true;
                    break;
                }
            }
            if (selected) {
                continue;
            }

            const uint32_t color = palette[palette_base + candidate];
            unsigned long long score = 0u;
            uint32_t position = 0u;
            for (uint32_t y = start_y; y < end_y; ++y) {
                for (uint32_t x = start_x; x < end_x; ++x) {
                    const size_t pixel = static_cast<size_t>(y) * info.width + x;
                    const uint32_t distance = color_distance(rgb[pixel], color);
                    score += min(distance, shared_best_distances[position++]);
                }
            }
            if (score < thread_score || (score == thread_score && candidate < thread_candidate)) {
                thread_score = score;
                thread_candidate = candidate;
            }
        }

        shared_scores[threadIdx.x] = thread_score;
        shared_candidates[threadIdx.x] = thread_candidate;
        __syncthreads();

        for (uint32_t offset = blockDim.x / 2u; offset != 0u; offset >>= 1u) {
            if (threadIdx.x < offset) {
                const unsigned long long other_score = shared_scores[threadIdx.x + offset];
                const uint32_t other_candidate = shared_candidates[threadIdx.x + offset];
                if (other_score < shared_scores[threadIdx.x] ||
                    (other_score == shared_scores[threadIdx.x] &&
                     other_candidate < shared_candidates[threadIdx.x])) {
                    shared_scores[threadIdx.x] = other_score;
                    shared_candidates[threadIdx.x] = other_candidate;
                }
            }
            __syncthreads();
        }

        if (threadIdx.x == 0u) {
            shared_selected[slot] = shared_candidates[0];
            block_indices[static_cast<size_t>(block) * info.local_color_count + slot] =
                static_cast<uint16_t>(shared_candidates[0]);
        }
        __syncthreads();

        const uint32_t selected_color = palette[palette_base + shared_selected[slot]];
        for (uint32_t position = threadIdx.x; position < block_pixel_count; position += blockDim.x) {
            const uint32_t x = start_x + position % block_width;
            const uint32_t y = start_y + position / block_width;
            const uint32_t source = rgb[static_cast<size_t>(y) * info.width + x];
            const uint32_t distance = color_distance(source, selected_color);
            if (distance < shared_best_distances[position]) {
                shared_best_distances[position] = distance;
            }
        }
        __syncthreads();
    }
}

__global__ void assign_pixels_kernel(
    const uint32_t *rgb,
    DeviceImageInfo info,
    const uint8_t *selectors,
    const uint32_t *palette,
    const uint16_t *block_indices,
    uint8_t *pixel_indices,
    unsigned long long *error_sum
) {
    const size_t pixel = static_cast<size_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    unsigned long long error = 0u;
    if (pixel < info.pixel_count) {
        const uint32_t block = block_for_pixel(pixel, info);
        const uint32_t palette_base =
            static_cast<uint32_t>(selectors[block]) * info.global_color_count;
        const uint32_t source = rgb[pixel];
        uint32_t best_distance = UINT_MAX;
        uint32_t best_local = 0u;
        for (uint32_t local = 0u; local < info.local_color_count; ++local) {
            const uint32_t global = block_indices[
                static_cast<size_t>(block) * info.local_color_count + local
            ];
            const uint32_t distance = color_distance(source, palette[palette_base + global]);
            if (distance < best_distance) {
                best_distance = distance;
                best_local = local;
            }
        }
        pixel_indices[pixel] = static_cast<uint8_t>(best_local);
        error = best_distance;
    }
    error = warp_sum(error);
    if ((threadIdx.x & 31u) == 0u) {
        atomicAdd(error_sum, error);
    }
}

dim3 grid_for(size_t items) {
    return dim3(static_cast<unsigned int>((items + CUDA_THREADS - 1u) / CUDA_THREADS));
}

}  // namespace

extern "C" int bpal5_cuda_device_count(int *count, char *error, size_t error_size) {
    int detected = 0;
    if (count == nullptr) {
        set_message(error, error_size, "Invalid CUDA device-count output");
        return 0;
    }
    const cudaError_t status = cudaGetDeviceCount(&detected);
    if (status != cudaSuccess) {
        *count = 0;
        set_cuda_message(error, error_size, "Cannot enumerate CUDA devices", status);
        return 0;
    }
    *count = detected;
    return 1;
}

extern "C" int bpal5_encode_rgb_cuda(
    const uint8_t *rgb,
    uint32_t width,
    uint32_t height,
    const bpal5_encode_options *options_input,
    int device_ordinal,
    bpal5_image *output,
    bpal5_cuda_encode_stats *stats,
    char *error,
    size_t error_size
) {
    bpal5_encode_options options;
    bpal5_image image{};
    bpal5_cuda_encode_stats local_stats{};
    bpal5_cuda_encode_stats *result_stats = stats != nullptr ? stats : &local_stats;
    DeviceImageInfo info{};
    DeviceBuffers buffers{};
    cudaDeviceProp properties{};
    std::chrono::steady_clock::time_point cpu_start;
    std::chrono::steady_clock::time_point cpu_end;
    std::chrono::steady_clock::time_point gpu_start;
    std::chrono::steady_clock::time_point gpu_end;
    size_t palette_entries = 0u;
    size_t block_entries = 0u;
    size_t pixel_count = 0u;
    size_t palette_bytes = 0u;
    size_t block_bytes = 0u;
    unsigned long long current_error = 0u;
    unsigned long long candidate_error = 0u;
    uint32_t pass = 0u;
    int device_count = 0;
    int success = 0;

#define BPAL5_CUDA_CHECK(call, operation) \
    do { \
        const cudaError_t call_status = (call); \
        if (call_status != cudaSuccess) { \
            set_cuda_message(error, error_size, operation, call_status); \
            goto cleanup; \
        } \
    } while (0)

    if (rgb == nullptr || output == nullptr) {
        set_message(error, error_size, "Invalid CUDA BPAL encode arguments");
        return 0;
    }
    std::memset(output, 0, sizeof(*output));
    std::memset(result_stats, 0, sizeof(*result_stats));
    if (options_input == nullptr) {
        bpal5_default_encode_options(&options);
    } else {
        options = *options_input;
    }

    if (!bpal5_cuda_device_count(&device_count, error, error_size)) {
        goto cleanup;
    }
    if (device_ordinal < 0 || device_ordinal >= device_count) {
        set_message(error, error_size, "Requested CUDA device does not exist");
        goto cleanup;
    }
    BPAL5_CUDA_CHECK(cudaSetDevice(device_ordinal), "Cannot select CUDA device");
    BPAL5_CUDA_CHECK(cudaGetDeviceProperties(&properties, device_ordinal), "Cannot query CUDA device");

    result_stats->device_ordinal = device_ordinal;
    std::snprintf(
        result_stats->device_name,
        sizeof(result_stats->device_name),
        "%s",
        properties.name
    );
    result_stats->requested_refinement_passes = options.refinement_passes;

    cpu_start = std::chrono::steady_clock::now();
    options.refinement_passes = 0u;
    if (!bpal5_encode_rgb(rgb, width, height, &options, &image, error, error_size)) {
        goto cleanup;
    }
    cpu_end = std::chrono::steady_clock::now();
    result_stats->cpu_initialization_milliseconds =
        std::chrono::duration<double, std::milli>(cpu_end - cpu_start).count();

    pixel_count = static_cast<size_t>(image.width) * image.height;
    palette_entries = static_cast<size_t>(image.palette_count) * image.global_color_count;
    block_entries = static_cast<size_t>(image.block_count) * image.local_color_count;
    palette_bytes = palette_entries * sizeof(uint32_t);
    block_bytes = block_entries * sizeof(uint16_t);
    info.width = image.width;
    info.height = image.height;
    info.block_size = image.block_size;
    info.blocks_x = image.blocks_x;
    info.block_count = image.block_count;
    info.local_color_count = image.local_color_count;
    info.global_color_count = image.global_color_count;
    info.palette_color_bits = image.palette_color_bits;
    info.pixel_count = pixel_count;

    gpu_start = std::chrono::steady_clock::now();
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.rgb_bytes, pixel_count * 3u), "Cannot allocate packed CUDA source image");
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.rgb, pixel_count * sizeof(uint32_t)), "Cannot allocate aligned CUDA source image");
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.selectors, image.block_count), "Cannot allocate CUDA palette selectors");
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.current_pixels, pixel_count), "Cannot allocate CUDA pixel indices");
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.candidate_pixels, pixel_count), "Cannot allocate CUDA candidate pixel indices");
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.current_blocks, block_bytes), "Cannot allocate CUDA block palettes");
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.candidate_blocks, block_bytes), "Cannot allocate CUDA candidate block palettes");
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.current_palette, palette_bytes), "Cannot allocate CUDA shared palette");
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.candidate_palette, palette_bytes), "Cannot allocate CUDA candidate palette");
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.counts, palette_entries * sizeof(uint32_t)), "Cannot allocate CUDA centroid counts");
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.red_sums, palette_entries * sizeof(unsigned long long)), "Cannot allocate CUDA red sums");
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.green_sums, palette_entries * sizeof(unsigned long long)), "Cannot allocate CUDA green sums");
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.blue_sums, palette_entries * sizeof(unsigned long long)), "Cannot allocate CUDA blue sums");
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.error_sum, sizeof(unsigned long long)), "Cannot allocate CUDA error sum");

    BPAL5_CUDA_CHECK(cudaMemcpy(buffers.rgb_bytes, rgb, pixel_count * 3u, cudaMemcpyHostToDevice), "Cannot upload source image to CUDA");
    BPAL5_CUDA_CHECK(cudaMemcpy(buffers.selectors, image.block_palette_selectors, image.block_count, cudaMemcpyHostToDevice), "Cannot upload palette selectors to CUDA");
    BPAL5_CUDA_CHECK(cudaMemcpy(buffers.current_pixels, image.pixel_indices, pixel_count, cudaMemcpyHostToDevice), "Cannot upload pixel indices to CUDA");
    BPAL5_CUDA_CHECK(cudaMemcpy(buffers.current_blocks, image.block_palette_indices, block_bytes, cudaMemcpyHostToDevice), "Cannot upload block palettes to CUDA");
    BPAL5_CUDA_CHECK(cudaMemcpy(buffers.current_palette, image.palette_rgba, palette_bytes, cudaMemcpyHostToDevice), "Cannot upload shared palette to CUDA");

    cache_rgb_kernel<<<grid_for(pixel_count), CUDA_THREADS>>>(buffers.rgb_bytes, buffers.rgb, pixel_count);
    BPAL5_CUDA_CHECK(cudaGetLastError(), "Cannot launch CUDA aligned RGB cache");

    BPAL5_CUDA_CHECK(cudaMemset(buffers.error_sum, 0, sizeof(unsigned long long)), "Cannot clear CUDA error sum");
    calculate_error_kernel<<<grid_for(pixel_count), CUDA_THREADS>>>(
        buffers.rgb,
        info,
        buffers.selectors,
        buffers.current_palette,
        buffers.current_blocks,
        buffers.current_pixels,
        buffers.error_sum
    );
    BPAL5_CUDA_CHECK(cudaGetLastError(), "Cannot launch CUDA error kernel");
    BPAL5_CUDA_CHECK(cudaMemcpy(&current_error, buffers.error_sum, sizeof(current_error), cudaMemcpyDeviceToHost), "Cannot read CUDA initial error");
    result_stats->initial_error = current_error;

    for (pass = 0u; pass < result_stats->requested_refinement_passes; ++pass) {
        BPAL5_CUDA_CHECK(cudaMemcpy(buffers.candidate_palette, buffers.current_palette, palette_bytes, cudaMemcpyDeviceToDevice), "Cannot copy CUDA candidate palette");
        BPAL5_CUDA_CHECK(cudaMemset(buffers.red_sums, 0, palette_entries * sizeof(unsigned long long)), "Cannot clear CUDA red sums");
        BPAL5_CUDA_CHECK(cudaMemset(buffers.green_sums, 0, palette_entries * sizeof(unsigned long long)), "Cannot clear CUDA green sums");
        BPAL5_CUDA_CHECK(cudaMemset(buffers.blue_sums, 0, palette_entries * sizeof(unsigned long long)), "Cannot clear CUDA blue sums");
        BPAL5_CUDA_CHECK(cudaMemset(buffers.counts, 0, palette_entries * sizeof(uint32_t)), "Cannot clear CUDA centroid counts");
        accumulate_centroids_kernel<<<grid_for(pixel_count), CUDA_THREADS>>>(
            buffers.rgb,
            info,
            buffers.selectors,
            buffers.current_blocks,
            buffers.current_pixels,
            buffers.red_sums,
            buffers.green_sums,
            buffers.blue_sums,
            buffers.counts
        );
        BPAL5_CUDA_CHECK(cudaGetLastError(), "Cannot launch CUDA centroid accumulation");
        finalize_centroids_kernel<<<grid_for(palette_entries), CUDA_THREADS>>>(
            buffers.candidate_palette,
            palette_entries,
            image.palette_color_bits,
            buffers.red_sums,
            buffers.green_sums,
            buffers.blue_sums,
            buffers.counts
        );
        BPAL5_CUDA_CHECK(cudaGetLastError(), "Cannot launch CUDA centroid update");

        select_block_palette_kernel<<<image.block_count, CUDA_THREADS>>>(
            buffers.rgb,
            info,
            buffers.selectors,
            buffers.candidate_palette,
            buffers.candidate_blocks
        );
        BPAL5_CUDA_CHECK(cudaGetLastError(), "Cannot launch CUDA block-palette selection");

        BPAL5_CUDA_CHECK(cudaMemset(buffers.error_sum, 0, sizeof(unsigned long long)), "Cannot clear CUDA candidate error");
        assign_pixels_kernel<<<grid_for(pixel_count), CUDA_THREADS>>>(
            buffers.rgb,
            info,
            buffers.selectors,
            buffers.candidate_palette,
            buffers.candidate_blocks,
            buffers.candidate_pixels,
            buffers.error_sum
        );
        BPAL5_CUDA_CHECK(cudaGetLastError(), "Cannot launch CUDA pixel assignment");
        BPAL5_CUDA_CHECK(cudaMemcpy(&candidate_error, buffers.error_sum, sizeof(candidate_error), cudaMemcpyDeviceToHost), "Cannot read CUDA candidate error");

        if (candidate_error >= current_error) {
            break;
        }
        std::swap(buffers.current_palette, buffers.candidate_palette);
        std::swap(buffers.current_blocks, buffers.candidate_blocks);
        std::swap(buffers.current_pixels, buffers.candidate_pixels);
        current_error = candidate_error;
        ++result_stats->accepted_refinement_passes;
    }

    BPAL5_CUDA_CHECK(cudaMemcpy(image.palette_rgba, buffers.current_palette, palette_bytes, cudaMemcpyDeviceToHost), "Cannot download CUDA shared palette");
    BPAL5_CUDA_CHECK(cudaMemcpy(image.block_palette_indices, buffers.current_blocks, block_bytes, cudaMemcpyDeviceToHost), "Cannot download CUDA block palettes");
    BPAL5_CUDA_CHECK(cudaMemcpy(image.pixel_indices, buffers.current_pixels, pixel_count, cudaMemcpyDeviceToHost), "Cannot download CUDA pixel indices");
    BPAL5_CUDA_CHECK(cudaDeviceSynchronize(), "Cannot finish CUDA encoding");
    gpu_end = std::chrono::steady_clock::now();
    result_stats->gpu_milliseconds =
        std::chrono::duration<double, std::milli>(gpu_end - gpu_start).count();
    result_stats->final_error = current_error;

    *output = image;
    std::memset(&image, 0, sizeof(image));
    success = 1;

cleanup:
    release_buffers(&buffers);
    if (!success) {
        bpal5_image_free(&image);
    }
#undef BPAL5_CUDA_CHECK
    return success;
}
