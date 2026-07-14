#include "bpal5_cuda.h"
#include "bpal5_encode_internal.h"

#include <cuda_runtime.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <limits>
#include <new>
#include <system_error>
#include <thread>
#include <utility>
#include <vector>

namespace {

constexpr unsigned int CUDA_THREADS = 256u;
constexpr unsigned int MAX_BLOCK_PIXELS = 64u * 64u;
constexpr unsigned int MAX_LOCAL_COLORS = 16u;
constexpr unsigned int MAX_GLOBAL_COLORS = 4096u;
constexpr unsigned int MAX_SAMPLE_PIXELS = 32768u;

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
    uint32_t *samples;
    uint32_t *sample_offsets;
    uint32_t *sample_counts;
    uint32_t *nearest_sample_distances;
};

struct HostPaletteSamples {
    std::vector<uint32_t> colors;
    std::vector<uint32_t> offsets;
    std::vector<uint32_t> counts;
};

struct CudaSetupState {
    cudaDeviceProp properties;
    cudaError_t status;
    const char *operation;
    int device_count;
    double milliseconds;
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

void initialize_cuda_device(int device_ordinal, CudaSetupState *state) {
    const auto started = std::chrono::steady_clock::now();
    state->status = cudaGetDeviceCount(&state->device_count);
    state->operation = "Cannot enumerate CUDA devices";
    if (state->status == cudaSuccess &&
        device_ordinal >= 0 && device_ordinal < state->device_count) {
        state->status = cudaSetDevice(device_ordinal);
        state->operation = "Cannot select CUDA device";
    }
    if (state->status == cudaSuccess &&
        device_ordinal >= 0 && device_ordinal < state->device_count) {
        state->status = cudaGetDeviceProperties(&state->properties, device_ordinal);
        state->operation = "Cannot query CUDA device";
    }
    if (state->status == cudaSuccess &&
        device_ordinal >= 0 && device_ordinal < state->device_count) {
        state->status = cudaFree(nullptr);
        state->operation = "Cannot initialize CUDA context";
    }
    state->milliseconds = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - started
    ).count();
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
    cudaFree(buffers->samples);
    cudaFree(buffers->sample_offsets);
    cudaFree(buffers->sample_counts);
    cudaFree(buffers->nearest_sample_distances);
    std::memset(buffers, 0, sizeof(*buffers));
}

uint32_t pack_host_rgba(uint8_t red, uint8_t green, uint8_t blue) {
    return static_cast<uint32_t>(red) |
        (static_cast<uint32_t>(green) << 8u) |
        (static_cast<uint32_t>(blue) << 16u) |
        0xff000000u;
}

void finalize_channel_palette(bpal5_image *image) {
    const size_t entries = static_cast<size_t>(image->palette_count) * image->global_color_count;
    for (size_t index = 0u; index < entries; ++index) {
        const uint8_t red = static_cast<uint8_t>(image->palette_rgba[index] & 255u);
        if (image->channel_mode == BPAL5_CHANNEL_SCALAR) {
            image->palette_rgba[index] = pack_host_rgba(red, red, red);
        }
    }
}

bool collect_palette_samples(
    const uint8_t *rgb,
    const bpal5_image &image,
    HostPaletteSamples *output,
    char *error,
    size_t error_size
) {
    try {
        std::vector<uint64_t> totals(image.palette_count, 0u);
        std::vector<uint64_t> strides(image.palette_count, 1u);
        std::vector<uint64_t> seen(image.palette_count, 0u);
        std::vector<uint32_t> stored(image.palette_count, 0u);
        uint64_t total_samples = 0u;

        output->offsets.assign(image.palette_count, 0u);
        output->counts.assign(image.palette_count, 0u);

        for (uint32_t block = 0u; block < image.block_count; ++block) {
            const uint32_t block_x = block % image.blocks_x;
            const uint32_t block_y = block / image.blocks_x;
            const uint32_t start_x = block_x * image.block_size;
            const uint32_t start_y = block_y * image.block_size;
            const uint32_t end_x = std::min(start_x + image.block_size, image.width);
            const uint32_t end_y = std::min(start_y + image.block_size, image.height);
            const uint32_t palette = image.block_palette_selectors[block];
            totals[palette] += static_cast<uint64_t>(end_x - start_x) * (end_y - start_y);
        }

        for (uint32_t palette = 0u; palette < image.palette_count; ++palette) {
            strides[palette] = std::max<uint64_t>(
                1u,
                (totals[palette] + MAX_SAMPLE_PIXELS - 1u) / MAX_SAMPLE_PIXELS
            );
            const uint64_t count = (totals[palette] + strides[palette] - 1u) / strides[palette];
            if (count > UINT32_MAX || total_samples + count > UINT32_MAX) {
                set_message(error, error_size, "CUDA palette sample set is too large");
                return false;
            }
            output->offsets[palette] = static_cast<uint32_t>(total_samples);
            output->counts[palette] = static_cast<uint32_t>(count);
            total_samples += count;
        }
        output->colors.resize(static_cast<size_t>(total_samples));

        for (uint32_t block = 0u; block < image.block_count; ++block) {
            const uint32_t block_x = block % image.blocks_x;
            const uint32_t block_y = block / image.blocks_x;
            const uint32_t start_x = block_x * image.block_size;
            const uint32_t start_y = block_y * image.block_size;
            const uint32_t end_x = std::min(start_x + image.block_size, image.width);
            const uint32_t end_y = std::min(start_y + image.block_size, image.height);
            const uint32_t palette = image.block_palette_selectors[block];
            for (uint32_t y = start_y; y < end_y; ++y) {
                for (uint32_t x = start_x; x < end_x; ++x) {
                    if (seen[palette] % strides[palette] == 0u) {
                        const uint8_t *pixel = rgb +
                            (static_cast<size_t>(y) * image.width + x) * 3u;
                        output->colors[output->offsets[palette] + stored[palette]] =
                            pack_host_rgba(pixel[0], pixel[1], pixel[2]);
                        ++stored[palette];
                    }
                    ++seen[palette];
                }
            }
        }
        return true;
    } catch (const std::bad_alloc &) {
        set_message(error, error_size, "Out of memory collecting CUDA palette samples");
        return false;
    }
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

__global__ void initialize_palettes_kernel(
    const uint32_t *samples,
    const uint32_t *sample_offsets,
    const uint32_t *sample_counts,
    uint32_t global_color_count,
    uint32_t *palette,
    uint32_t *nearest_distances
) {
    const uint32_t palette_index = blockIdx.x;
    const uint32_t sample_offset = sample_offsets[palette_index];
    const uint32_t sample_count = sample_counts[palette_index];
    const size_t palette_offset = static_cast<size_t>(palette_index) * global_color_count;

    for (uint32_t color = threadIdx.x; color < global_color_count; color += blockDim.x) {
        palette[palette_offset + color] = pack_rgba(0u, 0u, 0u);
    }
    for (uint32_t sample = threadIdx.x; sample < sample_count; sample += blockDim.x) {
        nearest_distances[sample_offset + sample] = UINT_MAX;
    }
    __syncthreads();
    if (threadIdx.x == 0u && sample_count != 0u) {
        palette[palette_offset] = samples[sample_offset];
    }
}

__global__ void choose_palette_centroid_kernel(
    const uint32_t *samples,
    const uint32_t *sample_offsets,
    const uint32_t *sample_counts,
    uint32_t global_color_count,
    uint32_t centroid,
    uint32_t *palette,
    uint32_t *nearest_distances
) {
    __shared__ uint32_t best_distances[CUDA_THREADS];
    __shared__ uint32_t best_samples[CUDA_THREADS];

    const uint32_t palette_index = blockIdx.x;
    const uint32_t sample_offset = sample_offsets[palette_index];
    const uint32_t sample_count = sample_counts[palette_index];
    const uint32_t active_count = min(sample_count, global_color_count);
    const size_t palette_offset = static_cast<size_t>(palette_index) * global_color_count;
    if (centroid >= active_count) {
        return;
    }

    const uint32_t previous = palette[palette_offset + centroid - 1u];
    uint32_t thread_best_distance = 0u;
    uint32_t thread_best_sample = 0u;
    for (uint32_t sample = threadIdx.x; sample < sample_count; sample += blockDim.x) {
        const uint32_t index = sample_offset + sample;
        const uint32_t distance = color_distance(samples[index], previous);
        const uint32_t nearest = min(distance, nearest_distances[index]);
        nearest_distances[index] = nearest;
        if (nearest > thread_best_distance ||
            (nearest == thread_best_distance && sample < thread_best_sample)) {
            thread_best_distance = nearest;
            thread_best_sample = sample;
        }
    }
    best_distances[threadIdx.x] = thread_best_distance;
    best_samples[threadIdx.x] = thread_best_sample;
    __syncthreads();

    for (uint32_t offset = blockDim.x / 2u; offset != 0u; offset >>= 1u) {
        if (threadIdx.x < offset) {
            const uint32_t other_distance = best_distances[threadIdx.x + offset];
            const uint32_t other_sample = best_samples[threadIdx.x + offset];
            if (other_distance > best_distances[threadIdx.x] ||
                (other_distance == best_distances[threadIdx.x] &&
                 other_sample < best_samples[threadIdx.x])) {
                best_distances[threadIdx.x] = other_distance;
                best_samples[threadIdx.x] = other_sample;
            }
        }
        __syncthreads();
    }
    if (threadIdx.x == 0u) {
        palette[palette_offset + centroid] = samples[sample_offset + best_samples[0]];
    }
}

__global__ void assign_palette_samples_kernel(
    const uint32_t *samples,
    const uint32_t *sample_offsets,
    const uint32_t *sample_counts,
    uint32_t global_color_count,
    const uint32_t *palette,
    unsigned long long *red_sums,
    unsigned long long *green_sums,
    unsigned long long *blue_sums,
    uint32_t *counts
) {
    const uint32_t palette_index = blockIdx.y;
    const uint32_t sample = blockIdx.x * blockDim.x + threadIdx.x;
    const uint32_t sample_count = sample_counts[palette_index];
    if (sample >= sample_count) {
        return;
    }
    const uint32_t sample_offset = sample_offsets[palette_index];
    const uint32_t active_count = min(sample_count, global_color_count);
    const size_t palette_offset = static_cast<size_t>(palette_index) * global_color_count;
    const uint32_t source = samples[sample_offset + sample];
    uint32_t best_centroid = 0u;
    uint32_t best_distance = color_distance(source, palette[palette_offset]);
    for (uint32_t centroid = 1u; centroid < active_count; ++centroid) {
        const uint32_t distance = color_distance(source, palette[palette_offset + centroid]);
        if (distance < best_distance) {
            best_distance = distance;
            best_centroid = centroid;
        }
    }
    const size_t entry = palette_offset + best_centroid;
    atomicAdd(red_sums + entry, static_cast<unsigned long long>(source & 255u));
    atomicAdd(green_sums + entry, static_cast<unsigned long long>((source >> 8u) & 255u));
    atomicAdd(blue_sums + entry, static_cast<unsigned long long>((source >> 16u) & 255u));
    atomicAdd(counts + entry, 1u);
}

__global__ void finalize_palette_samples_kernel(
    uint32_t *palette,
    uint32_t palette_count,
    uint32_t global_color_count,
    const uint32_t *sample_counts,
    const unsigned long long *red_sums,
    const unsigned long long *green_sums,
    const unsigned long long *blue_sums,
    const uint32_t *counts
) {
    const size_t entry = static_cast<size_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    const size_t palette_entries = static_cast<size_t>(palette_count) * global_color_count;
    if (entry >= palette_entries) {
        return;
    }
    const uint32_t palette_index = static_cast<uint32_t>(entry / global_color_count);
    const uint32_t centroid = static_cast<uint32_t>(entry % global_color_count);
    const uint32_t active_count = min(sample_counts[palette_index], global_color_count);
    if (centroid >= active_count) {
        palette[entry] = pack_rgba(0u, 0u, 0u);
    } else if (counts[entry] != 0u) {
        const uint32_t count = counts[entry];
        palette[entry] = pack_rgba(
            static_cast<uint8_t>((red_sums[entry] + count / 2u) / count),
            static_cast<uint8_t>((green_sums[entry] + count / 2u) / count),
            static_cast<uint8_t>((blue_sums[entry] + count / 2u) / count)
        );
    }
}

__global__ void quantize_palette_kernel(
    uint32_t *palette,
    size_t palette_entries,
    uint32_t palette_color_bits
) {
    const size_t entry = static_cast<size_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (entry < palette_entries) {
        palette[entry] = quantize_color(palette[entry], palette_color_bits);
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
    __shared__ uint32_t shared_candidate_positions[CUDA_THREADS];
    __shared__ uint32_t shared_best_distances[MAX_BLOCK_PIXELS];
    __shared__ uint32_t shared_selected[MAX_LOCAL_COLORS];
    __shared__ uint8_t shared_candidate_flags[MAX_GLOBAL_COLORS];
    __shared__ uint16_t shared_candidate_values[MAX_GLOBAL_COLORS];
    __shared__ uint16_t shared_nearest_globals[MAX_BLOCK_PIXELS];
    __shared__ uint32_t shared_candidate_count;

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

    for (uint32_t color = threadIdx.x; color < info.global_color_count; color += blockDim.x) {
        shared_candidate_flags[color] = 0u;
    }
    for (uint32_t position = threadIdx.x; position < block_pixel_count; position += blockDim.x) {
        const uint32_t x = start_x + position % block_width;
        const uint32_t y = start_y + position / block_width;
        const uint32_t source = rgb[static_cast<size_t>(y) * info.width + x];
        uint32_t best_global = 0u;
        uint32_t best_distance = color_distance(source, palette[palette_base]);
        for (uint32_t global = 1u; global < info.global_color_count; ++global) {
            const uint32_t distance = color_distance(source, palette[palette_base + global]);
            if (distance < best_distance) {
                best_distance = distance;
                best_global = global;
            }
        }
        shared_nearest_globals[position] = static_cast<uint16_t>(best_global);
        shared_best_distances[position] = UINT_MAX;
    }
    __syncthreads();

    if (threadIdx.x == 0u) {
        uint32_t candidate_count = 0u;
        for (uint32_t position = 0u; position < block_pixel_count; ++position) {
            const uint32_t global = shared_nearest_globals[position];
            if (shared_candidate_flags[global] == 0u) {
                shared_candidate_flags[global] = 1u;
                shared_candidate_values[candidate_count++] = static_cast<uint16_t>(global);
            }
        }
        for (uint32_t global = 0u;
             global < info.global_color_count && candidate_count < info.local_color_count;
             ++global) {
            if (shared_candidate_flags[global] == 0u) {
                shared_candidate_flags[global] = 1u;
                shared_candidate_values[candidate_count++] = static_cast<uint16_t>(global);
            }
        }
        shared_candidate_count = candidate_count;
    }
    __syncthreads();

    for (uint32_t slot = 0u; slot < info.local_color_count; ++slot) {
        unsigned long long thread_score = ULLONG_MAX;
        uint32_t thread_candidate_position = UINT_MAX;

        for (uint32_t candidate_position = threadIdx.x;
             candidate_position < shared_candidate_count;
             candidate_position += blockDim.x) {
            const uint32_t candidate = shared_candidate_values[candidate_position];
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
            if (score < thread_score ||
                (score == thread_score && candidate_position < thread_candidate_position)) {
                thread_score = score;
                thread_candidate_position = candidate_position;
            }
        }

        shared_scores[threadIdx.x] = thread_score;
        shared_candidate_positions[threadIdx.x] = thread_candidate_position;
        __syncthreads();

        for (uint32_t offset = blockDim.x / 2u; offset != 0u; offset >>= 1u) {
            if (threadIdx.x < offset) {
                const unsigned long long other_score = shared_scores[threadIdx.x + offset];
                const uint32_t other_position = shared_candidate_positions[threadIdx.x + offset];
                if (other_score < shared_scores[threadIdx.x] ||
                    (other_score == shared_scores[threadIdx.x] &&
                     other_position < shared_candidate_positions[threadIdx.x])) {
                    shared_scores[threadIdx.x] = other_score;
                    shared_candidate_positions[threadIdx.x] = other_position;
                }
            }
            __syncthreads();
        }

        if (threadIdx.x == 0u) {
            shared_selected[slot] = shared_candidate_values[shared_candidate_positions[0]];
            block_indices[static_cast<size_t>(block) * info.local_color_count + slot] =
                static_cast<uint16_t>(shared_selected[slot]);
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
    HostPaletteSamples samples{};
    CudaSetupState cuda_setup{};
    std::thread cuda_setup_thread;
    cudaEvent_t palette_started = nullptr;
    cudaEvent_t palette_finished = nullptr;
    cudaEvent_t initial_finished = nullptr;
    cudaEvent_t refinement_finished = nullptr;
    std::chrono::steady_clock::time_point cpu_start;
    std::chrono::steady_clock::time_point sample_start;
    std::chrono::steady_clock::time_point sample_end;
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
    int success = 0;
    float event_milliseconds = 0.0f;
    const uint8_t *source_rgb = rgb;
    std::vector<uint8_t> channel_source;

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

    if (options.channel_mode == BPAL5_CHANNEL_SCALAR) {
        const size_t source_pixels = static_cast<size_t>(width) * height;
        try {
            channel_source.resize(source_pixels * 3u);
        } catch (const std::bad_alloc &) {
            set_message(error, error_size, "Out of memory preparing CUDA BPAL channel mode");
            return 0;
        }
        for (size_t pixel = 0u; pixel < source_pixels; ++pixel) {
            const uint8_t red = rgb[pixel * 3u];
            channel_source[pixel * 3u] = red;
            channel_source[pixel * 3u + 1u] = red;
            channel_source[pixel * 3u + 2u] = red;
        }
        source_rgb = channel_source.data();
    }

    result_stats->requested_refinement_passes = options.refinement_passes;

    try {
        cuda_setup_thread = std::thread(initialize_cuda_device, device_ordinal, &cuda_setup);
    } catch (const std::system_error &) {
        initialize_cuda_device(device_ordinal, &cuda_setup);
    }

    cpu_start = std::chrono::steady_clock::now();
    if (!bpal5_prepare_rgb_image_internal(
            source_rgb,
            width,
            height,
            &options,
            &image,
            &result_stats->cpu_block_clustering_milliseconds,
            error,
            error_size)) {
        goto cleanup;
    }
    sample_start = std::chrono::steady_clock::now();
    if (!collect_palette_samples(source_rgb, image, &samples, error, error_size)) {
        goto cleanup;
    }
    sample_end = std::chrono::steady_clock::now();
    result_stats->cpu_sample_grouping_milliseconds =
        std::chrono::duration<double, std::milli>(sample_end - sample_start).count();
    cpu_end = std::chrono::steady_clock::now();
    result_stats->cpu_initialization_milliseconds =
        std::chrono::duration<double, std::milli>(cpu_end - cpu_start).count();

    if (cuda_setup_thread.joinable()) {
        cuda_setup_thread.join();
    }
    result_stats->cuda_setup_milliseconds = cuda_setup.milliseconds;
    if (cuda_setup.status != cudaSuccess) {
        set_cuda_message(error, error_size, cuda_setup.operation, cuda_setup.status);
        goto cleanup;
    }
    if (device_ordinal < 0 || device_ordinal >= cuda_setup.device_count) {
        set_message(error, error_size, "Requested CUDA device does not exist");
        goto cleanup;
    }
    BPAL5_CUDA_CHECK(cudaSetDevice(device_ordinal), "Cannot select initialized CUDA device");
    result_stats->device_ordinal = device_ordinal;
    std::snprintf(
        result_stats->device_name,
        sizeof(result_stats->device_name),
        "%s",
        cuda_setup.properties.name
    );

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
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.samples, samples.colors.size() * sizeof(uint32_t)), "Cannot allocate CUDA palette samples");
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.sample_offsets, image.palette_count * sizeof(uint32_t)), "Cannot allocate CUDA palette sample offsets");
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.sample_counts, image.palette_count * sizeof(uint32_t)), "Cannot allocate CUDA palette sample counts");
    BPAL5_CUDA_CHECK(cudaMalloc(&buffers.nearest_sample_distances, samples.colors.size() * sizeof(uint32_t)), "Cannot allocate CUDA palette sample distances");

    BPAL5_CUDA_CHECK(cudaMemcpy(buffers.rgb_bytes, source_rgb, pixel_count * 3u, cudaMemcpyHostToDevice), "Cannot upload source image to CUDA");
    BPAL5_CUDA_CHECK(cudaMemcpy(buffers.selectors, image.block_palette_selectors, image.block_count, cudaMemcpyHostToDevice), "Cannot upload palette selectors to CUDA");
    BPAL5_CUDA_CHECK(cudaMemcpy(buffers.samples, samples.colors.data(), samples.colors.size() * sizeof(uint32_t), cudaMemcpyHostToDevice), "Cannot upload CUDA palette samples");
    BPAL5_CUDA_CHECK(cudaMemcpy(buffers.sample_offsets, samples.offsets.data(), image.palette_count * sizeof(uint32_t), cudaMemcpyHostToDevice), "Cannot upload CUDA palette sample offsets");
    BPAL5_CUDA_CHECK(cudaMemcpy(buffers.sample_counts, samples.counts.data(), image.palette_count * sizeof(uint32_t), cudaMemcpyHostToDevice), "Cannot upload CUDA palette sample counts");

    cache_rgb_kernel<<<grid_for(pixel_count), CUDA_THREADS>>>(buffers.rgb_bytes, buffers.rgb, pixel_count);
    BPAL5_CUDA_CHECK(cudaGetLastError(), "Cannot launch CUDA aligned RGB cache");

    BPAL5_CUDA_CHECK(cudaEventCreate(&palette_started), "Cannot create CUDA palette-start event");
    BPAL5_CUDA_CHECK(cudaEventCreate(&palette_finished), "Cannot create CUDA palette-finish event");
    BPAL5_CUDA_CHECK(cudaEventCreate(&initial_finished), "Cannot create CUDA initial-encode event");
    BPAL5_CUDA_CHECK(cudaEventCreate(&refinement_finished), "Cannot create CUDA refinement event");
    BPAL5_CUDA_CHECK(cudaEventRecord(palette_started), "Cannot record CUDA palette-start event");

    initialize_palettes_kernel<<<image.palette_count, CUDA_THREADS>>>(
        buffers.samples,
        buffers.sample_offsets,
        buffers.sample_counts,
        image.global_color_count,
        buffers.current_palette,
        buffers.nearest_sample_distances
    );
    BPAL5_CUDA_CHECK(cudaGetLastError(), "Cannot launch CUDA palette initialization");
    for (uint32_t centroid = 1u; centroid < image.global_color_count; ++centroid) {
        choose_palette_centroid_kernel<<<image.palette_count, CUDA_THREADS>>>(
            buffers.samples,
            buffers.sample_offsets,
            buffers.sample_counts,
            image.global_color_count,
            centroid,
            buffers.current_palette,
            buffers.nearest_sample_distances
        );
        BPAL5_CUDA_CHECK(cudaGetLastError(), "Cannot launch CUDA palette centroid selection");
    }
    for (uint32_t iteration = 0u; iteration < options.kmeans_iterations; ++iteration) {
        BPAL5_CUDA_CHECK(cudaMemset(buffers.red_sums, 0, palette_entries * sizeof(unsigned long long)), "Cannot clear CUDA palette red sums");
        BPAL5_CUDA_CHECK(cudaMemset(buffers.green_sums, 0, palette_entries * sizeof(unsigned long long)), "Cannot clear CUDA palette green sums");
        BPAL5_CUDA_CHECK(cudaMemset(buffers.blue_sums, 0, palette_entries * sizeof(unsigned long long)), "Cannot clear CUDA palette blue sums");
        BPAL5_CUDA_CHECK(cudaMemset(buffers.counts, 0, palette_entries * sizeof(uint32_t)), "Cannot clear CUDA palette counts");
        assign_palette_samples_kernel<<<
            dim3((MAX_SAMPLE_PIXELS + CUDA_THREADS - 1u) / CUDA_THREADS, image.palette_count),
            CUDA_THREADS
        >>>(
            buffers.samples,
            buffers.sample_offsets,
            buffers.sample_counts,
            image.global_color_count,
            buffers.current_palette,
            buffers.red_sums,
            buffers.green_sums,
            buffers.blue_sums,
            buffers.counts
        );
        BPAL5_CUDA_CHECK(cudaGetLastError(), "Cannot launch CUDA palette sample assignment");
        finalize_palette_samples_kernel<<<grid_for(palette_entries), CUDA_THREADS>>>(
            buffers.current_palette,
            image.palette_count,
            image.global_color_count,
            buffers.sample_counts,
            buffers.red_sums,
            buffers.green_sums,
            buffers.blue_sums,
            buffers.counts
        );
        BPAL5_CUDA_CHECK(cudaGetLastError(), "Cannot launch CUDA palette sample update");
    }
    quantize_palette_kernel<<<grid_for(palette_entries), CUDA_THREADS>>>(
        buffers.current_palette,
        palette_entries,
        image.palette_color_bits
    );
    BPAL5_CUDA_CHECK(cudaGetLastError(), "Cannot launch CUDA palette quantization");
    BPAL5_CUDA_CHECK(cudaEventRecord(palette_finished), "Cannot record CUDA palette-finish event");

    select_block_palette_kernel<<<image.block_count, CUDA_THREADS>>>(
        buffers.rgb,
        info,
        buffers.selectors,
        buffers.current_palette,
        buffers.current_blocks
    );
    BPAL5_CUDA_CHECK(cudaGetLastError(), "Cannot launch CUDA initial block-palette selection");
    BPAL5_CUDA_CHECK(cudaMemset(buffers.error_sum, 0, sizeof(unsigned long long)), "Cannot clear CUDA error sum");
    assign_pixels_kernel<<<grid_for(pixel_count), CUDA_THREADS>>>(
        buffers.rgb,
        info,
        buffers.selectors,
        buffers.current_palette,
        buffers.current_blocks,
        buffers.current_pixels,
        buffers.error_sum
    );
    BPAL5_CUDA_CHECK(cudaGetLastError(), "Cannot launch CUDA initial pixel assignment");
    BPAL5_CUDA_CHECK(cudaEventRecord(initial_finished), "Cannot record CUDA initial-encode event");
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
    BPAL5_CUDA_CHECK(cudaEventRecord(refinement_finished), "Cannot record CUDA refinement event");

    BPAL5_CUDA_CHECK(cudaMemcpy(image.palette_rgba, buffers.current_palette, palette_bytes, cudaMemcpyDeviceToHost), "Cannot download CUDA shared palette");
    BPAL5_CUDA_CHECK(cudaMemcpy(image.block_palette_indices, buffers.current_blocks, block_bytes, cudaMemcpyDeviceToHost), "Cannot download CUDA block palettes");
    BPAL5_CUDA_CHECK(cudaMemcpy(image.pixel_indices, buffers.current_pixels, pixel_count, cudaMemcpyDeviceToHost), "Cannot download CUDA pixel indices");
    BPAL5_CUDA_CHECK(cudaDeviceSynchronize(), "Cannot finish CUDA encoding");
    gpu_end = std::chrono::steady_clock::now();
    result_stats->gpu_milliseconds =
        std::chrono::duration<double, std::milli>(gpu_end - gpu_start).count();
    BPAL5_CUDA_CHECK(cudaEventElapsedTime(&event_milliseconds, palette_started, palette_finished), "Cannot measure CUDA palette construction");
    result_stats->gpu_palette_building_milliseconds = event_milliseconds;
    BPAL5_CUDA_CHECK(cudaEventElapsedTime(&event_milliseconds, palette_finished, initial_finished), "Cannot measure CUDA initial encoding");
    result_stats->gpu_initial_encoding_milliseconds = event_milliseconds;
    BPAL5_CUDA_CHECK(cudaEventElapsedTime(&event_milliseconds, initial_finished, refinement_finished), "Cannot measure CUDA refinement");
    result_stats->gpu_refinement_milliseconds = event_milliseconds;
    result_stats->final_error = current_error;

    finalize_channel_palette(&image);

    *output = image;
    std::memset(&image, 0, sizeof(image));
    success = 1;

cleanup:
    if (cuda_setup_thread.joinable()) {
        cuda_setup_thread.join();
    }
    if (palette_started != nullptr) {
        cudaEventDestroy(palette_started);
    }
    if (palette_finished != nullptr) {
        cudaEventDestroy(palette_finished);
    }
    if (initial_finished != nullptr) {
        cudaEventDestroy(initial_finished);
    }
    if (refinement_finished != nullptr) {
        cudaEventDestroy(refinement_finished);
    }
    release_buffers(&buffers);
    if (!success) {
        bpal5_image_free(&image);
    }
#undef BPAL5_CUDA_CHECK
    return success;
}
