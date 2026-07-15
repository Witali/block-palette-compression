#include <cuda_runtime.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cfloat>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#define STBI_FAILURE_USERMSG
#define STB_IMAGE_IMPLEMENTATION
#if defined(_MSC_VER)
#pragma warning(push, 0)
#endif
#include "stb_image.h"
#if defined(_MSC_VER)
#pragma warning(pop)
#endif

namespace {

constexpr uint32_t DCT_VERSION = 2u;
constexpr uint32_t FLAG_AUTO_QUALITY = 1u;
constexpr uint32_t FLAG_SPLIT_LUMA_8X8 = 2u;
constexpr uint32_t COEFFICIENT_CODING_SHIFT = 8u;
constexpr uint32_t COEFFICIENT_CODING_MASK = 15u << COEFFICIENT_CODING_SHIFT;
constexpr uint32_t SUPPORTED_FLAGS = FLAG_AUTO_QUALITY | FLAG_SPLIT_LUMA_8X8 |
    COEFFICIENT_CODING_MASK;
constexpr int COEFFICIENT_CODING_LEGACY = 0;
constexpr int COEFFICIENT_CODING_GROUPED_EQUAL_2 = 1;
constexpr int COEFFICIENT_CODING_GROUPED_FRONT = 2;
constexpr size_t HEADER_BYTES = 64u;
constexpr int MCU_WIDTH = 16;
constexpr int MCU_HEIGHT = 16;
constexpr int CUDA_THREADS = 256;
constexpr std::array<uint32_t, 7> PRESET_UNITS{{6u, 8u, 12u, 16u, 24u, 36u, 48u}};
constexpr std::array<uint8_t, 8> MAGIC{{0x44, 0x43, 0x54, 0x42, 0x53, 0x32, 0x00, 0x00}};

struct Preset {
    uint32_t mode_code = 0u;
    double nominal_bpp = 0.0;
    uint32_t bytes_per_mcu = 0u;
    uint32_t y_bytes = 0u;
    uint32_t cb_bytes = 0u;
    uint32_t cr_bytes = 0u;
};

constexpr std::array<int, 64> LUMA_QUANTIZATION{{
    16,11,10,16,24,40,51,61,
    12,12,14,19,26,58,60,55,
    14,13,16,24,40,57,69,56,
    14,17,22,29,51,87,80,62,
    18,22,37,56,68,109,103,77,
    24,35,55,64,81,104,113,92,
    49,64,78,87,103,121,120,101,
    72,92,95,98,112,100,103,99,
}};

constexpr std::array<int, 64> CHROMA_QUANTIZATION{{
    17,18,24,47,99,99,99,99,
    18,21,26,66,99,99,99,99,
    24,26,56,99,99,99,99,99,
    47,66,99,99,99,99,99,99,
    99,99,99,99,99,99,99,99,
    99,99,99,99,99,99,99,99,
    99,99,99,99,99,99,99,99,
    99,99,99,99,99,99,99,99,
}};

__constant__ double DEVICE_BASIS_16[16 * 16];
__constant__ double DEVICE_BASIS_8[8 * 8];
__constant__ int DEVICE_SCAN_Y[4 * 255];
__constant__ int DEVICE_SCAN_8[4 * 63];
__constant__ int DEVICE_SCAN_C[4 * 127];
__constant__ int DEVICE_QY[64];
__constant__ int DEVICE_QC[64];

struct DctInfo {
    Preset preset{};
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t mcu_columns = 0;
    uint32_t mcu_rows = 0;
    uint32_t mcu_count = 0;
    uint32_t quality = 0;
    bool auto_quality = false;
    bool split_luma_8x8 = false;
    int coefficient_coding = COEFFICIENT_CODING_LEGACY;
    uint32_t search_candidate_count = 0;
};

struct GpuResult {
    std::vector<uint8_t> bytes;
    float kernel_ms = 0.0f;
};

template <typename T>
class DeviceBuffer {
public:
    DeviceBuffer() = default;
    explicit DeviceBuffer(size_t count) { allocate(count); }
    DeviceBuffer(const DeviceBuffer &) = delete;
    DeviceBuffer &operator=(const DeviceBuffer &) = delete;
    DeviceBuffer(DeviceBuffer &&other) noexcept : pointer_(other.pointer_) { other.pointer_ = nullptr; }
    DeviceBuffer &operator=(DeviceBuffer &&other) noexcept {
        if (this != &other) {
            cudaFree(pointer_);
            pointer_ = other.pointer_;
            other.pointer_ = nullptr;
        }
        return *this;
    }
    ~DeviceBuffer() { cudaFree(pointer_); }

    void allocate(size_t count) {
        cudaFree(pointer_);
        pointer_ = nullptr;
        if (count != 0u) {
            const cudaError_t status = cudaMalloc(reinterpret_cast<void **>(&pointer_), count * sizeof(T));
            if (status != cudaSuccess) {
                throw std::runtime_error(std::string("cudaMalloc: ") + cudaGetErrorString(status));
            }
        }
    }

    T *get() const { return pointer_; }

private:
    T *pointer_ = nullptr;
};

class CudaEvent {
public:
    CudaEvent() {
        const cudaError_t status = cudaEventCreate(&event_);
        if (status != cudaSuccess) {
            throw std::runtime_error(std::string("cudaEventCreate: ") + cudaGetErrorString(status));
        }
    }
    CudaEvent(const CudaEvent &) = delete;
    CudaEvent &operator=(const CudaEvent &) = delete;
    ~CudaEvent() { cudaEventDestroy(event_); }
    cudaEvent_t get() const { return event_; }

private:
    cudaEvent_t event_{};
};

void cuda_check(cudaError_t status, const char *operation) {
    if (status != cudaSuccess) {
        throw std::runtime_error(std::string(operation) + ": " + cudaGetErrorString(status));
    }
}

uint32_t read_u32(const uint8_t *bytes, size_t offset) {
    return static_cast<uint32_t>(bytes[offset]) |
        (static_cast<uint32_t>(bytes[offset + 1u]) << 8u) |
        (static_cast<uint32_t>(bytes[offset + 2u]) << 16u) |
        (static_cast<uint32_t>(bytes[offset + 3u]) << 24u);
}

void write_u32(uint8_t *bytes, size_t offset, uint32_t value) {
    bytes[offset] = static_cast<uint8_t>(value);
    bytes[offset + 1u] = static_cast<uint8_t>(value >> 8u);
    bytes[offset + 2u] = static_cast<uint8_t>(value >> 16u);
    bytes[offset + 3u] = static_cast<uint8_t>(value >> 24u);
}

bool make_balanced_preset(uint32_t units, Preset *preset) {
    if (std::find(PRESET_UNITS.begin(), PRESET_UNITS.end(), units) == PRESET_UNITS.end()) {
        return false;
    }
    preset->mode_code = units * 125u;
    preset->nominal_bpp = static_cast<double>(units) / 8.0;
    preset->bytes_per_mcu = units * 4u;
    if (units >= 24u) {
        // Preserve the reference converter's four-luma-to-two-chroma byte ratio.
        const uint32_t source_block_bytes = units * 2u / 3u;
        preset->y_bytes = source_block_bytes * 4u;
        preset->cb_bytes = source_block_bytes;
        preset->cr_bytes = source_block_bytes;
    } else {
        preset->y_bytes = units * 2u;
        preset->cb_bytes = units;
        preset->cr_bytes = units;
    }
    return true;
}

bool parse_preset_name(const std::string &name, Preset *preset) {
    size_t parsed = 0u;
    double bpp = 0.0;
    try {
        bpp = std::stod(name, &parsed);
    } catch (const std::exception &) {
        return false;
    }
    if (parsed != name.size() || !std::isfinite(bpp)) {
        return false;
    }
    const long long units = std::llround(bpp * 8.0);
    if (units < 0 || std::abs(bpp - static_cast<double>(units) / 8.0) >= 1e-9) {
        return false;
    }
    return make_balanced_preset(static_cast<uint32_t>(units), preset);
}

bool find_preset_mode(uint32_t mode_code, Preset *preset) {
    if (mode_code % 125u != 0u) {
        return false;
    }
    return make_balanced_preset(mode_code / 125u, preset);
}

int default_coefficient_coding(const Preset &preset) {
    return preset.mode_code == 750u || preset.mode_code == 1000u || preset.mode_code == 2000u
        ? COEFFICIENT_CODING_GROUPED_EQUAL_2
        : COEFFICIENT_CODING_GROUPED_FRONT;
}

double scan_score(int profile, int u, int v) {
    if (profile == 1) {
        return static_cast<double>(u) + static_cast<double>(v) * 2.4;
    }
    if (profile == 2) {
        return static_cast<double>(u) * 2.4 + static_cast<double>(v);
    }
    if (profile == 3) {
        return static_cast<double>(std::max(u, v)) * 1.45 +
            static_cast<double>(std::abs(u - v)) * 0.1;
    }
    return static_cast<double>(u + v) +
        (((u + v) % 2 == 0) ? static_cast<double>(v) : static_cast<double>(u)) * 0.001;
}

template <int WIDTH, int HEIGHT>
std::array<int, 4 * (WIDTH * HEIGHT - 1)> make_scans() {
    constexpr int COUNT = WIDTH * HEIGHT - 1;
    std::array<int, 4 * COUNT> output{};
    for (int profile = 0; profile < 4; ++profile) {
        std::vector<int> positions;
        positions.reserve(COUNT);
        for (int v = 0; v < HEIGHT; ++v) {
            for (int u = 0; u < WIDTH; ++u) {
                if (u != 0 || v != 0) {
                    positions.push_back(v * WIDTH + u);
                }
            }
        }
        std::sort(positions.begin(), positions.end(), [profile](int left, int right) {
            const int left_u = left % WIDTH;
            const int left_v = left / WIDTH;
            const int right_u = right % WIDTH;
            const int right_v = right / WIDTH;
            const double left_score = scan_score(profile, left_u, left_v);
            const double right_score = scan_score(profile, right_u, right_v);
            if (left_score != right_score) {
                return left_score < right_score;
            }
            if (left_u + left_v != right_u + right_v) {
                return left_u + left_v < right_u + right_v;
            }
            if (left_v != right_v) {
                return left_v < right_v;
            }
            return left_u < right_u;
        });
        std::copy(positions.begin(), positions.end(), output.begin() + profile * COUNT);
    }
    return output;
}

template <int SIZE>
std::array<double, SIZE * SIZE> make_basis() {
    std::array<double, SIZE * SIZE> basis{};
    for (int frequency = 0; frequency < SIZE; ++frequency) {
        const double normalization = frequency == 0
            ? std::sqrt(1.0 / static_cast<double>(SIZE))
            : std::sqrt(2.0 / static_cast<double>(SIZE));
        for (int position = 0; position < SIZE; ++position) {
            basis[frequency * SIZE + position] = normalization * std::cos(
                3.141592653589793238462643383279502884 *
                static_cast<double>((2 * position + 1) * frequency) /
                static_cast<double>(2 * SIZE)
            );
        }
    }
    return basis;
}

void initialize_device_tables() {
    const auto basis16 = make_basis<16>();
    const auto basis8 = make_basis<8>();
    const auto scans_y = make_scans<16, 16>();
    const auto scans_8 = make_scans<8, 8>();
    const auto scans_c = make_scans<8, 16>();
    cuda_check(cudaMemcpyToSymbol(DEVICE_BASIS_16, basis16.data(), sizeof(basis16)), "Upload 16-point DCT basis");
    cuda_check(cudaMemcpyToSymbol(DEVICE_BASIS_8, basis8.data(), sizeof(basis8)), "Upload 8-point DCT basis");
    cuda_check(cudaMemcpyToSymbol(DEVICE_SCAN_Y, scans_y.data(), sizeof(scans_y)), "Upload luma scans");
    cuda_check(cudaMemcpyToSymbol(DEVICE_SCAN_8, scans_8.data(), sizeof(scans_8)), "Upload 8x8 scans");
    cuda_check(cudaMemcpyToSymbol(DEVICE_SCAN_C, scans_c.data(), sizeof(scans_c)), "Upload chroma scans");
    cuda_check(cudaMemcpyToSymbol(DEVICE_QY, LUMA_QUANTIZATION.data(), sizeof(LUMA_QUANTIZATION)), "Upload luma quantizer");
    cuda_check(cudaMemcpyToSymbol(DEVICE_QC, CHROMA_QUANTIZATION.data(), sizeof(CHROMA_QUANTIZATION)), "Upload chroma quantizer");
}

__device__ __forceinline__ double rn_add(double left, double right) {
    return __dadd_rn(left, right);
}

__device__ __forceinline__ double rn_mul(double left, double right) {
    return __dmul_rn(left, right);
}

__device__ __forceinline__ double rn_square(double value) {
    return rn_mul(value, value);
}

__device__ __forceinline__ int round_signed(double value) {
    return value < 0.0
        ? -static_cast<int>(floor(-value + 0.5))
        : static_cast<int>(floor(value + 0.5));
}

__device__ __forceinline__ int clamp_int(int value, int minimum, int maximum) {
    return max(minimum, min(maximum, value));
}

__device__ __forceinline__ double basis_value(int size, int frequency, int position) {
    return size == 16
        ? DEVICE_BASIS_16[frequency * 16 + position]
        : DEVICE_BASIS_8[frequency * 8 + position];
}

__device__ __forceinline__ int scan_position(int width, int height, int profile, int index) {
    if (width == 16) {
        return DEVICE_SCAN_Y[profile * 255 + index];
    }
    return height == 8
        ? DEVICE_SCAN_8[profile * 63 + index]
        : DEVICE_SCAN_C[profile * 127 + index];
}

__device__ double quantization_step(
    int u,
    int v,
    int width,
    int height,
    int quality,
    bool chroma
) {
    const int table_x = min(7, static_cast<int>(floor(
        static_cast<double>(u * 7) / static_cast<double>(max(1, width - 1)) + 0.5
    )));
    const int table_y = min(7, static_cast<int>(floor(
        static_cast<double>(v * 7) / static_cast<double>(max(1, height - 1)) + 0.5
    )));
    const double quality_scale = quality < 50
        ? 50.0 / static_cast<double>(quality)
        : 2.0 - static_cast<double>(quality) * 0.02;
    const double dimension_scale = sqrt(static_cast<double>(width * height) / 64.0);
    const int table_value = chroma
        ? DEVICE_QC[table_y * 8 + table_x]
        : DEVICE_QY[table_y * 8 + table_x];
    return max(1.0, static_cast<double>(table_value) * quality_scale * dimension_scale);
}

__device__ void write_bits(uint8_t *record, int *bit_offset, uint32_t value, int bit_count) {
    for (int bit = bit_count - 1; bit >= 0; --bit) {
        const int byte_index = *bit_offset >> 3;
        const int bit_index = 7 - (*bit_offset & 7);
        record[byte_index] |= static_cast<uint8_t>(((value >> bit) & 1u) << bit_index);
        ++(*bit_offset);
    }
}

__device__ void write_signed_bits(uint8_t *record, int *bit_offset, int value, int bit_count) {
    const uint32_t encoded = value < 0
        ? static_cast<uint32_t>(value + (1 << bit_count))
        : static_cast<uint32_t>(value);
    write_bits(record, bit_offset, encoded, bit_count);
}

__device__ uint32_t read_bits(const uint8_t *record, int *bit_offset, int bit_count) {
    uint32_t value = 0u;
    for (int bit = 0; bit < bit_count; ++bit) {
        const int byte_index = *bit_offset >> 3;
        const int bit_index = 7 - (*bit_offset & 7);
        value = value * 2u + ((record[byte_index] >> bit_index) & 1u);
        ++(*bit_offset);
    }
    return value;
}

__device__ int read_signed_bits(const uint8_t *record, int *bit_offset, int bit_count) {
    const uint32_t value = read_bits(record, bit_offset, bit_count);
    const uint32_t sign_bit = 1u << (bit_count - 1);
    return (value & sign_bit) != 0u
        ? static_cast<int>(value) - (1 << bit_count)
        : static_cast<int>(value);
}

template <int WIDTH, int HEIGHT, bool CHROMA>
__device__ void encode_legacy_component_record(
    const double *coefficients,
    uint8_t *record,
    int byte_count,
    int quality
) {
    const int ac_count = (byte_count * 8 - 18) / 6;
    double base_error = 0.0;
    for (int position = 0; position < WIDTH * HEIGHT; ++position) {
        base_error = rn_add(base_error, rn_square(coefficients[position]));
    }

    double best_error = DBL_MAX;
    int best_profile = 0;
    int best_scale_index = 0;
    int best_dc = 0;

    for (int profile = 0; profile < 4; ++profile) {
        for (int scale_index = 0; scale_index < 8; ++scale_index) {
            const int scale = 1 << scale_index;
            const double dc_step = quantization_step(0, 0, WIDTH, HEIGHT, quality, CHROMA) * scale;
            const int dc = clamp_int(round_signed(coefficients[0] / dc_step), -512, 511);
            const double restored_dc = static_cast<double>(dc) * dc_step;
            double error = base_error;
            error = rn_add(error, rn_square(coefficients[0] - restored_dc));
            error = rn_add(error, -rn_square(coefficients[0]));

            for (int index = 0; index < ac_count; ++index) {
                const int position = scan_position(WIDTH, HEIGHT, profile, index);
                const int u = position % WIDTH;
                const int v = position / WIDTH;
                const double step = quantization_step(u, v, WIDTH, HEIGHT, quality, CHROMA) * scale;
                const int stored = clamp_int(round_signed(coefficients[position] / step), -32, 31);
                const double restored = static_cast<double>(stored) * step;
                error = rn_add(error, rn_square(coefficients[position] - restored));
                error = rn_add(error, -rn_square(coefficients[position]));
            }

            const bool better = error < best_error ||
                (error == best_error && (scale_index < best_scale_index ||
                (scale_index == best_scale_index && profile < best_profile)));
            if (better) {
                best_error = error;
                best_profile = profile;
                best_scale_index = scale_index;
                best_dc = dc;
            }
        }
    }

    int bit_offset = 0;
    write_bits(record, &bit_offset, static_cast<uint32_t>((best_profile << 4) | best_scale_index), 8);
    write_signed_bits(record, &bit_offset, best_dc, 10);
    const int scale = 1 << best_scale_index;
    for (int index = 0; index < ac_count; ++index) {
        const int position = scan_position(WIDTH, HEIGHT, best_profile, index);
        const int u = position % WIDTH;
        const int v = position / WIDTH;
        const double step = quantization_step(u, v, WIDTH, HEIGHT, quality, CHROMA) * scale;
        const int stored = clamp_int(round_signed(coefficients[position] / step), -32, 31);
        write_signed_bits(record, &bit_offset, stored, 6);
    }
}

__device__ int grouped_count(int coefficient_coding) {
    return coefficient_coding == COEFFICIENT_CODING_GROUPED_EQUAL_2 ? 2 : 3;
}

__device__ int grouped_end(int coefficient_coding, int group, int ac_count) {
    if (coefficient_coding == COEFFICIENT_CODING_GROUPED_EQUAL_2) {
        return (group + 1) * ac_count / 2;
    }
    if (group == 0) {
        return (ac_count + 5) / 6;
    }
    if (group == 1) {
        return (ac_count + 1) / 2;
    }
    return ac_count;
}

template <int WIDTH, int HEIGHT, bool CHROMA>
__device__ void encode_grouped_component_record(
    const double *coefficients,
    uint8_t *record,
    int byte_count,
    int quality,
    int coefficient_coding
) {
    const int group_count = grouped_count(coefficient_coding);
    const int ac_count = (byte_count * 8 - 18 - group_count * 3) / 5;
    double base_error = 0.0;
    for (int position = 0; position < WIDTH * HEIGHT; ++position) {
        base_error = rn_add(base_error, rn_square(coefficients[position]));
    }

    int best_dc_scale = 0;
    int best_dc = 0;
    double best_dc_delta = DBL_MAX;
    for (int scale_index = 0; scale_index < 8; ++scale_index) {
        const int scale = 1 << scale_index;
        const double step = quantization_step(0, 0, WIDTH, HEIGHT, quality, CHROMA) * scale;
        const int stored = clamp_int(round_signed(coefficients[0] / step), -512, 511);
        const double restored = static_cast<double>(stored) * step;
        const double delta = rn_add(
            rn_square(coefficients[0] - restored),
            -rn_square(coefficients[0])
        );
        if (delta < best_dc_delta || (delta == best_dc_delta && scale_index < best_dc_scale)) {
            best_dc_delta = delta;
            best_dc_scale = scale_index;
            best_dc = stored;
        }
    }

    double best_error = DBL_MAX;
    int best_profile = 0;
    int best_group_scales[3] = {0, 0, 0};
    for (int profile = 0; profile < 4; ++profile) {
        double error = rn_add(base_error, best_dc_delta);
        int group_scales[3] = {0, 0, 0};
        int group_start = 0;

        for (int group = 0; group < group_count; ++group) {
            const int group_finish = grouped_end(coefficient_coding, group, ac_count);
            double best_group_delta = DBL_MAX;
            int best_group_scale = 0;

            for (int scale_index = 0; scale_index < 8; ++scale_index) {
                const int scale = 1 << scale_index;
                double delta = 0.0;
                for (int index = group_start; index < group_finish; ++index) {
                    const int position = scan_position(WIDTH, HEIGHT, profile, index);
                    const int u = position % WIDTH;
                    const int v = position / WIDTH;
                    const double step = quantization_step(u, v, WIDTH, HEIGHT, quality, CHROMA) * scale;
                    const int stored = clamp_int(round_signed(coefficients[position] / step), -16, 15);
                    const double restored = static_cast<double>(stored) * step;
                    const double coefficient_delta = rn_add(
                        rn_square(coefficients[position] - restored),
                        -rn_square(coefficients[position])
                    );
                    delta = rn_add(delta, coefficient_delta);
                }
                if (delta < best_group_delta ||
                    (delta == best_group_delta && scale_index < best_group_scale)) {
                    best_group_delta = delta;
                    best_group_scale = scale_index;
                }
            }

            group_scales[group] = best_group_scale;
            error = rn_add(error, best_group_delta);
            group_start = group_finish;
        }

        const bool better = error < best_error || (error == best_error && profile < best_profile);
        if (better) {
            best_error = error;
            best_profile = profile;
            for (int group = 0; group < group_count; ++group) {
                best_group_scales[group] = group_scales[group];
            }
        }
    }

    int bit_offset = 0;
    write_bits(record, &bit_offset, static_cast<uint32_t>((best_profile << 4) | best_dc_scale), 8);
    write_signed_bits(record, &bit_offset, best_dc, 10);
    for (int group = 0; group < group_count; ++group) {
        write_bits(record, &bit_offset, static_cast<uint32_t>(best_group_scales[group]), 3);
    }
    int group_start = 0;
    for (int group = 0; group < group_count; ++group) {
        const int group_finish = grouped_end(coefficient_coding, group, ac_count);
        const int scale = 1 << best_group_scales[group];
        for (int index = group_start; index < group_finish; ++index) {
            const int position = scan_position(WIDTH, HEIGHT, best_profile, index);
            const int u = position % WIDTH;
            const int v = position / WIDTH;
            const double step = quantization_step(u, v, WIDTH, HEIGHT, quality, CHROMA) * scale;
            const int stored = clamp_int(round_signed(coefficients[position] / step), -16, 15);
            write_signed_bits(record, &bit_offset, stored, 5);
        }
        group_start = group_finish;
    }
}

template <int WIDTH, int HEIGHT, bool CHROMA>
__device__ void encode_component_record(
    const double *coefficients,
    uint8_t *record,
    int byte_count,
    int quality,
    int coefficient_coding
) {
    if (coefficient_coding == COEFFICIENT_CODING_LEGACY) {
        encode_legacy_component_record<WIDTH, HEIGHT, CHROMA>(
            coefficients, record, byte_count, quality
        );
    } else {
        encode_grouped_component_record<WIDTH, HEIGHT, CHROMA>(
            coefficients, record, byte_count, quality, coefficient_coding
        );
    }
}

template <int WIDTH, int HEIGHT, bool CHROMA>
__global__ void encode_component_kernel(
    const uint8_t *rgb,
    uint32_t width,
    uint32_t height,
    uint32_t mcu_columns,
    uint32_t mcu_count,
    uint32_t bytes_per_mcu,
    uint32_t component_offset,
    uint32_t component_bytes,
    int component,
    int luma_block,
    int quality,
    int coefficient_coding,
    uint8_t *output
) {
    const uint32_t mcu_index = blockIdx.x;
    if (mcu_index >= mcu_count) {
        return;
    }
    constexpr int COUNT = WIDTH * HEIGHT;
    __shared__ double samples[COUNT];
    __shared__ double horizontal[COUNT];
    __shared__ double coefficients[COUNT];
    const int position = threadIdx.x;
    const uint32_t mcu_x = mcu_index % mcu_columns;
    const uint32_t mcu_y = mcu_index / mcu_columns;
    const int block_y = !CHROMA && HEIGHT == 8 ? (luma_block >> 1) * 8 : 0;

    if (position < COUNT) {
        const int local_x = position % WIDTH;
        const int local_y = position / WIDTH;
        const uint32_t source_y = min(
            height - 1u,
            mcu_y * MCU_HEIGHT + static_cast<uint32_t>(block_y + local_y)
        );
        if constexpr (!CHROMA) {
            const int block_x = WIDTH == 8 ? (luma_block & 1) * 8 : 0;
            const uint32_t source_x = min(
                width - 1u,
                mcu_x * MCU_WIDTH + static_cast<uint32_t>(block_x + local_x)
            );
            const size_t source = (static_cast<size_t>(source_y) * width + source_x) * 3u;
            const double red = rgb[source];
            const double green = rgb[source + 1u];
            const double blue = rgb[source + 2u];
            double value = rn_add(rn_mul(0.299, red), rn_mul(0.587, green));
            value = rn_add(value, rn_mul(0.114, blue));
            samples[position] = rn_add(value, -128.0);
        } else {
            double sum = 0.0;
            for (int pair = 0; pair < 2; ++pair) {
                const uint32_t source_x = min(
                    width - 1u,
                    mcu_x * MCU_WIDTH + static_cast<uint32_t>(local_x * 2 + pair)
                );
                const size_t source = (static_cast<size_t>(source_y) * width + source_x) * 3u;
                const double red = rgb[source];
                const double green = rgb[source + 1u];
                const double blue = rgb[source + 2u];
                double value;
                if (component == 1) {
                    value = rn_add(128.0, -rn_mul(0.168736, red));
                    value = rn_add(value, -rn_mul(0.331264, green));
                    value = rn_add(value, rn_mul(0.5, blue));
                } else {
                    value = rn_add(128.0, rn_mul(0.5, red));
                    value = rn_add(value, -rn_mul(0.418688, green));
                    value = rn_add(value, -rn_mul(0.081312, blue));
                }
                sum = rn_add(sum, value);
            }
            samples[position] = rn_add(rn_mul(sum, 0.5), -128.0);
        }
    }
    __syncthreads();

    if (position < COUNT) {
        const int y = position / WIDTH;
        const int u = position % WIDTH;
        double sum = 0.0;
        for (int x = 0; x < WIDTH; ++x) {
            sum = rn_add(sum, rn_mul(samples[y * WIDTH + x], basis_value(WIDTH, u, x)));
        }
        horizontal[position] = sum;
    }
    __syncthreads();

    if (position < COUNT) {
        const int v = position / WIDTH;
        const int u = position % WIDTH;
        double sum = 0.0;
        for (int y = 0; y < HEIGHT; ++y) {
            sum = rn_add(sum, rn_mul(basis_value(HEIGHT, v, y), horizontal[y * WIDTH + u]));
        }
        coefficients[position] = sum;
    }
    __syncthreads();

    if (position == 0) {
        uint8_t *record = output + HEADER_BYTES +
            static_cast<size_t>(mcu_index) * bytes_per_mcu + component_offset;
        encode_component_record<WIDTH, HEIGHT, CHROMA>(
            coefficients,
            record,
            static_cast<int>(component_bytes),
            quality,
            coefficient_coding
        );
    }
}

template <int WIDTH, int HEIGHT, bool CHROMA>
__device__ bool decode_legacy_component_record(
    const uint8_t *record,
    int byte_count,
    int quality,
    double *coefficients
) {
    for (int position = 0; position < WIDTH * HEIGHT; ++position) {
        coefficients[position] = 0.0;
    }
    int bit_offset = 0;
    const uint32_t header = read_bits(record, &bit_offset, 8);
    const int profile = static_cast<int>(header >> 4u);
    const int scale_index = static_cast<int>(header & 15u);
    if (profile >= 4 || scale_index >= 8) {
        return false;
    }
    const int scale = 1 << scale_index;
    const int dc = read_signed_bits(record, &bit_offset, 10);
    coefficients[0] = static_cast<double>(dc) *
        quantization_step(0, 0, WIDTH, HEIGHT, quality, CHROMA) * scale;
    const int ac_count = (byte_count * 8 - 18) / 6;
    for (int index = 0; index < ac_count; ++index) {
        const int position = scan_position(WIDTH, HEIGHT, profile, index);
        const int u = position % WIDTH;
        const int v = position / WIDTH;
        const int stored = read_signed_bits(record, &bit_offset, 6);
        coefficients[position] = static_cast<double>(stored) *
            quantization_step(u, v, WIDTH, HEIGHT, quality, CHROMA) * scale;
    }
    return true;
}

template <int WIDTH, int HEIGHT, bool CHROMA>
__device__ bool decode_grouped_component_record(
    const uint8_t *record,
    int byte_count,
    int quality,
    int coefficient_coding,
    double *coefficients
) {
    for (int position = 0; position < WIDTH * HEIGHT; ++position) {
        coefficients[position] = 0.0;
    }
    int bit_offset = 0;
    const uint32_t header = read_bits(record, &bit_offset, 8);
    const int profile = static_cast<int>(header >> 4u);
    const int dc_scale_index = static_cast<int>(header & 15u);
    if (profile >= 4 || dc_scale_index >= 8) {
        return false;
    }
    const int dc = read_signed_bits(record, &bit_offset, 10);
    coefficients[0] = static_cast<double>(dc) *
        quantization_step(0, 0, WIDTH, HEIGHT, quality, CHROMA) *
        (1 << dc_scale_index);

    const int group_count = grouped_count(coefficient_coding);
    const int ac_count = (byte_count * 8 - 18 - group_count * 3) / 5;
    int group_scales[3] = {0, 0, 0};
    for (int group = 0; group < group_count; ++group) {
        group_scales[group] = static_cast<int>(read_bits(record, &bit_offset, 3));
    }

    int group_start = 0;
    for (int group = 0; group < group_count; ++group) {
        const int group_finish = grouped_end(coefficient_coding, group, ac_count);
        const int scale = 1 << group_scales[group];
        for (int index = group_start; index < group_finish; ++index) {
            const int position = scan_position(WIDTH, HEIGHT, profile, index);
            const int u = position % WIDTH;
            const int v = position / WIDTH;
            const int stored = read_signed_bits(record, &bit_offset, 5);
            coefficients[position] = static_cast<double>(stored) *
                quantization_step(u, v, WIDTH, HEIGHT, quality, CHROMA) * scale;
        }
        group_start = group_finish;
    }
    return true;
}

template <int WIDTH, int HEIGHT, bool CHROMA>
__device__ bool decode_component_record(
    const uint8_t *record,
    int byte_count,
    int quality,
    int coefficient_coding,
    double *coefficients
) {
    if (coefficient_coding == COEFFICIENT_CODING_LEGACY) {
        return decode_legacy_component_record<WIDTH, HEIGHT, CHROMA>(
            record, byte_count, quality, coefficients
        );
    }
    return decode_grouped_component_record<WIDTH, HEIGHT, CHROMA>(
        record, byte_count, quality, coefficient_coding, coefficients
    );
}

template <int WIDTH, int HEIGHT>
__device__ double sample_inverse_dct(const double *coefficients, int x, int y) {
    double output = 0.0;
    for (int u = 0; u < WIDTH; ++u) {
        double vertical = 0.0;
        for (int v = 0; v < HEIGHT; ++v) {
            vertical = rn_add(
                vertical,
                rn_mul(basis_value(HEIGHT, v, y), coefficients[v * WIDTH + u])
            );
        }
        output = rn_add(output, rn_mul(vertical, basis_value(WIDTH, u, x)));
    }
    return output;
}

__device__ uint8_t clamp_byte(double value) {
    return static_cast<uint8_t>(clamp_int(round_signed(value), 0, 255));
}

__device__ void convert_to_rgba(double y, double cb, double cr, uint8_t *output) {
    const double centered_cb = cb - 128.0;
    const double centered_cr = cr - 128.0;
    double red = rn_add(y, rn_mul(1.402, centered_cr));
    double green = rn_add(y, -rn_mul(0.344136, centered_cb));
    green = rn_add(green, -rn_mul(0.714136, centered_cr));
    double blue = rn_add(y, rn_mul(1.772, centered_cb));
    output[0] = clamp_byte(red);
    output[1] = clamp_byte(green);
    output[2] = clamp_byte(blue);
    output[3] = 255u;
}

__global__ void decode_image_kernel(
    const uint8_t *file,
    uint32_t width,
    uint32_t height,
    uint32_t mcu_columns,
    uint32_t mcu_count,
    Preset preset,
    int quality,
    bool split_luma_8x8,
    int coefficient_coding,
    uint8_t *rgb,
    int *error_flag
) {
    const uint32_t mcu_index = blockIdx.x;
    if (mcu_index >= mcu_count) {
        return;
    }
    __shared__ double y_coefficients[16 * 16];
    __shared__ double cb_coefficients[8 * 16];
    __shared__ double cr_coefficients[8 * 16];
    const uint8_t *record = file + HEADER_BYTES +
        static_cast<size_t>(mcu_index) * preset.bytes_per_mcu;

    if (threadIdx.x == 0) {
        bool y_ok = true;
        if (split_luma_8x8) {
            const int block_bytes = static_cast<int>(preset.y_bytes / 4u);
            for (int block = 0; block < 4; ++block) {
                y_ok = decode_component_record<8, 8, false>(
                    record + block * block_bytes,
                    block_bytes,
                    quality,
                    coefficient_coding,
                    y_coefficients + block * 64
                ) && y_ok;
            }
        } else {
            y_ok = decode_component_record<16, 16, false>(
                record,
                static_cast<int>(preset.y_bytes),
                quality,
                coefficient_coding,
                y_coefficients
            );
        }
        const bool cb_ok = decode_component_record<8, 16, true>(
            record + preset.y_bytes,
            static_cast<int>(preset.cb_bytes),
            quality,
            coefficient_coding,
            cb_coefficients
        );
        const bool cr_ok = decode_component_record<8, 16, true>(
            record + preset.y_bytes + preset.cb_bytes,
            static_cast<int>(preset.cr_bytes),
            quality,
            coefficient_coding,
            cr_coefficients
        );
        if (!y_ok || !cb_ok || !cr_ok) {
            atomicExch(error_flag, 1);
        }
    }
    __syncthreads();

    const int local = threadIdx.x;
    if (local >= 256) {
        return;
    }
    const int local_x = local % 16;
    const int local_y = local / 16;
    const uint32_t mcu_x = mcu_index % mcu_columns;
    const uint32_t mcu_y = mcu_index / mcu_columns;
    const uint32_t x = mcu_x * 16u + static_cast<uint32_t>(local_x);
    const uint32_t y = mcu_y * 16u + static_cast<uint32_t>(local_y);
    if (x >= width || y >= height) {
        return;
    }

    double luma;
    if (split_luma_8x8) {
        const int luma_block = (local_y / 8) * 2 + local_x / 8;
        luma = sample_inverse_dct<8, 8>(
            y_coefficients + luma_block * 64,
            local_x % 8,
            local_y % 8
        ) + 128.0;
    } else {
        luma = sample_inverse_dct<16, 16>(y_coefficients, local_x, local_y) + 128.0;
    }
    const double cb = sample_inverse_dct<8, 16>(cb_coefficients, local_x / 2, local_y) + 128.0;
    const double cr = sample_inverse_dct<8, 16>(cr_coefficients, local_x / 2, local_y) + 128.0;
    uint8_t rgba[4];
    convert_to_rgba(luma, cb, cr, rgba);
    const size_t destination = (static_cast<size_t>(y) * width + x) * 3u;
    rgb[destination] = rgba[0];
    rgb[destination + 1u] = rgba[1];
    rgb[destination + 2u] = rgba[2];
}

__global__ void sample_pixel_kernel(
    const uint8_t *record,
    Preset preset,
    int quality,
    bool split_luma_8x8,
    int coefficient_coding,
    int local_x,
    int local_y,
    uint8_t *rgba,
    int *error_flag
) {
    __shared__ double y_coefficients[16 * 16];
    __shared__ double cb_coefficients[8 * 16];
    __shared__ double cr_coefficients[8 * 16];
    if (threadIdx.x == 0) {
        bool y_ok;
        if (split_luma_8x8) {
            const int block_bytes = static_cast<int>(preset.y_bytes / 4u);
            const int luma_block = (local_y / 8) * 2 + local_x / 8;
            y_ok = decode_component_record<8, 8, false>(
                record + luma_block * block_bytes,
                block_bytes,
                quality,
                coefficient_coding,
                y_coefficients
            );
        } else {
            y_ok = decode_component_record<16, 16, false>(
                record,
                static_cast<int>(preset.y_bytes),
                quality,
                coefficient_coding,
                y_coefficients
            );
        }
        const bool cb_ok = decode_component_record<8, 16, true>(
            record + preset.y_bytes,
            static_cast<int>(preset.cb_bytes),
            quality,
            coefficient_coding,
            cb_coefficients
        );
        const bool cr_ok = decode_component_record<8, 16, true>(
            record + preset.y_bytes + preset.cb_bytes,
            static_cast<int>(preset.cr_bytes),
            quality,
            coefficient_coding,
            cr_coefficients
        );
        if (!y_ok || !cb_ok || !cr_ok) {
            *error_flag = 1;
            return;
        }
        double luma;
        if (split_luma_8x8) {
            luma = sample_inverse_dct<8, 8>(
                y_coefficients,
                local_x % 8,
                local_y % 8
            ) + 128.0;
        } else {
            luma = sample_inverse_dct<16, 16>(y_coefficients, local_x, local_y) + 128.0;
        }
        const double cb = sample_inverse_dct<8, 16>(cb_coefficients, local_x / 2, local_y) + 128.0;
        const double cr = sample_inverse_dct<8, 16>(cr_coefficients, local_x / 2, local_y) + 128.0;
        convert_to_rgba(luma, cb, cr, rgba);
    }
}

std::vector<uint8_t> make_header(
    uint32_t width,
    uint32_t height,
    const Preset &preset,
    uint32_t quality,
    bool auto_quality,
    bool split_luma_8x8,
    int coefficient_coding,
    uint32_t candidate_count
) {
    const uint32_t columns = (width + 15u) / 16u;
    const uint32_t rows = (height + 15u) / 16u;
    const uint64_t count = static_cast<uint64_t>(columns) * rows;
    const uint64_t payload = count * preset.bytes_per_mcu;
    if (count > UINT32_MAX || payload > UINT32_MAX) {
        throw std::runtime_error("DCTBS2 image is too large for the v2 header");
    }
    std::vector<uint8_t> header(HEADER_BYTES, 0u);
    std::copy(MAGIC.begin(), MAGIC.end(), header.begin());
    write_u32(header.data(), 8u, DCT_VERSION);
    write_u32(header.data(), 12u, preset.mode_code);
    write_u32(header.data(), 16u, width);
    write_u32(header.data(), 20u, height);
    write_u32(header.data(), 24u, columns);
    write_u32(header.data(), 28u, rows);
    write_u32(header.data(), 32u, preset.bytes_per_mcu);
    write_u32(header.data(), 36u, preset.y_bytes);
    write_u32(header.data(), 40u, preset.cb_bytes);
    write_u32(header.data(), 44u, preset.cr_bytes);
    write_u32(header.data(), 48u, quality);
    write_u32(
        header.data(),
        52u,
        (auto_quality ? FLAG_AUTO_QUALITY : 0u) |
            (split_luma_8x8 ? FLAG_SPLIT_LUMA_8X8 : 0u) |
            (static_cast<uint32_t>(coefficient_coding) << COEFFICIENT_CODING_SHIFT)
    );
    write_u32(header.data(), 56u, static_cast<uint32_t>(payload));
    write_u32(header.data(), 60u, candidate_count);
    return header;
}

DctInfo inspect_header(const uint8_t *bytes, uint64_t file_size) {
    if (file_size < HEADER_BYTES || !std::equal(MAGIC.begin(), MAGIC.end(), bytes)) {
        throw std::runtime_error("Invalid or truncated DCTBS2 file");
    }
    if (read_u32(bytes, 8u) != DCT_VERSION) {
        throw std::runtime_error("Unsupported DCTBS2 version");
    }
    Preset preset;
    if (!find_preset_mode(read_u32(bytes, 12u), &preset)) {
        throw std::runtime_error("Unsupported DCTBS2 mode");
    }
    DctInfo info;
    info.preset = preset;
    info.width = read_u32(bytes, 16u);
    info.height = read_u32(bytes, 20u);
    info.mcu_columns = read_u32(bytes, 24u);
    info.mcu_rows = read_u32(bytes, 28u);
    info.quality = read_u32(bytes, 48u);
    const uint32_t flags = read_u32(bytes, 52u);
    const uint32_t payload = read_u32(bytes, 56u);
    info.search_candidate_count = read_u32(bytes, 60u);
    info.auto_quality = (flags & FLAG_AUTO_QUALITY) != 0u;
    info.split_luma_8x8 = (flags & FLAG_SPLIT_LUMA_8X8) != 0u;
    info.coefficient_coding = static_cast<int>(
        (flags & COEFFICIENT_CODING_MASK) >> COEFFICIENT_CODING_SHIFT
    );

    if (info.width == 0u || info.height == 0u || info.quality < 1u || info.quality > 100u ||
        (flags & ~SUPPORTED_FLAGS) != 0u || info.mcu_columns != (info.width + 15u) / 16u ||
        info.coefficient_coding > COEFFICIENT_CODING_GROUPED_FRONT ||
        info.mcu_rows != (info.height + 15u) / 16u ||
        (info.split_luma_8x8 && preset.nominal_bpp < 3.0) ||
        read_u32(bytes, 32u) != preset.bytes_per_mcu ||
        read_u32(bytes, 36u) != preset.y_bytes ||
        read_u32(bytes, 40u) != preset.cb_bytes ||
        read_u32(bytes, 44u) != preset.cr_bytes) {
        throw std::runtime_error("Invalid DCTBS2 layout");
    }
    const uint64_t count = static_cast<uint64_t>(info.mcu_columns) * info.mcu_rows;
    const uint64_t expected_payload = count * preset.bytes_per_mcu;
    if (count > UINT32_MAX || expected_payload != payload ||
        file_size != HEADER_BYTES + expected_payload) {
        throw std::runtime_error("Invalid DCTBS2 payload length");
    }
    info.mcu_count = static_cast<uint32_t>(count);
    return info;
}

DctInfo inspect_file(const std::vector<uint8_t> &bytes) {
    if (bytes.size() < HEADER_BYTES) {
        throw std::runtime_error("Invalid or truncated DCTBS2 file");
    }
    return inspect_header(bytes.data(), bytes.size());
}

GpuResult encode_gpu(
    const std::vector<uint8_t> &rgb,
    uint32_t width,
    uint32_t height,
    const Preset &preset,
    uint32_t quality,
    bool auto_quality,
    uint32_t candidate_count
) {
    const bool split_luma_8x8 = preset.nominal_bpp >= 3.0;
    const int coefficient_coding = default_coefficient_coding(preset);
    std::vector<uint8_t> header = make_header(
        width,
        height,
        preset,
        quality,
        auto_quality,
        split_luma_8x8,
        coefficient_coding,
        candidate_count
    );
    const uint32_t columns = (width + 15u) / 16u;
    const uint32_t rows = (height + 15u) / 16u;
    const uint32_t count = columns * rows;
    GpuResult result;
    result.bytes.resize(HEADER_BYTES + static_cast<size_t>(count) * preset.bytes_per_mcu, 0u);
    std::copy(header.begin(), header.end(), result.bytes.begin());

    DeviceBuffer<uint8_t> device_rgb(rgb.size());
    DeviceBuffer<uint8_t> device_output(result.bytes.size());
    cuda_check(cudaMemcpy(device_rgb.get(), rgb.data(), rgb.size(), cudaMemcpyHostToDevice), "Upload RGB image");
    cuda_check(cudaMemset(device_output.get(), 0, result.bytes.size()), "Clear DCTBS2 output");
    cuda_check(cudaMemcpy(device_output.get(), header.data(), header.size(), cudaMemcpyHostToDevice), "Upload DCTBS2 header");

    CudaEvent started;
    CudaEvent finished;
    cuda_check(cudaEventRecord(started.get()), "Start encode timer");
    if (split_luma_8x8) {
        const uint32_t block_bytes = preset.y_bytes / 4u;
        for (int block = 0; block < 4; ++block) {
            encode_component_kernel<8, 8, false><<<count, 64>>>(
                device_rgb.get(), width, height, columns, count,
                preset.bytes_per_mcu, static_cast<uint32_t>(block) * block_bytes,
                block_bytes, 0, block, static_cast<int>(quality), coefficient_coding,
                device_output.get()
            );
            cuda_check(cudaGetLastError(), "Launch split luma DCT kernel");
        }
    } else {
        encode_component_kernel<16, 16, false><<<count, CUDA_THREADS>>>(
            device_rgb.get(), width, height, columns, count,
            preset.bytes_per_mcu, 0u, preset.y_bytes, 0, 0,
            static_cast<int>(quality), coefficient_coding, device_output.get()
        );
        cuda_check(cudaGetLastError(), "Launch luma DCT kernel");
    }
    encode_component_kernel<8, 16, true><<<count, CUDA_THREADS>>>(
        device_rgb.get(), width, height, columns, count,
        preset.bytes_per_mcu, preset.y_bytes, preset.cb_bytes, 1, 0,
        static_cast<int>(quality), coefficient_coding, device_output.get()
    );
    cuda_check(cudaGetLastError(), "Launch Cb DCT kernel");
    encode_component_kernel<8, 16, true><<<count, CUDA_THREADS>>>(
        device_rgb.get(), width, height, columns, count,
        preset.bytes_per_mcu, preset.y_bytes + preset.cb_bytes, preset.cr_bytes, 2,
        0, static_cast<int>(quality), coefficient_coding, device_output.get()
    );
    cuda_check(cudaGetLastError(), "Launch Cr DCT kernel");
    cuda_check(cudaEventRecord(finished.get()), "Stop encode timer");
    cuda_check(cudaEventSynchronize(finished.get()), "Wait for DCT kernels");
    cuda_check(cudaEventElapsedTime(&result.kernel_ms, started.get(), finished.get()), "Measure DCT kernels");
    cuda_check(cudaMemcpy(result.bytes.data(), device_output.get(), result.bytes.size(), cudaMemcpyDeviceToHost), "Download DCTBS2 file");
    return result;
}

GpuResult decode_gpu(const std::vector<uint8_t> &file, const DctInfo &info) {
    GpuResult result;
    result.bytes.resize(static_cast<size_t>(info.width) * info.height * 3u);
    DeviceBuffer<uint8_t> device_file(file.size());
    DeviceBuffer<uint8_t> device_rgb(result.bytes.size());
    DeviceBuffer<int> device_error(1u);
    cuda_check(cudaMemcpy(device_file.get(), file.data(), file.size(), cudaMemcpyHostToDevice), "Upload DCTBS2 file");
    cuda_check(cudaMemset(device_error.get(), 0, sizeof(int)), "Clear decoder error flag");

    CudaEvent started;
    CudaEvent finished;
    cuda_check(cudaEventRecord(started.get()), "Start decode timer");
    decode_image_kernel<<<info.mcu_count, CUDA_THREADS>>>(
        device_file.get(), info.width, info.height, info.mcu_columns, info.mcu_count,
        info.preset, static_cast<int>(info.quality), info.split_luma_8x8,
        info.coefficient_coding,
        device_rgb.get(), device_error.get()
    );
    cuda_check(cudaGetLastError(), "Launch DCTBS2 decode kernel");
    cuda_check(cudaEventRecord(finished.get()), "Stop decode timer");
    cuda_check(cudaEventSynchronize(finished.get()), "Wait for DCTBS2 decode kernel");
    cuda_check(cudaEventElapsedTime(&result.kernel_ms, started.get(), finished.get()), "Measure DCTBS2 decode kernel");
    int error_flag = 0;
    cuda_check(cudaMemcpy(&error_flag, device_error.get(), sizeof(int), cudaMemcpyDeviceToHost), "Read decoder error flag");
    if (error_flag != 0) {
        throw std::runtime_error("Invalid DCT component profile");
    }
    cuda_check(cudaMemcpy(result.bytes.data(), device_rgb.get(), result.bytes.size(), cudaMemcpyDeviceToHost), "Download RGB image");
    return result;
}

std::array<uint8_t, 4> sample_pixel_gpu(
    const std::vector<uint8_t> &record,
    const DctInfo &info,
    uint32_t x,
    uint32_t y
) {
    if (x >= info.width || y >= info.height) {
        throw std::runtime_error("Pixel coordinate is outside the image");
    }
    if (record.size() != info.preset.bytes_per_mcu) {
        throw std::runtime_error("Invalid MCU record length");
    }
    DeviceBuffer<uint8_t> device_record(info.preset.bytes_per_mcu);
    DeviceBuffer<uint8_t> device_rgba(4u);
    DeviceBuffer<int> device_error(1u);
    cuda_check(cudaMemcpy(
        device_record.get(), record.data(), record.size(), cudaMemcpyHostToDevice
    ), "Upload one MCU record");
    cuda_check(cudaMemset(device_error.get(), 0, sizeof(int)), "Clear pixel decoder error flag");
    sample_pixel_kernel<<<1, 1>>>(
        device_record.get(), info.preset, static_cast<int>(info.quality),
        info.split_luma_8x8, info.coefficient_coding,
        static_cast<int>(x % 16u), static_cast<int>(y % 16u),
        device_rgba.get(), device_error.get()
    );
    cuda_check(cudaGetLastError(), "Launch direct pixel kernel");
    cuda_check(cudaDeviceSynchronize(), "Wait for direct pixel kernel");
    int error_flag = 0;
    cuda_check(cudaMemcpy(&error_flag, device_error.get(), sizeof(int), cudaMemcpyDeviceToHost), "Read pixel decoder error flag");
    if (error_flag != 0) {
        throw std::runtime_error("Invalid DCT component profile");
    }
    std::array<uint8_t, 4> rgba{};
    cuda_check(cudaMemcpy(rgba.data(), device_rgba.get(), rgba.size(), cudaMemcpyDeviceToHost), "Download direct pixel");
    return rgba;
}

std::vector<uint8_t> read_binary_file(const std::string &path) {
    std::ifstream input(path, std::ios::binary | std::ios::ate);
    if (!input) {
        throw std::runtime_error("Could not open input file: " + path);
    }
    const std::streamsize length = input.tellg();
    if (length < 0) {
        throw std::runtime_error("Could not measure input file: " + path);
    }
    std::vector<uint8_t> bytes(static_cast<size_t>(length));
    input.seekg(0, std::ios::beg);
    if (length != 0 && !input.read(reinterpret_cast<char *>(bytes.data()), length)) {
        throw std::runtime_error("Could not read input file: " + path);
    }
    return bytes;
}

void write_binary_file(const std::string &path, const std::vector<uint8_t> &bytes) {
    std::ofstream output(path, std::ios::binary);
    if (!output || !output.write(reinterpret_cast<const char *>(bytes.data()), static_cast<std::streamsize>(bytes.size()))) {
        throw std::runtime_error("Could not write output file: " + path);
    }
}

void write_ppm(const std::string &path, const std::vector<uint8_t> &rgb, uint32_t width, uint32_t height) {
    std::ofstream output(path, std::ios::binary);
    if (!output) {
        throw std::runtime_error("Could not open output PPM: " + path);
    }
    output << "P6\n" << width << ' ' << height << "\n255\n";
    output.write(reinterpret_cast<const char *>(rgb.data()), static_cast<std::streamsize>(rgb.size()));
    if (!output) {
        throw std::runtime_error("Could not write output PPM: " + path);
    }
}

std::vector<uint8_t> load_image_rgb(const std::string &path, uint32_t *width, uint32_t *height) {
    int image_width = 0;
    int image_height = 0;
    int source_channels = 0;
    stbi_uc *pixels = stbi_load(path.c_str(), &image_width, &image_height, &source_channels, STBI_rgb);
    if (pixels == nullptr) {
        const char *reason = stbi_failure_reason();
        throw std::runtime_error(std::string("Could not load image: ") + (reason != nullptr ? reason : "unknown error"));
    }
    if (image_width <= 0 || image_height <= 0) {
        stbi_image_free(pixels);
        throw std::runtime_error("Input image has invalid dimensions");
    }
    const uint64_t pixel_count = static_cast<uint64_t>(image_width) * image_height;
    if (pixel_count > (UINT32_MAX / 3u)) {
        stbi_image_free(pixels);
        throw std::runtime_error("Input image is too large");
    }
    std::vector<uint8_t> rgb(static_cast<size_t>(pixel_count) * 3u);
    std::copy(pixels, pixels + rgb.size(), rgb.begin());
    stbi_image_free(pixels);
    *width = static_cast<uint32_t>(image_width);
    *height = static_cast<uint32_t>(image_height);
    return rgb;
}

uint64_t squared_error(const std::vector<uint8_t> &left, const std::vector<uint8_t> &right) {
    if (left.size() != right.size()) {
        throw std::runtime_error("Cannot compare images with different dimensions");
    }
    uint64_t error = 0u;
    for (size_t index = 0; index < left.size(); ++index) {
        const int difference = static_cast<int>(left[index]) - right[index];
        error += static_cast<uint64_t>(difference * difference);
    }
    return error;
}

double psnr_from_error(uint64_t error, uint64_t sample_count) {
    if (error == 0u) {
        return std::numeric_limits<double>::infinity();
    }
    const double mse = static_cast<double>(error) / static_cast<double>(sample_count);
    return 10.0 * std::log10((255.0 * 255.0) / mse);
}

uint32_t parse_u32(const std::string &text, const char *label) {
    size_t parsed = 0u;
    unsigned long value = 0u;
    try {
        value = std::stoul(text, &parsed, 10);
    } catch (...) {
        throw std::runtime_error(std::string("Invalid ") + label + ": " + text);
    }
    if (parsed != text.size() || value > UINT32_MAX) {
        throw std::runtime_error(std::string("Invalid ") + label + ": " + text);
    }
    return static_cast<uint32_t>(value);
}

int parse_device(const std::string &text) {
    const uint32_t value = parse_u32(text, "CUDA device");
    if (value > static_cast<uint32_t>(INT_MAX)) {
        throw std::runtime_error("CUDA device ordinal is too large");
    }
    return static_cast<int>(value);
}

cudaDeviceProp select_device(int ordinal) {
    int count = 0;
    cuda_check(cudaGetDeviceCount(&count), "Enumerate CUDA devices");
    if (ordinal < 0 || ordinal >= count) {
        throw std::runtime_error("CUDA device ordinal is outside the available range");
    }
    cuda_check(cudaSetDevice(ordinal), "Select CUDA device");
    cudaDeviceProp properties{};
    cuda_check(cudaGetDeviceProperties(&properties, ordinal), "Query CUDA device");
    cuda_check(cudaFree(nullptr), "Initialize CUDA context");
    initialize_device_tables();
    return properties;
}

void print_usage(const char *program) {
    std::fprintf(
        stderr,
        "Usage:\n"
        "  %s encode INPUT_IMAGE OUTPUT.dctbs2 [options]\n"
        "  %s decode INPUT.dctbs2 OUTPUT.ppm [--device N]\n"
        "  %s pixel INPUT.dctbs2 X Y [--device N]\n"
        "  %s info INPUT.dctbs2\n"
        "  %s presets\n"
        "  %s --version\n\n"
        "Encode options:\n"
        "  --preset BPP       0.75, 1, 1.5, 2, 3, 4.5, or 6 (default 1.5)\n"
        "  --quality N        Quantization quality 1..100 (default 72)\n"
        "  --find-quality     Search CUDA candidates and maximize RGB PSNR\n"
        "  --find-settings    Alias for --find-quality\n"
        "  --device N         CUDA device ordinal (default 0)\n\n"
        "Images: JPEG, PNG, TGA, BMP, PSD, GIF, HDR, PIC, and binary PNM.\n"
        "Decode output is binary PPM P6. The pixel command uploads only one MCU record.\n",
        program, program, program, program, program, program
    );
}

int command_presets(int argc) {
    if (argc != 2) {
        throw std::runtime_error("The presets command does not accept arguments");
    }
    std::cout << "bpp\tbytes/MCU\tY\tCb\tCr\n";
    for (uint32_t units : PRESET_UNITS) {
        Preset preset;
        make_balanced_preset(units, &preset);
        std::cout << preset.nominal_bpp << '\t' << preset.bytes_per_mcu << '\t'
                  << preset.y_bytes << '\t' << preset.cb_bytes << '\t'
                  << preset.cr_bytes << '\n';
    }
    return 0;
}

int print_version() {
    int runtime_version = 0;
    int count = 0;
    cuda_check(cudaRuntimeGetVersion(&runtime_version), "Query CUDA runtime");
    cuda_check(cudaGetDeviceCount(&count), "Enumerate CUDA devices");
    std::cout << "dctcuda DCTBS2 v" << DCT_VERSION << ", CUDA runtime "
              << runtime_version / 1000 << '.' << (runtime_version % 1000) / 10
              << ", " << count << " device(s)\n";
    for (int device = 0; device < count; ++device) {
        cudaDeviceProp properties{};
        if (cudaGetDeviceProperties(&properties, device) == cudaSuccess) {
            std::cout << "  [" << device << "] " << properties.name
                      << " (SM " << properties.major << '.' << properties.minor << ")\n";
        }
    }
    return 0;
}

int command_encode(int argc, char **argv) {
    if (argc < 4) {
        print_usage(argv[0]);
        return 2;
    }
    Preset preset;
    make_balanced_preset(12u, &preset);
    uint32_t quality = 72u;
    bool find_quality = false;
    int device = 0;
    for (int index = 4; index < argc; ++index) {
        const std::string option = argv[index];
        if (option == "--preset" && index + 1 < argc) {
            if (!parse_preset_name(argv[++index], &preset)) {
                throw std::runtime_error("Preset must be 0.75, 1, 1.5, 2, 3, 4.5, or 6");
            }
        } else if (option == "--quality" && index + 1 < argc) {
            quality = parse_u32(argv[++index], "quality");
            if (quality < 1u || quality > 100u) {
                throw std::runtime_error("Quality must be from 1 through 100");
            }
        } else if (option == "--find-quality" || option == "--find-settings") {
            find_quality = true;
        } else if (option == "--device" && index + 1 < argc) {
            device = parse_device(argv[++index]);
        } else {
            throw std::runtime_error("Unknown or incomplete option: " + option);
        }
    }

    uint32_t width = 0u;
    uint32_t height = 0u;
    const std::vector<uint8_t> rgb = load_image_rgb(argv[2], &width, &height);
    const auto wall_started = std::chrono::steady_clock::now();
    const cudaDeviceProp properties = select_device(device);
    GpuResult selected;
    GpuResult selected_decoded;
    uint64_t selected_error = UINT64_MAX;
    uint32_t candidate_count = 0u;

    if (find_quality) {
        std::vector<uint32_t> tested;
        uint32_t coarse_best = quality;
        uint64_t coarse_error = UINT64_MAX;
        for (uint32_t candidate = 20u; candidate <= 95u; candidate += 5u) {
            GpuResult encoded = encode_gpu(rgb, width, height, preset, candidate, true, 0u);
            const DctInfo info = inspect_file(encoded.bytes);
            GpuResult decoded = decode_gpu(encoded.bytes, info);
            const uint64_t error = squared_error(rgb, decoded.bytes);
            const double psnr = psnr_from_error(error, static_cast<uint64_t>(width) * height * 3u);
            std::cerr << "  quality " << candidate << ": PSNR " << std::fixed
                      << std::setprecision(4) << psnr << " dB\n";
            tested.push_back(candidate);
            if (error < coarse_error || (error == coarse_error && candidate > coarse_best)) {
                coarse_error = error;
                coarse_best = candidate;
            }
            if (error < selected_error || (error == selected_error && candidate > quality)) {
                selected_error = error;
                quality = candidate;
            }
        }
        const uint32_t refine_start = coarse_best > 4u ? coarse_best - 4u : 1u;
        const uint32_t refine_end = std::min(100u, coarse_best + 4u);
        for (uint32_t candidate = refine_start; candidate <= refine_end; ++candidate) {
            if (std::find(tested.begin(), tested.end(), candidate) != tested.end()) {
                continue;
            }
            GpuResult encoded = encode_gpu(rgb, width, height, preset, candidate, true, 0u);
            const DctInfo info = inspect_file(encoded.bytes);
            GpuResult decoded = decode_gpu(encoded.bytes, info);
            const uint64_t error = squared_error(rgb, decoded.bytes);
            const double psnr = psnr_from_error(error, static_cast<uint64_t>(width) * height * 3u);
            std::cerr << "  quality " << candidate << ": PSNR " << std::fixed
                      << std::setprecision(4) << psnr << " dB\n";
            tested.push_back(candidate);
            if (error < selected_error || (error == selected_error && candidate > quality)) {
                selected_error = error;
                quality = candidate;
            }
        }
        candidate_count = static_cast<uint32_t>(tested.size());
        selected = encode_gpu(rgb, width, height, preset, quality, true, candidate_count);
        const DctInfo info = inspect_file(selected.bytes);
        selected_decoded = decode_gpu(selected.bytes, info);
        selected_error = squared_error(rgb, selected_decoded.bytes);
    } else {
        selected = encode_gpu(rgb, width, height, preset, quality, false, 0u);
        const DctInfo info = inspect_file(selected.bytes);
        selected_decoded = decode_gpu(selected.bytes, info);
        selected_error = squared_error(rgb, selected_decoded.bytes);
    }

    write_binary_file(argv[3], selected.bytes);
    const double wall_ms = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - wall_started
    ).count();
    const double actual_bpp = static_cast<double>(selected.bytes.size() * 8u) /
        static_cast<double>(static_cast<uint64_t>(width) * height);
    const double psnr = psnr_from_error(selected_error, static_cast<uint64_t>(width) * height * 3u);
    std::cout << "Encoded DCTBS2 " << width << 'x' << height
              << ": preset " << preset.nominal_bpp << " bpp, quality " << quality;
    if (find_quality) {
        std::cout << " (auto, " << candidate_count << " candidates)";
    }
    std::cout << ", " << selected.bytes.size() << " bytes, " << std::fixed
              << std::setprecision(3) << actual_bpp << " actual bpp, PSNR "
              << std::setprecision(4) << psnr << " dB\n"
              << "CUDA encode kernels " << std::setprecision(3) << selected.kernel_ms
              << " ms, decode kernel " << selected_decoded.kernel_ms
              << " ms, wall " << wall_ms << " ms, device " << properties.name << '\n';
    return 0;
}

int command_decode(int argc, char **argv) {
    if (argc < 4) {
        print_usage(argv[0]);
        return 2;
    }
    int device = 0;
    for (int index = 4; index < argc; ++index) {
        const std::string option = argv[index];
        if (option == "--device" && index + 1 < argc) {
            device = parse_device(argv[++index]);
        } else {
            throw std::runtime_error("Unknown or incomplete option: " + option);
        }
    }
    const std::vector<uint8_t> file = read_binary_file(argv[2]);
    const DctInfo info = inspect_file(file);
    const cudaDeviceProp properties = select_device(device);
    const GpuResult decoded = decode_gpu(file, info);
    write_ppm(argv[3], decoded.bytes, info.width, info.height);
    std::cout << "Decoded DCTBS2 " << info.width << 'x' << info.height
              << ": preset " << info.preset.nominal_bpp << " bpp, quality " << info.quality
              << ", CUDA kernel " << std::fixed << std::setprecision(3)
              << decoded.kernel_ms << " ms, device " << properties.name << '\n';
    return 0;
}

int command_pixel(int argc, char **argv) {
    if (argc < 5) {
        print_usage(argv[0]);
        return 2;
    }
    const uint32_t x = parse_u32(argv[3], "x coordinate");
    const uint32_t y = parse_u32(argv[4], "y coordinate");
    int device = 0;
    for (int index = 5; index < argc; ++index) {
        const std::string option = argv[index];
        if (option == "--device" && index + 1 < argc) {
            device = parse_device(argv[++index]);
        } else {
            throw std::runtime_error("Unknown or incomplete option: " + option);
        }
    }
    std::ifstream file(argv[2], std::ios::binary | std::ios::ate);
    if (!file) {
        throw std::runtime_error(std::string("Could not open input file: ") + argv[2]);
    }
    const std::streamoff measured_size = file.tellg();
    if (measured_size < static_cast<std::streamoff>(HEADER_BYTES)) {
        throw std::runtime_error("Invalid or truncated DCTBS2 file");
    }
    const uint64_t file_size = static_cast<uint64_t>(measured_size);
    std::array<uint8_t, HEADER_BYTES> header{};
    file.seekg(0, std::ios::beg);
    if (!file.read(reinterpret_cast<char *>(header.data()), header.size())) {
        throw std::runtime_error("Could not read DCTBS2 header");
    }
    const DctInfo info = inspect_header(header.data(), file_size);
    if (x >= info.width || y >= info.height) {
        throw std::runtime_error("Pixel coordinate is outside the image");
    }
    const uint32_t mcu_index = (y / 16u) * info.mcu_columns + (x / 16u);
    const size_t offset = HEADER_BYTES + static_cast<size_t>(mcu_index) * info.preset.bytes_per_mcu;
    std::vector<uint8_t> record(info.preset.bytes_per_mcu);
    file.seekg(static_cast<std::streamoff>(offset), std::ios::beg);
    if (!file.read(reinterpret_cast<char *>(record.data()), record.size())) {
        throw std::runtime_error("Could not read DCTBS2 MCU record");
    }
    select_device(device);
    const std::array<uint8_t, 4> rgba = sample_pixel_gpu(record, info, x, y);
    std::cout << "RGBA(" << x << ',' << y << ") = "
              << static_cast<unsigned int>(rgba[0]) << ' '
              << static_cast<unsigned int>(rgba[1]) << ' '
              << static_cast<unsigned int>(rgba[2]) << ' '
              << static_cast<unsigned int>(rgba[3]) << '\n'
              << "MCU " << mcu_index << ", byte offset " << offset
              << ", uploaded " << info.preset.bytes_per_mcu << " bytes\n";
    return 0;
}

int command_info(int argc, char **argv) {
    if (argc != 3) {
        print_usage(argv[0]);
        return 2;
    }
    const std::vector<uint8_t> file = read_binary_file(argv[2]);
    const DctInfo info = inspect_file(file);
    const double actual_bpp = static_cast<double>(file.size() * 8u) /
        static_cast<double>(static_cast<uint64_t>(info.width) * info.height);
    std::cout << "DCTBS2 v" << DCT_VERSION << ' ' << info.width << 'x' << info.height
              << ", preset " << info.preset.nominal_bpp << " bpp, quality " << info.quality
              << ", " << info.mcu_columns << 'x' << info.mcu_rows << " MCUs, "
              << info.preset.bytes_per_mcu << " bytes/MCU, " << file.size()
              << " bytes, " << std::fixed << std::setprecision(3) << actual_bpp
              << " actual bpp";
    if (info.auto_quality) {
        std::cout << ", auto quality (" << info.search_candidate_count << " candidates)";
    }
    std::cout << '\n';
    return 0;
}

}  // namespace

int main(int argc, char **argv) {
    try {
        if (argc == 2 && std::strcmp(argv[1], "--version") == 0) {
            return print_version();
        }
        if (argc < 2) {
            print_usage(argv[0]);
            return 2;
        }
        const std::string command = argv[1];
        if (command == "encode") {
            return command_encode(argc, argv);
        }
        if (command == "decode") {
            return command_decode(argc, argv);
        }
        if (command == "pixel") {
            return command_pixel(argc, argv);
        }
        if (command == "info") {
            return command_info(argc, argv);
        }
        if (command == "presets") {
            return command_presets(argc);
        }
        print_usage(argv[0]);
        return 2;
    } catch (const std::exception &error) {
        std::cerr << "dctcuda: " << error.what() << '\n';
        return 1;
    }
}
