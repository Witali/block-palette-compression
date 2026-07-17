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
constexpr uint32_t FLAG_DCT_LIBRARY = 4u;
constexpr uint32_t FLAG_CHROMA_420 = 8u;
constexpr uint32_t FLAG_ZIGZAG_ORDER = 16u;
constexpr uint32_t COEFFICIENT_CODING_SHIFT = 8u;
constexpr uint32_t COEFFICIENT_CODING_MASK = 15u << COEFFICIENT_CODING_SHIFT;
constexpr uint32_t SUPPORTED_FLAGS = FLAG_AUTO_QUALITY | FLAG_SPLIT_LUMA_8X8 |
    FLAG_DCT_LIBRARY | FLAG_CHROMA_420 | FLAG_ZIGZAG_ORDER | COEFFICIENT_CODING_MASK;
constexpr int COEFFICIENT_CODING_LEGACY = 0;
constexpr int COEFFICIENT_CODING_GROUPED_EQUAL_2 = 1;
constexpr int COEFFICIENT_CODING_GROUPED_FRONT = 2;
constexpr int COEFFICIENT_CODING_SKIP_RLE_EQUAL_2 = 3;
constexpr int COEFFICIENT_CODING_DUAL_SKIP_EQUAL_2 = 4;
constexpr int COEFFICIENT_CODING_DUAL_SKIP_FRONT = 5;
constexpr int COEFFICIENT_CODING_MASKED_TAIL_8X8 = 6;
constexpr int COEFFICIENT_CODING_MASKED_TAIL_IMPLICIT2_48 = 7;
constexpr size_t HEADER_BYTES = 64u;
constexpr size_t LIBRARY_HEADER_BYTES = 32u;
constexpr uint32_t LIBRARY_VERSION_TAIL_REFERENCE = 1u;
constexpr uint32_t LIBRARY_VERSION_HEADER_REFERENCE = 2u;
constexpr uint32_t LIBRARY_VERSION_SPECTRAL_QUARTER = 3u;
constexpr uint32_t LIBRARY_VERSION_SPECTRAL_HALF = 4u;
constexpr uint32_t LIBRARY_VERSION_SPECTRAL_FULL = 5u;
constexpr uint32_t LIBRARY_VERSION_SIDECAR_REFERENCE = 6u;
constexpr uint32_t LIBRARY_VERSION_SIDECAR_SPECTRAL_QUARTER = 7u;
constexpr uint32_t LIBRARY_VERSION_SIDECAR_SPECTRAL_HALF = 8u;
constexpr uint32_t LIBRARY_VERSION_SIDECAR_SPECTRAL_FULL = 9u;
constexpr int MCU_WIDTH = 16;
constexpr int MCU_HEIGHT = 16;
constexpr int CUDA_THREADS = 256;
constexpr std::array<uint32_t, 9> PRESET_UNITS{{
    6u, 8u, 12u, 16u, 24u, 36u, 48u, 60u, 72u
}};
constexpr std::array<uint8_t, 8> MAGIC{{0x44, 0x43, 0x54, 0x42, 0x53, 0x32, 0x00, 0x00}};
constexpr std::array<uint8_t, 8> LIBRARY_MAGIC{{0x44, 0x43, 0x54, 0x4c, 0x49, 0x42, 0x31, 0x00}};

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
__constant__ int DEVICE_ZIGZAG_Y[255];
__constant__ int DEVICE_ZIGZAG_8[63];
__constant__ int DEVICE_ZIGZAG_C[127];
__constant__ int DEVICE_SKIP_SCAN_Y[8 * 255];
__constant__ int DEVICE_SKIP_SCAN_8[8 * 63];
__constant__ int DEVICE_SKIP_SCAN_C[8 * 127];
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
    bool chroma_420 = false;
    bool zigzag_order = false;
    bool library_enabled = false;
    int coefficient_coding = COEFFICIENT_CODING_LEGACY;
    uint32_t search_candidate_count = 0;
    uint32_t payload_bytes = 0;
    uint32_t library_bytes = 0;
    uint32_t library_version = 0;
    uint32_t y_library_count = 0;
    uint32_t cb_library_count = 0;
    uint32_t cr_library_count = 0;
    uint32_t y_library_offset = 0;
    uint32_t cb_library_offset = 0;
    uint32_t cr_library_offset = 0;
    uint32_t y_library_record_bytes = 0;
    uint32_t y_reference_offset = 0;
    uint32_t cb_reference_offset = 0;
    uint32_t cr_reference_offset = 0;
    uint32_t y_reference_bits = 0;
    uint32_t cb_reference_bits = 0;
    uint32_t cr_reference_bits = 0;
};

struct DctLibraryLayout {
    uint32_t version = 0;
    uint32_t y_count = 0;
    uint32_t cb_count = 0;
    uint32_t cr_count = 0;
    uint32_t y_offset = 0;
    uint32_t cb_offset = 0;
    uint32_t cr_offset = 0;
    uint32_t y_record_bytes = 0;
    uint32_t y_reference_offset = 0;
    uint32_t cb_reference_offset = 0;
    uint32_t cr_reference_offset = 0;
    uint32_t y_reference_bits = 0;
    uint32_t cb_reference_bits = 0;
    uint32_t cr_reference_bits = 0;
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
    if (preset.mode_code == 750u) {
        return COEFFICIENT_CODING_SKIP_RLE_EQUAL_2;
    }
    if (preset.mode_code == 1000u || preset.mode_code == 2000u) {
        return COEFFICIENT_CODING_DUAL_SKIP_EQUAL_2;
    }
    if (preset.mode_code == 1500u || preset.mode_code == 3000u ||
        preset.mode_code == 4500u) {
        return COEFFICIENT_CODING_DUAL_SKIP_FRONT;
    }
    return COEFFICIENT_CODING_GROUPED_FRONT;
}

std::vector<Preset> component_budget_presets(
    const Preset &base,
    const std::string &mode
) {
    std::vector<Preset> result{base};
    if (mode == "fixed" || base.nominal_bpp > 3.0) {
        return result;
    }
    std::vector<uint32_t> chroma_budgets;
    if (mode == "fast") {
        if (base.mode_code == 3000u) chroma_budgets = {6u, 12u, 20u};
        else if (base.mode_code == 2000u) chroma_budgets = {6u, 5u};
        else if (base.mode_code == 1500u) chroma_budgets = {5u, 4u};
        else if (base.mode_code == 1000u) chroma_budgets = {5u, 4u};
        else if (base.mode_code == 750u) chroma_budgets = {4u, 3u};
    } else if (mode == "expanded") {
        if (base.mode_code == 3000u) chroma_budgets = {4u, 6u, 8u, 10u, 12u, 14u, 16u, 18u, 20u, 22u, 24u};
        else if (base.mode_code == 2000u) chroma_budgets = {3u, 4u, 5u, 6u, 7u, 8u, 9u, 10u};
        else if (base.mode_code == 1500u) chroma_budgets = {4u, 5u, 6u, 7u, 8u, 9u};
        else if (base.mode_code == 1000u) chroma_budgets = {3u, 4u, 5u, 6u, 7u, 8u};
        else if (base.mode_code == 750u) chroma_budgets = {3u, 4u, 5u, 6u};
    } else {
        throw std::runtime_error("Component budget must be fixed, fast, or expanded");
    }
    for (const uint32_t chroma_bytes : chroma_budgets) {
        Preset candidate = base;
        candidate.y_bytes = base.bytes_per_mcu - chroma_bytes * 2u;
        candidate.cb_bytes = chroma_bytes;
        candidate.cr_bytes = chroma_bytes;
        const uint32_t y_record_bytes = candidate.nominal_bpp >= 3.0
            ? candidate.y_bytes / 4u : candidate.y_bytes;
        if (y_record_bytes < 3u || candidate.cb_bytes < 3u ||
            (candidate.nominal_bpp >= 3.0 && candidate.y_bytes % 4u != 0u)) {
            continue;
        }
        const bool duplicate = std::any_of(result.begin(), result.end(), [&](const Preset &item) {
            return item.y_bytes == candidate.y_bytes && item.cb_bytes == candidate.cb_bytes &&
                item.cr_bytes == candidate.cr_bytes;
        });
        if (!duplicate) result.push_back(candidate);
    }
    return result;
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

template <int WIDTH, int HEIGHT>
std::array<int, WIDTH * HEIGHT - 1> make_zigzag_scan() {
    std::array<int, WIDTH * HEIGHT - 1> output{};
    int index = 0;
    for (int diagonal = 0; diagonal <= WIDTH + HEIGHT - 2; ++diagonal) {
        const int minimum_u = std::max(0, diagonal - HEIGHT + 1);
        const int maximum_u = std::min(WIDTH - 1, diagonal);
        if ((diagonal & 1) == 0) {
            for (int u = minimum_u; u <= maximum_u; ++u) {
                const int v = diagonal - u;
                if (u != 0 || v != 0) output[index++] = v * WIDTH + u;
            }
        } else {
            for (int u = maximum_u; u >= minimum_u; --u) {
                const int v = diagonal - u;
                if (u != 0 || v != 0) output[index++] = v * WIDTH + u;
            }
        }
    }
    return output;
}

double skip_scan_score(int profile, double u, double v) {
    const double radius = std::sqrt(u * u + v * v);
    if (profile == 1) return 0.22 * u * u + 2.1 * v * v;
    if (profile == 2) return 2.1 * u * u + 0.22 * v * v;
    if (profile == 3) {
        return std::min(0.18 * u * u + 2.4 * v * v, 2.4 * u * u + 0.18 * v * v);
    }
    if (profile == 4) return 0.72 * radius * radius + 1.35 * std::abs(u - v);
    if (profile == 5) {
        return 0.72 * radius * radius + 0.55 * std::min(u, v) + 0.08 * std::abs(u - v);
    }
    if (profile == 6) return std::abs(radius - 0.34) + 0.18 * radius;
    if (profile == 7) return std::abs(radius - 0.52) + 0.10 * std::min(u, v);
    return radius * radius;
}

template <int WIDTH, int HEIGHT>
std::array<int, 8 * (WIDTH * HEIGHT - 1)> make_skip_scans() {
    constexpr int COUNT = WIDTH * HEIGHT - 1;
    std::array<int, 8 * COUNT> output{};
    for (int profile = 0; profile < 8; ++profile) {
        std::vector<int> positions;
        positions.reserve(COUNT);
        for (int v = 0; v < HEIGHT; ++v) {
            for (int u = 0; u < WIDTH; ++u) {
                if (u != 0 || v != 0) positions.push_back(v * WIDTH + u);
            }
        }
        std::sort(positions.begin(), positions.end(), [profile](int left, int right) {
            const int left_u = left % WIDTH;
            const int left_v = left / WIDTH;
            const int right_u = right % WIDTH;
            const int right_v = right / WIDTH;
            const double left_score = skip_scan_score(
                profile,
                static_cast<double>(left_u) / static_cast<double>(WIDTH - 1),
                static_cast<double>(left_v) / static_cast<double>(HEIGHT - 1)
            );
            const double right_score = skip_scan_score(
                profile,
                static_cast<double>(right_u) / static_cast<double>(WIDTH - 1),
                static_cast<double>(right_v) / static_cast<double>(HEIGHT - 1)
            );
            if (left_score != right_score) return left_score < right_score;
            if (left_u + left_v != right_u + right_v) {
                return left_u + left_v < right_u + right_v;
            }
            if (left_v != right_v) return left_v < right_v;
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
    const auto zigzag_y = make_zigzag_scan<16, 16>();
    const auto zigzag_8 = make_zigzag_scan<8, 8>();
    const auto zigzag_c = make_zigzag_scan<8, 16>();
    const auto skip_scans_y = make_skip_scans<16, 16>();
    const auto skip_scans_8 = make_skip_scans<8, 8>();
    const auto skip_scans_c = make_skip_scans<8, 16>();
    cuda_check(cudaMemcpyToSymbol(DEVICE_BASIS_16, basis16.data(), sizeof(basis16)), "Upload 16-point DCT basis");
    cuda_check(cudaMemcpyToSymbol(DEVICE_BASIS_8, basis8.data(), sizeof(basis8)), "Upload 8-point DCT basis");
    cuda_check(cudaMemcpyToSymbol(DEVICE_SCAN_Y, scans_y.data(), sizeof(scans_y)), "Upload luma scans");
    cuda_check(cudaMemcpyToSymbol(DEVICE_SCAN_8, scans_8.data(), sizeof(scans_8)), "Upload 8x8 scans");
    cuda_check(cudaMemcpyToSymbol(DEVICE_SCAN_C, scans_c.data(), sizeof(scans_c)), "Upload chroma scans");
    cuda_check(cudaMemcpyToSymbol(DEVICE_ZIGZAG_Y, zigzag_y.data(), sizeof(zigzag_y)), "Upload luma zigzag");
    cuda_check(cudaMemcpyToSymbol(DEVICE_ZIGZAG_8, zigzag_8.data(), sizeof(zigzag_8)), "Upload 8x8 zigzag");
    cuda_check(cudaMemcpyToSymbol(DEVICE_ZIGZAG_C, zigzag_c.data(), sizeof(zigzag_c)), "Upload chroma zigzag");
    cuda_check(cudaMemcpyToSymbol(
        DEVICE_SKIP_SCAN_Y, skip_scans_y.data(), sizeof(skip_scans_y)
    ), "Upload luma skip scans");
    cuda_check(cudaMemcpyToSymbol(
        DEVICE_SKIP_SCAN_8, skip_scans_8.data(), sizeof(skip_scans_8)
    ), "Upload 8x8 skip scans");
    cuda_check(cudaMemcpyToSymbol(
        DEVICE_SKIP_SCAN_C, skip_scans_c.data(), sizeof(skip_scans_c)
    ), "Upload chroma skip scans");
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

// Keep this lookup out of the already large codec kernels. CUDA 13.3's sm_120
// optimizer can overflow its own stack when the three table branches are
// force-inlined through every grouped, skip, and masked-tail loop.
__device__ __noinline__ int zigzag_position(int width, int height, int index) {
    if (width == 16) return DEVICE_ZIGZAG_Y[index];
    return height == 8 ? DEVICE_ZIGZAG_8[index] : DEVICE_ZIGZAG_C[index];
}

__device__ __forceinline__ int scan_position(
    int width,
    int height,
    int profile,
    int index,
    bool zigzag_order
) {
    if (zigzag_order) {
        if (profile == 0) return zigzag_position(width, height, index);
        --profile;
    }
    if (width == 16) {
        return DEVICE_SCAN_Y[profile * 255 + index];
    }
    return height == 8
        ? DEVICE_SCAN_8[profile * 63 + index]
        : DEVICE_SCAN_C[profile * 127 + index];
}

__device__ __forceinline__ int skip_scan_position(
    int width,
    int height,
    int profile,
    int index,
    bool zigzag_order
) {
    if (zigzag_order) {
        if (profile == 0) return zigzag_position(width, height, index);
        --profile;
    }
    if (width == 16) {
        return DEVICE_SKIP_SCAN_Y[profile * 255 + index];
    }
    return height == 8
        ? DEVICE_SKIP_SCAN_8[profile * 63 + index]
        : DEVICE_SKIP_SCAN_C[profile * 127 + index];
}

__device__ __forceinline__ int coefficient_order_position(
    int width,
    int height,
    int rank,
    bool zigzag_order
) {
    return zigzag_order && rank > 0 ? zigzag_position(width, height, rank - 1) : rank;
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

// Candidate encoders are invoked once per component. Keeping them as device
// calls prevents the runtime coding dispatcher from expanding every complete
// implementation into one enormous sm_120 kernel.
template <int WIDTH, int HEIGHT, bool CHROMA>
__device__ __noinline__ void encode_legacy_component_record(
    const double *coefficients,
    uint8_t *record,
    int byte_count,
    int quality,
    bool zigzag_order
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

    for (int profile = 0; profile < (zigzag_order ? 5 : 4); ++profile) {
        for (int scale_index = 0; scale_index < 8; ++scale_index) {
            const int scale = 1 << scale_index;
            const double dc_step = quantization_step(0, 0, WIDTH, HEIGHT, quality, CHROMA) * scale;
            const int dc = clamp_int(round_signed(coefficients[0] / dc_step), -512, 511);
            const double restored_dc = static_cast<double>(dc) * dc_step;
            double error = base_error;
            error = rn_add(error, rn_square(coefficients[0] - restored_dc));
            error = rn_add(error, -rn_square(coefficients[0]));

            for (int index = 0; index < ac_count; ++index) {
                const int position = scan_position(WIDTH, HEIGHT, profile, index, zigzag_order);
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
        const int position = scan_position(
            WIDTH, HEIGHT, best_profile, index, zigzag_order
        );
        const int u = position % WIDTH;
        const int v = position / WIDTH;
        const double step = quantization_step(u, v, WIDTH, HEIGHT, quality, CHROMA) * scale;
        const int stored = clamp_int(round_signed(coefficients[position] / step), -32, 31);
        write_signed_bits(record, &bit_offset, stored, 6);
    }
}

__device__ int grouped_count(int coefficient_coding) {
    return coefficient_coding == COEFFICIENT_CODING_GROUPED_EQUAL_2 ||
        coefficient_coding == COEFFICIENT_CODING_SKIP_RLE_EQUAL_2 ||
        coefficient_coding == COEFFICIENT_CODING_DUAL_SKIP_EQUAL_2 ? 2 : 3;
}

__device__ void write_signed_bits_lsb(
    uint8_t *record,
    int *bit_offset,
    int value,
    int bit_count
) {
    const uint32_t encoded = value < 0
        ? static_cast<uint32_t>(value + (1 << bit_count))
        : static_cast<uint32_t>(value);
    for (int bit = 0; bit < bit_count; ++bit) {
        const int absolute_bit = *bit_offset + bit;
        record[absolute_bit >> 3] |= static_cast<uint8_t>(
            ((encoded >> bit) & 1u) << (absolute_bit & 7)
        );
    }
    *bit_offset += bit_count;
}

__device__ void write_bits_lsb(
    uint8_t *record,
    int *bit_offset,
    uint32_t value,
    int bit_count
) {
    for (int bit = 0; bit < bit_count; ++bit) {
        const int absolute_bit = *bit_offset + bit;
        record[absolute_bit >> 3] |= static_cast<uint8_t>(
            ((value >> bit) & 1u) << (absolute_bit & 7)
        );
    }
    *bit_offset += bit_count;
}

__device__ uint32_t read_bits_lsb(
    const uint8_t *record,
    int *bit_offset,
    int bit_count
) {
    uint32_t value = 0u;
    for (int bit = 0; bit < bit_count; ++bit) {
        const int absolute_bit = *bit_offset + bit;
        value |= static_cast<uint32_t>(
            (record[absolute_bit >> 3] >> (absolute_bit & 7)) & 1u
        ) << bit;
    }
    *bit_offset += bit_count;
    return value;
}

__device__ int read_signed_bits_lsb(
    const uint8_t *record,
    int *bit_offset,
    int bit_count
) {
    const uint32_t value = read_bits_lsb(record, bit_offset, bit_count);
    const uint32_t sign_bit = 1u << (bit_count - 1);
    return (value & sign_bit) != 0u
        ? static_cast<int>(value) - (1 << bit_count)
        : static_cast<int>(value);
}

__device__ bool masked_tail_config(
    int byte_count,
    int *dc_bits,
    int *ac_bits,
    int *max_ac
) {
    if (byte_count == 16) {
        *dc_bits = 10; *ac_bits = 6; *max_ac = 9; return true;
    }
    if (byte_count == 24) {
        *dc_bits = 9; *ac_bits = 7; *max_ac = 17; return true;
    }
    if (byte_count == 32) {
        *dc_bits = 8; *ac_bits = 8; *max_ac = 23; return true;
    }
    if (byte_count == 40) {
        *dc_bits = 8; *ac_bits = 8; *max_ac = 31; return true;
    }
    if (byte_count == 48) {
        *dc_bits = 10; *ac_bits = 8; *max_ac = 38; return true;
    }
    return false;
}

__device__ uint32_t read_u32_little_device(const uint8_t *record) {
    return static_cast<uint32_t>(record[0]) |
        static_cast<uint32_t>(record[1]) << 8u |
        static_cast<uint32_t>(record[2]) << 16u |
        static_cast<uint32_t>(record[3]) << 24u;
}

__device__ void write_u32_little_device(uint8_t *record, uint32_t value) {
    record[0] = static_cast<uint8_t>(value);
    record[1] = static_cast<uint8_t>(value >> 8u);
    record[2] = static_cast<uint8_t>(value >> 16u);
    record[3] = static_cast<uint8_t>(value >> 24u);
}

__device__ bool masked_tail_has_position(uint32_t low, uint32_t high, int position) {
    const int bit = position - 1;
    return bit < 32
        ? ((low >> bit) & 1u) != 0u
        : ((high >> (bit - 32)) & 1u) != 0u;
}

__device__ int grouped_end(int coefficient_coding, int group, int ac_count) {
    if (coefficient_coding == COEFFICIENT_CODING_GROUPED_EQUAL_2 ||
        coefficient_coding == COEFFICIENT_CODING_SKIP_RLE_EQUAL_2 ||
        coefficient_coding == COEFFICIENT_CODING_DUAL_SKIP_EQUAL_2) {
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
__device__ __noinline__ double encode_grouped_component_record(
    const double *coefficients,
    uint8_t *record,
    int byte_count,
    int quality,
    int coefficient_coding,
    bool zigzag_order
) {
    const int group_count = grouped_count(coefficient_coding);
    const int ac_count = min(
        WIDTH * HEIGHT - 1,
        (byte_count * 8 - 18 - group_count * 3) / 5
    );
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
    for (int profile = 0; profile < (zigzag_order ? 5 : 4); ++profile) {
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
                    const int position = scan_position(
                        WIDTH, HEIGHT, profile, index, zigzag_order
                    );
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
            const int position = scan_position(
                WIDTH, HEIGHT, best_profile, index, zigzag_order
            );
            const int u = position % WIDTH;
            const int v = position / WIDTH;
            const double step = quantization_step(u, v, WIDTH, HEIGHT, quality, CHROMA) * scale;
            const int stored = clamp_int(round_signed(coefficients[position] / step), -16, 15);
            write_signed_bits(record, &bit_offset, stored, 5);
        }
        group_start = group_finish;
    }
    return best_error;
}

template <int WIDTH, int HEIGHT>
__device__ int skip_token_count(int byte_count, int coefficient_coding) {
    const int payload_bits = byte_count * 8 - 18;
    if (coefficient_coding == COEFFICIENT_CODING_SKIP_RLE_EQUAL_2) {
        return payload_bits / 8;
    }
    if (byte_count == 32) return 32;
    if (byte_count == 24) return 24;
    if (byte_count == 16) return WIDTH == 16 && HEIGHT == 16 ? 15 : 14;
    int token_count = payload_bits / 7;
    int coarse_count = (token_count + 1) / 2;
    while (coarse_count * 8 + (token_count - coarse_count) * 6 > payload_bits) {
        --token_count;
        coarse_count = (token_count + 1) / 2;
    }
    return token_count;
}

template <int WIDTH, int HEIGHT>
__device__ int skip_coarse_count(int byte_count, int coefficient_coding, int token_count) {
    if (coefficient_coding == COEFFICIENT_CODING_SKIP_RLE_EQUAL_2) return token_count;
    if (byte_count == 32) return 16;
    if (byte_count == 24) return WIDTH == 16 && HEIGHT == 16 ? 12 : 11;
    if (byte_count == 16) return WIDTH == 16 && HEIGHT == 16 ? 7 : 8;
    return (token_count + 1) / 2;
}

template <int WIDTH, int HEIGHT>
__device__ int skip_tail_token_count(int byte_count, int coefficient_coding) {
    const int payload_bits = byte_count * 8 - 18;
    const int token_count = skip_token_count<WIDTH, HEIGHT>(byte_count, coefficient_coding);
    const int coarse_count = skip_coarse_count<WIDTH, HEIGHT>(
        byte_count, coefficient_coding, token_count
    );
    const int spare_bits = payload_bits - coarse_count * 8 - (token_count - coarse_count) * 6;
    int tail_count = 0;
    int tail_bits = 0;
    while (tail_bits + 4 + (tail_count > 0 ? 2 : 0) <= spare_bits) {
        tail_bits += 4 + (tail_count > 0 ? 2 : 0);
        ++tail_count;
    }
    return tail_count;
}

template <int WIDTH, int HEIGHT, bool CHROMA>
__device__ double skip_coefficient_benefit(
    const double *coefficients,
    int position,
    int quality,
    int scale_index,
    int bit_count,
    int *stored_value
) {
    const int u = position % WIDTH;
    const int v = position / WIDTH;
    const double step = quantization_step(u, v, WIDTH, HEIGHT, quality, CHROMA) *
        (1 << scale_index);
    const int minimum = -(1 << (bit_count - 1));
    const int maximum = (1 << (bit_count - 1)) - 1;
    const int stored = clamp_int(round_signed(coefficients[position] / step), minimum, maximum);
    const double restored = static_cast<double>(stored) * step;
    const double delta = rn_add(
        rn_square(coefficients[position] - restored),
        -rn_square(coefficients[position])
    );
    if (delta >= 0.0) {
        *stored_value = 0;
        return 0.0;
    }
    *stored_value = stored;
    return -delta;
}

template <int WIDTH, int HEIGHT, bool CHROMA>
__device__ __noinline__ void encode_skip_component_record(
    const double *coefficients,
    uint8_t *record,
    int byte_count,
    int quality,
    int coefficient_coding,
    double baseline_error,
    bool zigzag_order
) {
    constexpr int MAX_TOKENS = 32;
    constexpr int MAX_TAIL_TOKENS = 8;
    constexpr int MAX_POSITIONS = 256;
    const int token_count = skip_token_count<WIDTH, HEIGHT>(byte_count, coefficient_coding);
    const int coarse_count = skip_coarse_count<WIDTH, HEIGHT>(
        byte_count, coefficient_coding, token_count
    );
    const int tail_count = skip_tail_token_count<WIDTH, HEIGHT>(byte_count, coefficient_coding);
    if (token_count < 1 || token_count > MAX_TOKENS || tail_count > MAX_TAIL_TOKENS) return;

    double base_error = 0.0;
#pragma unroll 1
    for (int position = 0; position < WIDTH * HEIGHT; ++position) {
        base_error = rn_add(base_error, rn_square(coefficients[position]));
    }

    double best_error = baseline_error;
    int best_profile = -1;
    int best_scale_index = 0;
    int best_dc = 0;
    int16_t best_path[MAX_TOKENS];
    int16_t best_tail_path[MAX_TAIL_TOKENS];
    int16_t best_tail_stored[MAX_TAIL_TOKENS];
    int16_t candidate_path[MAX_TOKENS];
    int16_t candidate_tail_path[MAX_TAIL_TOKENS];
    int16_t candidate_tail_stored[MAX_TAIL_TOKENS];
    double previous[MAX_POSITIONS];
    double current[MAX_POSITIONS];
    int16_t back[MAX_TOKENS][MAX_POSITIONS];

// These dynamic-programming loops must remain loops. Fully unrolling the
// 32 x 256 state space makes CUDA 13.3 emit roughly 600k PTX instructions
// for each component specialization and can overflow ptxas on sm_120.
#pragma unroll 1
    for (int profile = 0; profile < (zigzag_order ? 9 : 8); ++profile) {
#pragma unroll 1
        for (int scale_index = 0; scale_index < 8; ++scale_index) {
            const int scale = 1 << scale_index;
            const double dc_step = quantization_step(0, 0, WIDTH, HEIGHT, quality, CHROMA) * scale;
            const int dc = clamp_int(round_signed(coefficients[0] / dc_step), -512, 511);
            const double restored_dc = static_cast<double>(dc) * dc_step;
            const double dc_delta = rn_add(
                rn_square(coefficients[0] - restored_dc),
                -rn_square(coefficients[0])
            );
            const int maximum_index = min(WIDTH * HEIGHT - 2, 4 * (token_count - 1));
#pragma unroll 1
            for (int index = 0; index <= maximum_index; ++index) {
                previous[index] = -DBL_MAX;
            }
            int ignored_stored = 0;
            previous[0] = skip_coefficient_benefit<WIDTH, HEIGHT, CHROMA>(
                coefficients,
                skip_scan_position(WIDTH, HEIGHT, profile, 0, zigzag_order),
                quality,
                scale_index,
                6,
                &ignored_stored
            );

#pragma unroll 1
            for (int token_index = 1; token_index < token_count; ++token_index) {
#pragma unroll 1
                for (int index = 0; index <= maximum_index; ++index) {
                    current[index] = -DBL_MAX;
                    back[token_index][index] = -1;
                }
                const bool fine = coefficient_coding != COEFFICIENT_CODING_SKIP_RLE_EQUAL_2 &&
                    token_index >= coarse_count;
                const int value_bits = fine ? 4 : 6;
                const int value_scale_index = fine ? (scale_index >= 3 ? 1 : 0) : scale_index;
                const int first_index = token_index;
                const int last_index = min(maximum_index, 4 * token_index);
#pragma unroll 1
                for (int index = first_index; index <= last_index; ++index) {
                    double previous_benefit = -DBL_MAX;
                    int previous_index = -1;
                    for (int distance = 1; distance <= 4; ++distance) {
                        const int candidate_index = index - distance;
                        if (candidate_index >= 0 && previous[candidate_index] > previous_benefit) {
                            previous_benefit = previous[candidate_index];
                            previous_index = candidate_index;
                        }
                    }
                    if (previous_index < 0) continue;
                    const double benefit = skip_coefficient_benefit<WIDTH, HEIGHT, CHROMA>(
                        coefficients,
                        skip_scan_position(WIDTH, HEIGHT, profile, index, zigzag_order),
                        quality,
                        value_scale_index,
                        value_bits,
                        &ignored_stored
                    );
                    current[index] = rn_add(previous_benefit, benefit);
                    back[token_index][index] = static_cast<int16_t>(previous_index);
                }
#pragma unroll 1
                for (int index = 0; index <= maximum_index; ++index) {
                    previous[index] = current[index];
                }
            }

            int end_index = 0;
            double total_benefit = -DBL_MAX;
#pragma unroll 1
            for (int index = 0; index <= maximum_index; ++index) {
                if (previous[index] > total_benefit) {
                    total_benefit = previous[index];
                    end_index = index;
                }
            }
            candidate_path[token_count - 1] = static_cast<int16_t>(end_index);
#pragma unroll 1
            for (int token_index = token_count - 1; token_index > 0; --token_index) {
                candidate_path[token_index - 1] = back[token_index][candidate_path[token_index]];
            }

            double tail_benefit = 0.0;
            for (int token_index = 0; token_index < tail_count; ++token_index) {
                candidate_tail_path[token_index] = -1;
                candidate_tail_stored[token_index] = 0;
            }
            if (tail_count > 0) {
                const int tail_scale_index = scale_index >= 3 ? 1 : 0;
                const int scan_length = WIDTH * HEIGHT - 1;
                for (int index = 0; index < scan_length; ++index) {
                    previous[index] = -DBL_MAX;
                    back[0][index] = -1;
                }
                for (int distance = 1; distance <= 4; ++distance) {
                    const int index = end_index + distance;
                    if (index >= scan_length) break;
                    previous[index] = skip_coefficient_benefit<WIDTH, HEIGHT, CHROMA>(
                        coefficients,
                        skip_scan_position(WIDTH, HEIGHT, profile, index, zigzag_order),
                        quality,
                        tail_scale_index,
                        4,
                        &ignored_stored
                    );
                    back[0][index] = static_cast<int16_t>(end_index);
                }
                for (int tail_index = 1; tail_index < tail_count; ++tail_index) {
                    for (int index = 0; index < scan_length; ++index) {
                        current[index] = -DBL_MAX;
                        back[tail_index][index] = -1;
                    }
                    for (int index = 0; index < scan_length; ++index) {
                        double previous_benefit = -DBL_MAX;
                        int previous_index = -1;
                        for (int distance = 1; distance <= 4; ++distance) {
                            const int source_index = index - distance;
                            if (source_index >= 0 && previous[source_index] > previous_benefit) {
                                previous_benefit = previous[source_index];
                                previous_index = source_index;
                            }
                        }
                        if (previous_index < 0) continue;
                        const double benefit = skip_coefficient_benefit<WIDTH, HEIGHT, CHROMA>(
                            coefficients,
                            skip_scan_position(WIDTH, HEIGHT, profile, index, zigzag_order),
                            quality,
                            tail_scale_index,
                            4,
                            &ignored_stored
                        );
                        current[index] = rn_add(previous_benefit, benefit);
                        back[tail_index][index] = static_cast<int16_t>(previous_index);
                    }
                    for (int index = 0; index < scan_length; ++index) previous[index] = current[index];
                }
                int tail_end_index = -1;
                for (int index = 0; index < scan_length; ++index) {
                    if (previous[index] > tail_benefit || tail_end_index < 0 && previous[index] > -DBL_MAX) {
                        tail_benefit = previous[index];
                        tail_end_index = index;
                    }
                }
                if (tail_end_index >= 0) {
                    candidate_tail_path[tail_count - 1] = static_cast<int16_t>(tail_end_index);
                    for (int tail_index = tail_count - 1; tail_index > 0; --tail_index) {
                        candidate_tail_path[tail_index - 1] =
                            back[tail_index][candidate_tail_path[tail_index]];
                    }
                    for (int tail_index = 0; tail_index < tail_count; ++tail_index) {
                        int stored = 0;
                        skip_coefficient_benefit<WIDTH, HEIGHT, CHROMA>(
                            coefficients,
                            skip_scan_position(
                                WIDTH, HEIGHT, profile, candidate_tail_path[tail_index], zigzag_order
                            ),
                            quality,
                            tail_scale_index,
                            4,
                            &stored
                        );
                        candidate_tail_stored[tail_index] = static_cast<int16_t>(stored);
                    }
                }
            }
            const double error = rn_add(rn_add(rn_add(base_error, dc_delta), -total_benefit), -tail_benefit);
            const bool better = error < best_error ||
                (error == best_error && best_profile >= 0 &&
                    (scale_index < best_scale_index ||
                    (scale_index == best_scale_index && profile < best_profile)));
            if (!better) continue;
            best_error = error;
            best_profile = profile;
            best_scale_index = scale_index;
            best_dc = dc;
#pragma unroll 1
            for (int token_index = 0; token_index < token_count; ++token_index) {
                best_path[token_index] = candidate_path[token_index];
            }
            for (int token_index = 0; token_index < tail_count; ++token_index) {
                best_tail_path[token_index] = candidate_tail_path[token_index];
                best_tail_stored[token_index] = candidate_tail_stored[token_index];
            }
        }
    }

    if (best_profile < 0) return;
#pragma unroll 1
    for (int byte = 0; byte < byte_count; ++byte) record[byte] = 0u;
    int bit_offset = 0;
    write_bits(record, &bit_offset, static_cast<uint32_t>(
        (best_profile << 4) | best_scale_index | 8
    ), 8);
    write_signed_bits(record, &bit_offset, best_dc, 10);
#pragma unroll 1
    for (int token_index = 0; token_index < token_count; ++token_index) {
        const bool fine = coefficient_coding != COEFFICIENT_CODING_SKIP_RLE_EQUAL_2 &&
            token_index >= coarse_count;
        const int value_bits = fine ? 4 : 6;
        const int value_scale_index = fine ? (best_scale_index >= 3 ? 1 : 0) : best_scale_index;
        const int position = skip_scan_position(
            WIDTH, HEIGHT, best_profile, best_path[token_index], zigzag_order
        );
        int stored = 0;
        skip_coefficient_benefit<WIDTH, HEIGHT, CHROMA>(
            coefficients, position, quality, value_scale_index, value_bits, &stored
        );
        const int skip = token_index + 1 < token_count
            ? best_path[token_index + 1] - best_path[token_index] - 1
            : tail_count > 0 && best_tail_path[0] >= 0
                ? best_tail_path[0] - best_path[token_index] - 1 : 0;
        write_signed_bits(record, &bit_offset, stored, value_bits);
        write_bits(record, &bit_offset, static_cast<uint32_t>(skip), 2);
    }
    for (int token_index = 0; token_index < tail_count; ++token_index) {
        write_signed_bits(record, &bit_offset, best_tail_stored[token_index], 4);
        if (token_index + 1 < tail_count) {
            const int skip = best_tail_path[token_index] >= 0 && best_tail_path[token_index + 1] >= 0
                ? best_tail_path[token_index + 1] - best_tail_path[token_index] - 1 : 0;
            write_bits(record, &bit_offset, static_cast<uint32_t>(skip), 2);
        }
    }
}

template <int WIDTH, int HEIGHT, bool CHROMA>
__device__ __noinline__ bool encode_masked_tail_component_record(
    const double *coefficients,
    uint8_t *record,
    int byte_count,
    int quality,
    bool implicit2,
    bool zigzag_order
) {
    if (WIDTH != 8 || HEIGHT != 8) return false;
    int dc_bits = 0;
    int ac_bits = 0;
    int max_ac = 0;
    if (implicit2) {
        if (byte_count != 48) return false;
        dc_bits = 10;
        ac_bits = 8;
        max_ac = 39;
    } else if (!masked_tail_config(byte_count, &dc_bits, &ac_bits, &max_ac)) {
        return false;
    }
    const int implicit_count = implicit2 ? 2 : 0;
    const int implicit_rank_2 = zigzag_order ? 2 : 8;
    const int flexible_ac = max_ac - implicit_count;

    double base_error = 0.0;
    for (int position = 0; position < 64; ++position) {
        base_error = rn_add(base_error, rn_square(coefficients[position]));
    }

    double best_error = DBL_MAX;
    int best_scale_index = 0;
    int best_dc = 0;
    int best_tail_start = 64;
    uint32_t best_mask_low = 0u;
    uint32_t best_mask_high = 0u;
    bool best_selected[64] = {};

    for (int scale_index = 0; scale_index < 4; ++scale_index) {
        const int scale = 1 << scale_index;
        const int dc_minimum = -(1 << (dc_bits - 1));
        const int dc_maximum = (1 << (dc_bits - 1)) - 1;
        const int ac_minimum = -(1 << (ac_bits - 1));
        const int ac_maximum = (1 << (ac_bits - 1)) - 1;
        const double dc_step = quantization_step(0, 0, 8, 8, quality, CHROMA) * scale;
        const int dc = clamp_int(round_signed(coefficients[0] / dc_step), dc_minimum, dc_maximum);
        const double restored_dc = static_cast<double>(dc) * dc_step;
        const double dc_error = rn_add(
            rn_add(base_error, rn_square(coefficients[0] - restored_dc)),
            -rn_square(coefficients[0])
        );
        double benefits[64];
        for (int rank = 1; rank < 64; ++rank) {
            const int position = coefficient_order_position(8, 8, rank, zigzag_order);
            const int u = position & 7;
            const int v = position >> 3;
            const double step = quantization_step(u, v, 8, 8, quality, CHROMA) * scale;
            const int stored = clamp_int(
                round_signed(coefficients[position] / step), ac_minimum, ac_maximum
            );
            const double keep_error = rn_square(
                coefficients[position] - static_cast<double>(stored) * step
            );
            const double drop_error = rn_square(coefficients[position]);
            benefits[rank] = keep_error < drop_error
                ? rn_add(drop_error, -keep_error) : 0.0;
        }

        bool selected[64] = {};
        uint32_t mask_low = 0u;
        uint32_t mask_high = 0u;
        double implicit_benefit = 0.0;
        if (implicit2) {
            implicit_benefit = rn_add(benefits[1], benefits[implicit_rank_2]);
        }
        double explicit_benefit = 0.0;
        double tail_benefit = 0.0;
        for (int rank = 64 - flexible_ac; rank < 64; ++rank) {
            tail_benefit = rn_add(tail_benefit, benefits[rank]);
        }

        for (int explicit_count = 0; explicit_count <= flexible_ac; ++explicit_count) {
            const int tail_start = 64 - flexible_ac + explicit_count;
            const double error = rn_add(
                rn_add(rn_add(dc_error, -implicit_benefit), -explicit_benefit), -tail_benefit
            );
            if (error < best_error) {
                best_error = error;
                best_scale_index = scale_index;
                best_dc = dc;
                best_tail_start = tail_start;
                best_mask_low = mask_low;
                best_mask_high = mask_high;
                for (int position = 0; position < 64; ++position) {
                    best_selected[position] = selected[position];
                }
            }

            if (explicit_count == flexible_ac) break;
            tail_benefit = rn_add(tail_benefit, -benefits[tail_start]);
            int best_rank = -1;
            for (int rank = 1; rank <= min(62, tail_start); ++rank) {
                if (selected[rank] || (implicit2 && (rank == 1 || rank == implicit_rank_2))) {
                    continue;
                }
                if (best_rank < 0 || benefits[rank] > benefits[best_rank] ||
                    (benefits[rank] == benefits[best_rank] && rank < best_rank)) {
                    best_rank = rank;
                }
            }
            selected[best_rank] = true;
            explicit_benefit = rn_add(explicit_benefit, benefits[best_rank]);
            const int mask_bit = best_rank - 1;
            if (mask_bit < 32) mask_low |= 1u << mask_bit;
            else mask_high |= 1u << (mask_bit - 32);
        }
    }

    if (implicit2) {
        int bit_offset = 0;
        for (int rank = 1; rank <= 62; ++rank) {
            if (rank == 1 || rank == implicit_rank_2) continue;
            write_bits_lsb(record, &bit_offset, best_selected[rank] ? 1u : 0u, 1);
        }
        write_bits_lsb(record, &bit_offset, static_cast<uint32_t>(best_scale_index), 2);
        write_signed_bits_lsb(record, &bit_offset, best_dc, dc_bits);
        const int scale = 1 << best_scale_index;
        const int ac_minimum = -(1 << (ac_bits - 1));
        const int ac_maximum = (1 << (ac_bits - 1)) - 1;
        const int implicit_positions[2] = {1, 8};
        for (int index = 0; index < 2; ++index) {
            const int position = implicit_positions[index];
            const double step = quantization_step(
                position & 7, position >> 3, 8, 8, quality, CHROMA
            ) * scale;
            int stored = clamp_int(
                round_signed(coefficients[position] / step), ac_minimum, ac_maximum
            );
            const double keep_error = rn_square(
                coefficients[position] - static_cast<double>(stored) * step
            );
            if (keep_error >= rn_square(coefficients[position])) stored = 0;
            write_signed_bits_lsb(record, &bit_offset, stored, ac_bits);
        }
        for (int rank = 1; rank < best_tail_start && rank <= 62; ++rank) {
            if (!best_selected[rank]) continue;
            const int position = coefficient_order_position(8, 8, rank, zigzag_order);
            const double step = quantization_step(
                position & 7, position >> 3, 8, 8, quality, CHROMA
            ) * scale;
            int stored = clamp_int(
                round_signed(coefficients[position] / step), ac_minimum, ac_maximum
            );
            const double keep_error = rn_square(
                coefficients[position] - static_cast<double>(stored) * step
            );
            if (keep_error >= rn_square(coefficients[position])) stored = 0;
            write_signed_bits_lsb(record, &bit_offset, stored, ac_bits);
        }
        for (int rank = best_tail_start; rank < 64; ++rank) {
            const int position = coefficient_order_position(8, 8, rank, zigzag_order);
            const double step = quantization_step(
                position & 7, position >> 3, 8, 8, quality, CHROMA
            ) * scale;
            int stored = clamp_int(
                round_signed(coefficients[position] / step), ac_minimum, ac_maximum
            );
            const double keep_error = rn_square(
                coefficients[position] - static_cast<double>(stored) * step
            );
            if (keep_error >= rn_square(coefficients[position])) stored = 0;
            write_signed_bits_lsb(record, &bit_offset, stored, ac_bits);
        }
        return true;
    }

    write_u32_little_device(record, best_mask_low);
    write_u32_little_device(
        record + 4,
        (best_mask_high & 0x3fffffffu) | (static_cast<uint32_t>(best_scale_index) << 30u)
    );
    int bit_offset = 0;
    write_signed_bits_lsb(record + 8, &bit_offset, best_dc, dc_bits);
    const int scale = 1 << best_scale_index;
    const int ac_minimum = -(1 << (ac_bits - 1));
    const int ac_maximum = (1 << (ac_bits - 1)) - 1;
    for (int rank = 1; rank < best_tail_start && rank <= 62; ++rank) {
        if (!masked_tail_has_position(best_mask_low, best_mask_high, rank)) continue;
        const int position = coefficient_order_position(8, 8, rank, zigzag_order);
        const double step = quantization_step(
            position & 7, position >> 3, 8, 8, quality, CHROMA
        ) * scale;
        int stored = clamp_int(
            round_signed(coefficients[position] / step), ac_minimum, ac_maximum
        );
        const double keep_error = rn_square(
            coefficients[position] - static_cast<double>(stored) * step
        );
        if (keep_error >= rn_square(coefficients[position])) stored = 0;
        write_signed_bits_lsb(record + 8, &bit_offset, stored, ac_bits);
    }
    for (int rank = best_tail_start; rank < 64; ++rank) {
        const int position = coefficient_order_position(8, 8, rank, zigzag_order);
        const double step = quantization_step(
            position & 7, position >> 3, 8, 8, quality, CHROMA
        ) * scale;
        int stored = clamp_int(
            round_signed(coefficients[position] / step), ac_minimum, ac_maximum
        );
        const double keep_error = rn_square(
            coefficients[position] - static_cast<double>(stored) * step
        );
        if (keep_error >= rn_square(coefficients[position])) stored = 0;
        write_signed_bits_lsb(record + 8, &bit_offset, stored, ac_bits);
    }
    return true;
}

template <int WIDTH, int HEIGHT, bool CHROMA>
__device__ void encode_component_record(
    const double *coefficients,
    uint8_t *record,
    int byte_count,
    int quality,
    int coefficient_coding,
    bool allow_skip,
    bool zigzag_order
) {
    if (coefficient_coding == COEFFICIENT_CODING_LEGACY) {
        encode_legacy_component_record<WIDTH, HEIGHT, CHROMA>(
            coefficients, record, byte_count, quality, zigzag_order
        );
    } else if ((coefficient_coding == COEFFICIENT_CODING_MASKED_TAIL_8X8 ||
        coefficient_coding == COEFFICIENT_CODING_MASKED_TAIL_IMPLICIT2_48) &&
        encode_masked_tail_component_record<WIDTH, HEIGHT, CHROMA>(
            coefficients, record, byte_count, quality,
            coefficient_coding == COEFFICIENT_CODING_MASKED_TAIL_IMPLICIT2_48,
            zigzag_order
        )) {
        return;
    } else {
        const double baseline_error = encode_grouped_component_record<WIDTH, HEIGHT, CHROMA>(
            coefficients, record, byte_count, quality, coefficient_coding, zigzag_order
        );
        if (allow_skip && coefficient_coding >= COEFFICIENT_CODING_SKIP_RLE_EQUAL_2 &&
            coefficient_coding <= COEFFICIENT_CODING_DUAL_SKIP_FRONT) {
            encode_skip_component_record<WIDTH, HEIGHT, CHROMA>(
                coefficients, record, byte_count, quality, coefficient_coding,
                baseline_error, zigzag_order
            );
        }
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
    bool allow_skip,
    bool zigzag_order,
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
        if constexpr (!CHROMA) {
            const uint32_t source_y = min(
                height - 1u,
                mcu_y * MCU_HEIGHT + static_cast<uint32_t>(block_y + local_y)
            );
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
            constexpr int VERTICAL_SAMPLES = HEIGHT == 8 ? 2 : 1;
            for (int sample_y = 0; sample_y < VERTICAL_SAMPLES; ++sample_y) {
                const uint32_t source_y = min(
                    height - 1u,
                    mcu_y * MCU_HEIGHT + static_cast<uint32_t>(local_y * VERTICAL_SAMPLES + sample_y)
                );
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
            }
            samples[position] = rn_add(
                rn_mul(sum, 1.0 / static_cast<double>(VERTICAL_SAMPLES * 2)), -128.0
            );
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
            coefficient_coding,
            allow_skip,
            zigzag_order
        );
    }
}

__host__ __device__ bool is_header_library_version(int version) {
    return version >= static_cast<int>(LIBRARY_VERSION_HEADER_REFERENCE) &&
        version <= static_cast<int>(LIBRARY_VERSION_SPECTRAL_FULL);
}

__host__ __device__ bool is_sidecar_library_version(int version) {
    return version >= static_cast<int>(LIBRARY_VERSION_SIDECAR_REFERENCE) &&
        version <= static_cast<int>(LIBRARY_VERSION_SIDECAR_SPECTRAL_FULL);
}

__host__ __device__ int library_frequency_quarters(int version) {
    if (version == static_cast<int>(LIBRARY_VERSION_SPECTRAL_QUARTER) ||
        version == static_cast<int>(LIBRARY_VERSION_SIDECAR_SPECTRAL_QUARTER)) {
        return 1;
    }
    if (version == static_cast<int>(LIBRARY_VERSION_SPECTRAL_HALF) ||
        version == static_cast<int>(LIBRARY_VERSION_SIDECAR_SPECTRAL_HALF)) {
        return 2;
    }
    if (version == static_cast<int>(LIBRARY_VERSION_SPECTRAL_FULL) ||
        version == static_cast<int>(LIBRARY_VERSION_SIDECAR_SPECTRAL_FULL)) {
        return 4;
    }
    return 0;
}

__host__ __device__ uint32_t sidecar_reference_bits(uint32_t entry_count) {
    if (entry_count == 0u) {
        return 0u;
    }
    uint32_t bits = 0u;
    uint32_t maximum_value = entry_count;
    while (maximum_value != 0u) {
        ++bits;
        maximum_value >>= 1u;
    }
    return bits;
}

__device__ int spectral_scan_index(int index, int ac_count, int scan_length, int library_version) {
    const int quarters = library_frequency_quarters(library_version);
    if (quarters == 0) {
        return index;
    }
    const int requested_high = (ac_count * quarters + 2) / 4;
    const int high_count = min(scan_length - ac_count, requested_high);
    const int low_count = ac_count - high_count;
    return index < low_count ? index : ac_count + index - low_count;
}

__device__ int read_sidecar_reference(
    const uint8_t *library,
    uint32_t byte_offset,
    uint32_t bit_count,
    uint32_t reference_index
) {
    if (library == nullptr || bit_count == 0u) {
        return 0;
    }
    const uint64_t bit_offset = static_cast<uint64_t>(byte_offset) * 8u +
        static_cast<uint64_t>(reference_index) * bit_count;
    int value = 0;
    for (uint32_t bit = 0; bit < bit_count; ++bit) {
        const uint64_t position = bit_offset + bit;
        value |= static_cast<int>((library[position >> 3u] >> (position & 7u)) & 1u) << bit;
    }
    return value;
}

template <int WIDTH, int HEIGHT, bool CHROMA>
__device__ __noinline__ bool decode_masked_tail_component_record(
    const uint8_t *record,
    int byte_count,
    int quality,
    int library_version,
    double *coefficients,
    bool implicit2,
    bool zigzag_order
) {
    if (WIDTH != 8 || HEIGHT != 8 || library_version != 0) return false;
    int dc_bits = 0;
    int ac_bits = 0;
    int max_ac = 0;
    if (implicit2) {
        if (byte_count != 48) return false;
        dc_bits = 10;
        ac_bits = 8;
        max_ac = 39;
    } else if (!masked_tail_config(byte_count, &dc_bits, &ac_bits, &max_ac)) {
        return false;
    }
    for (int position = 0; position < 64; ++position) coefficients[position] = 0.0;

    bool selected[64] = {};
    int scale_index = 0;
    int bit_offset = 0;
    int explicit_count = 0;
    const int implicit_rank_2 = zigzag_order ? 2 : 8;
    if (implicit2) {
        for (int rank = 1; rank <= 62; ++rank) {
            if (rank == 1 || rank == implicit_rank_2) continue;
            selected[rank] = read_bits_lsb(record, &bit_offset, 1) != 0u;
            explicit_count += selected[rank] ? 1 : 0;
        }
        scale_index = static_cast<int>(read_bits_lsb(record, &bit_offset, 2));
    } else {
        const uint32_t mask_low = read_u32_little_device(record);
        const uint32_t raw_mask_high = read_u32_little_device(record + 4);
        const uint32_t mask_high = raw_mask_high & 0x3fffffffu;
        scale_index = static_cast<int>(raw_mask_high >> 30u);
        explicit_count = __popc(mask_low) + __popc(mask_high);
        bit_offset = 64;
        for (int rank = 1; rank <= 62; ++rank) {
            selected[rank] = masked_tail_has_position(mask_low, mask_high, rank);
        }
    }
    const int implicit_count = implicit2 ? 2 : 0;
    const int flexible_ac = max_ac - implicit_count;
    if (explicit_count > flexible_ac) return false;
    const int tail_count = flexible_ac - explicit_count;
    const int tail_start = 64 - tail_count;
    for (int rank = max(1, tail_start); rank <= 62; ++rank) {
        if (selected[rank]) return false;
    }

    const int scale = 1 << scale_index;
    const int dc = read_signed_bits_lsb(record, &bit_offset, dc_bits);
    coefficients[0] = static_cast<double>(dc) *
        quantization_step(0, 0, 8, 8, quality, CHROMA) * scale;
    if (implicit2) {
        const int implicit_positions[2] = {1, 8};
        for (int index = 0; index < 2; ++index) {
            const int position = implicit_positions[index];
            const int stored = read_signed_bits_lsb(record, &bit_offset, ac_bits);
            coefficients[position] = static_cast<double>(stored) * quantization_step(
                position & 7, position >> 3, 8, 8, quality, CHROMA
            ) * scale;
        }
    }
    for (int rank = 1; rank < tail_start && rank <= 62; ++rank) {
        if (!selected[rank]) continue;
        const int position = coefficient_order_position(8, 8, rank, zigzag_order);
        const int stored = read_signed_bits_lsb(record, &bit_offset, ac_bits);
        coefficients[position] = static_cast<double>(stored) * quantization_step(
            position & 7, position >> 3, 8, 8, quality, CHROMA
        ) * scale;
    }
    for (int rank = tail_start; rank < 64; ++rank) {
        const int position = coefficient_order_position(8, 8, rank, zigzag_order);
        const int stored = read_signed_bits_lsb(record, &bit_offset, ac_bits);
        coefficients[position] = static_cast<double>(stored) * quantization_step(
            position & 7, position >> 3, 8, 8, quality, CHROMA
        ) * scale;
    }
    return true;
}

template <int WIDTH, int HEIGHT, bool CHROMA>
__device__ __noinline__ bool decode_legacy_component_record(
    const uint8_t *record,
    int byte_count,
    int quality,
    int library_version,
    int external_library_index,
    double *coefficients,
    int *library_index,
    bool add_coefficients,
    bool zigzag_order
) {
    if (!add_coefficients) {
        for (int position = 0; position < WIDTH * HEIGHT; ++position) {
            coefficients[position] = 0.0;
        }
    }
    int bit_offset = 0;
    const uint32_t header = read_bits(record, &bit_offset, 8);
    const int packed_profile = static_cast<int>(header >> 4u);
    const bool header_reference = is_header_library_version(library_version);
    const int profile = header_reference
        ? packed_profile & 3 : packed_profile;
    const int scale_index = static_cast<int>(header & 15u);
    if (profile >= (zigzag_order ? 5 : 4) || scale_index >= 8) {
        return false;
    }
    const int scale = 1 << scale_index;
    const int dc = read_signed_bits(record, &bit_offset, 10);
    const double restored_dc = static_cast<double>(dc) *
        quantization_step(0, 0, WIDTH, HEIGHT, quality, CHROMA) * scale;
    coefficients[0] = add_coefficients ? coefficients[0] + restored_dc : restored_dc;
    const bool tail_reference = library_version == static_cast<int>(LIBRARY_VERSION_TAIL_REFERENCE);
    const int ac_count = (byte_count * 8 - 18) / 6 - (tail_reference ? 1 : 0);
    int resolved_library_index = header_reference ? packed_profile >> 2 :
        is_sidecar_library_version(library_version) ? external_library_index : 0;
    for (int index = 0; index < ac_count; ++index) {
        const int scan_index = resolved_library_index > 0
            ? spectral_scan_index(index, ac_count, WIDTH * HEIGHT - 1, library_version) : index;
        const int position = scan_position(
            WIDTH, HEIGHT, profile, scan_index, zigzag_order
        );
        const int u = position % WIDTH;
        const int v = position / WIDTH;
        const int stored = read_signed_bits(record, &bit_offset, 6);
        const double restored = static_cast<double>(stored) *
            quantization_step(u, v, WIDTH, HEIGHT, quality, CHROMA) * scale;
        coefficients[position] = add_coefficients ? coefficients[position] + restored : restored;
    }
    if (tail_reference) {
        resolved_library_index = static_cast<int>(read_bits(record, &bit_offset, 6));
    }
    *library_index = resolved_library_index;
    return true;
}

template <int WIDTH, int HEIGHT, bool CHROMA>
__device__ __noinline__ bool decode_grouped_component_record(
    const uint8_t *record,
    int byte_count,
    int quality,
    int coefficient_coding,
    int library_version,
    int external_library_index,
    double *coefficients,
    int *library_index,
    bool add_coefficients,
    bool zigzag_order
) {
    if (!add_coefficients) {
        for (int position = 0; position < WIDTH * HEIGHT; ++position) {
            coefficients[position] = 0.0;
        }
    }
    int bit_offset = 0;
    const uint32_t header = read_bits(record, &bit_offset, 8);
    const int packed_profile = static_cast<int>(header >> 4u);
    const bool header_reference = is_header_library_version(library_version);
    const int packed_scale = static_cast<int>(header & 15u);
    const bool skip_record = coefficient_coding >= COEFFICIENT_CODING_SKIP_RLE_EQUAL_2 &&
        coefficient_coding <= COEFFICIENT_CODING_DUAL_SKIP_FRONT &&
        (packed_scale & 8) != 0;
    const int profile = skip_record ? packed_profile :
        header_reference ? packed_profile & 3 : packed_profile;
    const int dc_scale_index = packed_scale & 7;
    if (profile >= (skip_record ? (zigzag_order ? 9 : 8) : (zigzag_order ? 5 : 4)) ||
        (!skip_record && packed_scale >= 8) ||
        (skip_record && library_version != 0)) {
        return false;
    }
    const int dc = read_signed_bits(record, &bit_offset, 10);
    const double restored_dc = static_cast<double>(dc) *
        quantization_step(0, 0, WIDTH, HEIGHT, quality, CHROMA) *
        (1 << dc_scale_index);
    coefficients[0] = add_coefficients ? coefficients[0] + restored_dc : restored_dc;

    if (skip_record) {
        const int token_count = skip_token_count<WIDTH, HEIGHT>(byte_count, coefficient_coding);
        const int coarse_count = skip_coarse_count<WIDTH, HEIGHT>(
            byte_count, coefficient_coding, token_count
        );
        const int tail_count = skip_tail_token_count<WIDTH, HEIGHT>(byte_count, coefficient_coding);
        int scan_index = 0;
        for (int token_index = 0; token_index < token_count; ++token_index) {
            if (scan_index >= WIDTH * HEIGHT - 1) return false;
            const bool fine = coefficient_coding != COEFFICIENT_CODING_SKIP_RLE_EQUAL_2 &&
                token_index >= coarse_count;
            const int value_bits = fine ? 4 : 6;
            const int scale_index = fine ? (dc_scale_index >= 3 ? 1 : 0) : dc_scale_index;
            const int stored = read_signed_bits(record, &bit_offset, value_bits);
            const int skip = static_cast<int>(read_bits(record, &bit_offset, 2));
            const int position = skip_scan_position(
                WIDTH, HEIGHT, profile, scan_index, zigzag_order
            );
            const int u = position % WIDTH;
            const int v = position / WIDTH;
            const double restored = static_cast<double>(stored) *
                quantization_step(u, v, WIDTH, HEIGHT, quality, CHROMA) * (1 << scale_index);
            coefficients[position] = add_coefficients ? coefficients[position] + restored : restored;
            scan_index += skip + 1;
        }
        const int tail_scale_index = dc_scale_index >= 3 ? 1 : 0;
        for (int token_index = 0; token_index < tail_count; ++token_index) {
            const int stored = read_signed_bits(record, &bit_offset, 4);
            if (scan_index < WIDTH * HEIGHT - 1) {
                const int position = skip_scan_position(
                    WIDTH, HEIGHT, profile, scan_index, zigzag_order
                );
                const int u = position % WIDTH;
                const int v = position / WIDTH;
                const double restored = static_cast<double>(stored) *
                    quantization_step(u, v, WIDTH, HEIGHT, quality, CHROMA) *
                    (1 << tail_scale_index);
                coefficients[position] = add_coefficients ? coefficients[position] + restored : restored;
            } else if (stored != 0) {
                return false;
            }
            if (token_index + 1 < tail_count) {
                const int skip = static_cast<int>(read_bits(record, &bit_offset, 2));
                scan_index += skip + 1;
            }
        }
        *library_index = 0;
        return true;
    }

    const int group_count = grouped_count(coefficient_coding);
    const bool tail_reference = library_version == static_cast<int>(LIBRARY_VERSION_TAIL_REFERENCE);
    const int ac_count = min(
        WIDTH * HEIGHT - 1,
        (byte_count * 8 - 18 - group_count * 3) / 5 - (tail_reference ? 1 : 0)
    );
    int resolved_library_index = header_reference ? packed_profile >> 2 :
        is_sidecar_library_version(library_version) ? external_library_index : 0;
    int group_scales[3] = {0, 0, 0};
    for (int group = 0; group < group_count; ++group) {
        group_scales[group] = static_cast<int>(read_bits(record, &bit_offset, 3));
    }

    int group_start = 0;
    for (int group = 0; group < group_count; ++group) {
        const int group_finish = grouped_end(coefficient_coding, group, ac_count);
        const int scale = 1 << group_scales[group];
        for (int index = group_start; index < group_finish; ++index) {
            const int scan_index = resolved_library_index > 0
                ? spectral_scan_index(index, ac_count, WIDTH * HEIGHT - 1, library_version) : index;
            const int position = scan_position(
                WIDTH, HEIGHT, profile, scan_index, zigzag_order
            );
            const int u = position % WIDTH;
            const int v = position / WIDTH;
            const int stored = read_signed_bits(record, &bit_offset, 5);
            const double restored = static_cast<double>(stored) *
                quantization_step(u, v, WIDTH, HEIGHT, quality, CHROMA) * scale;
            coefficients[position] = add_coefficients ? coefficients[position] + restored : restored;
        }
        group_start = group_finish;
    }
    if (tail_reference) {
        resolved_library_index = static_cast<int>(read_bits(record, &bit_offset, 5));
    }
    *library_index = resolved_library_index;
    return true;
}

template <int WIDTH, int HEIGHT, bool CHROMA>
__device__ __noinline__ bool decode_component_record(
    const uint8_t *record,
    int byte_count,
    int quality,
    int coefficient_coding,
    const uint8_t *library,
    int library_version,
    int external_library_index,
    uint32_t library_count,
    uint32_t library_offset,
    int library_record_bytes,
    double *coefficients,
    bool zigzag_order
) {
    int library_index = 0;
    bool valid;
    if ((coefficient_coding == COEFFICIENT_CODING_MASKED_TAIL_8X8 ||
        (coefficient_coding == COEFFICIENT_CODING_MASKED_TAIL_IMPLICIT2_48 &&
            byte_count == 48)) &&
        WIDTH == 8 && HEIGHT == 8) {
        valid = decode_masked_tail_component_record<WIDTH, HEIGHT, CHROMA>(
            record, byte_count, quality, library_version, coefficients,
            coefficient_coding == COEFFICIENT_CODING_MASKED_TAIL_IMPLICIT2_48,
            zigzag_order
        );
    } else if (coefficient_coding == COEFFICIENT_CODING_LEGACY) {
        valid = decode_legacy_component_record<WIDTH, HEIGHT, CHROMA>(
            record, byte_count, quality, library_version, external_library_index,
            coefficients, &library_index, false, zigzag_order
        );
    } else {
        valid = decode_grouped_component_record<WIDTH, HEIGHT, CHROMA>(
            record, byte_count, quality, coefficient_coding, library_version,
            external_library_index, coefficients, &library_index, false, zigzag_order
        );
    }
    if (!valid || library_index < 0 || static_cast<uint32_t>(library_index) > library_count) {
        return false;
    }
    if (library_index == 0) {
        return true;
    }
    if (library == nullptr || library_record_bytes != byte_count) {
        return false;
    }

    int ignored_index = 0;
    const uint8_t *prototype_record = library + library_offset +
        static_cast<size_t>(library_index - 1) * static_cast<size_t>(library_record_bytes);
    if (coefficient_coding == COEFFICIENT_CODING_MASKED_TAIL_8X8 ||
        coefficient_coding == COEFFICIENT_CODING_MASKED_TAIL_IMPLICIT2_48) {
        return false;
    } else if (coefficient_coding == COEFFICIENT_CODING_LEGACY) {
        valid = decode_legacy_component_record<WIDTH, HEIGHT, CHROMA>(
            prototype_record, library_record_bytes, quality, 0, 0,
            coefficients, &ignored_index, true, zigzag_order
        );
    } else {
        valid = decode_grouped_component_record<WIDTH, HEIGHT, CHROMA>(
            prototype_record, library_record_bytes, quality, coefficient_coding, 0,
            0, coefficients, &ignored_index, true, zigzag_order
        );
    }
    if (!valid) {
        return false;
    }
    return true;
}

template <int WIDTH, int HEIGHT>
__device__ __noinline__ double sample_inverse_dct(const double *coefficients, int x, int y) {
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

__device__ __noinline__ double sample_chroma_420(
    const double *coefficients,
    int local_x,
    int local_y
) {
    const int floor_x = (local_x & 1) == 0 ? (local_x >> 1) - 1 : local_x >> 1;
    const int floor_y = (local_y & 1) == 0 ? (local_y >> 1) - 1 : local_y >> 1;
    const int x0 = clamp_int(floor_x, 0, 7);
    const int y0 = clamp_int(floor_y, 0, 7);
    const int x1 = clamp_int(floor_x + 1, 0, 7);
    const int y1 = clamp_int(floor_y + 1, 0, 7);
    const int fraction_x = (local_x & 1) == 0 ? 3 : 1;
    const int fraction_y = (local_y & 1) == 0 ? 3 : 1;
    const double top = rn_add(
        rn_mul(4 - fraction_x, sample_inverse_dct<8, 8>(coefficients, x0, y0)),
        rn_mul(fraction_x, sample_inverse_dct<8, 8>(coefficients, x1, y0))
    );
    const double bottom = rn_add(
        rn_mul(4 - fraction_x, sample_inverse_dct<8, 8>(coefficients, x0, y1)),
        rn_mul(fraction_x, sample_inverse_dct<8, 8>(coefficients, x1, y1))
    );
    return rn_mul(
        rn_add(rn_mul(4 - fraction_y, top), rn_mul(fraction_y, bottom)),
        1.0 / 16.0
    );
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
    const uint8_t *library,
    DctLibraryLayout library_layout,
    uint32_t width,
    uint32_t height,
    uint32_t mcu_columns,
    uint32_t mcu_count,
    Preset preset,
    int quality,
    bool split_luma_8x8,
    bool chroma_420,
    int coefficient_coding,
    bool zigzag_order,
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
                const int library_index = read_sidecar_reference(
                    library,
                    library_layout.y_reference_offset,
                    library_layout.y_reference_bits,
                    mcu_index * 4u + static_cast<uint32_t>(block)
                );
                y_ok = decode_component_record<8, 8, false>(
                    record + block * block_bytes,
                    block_bytes,
                    quality,
                    coefficient_coding,
                    library,
                    static_cast<int>(library_layout.version),
                    library_index,
                    library_layout.y_count,
                    library_layout.y_offset,
                    block_bytes,
                    y_coefficients + block * 64,
                    zigzag_order
                ) && y_ok;
            }
        } else {
            const int library_index = read_sidecar_reference(
                library,
                library_layout.y_reference_offset,
                library_layout.y_reference_bits,
                mcu_index
            );
            y_ok = decode_component_record<16, 16, false>(
                record,
                static_cast<int>(preset.y_bytes),
                quality,
                coefficient_coding,
                library,
                static_cast<int>(library_layout.version),
                library_index,
                library_layout.y_count,
                library_layout.y_offset,
                static_cast<int>(preset.y_bytes),
                y_coefficients,
                zigzag_order
            );
        }
        const int cb_library_index = read_sidecar_reference(
            library,
            library_layout.cb_reference_offset,
            library_layout.cb_reference_bits,
            mcu_index
        );
        const bool cb_ok = chroma_420
            ? decode_component_record<8, 8, true>(
                record + preset.y_bytes,
                static_cast<int>(preset.cb_bytes),
                quality,
                coefficient_coding,
                library,
                static_cast<int>(library_layout.version),
                cb_library_index,
                library_layout.cb_count,
                library_layout.cb_offset,
                static_cast<int>(preset.cb_bytes),
                cb_coefficients,
                zigzag_order
            )
            : decode_component_record<8, 16, true>(
                record + preset.y_bytes,
                static_cast<int>(preset.cb_bytes),
                quality,
                coefficient_coding,
                library,
                static_cast<int>(library_layout.version),
                cb_library_index,
                library_layout.cb_count,
                library_layout.cb_offset,
                static_cast<int>(preset.cb_bytes),
                cb_coefficients,
                zigzag_order
            );
        const int cr_library_index = read_sidecar_reference(
            library,
            library_layout.cr_reference_offset,
            library_layout.cr_reference_bits,
            mcu_index
        );
        const bool cr_ok = chroma_420
            ? decode_component_record<8, 8, true>(
                record + preset.y_bytes + preset.cb_bytes,
                static_cast<int>(preset.cr_bytes),
                quality,
                coefficient_coding,
                library,
                static_cast<int>(library_layout.version),
                cr_library_index,
                library_layout.cr_count,
                library_layout.cr_offset,
                static_cast<int>(preset.cr_bytes),
                cr_coefficients,
                zigzag_order
            )
            : decode_component_record<8, 16, true>(
                record + preset.y_bytes + preset.cb_bytes,
                static_cast<int>(preset.cr_bytes),
                quality,
                coefficient_coding,
                library,
                static_cast<int>(library_layout.version),
                cr_library_index,
                library_layout.cr_count,
                library_layout.cr_offset,
                static_cast<int>(preset.cr_bytes),
                cr_coefficients,
                zigzag_order
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
    const double cb = (chroma_420
        ? sample_chroma_420(cb_coefficients, local_x, local_y)
        : sample_inverse_dct<8, 16>(cb_coefficients, local_x / 2, local_y)) + 128.0;
    const double cr = (chroma_420
        ? sample_chroma_420(cr_coefficients, local_x, local_y)
        : sample_inverse_dct<8, 16>(cr_coefficients, local_x / 2, local_y)) + 128.0;
    uint8_t rgba[4];
    convert_to_rgba(luma, cb, cr, rgba);
    const size_t destination = (static_cast<size_t>(y) * width + x) * 3u;
    rgb[destination] = rgba[0];
    rgb[destination + 1u] = rgba[1];
    rgb[destination + 2u] = rgba[2];
}

__global__ void sample_pixel_kernel(
    const uint8_t *record,
    const uint8_t *library,
    DctLibraryLayout library_layout,
    Preset preset,
    int quality,
    bool split_luma_8x8,
    bool chroma_420,
    int coefficient_coding,
    bool zigzag_order,
    uint32_t mcu_index,
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
            const int library_index = read_sidecar_reference(
                library,
                library_layout.y_reference_offset,
                library_layout.y_reference_bits,
                mcu_index * 4u + static_cast<uint32_t>(luma_block)
            );
            y_ok = decode_component_record<8, 8, false>(
                record + luma_block * block_bytes,
                block_bytes,
                quality,
                coefficient_coding,
                library,
                static_cast<int>(library_layout.version),
                library_index,
                library_layout.y_count,
                library_layout.y_offset,
                block_bytes,
                y_coefficients,
                zigzag_order
            );
        } else {
            const int library_index = read_sidecar_reference(
                library,
                library_layout.y_reference_offset,
                library_layout.y_reference_bits,
                mcu_index
            );
            y_ok = decode_component_record<16, 16, false>(
                record,
                static_cast<int>(preset.y_bytes),
                quality,
                coefficient_coding,
                library,
                static_cast<int>(library_layout.version),
                library_index,
                library_layout.y_count,
                library_layout.y_offset,
                static_cast<int>(preset.y_bytes),
                y_coefficients,
                zigzag_order
            );
        }
        const int cb_library_index = read_sidecar_reference(
            library,
            library_layout.cb_reference_offset,
            library_layout.cb_reference_bits,
            mcu_index
        );
        const bool cb_ok = chroma_420
            ? decode_component_record<8, 8, true>(
                record + preset.y_bytes, static_cast<int>(preset.cb_bytes), quality,
                coefficient_coding, library, static_cast<int>(library_layout.version),
                cb_library_index, library_layout.cb_count, library_layout.cb_offset,
                static_cast<int>(preset.cb_bytes), cb_coefficients, zigzag_order
            )
            : decode_component_record<8, 16, true>(
                record + preset.y_bytes, static_cast<int>(preset.cb_bytes), quality,
                coefficient_coding, library, static_cast<int>(library_layout.version),
                cb_library_index, library_layout.cb_count, library_layout.cb_offset,
                static_cast<int>(preset.cb_bytes), cb_coefficients, zigzag_order
            );
        const int cr_library_index = read_sidecar_reference(
            library,
            library_layout.cr_reference_offset,
            library_layout.cr_reference_bits,
            mcu_index
        );
        const bool cr_ok = chroma_420
            ? decode_component_record<8, 8, true>(
                record + preset.y_bytes + preset.cb_bytes, static_cast<int>(preset.cr_bytes),
                quality, coefficient_coding, library, static_cast<int>(library_layout.version),
                cr_library_index, library_layout.cr_count, library_layout.cr_offset,
                static_cast<int>(preset.cr_bytes), cr_coefficients, zigzag_order
            )
            : decode_component_record<8, 16, true>(
                record + preset.y_bytes + preset.cb_bytes, static_cast<int>(preset.cr_bytes),
                quality, coefficient_coding, library, static_cast<int>(library_layout.version),
                cr_library_index, library_layout.cr_count, library_layout.cr_offset,
                static_cast<int>(preset.cr_bytes), cr_coefficients, zigzag_order
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
        const double cb = (chroma_420
            ? sample_chroma_420(cb_coefficients, local_x, local_y)
            : sample_inverse_dct<8, 16>(cb_coefficients, local_x / 2, local_y)) + 128.0;
        const double cr = (chroma_420
            ? sample_chroma_420(cr_coefficients, local_x, local_y)
            : sample_inverse_dct<8, 16>(cr_coefficients, local_x / 2, local_y)) + 128.0;
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
    bool zigzag_order,
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
            FLAG_CHROMA_420 |
            (zigzag_order ? FLAG_ZIGZAG_ORDER : 0u) |
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
    info.width = read_u32(bytes, 16u);
    info.height = read_u32(bytes, 20u);
    info.mcu_columns = read_u32(bytes, 24u);
    info.mcu_rows = read_u32(bytes, 28u);
    info.quality = read_u32(bytes, 48u);
    const uint32_t flags = read_u32(bytes, 52u);
    const uint32_t payload = read_u32(bytes, 56u);
    const uint32_t metadata = read_u32(bytes, 60u);
    info.auto_quality = (flags & FLAG_AUTO_QUALITY) != 0u;
    info.split_luma_8x8 = (flags & FLAG_SPLIT_LUMA_8X8) != 0u;
    info.chroma_420 = (flags & FLAG_CHROMA_420) != 0u;
    info.zigzag_order = (flags & FLAG_ZIGZAG_ORDER) != 0u;
    info.library_enabled = (flags & FLAG_DCT_LIBRARY) != 0u;
    info.payload_bytes = payload;
    info.library_bytes = info.library_enabled ? metadata : 0u;
    info.search_candidate_count = info.library_enabled ? 0u : metadata;
    info.coefficient_coding = static_cast<int>(
        (flags & COEFFICIENT_CODING_MASK) >> COEFFICIENT_CODING_SHIFT
    );
    const uint32_t y_bytes = read_u32(bytes, 36u);
    const uint32_t cb_bytes = read_u32(bytes, 40u);
    const uint32_t cr_bytes = read_u32(bytes, 44u);
    const uint32_t y_record_bytes = info.split_luma_8x8 ? y_bytes / 4u : y_bytes;

    if (info.width == 0u || info.height == 0u || info.quality < 1u || info.quality > 100u ||
        (flags & ~SUPPORTED_FLAGS) != 0u || info.mcu_columns != (info.width + 15u) / 16u ||
        info.coefficient_coding > COEFFICIENT_CODING_MASKED_TAIL_IMPLICIT2_48 ||
        (info.library_enabled &&
            (info.coefficient_coding == COEFFICIENT_CODING_MASKED_TAIL_8X8 ||
                info.coefficient_coding == COEFFICIENT_CODING_MASKED_TAIL_IMPLICIT2_48)) ||
        info.mcu_rows != (info.height + 15u) / 16u ||
        (info.split_luma_8x8 && preset.nominal_bpp < 3.0) ||
        read_u32(bytes, 32u) != preset.bytes_per_mcu ||
        y_bytes + cb_bytes + cr_bytes != preset.bytes_per_mcu ||
        y_record_bytes < 3u || (info.split_luma_8x8 && y_bytes % 4u != 0u) ||
        cb_bytes < 3u || cr_bytes < 3u) {
        throw std::runtime_error("Invalid DCTBS2 layout");
    }
    preset.y_bytes = y_bytes;
    preset.cb_bytes = cb_bytes;
    preset.cr_bytes = cr_bytes;
    info.preset = preset;
    const uint64_t count = static_cast<uint64_t>(info.mcu_columns) * info.mcu_rows;
    const uint64_t expected_payload = count * preset.bytes_per_mcu;
    if (count > UINT32_MAX || expected_payload != payload ||
        file_size != HEADER_BYTES + expected_payload + info.library_bytes) {
        throw std::runtime_error("Invalid DCTBS2 payload length");
    }
    info.mcu_count = static_cast<uint32_t>(count);
    return info;
}

DctInfo inspect_file(const std::vector<uint8_t> &bytes) {
    if (bytes.size() < HEADER_BYTES) {
        throw std::runtime_error("Invalid or truncated DCTBS2 file");
    }
    DctInfo info = inspect_header(bytes.data(), bytes.size());
    if (!info.library_enabled) {
        return info;
    }

    const size_t offset = HEADER_BYTES + info.payload_bytes;
    if (info.library_bytes < LIBRARY_HEADER_BYTES ||
        !std::equal(LIBRARY_MAGIC.begin(), LIBRARY_MAGIC.end(), bytes.data() + offset)) {
        throw std::runtime_error("Invalid DCT prototype library");
    }
    const uint8_t *library = bytes.data() + offset;
    info.library_version = read_u32(library, 8u);
    info.y_library_count = read_u32(library, 12u);
    info.cb_library_count = read_u32(library, 16u);
    info.cr_library_count = read_u32(library, 20u);
    info.y_library_record_bytes = read_u32(library, 24u);
    const bool header_reference = is_header_library_version(static_cast<int>(info.library_version));
    const bool sidecar_reference = is_sidecar_library_version(static_cast<int>(info.library_version));
    const bool tail_reference = info.library_version == LIBRARY_VERSION_TAIL_REFERENCE;
    const uint32_t maximum_entries = header_reference ? 3u : sidecar_reference ? 63u :
        info.coefficient_coding == COEFFICIENT_CODING_LEGACY ? 63u : 31u;
    const uint32_t expected_y_bytes = info.split_luma_8x8
        ? info.preset.y_bytes / 4u : info.preset.y_bytes;
    info.y_reference_bits = sidecar_reference
        ? sidecar_reference_bits(info.y_library_count) : 0u;
    info.cb_reference_bits = sidecar_reference
        ? sidecar_reference_bits(info.cb_library_count) : 0u;
    info.cr_reference_bits = sidecar_reference
        ? sidecar_reference_bits(info.cr_library_count) : 0u;
    const uint64_t y_reference_count = static_cast<uint64_t>(info.mcu_count) *
        (info.split_luma_8x8 ? 4u : 1u);
    const uint64_t y_reference_bytes =
        (y_reference_count * info.y_reference_bits + 7u) / 8u;
    const uint64_t cb_reference_bytes =
        (static_cast<uint64_t>(info.mcu_count) * info.cb_reference_bits + 7u) / 8u;
    const uint64_t cr_reference_bytes =
        (static_cast<uint64_t>(info.mcu_count) * info.cr_reference_bits + 7u) / 8u;
    const uint64_t total_reference_bytes =
        y_reference_bytes + cb_reference_bytes + cr_reference_bytes;
    const uint64_t expected_library_bytes = LIBRARY_HEADER_BYTES + total_reference_bytes +
        static_cast<uint64_t>(info.y_library_count) * expected_y_bytes +
        static_cast<uint64_t>(info.cb_library_count) * info.preset.cb_bytes +
        static_cast<uint64_t>(info.cr_library_count) * info.preset.cr_bytes;

    if ((!header_reference && !sidecar_reference && !tail_reference) ||
        info.y_library_count > maximum_entries || info.cb_library_count > maximum_entries ||
        info.cr_library_count > maximum_entries ||
        info.y_library_count + info.cb_library_count + info.cr_library_count == 0u ||
        info.y_library_record_bytes != expected_y_bytes ||
        read_u32(library, 28u) != info.library_bytes ||
        expected_library_bytes != info.library_bytes) {
        throw std::runtime_error("Invalid DCT prototype library layout");
    }

    info.y_reference_offset = static_cast<uint32_t>(LIBRARY_HEADER_BYTES);
    info.cb_reference_offset = static_cast<uint32_t>(LIBRARY_HEADER_BYTES + y_reference_bytes);
    info.cr_reference_offset = static_cast<uint32_t>(
        LIBRARY_HEADER_BYTES + y_reference_bytes + cb_reference_bytes
    );
    info.y_library_offset = static_cast<uint32_t>(LIBRARY_HEADER_BYTES + total_reference_bytes);
    info.cb_library_offset = info.y_library_offset + info.y_library_count * expected_y_bytes;
    info.cr_library_offset = info.cb_library_offset + info.cb_library_count * info.preset.cb_bytes;
    return info;
}

DctLibraryLayout make_library_layout(const DctInfo &info) {
    DctLibraryLayout layout;
    if (!info.library_enabled) {
        return layout;
    }
    layout.version = info.library_version;
    layout.y_count = info.y_library_count;
    layout.cb_count = info.cb_library_count;
    layout.cr_count = info.cr_library_count;
    layout.y_offset = info.y_library_offset;
    layout.cb_offset = info.cb_library_offset;
    layout.cr_offset = info.cr_library_offset;
    layout.y_record_bytes = info.y_library_record_bytes;
    layout.y_reference_offset = info.y_reference_offset;
    layout.cb_reference_offset = info.cb_reference_offset;
    layout.cr_reference_offset = info.cr_reference_offset;
    layout.y_reference_bits = info.y_reference_bits;
    layout.cb_reference_bits = info.cb_reference_bits;
    layout.cr_reference_bits = info.cr_reference_bits;
    return layout;
}

GpuResult encode_gpu(
    const std::vector<uint8_t> &rgb,
    uint32_t width,
    uint32_t height,
    const Preset &preset,
    uint32_t quality,
    bool auto_quality,
    uint32_t candidate_count,
    int coefficient_coding,
    bool zigzag_order
) {
    const bool split_luma_8x8 = preset.nominal_bpp >= 3.0;
    std::vector<uint8_t> header = make_header(
        width,
        height,
        preset,
        quality,
        auto_quality,
        split_luma_8x8,
        zigzag_order,
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
                true, zigzag_order, device_output.get()
            );
            cuda_check(cudaGetLastError(), "Launch split luma DCT kernel");
        }
    } else {
        encode_component_kernel<16, 16, false><<<count, CUDA_THREADS>>>(
            device_rgb.get(), width, height, columns, count,
            preset.bytes_per_mcu, 0u, preset.y_bytes, 0, 0,
            static_cast<int>(quality), coefficient_coding, true, zigzag_order,
            device_output.get()
        );
        cuda_check(cudaGetLastError(), "Launch luma DCT kernel");
    }
    encode_component_kernel<8, 8, true><<<count, 64>>>(
        device_rgb.get(), width, height, columns, count,
        preset.bytes_per_mcu, preset.y_bytes, preset.cb_bytes, 1, 0,
        static_cast<int>(quality), coefficient_coding, split_luma_8x8, zigzag_order,
        device_output.get()
    );
    cuda_check(cudaGetLastError(), "Launch Cb DCT kernel");
    encode_component_kernel<8, 8, true><<<count, 64>>>(
        device_rgb.get(), width, height, columns, count,
        preset.bytes_per_mcu, preset.y_bytes + preset.cb_bytes, preset.cr_bytes, 2,
        0, static_cast<int>(quality), coefficient_coding, split_luma_8x8, zigzag_order,
        device_output.get()
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
    const uint8_t *device_library = info.library_enabled
        ? device_file.get() + HEADER_BYTES + info.payload_bytes : nullptr;
    decode_image_kernel<<<info.mcu_count, CUDA_THREADS>>>(
        device_file.get(), device_library, make_library_layout(info),
        info.width, info.height, info.mcu_columns, info.mcu_count,
        info.preset, static_cast<int>(info.quality), info.split_luma_8x8,
        info.chroma_420, info.coefficient_coding, info.zigzag_order,
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
    const std::vector<uint8_t> &library,
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
    DeviceBuffer<uint8_t> device_library(std::max<size_t>(1u, library.size()));
    DeviceBuffer<uint8_t> device_rgba(4u);
    DeviceBuffer<int> device_error(1u);
    cuda_check(cudaMemcpy(
        device_record.get(), record.data(), record.size(), cudaMemcpyHostToDevice
    ), "Upload one MCU record");
    if (!library.empty()) {
        cuda_check(cudaMemcpy(
            device_library.get(), library.data(), library.size(), cudaMemcpyHostToDevice
        ), "Upload DCT prototype library");
    }
    cuda_check(cudaMemset(device_error.get(), 0, sizeof(int)), "Clear pixel decoder error flag");
    const uint32_t mcu_index = (y / MCU_HEIGHT) * info.mcu_columns + (x / MCU_WIDTH);
    sample_pixel_kernel<<<1, 1>>>(
        device_record.get(), info.library_enabled ? device_library.get() : nullptr,
        make_library_layout(info), info.preset, static_cast<int>(info.quality),
        info.split_luma_8x8, info.chroma_420, info.coefficient_coding,
        info.zigzag_order,
        mcu_index,
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

const char *coefficient_coding_name(int coding) {
    if (coding == COEFFICIENT_CODING_GROUPED_FRONT) return "grouped-5-front";
    if (coding == COEFFICIENT_CODING_MASKED_TAIL_8X8) return "masked-tail-8x8";
    if (coding == COEFFICIENT_CODING_MASKED_TAIL_IMPLICIT2_48) {
        return "masked-tail-implicit2-48";
    }
    if (coding == COEFFICIENT_CODING_DUAL_SKIP_FRONT) return "dual-scale-skip-front";
    if (coding == COEFFICIENT_CODING_DUAL_SKIP_EQUAL_2) return "dual-scale-skip-equal-2";
    if (coding == COEFFICIENT_CODING_SKIP_RLE_EQUAL_2) return "skip-rle-equal-2";
    if (coding == COEFFICIENT_CODING_GROUPED_EQUAL_2) return "grouped-5-equal-2";
    return "legacy";
}

int parse_coefficient_coding(const std::string &name) {
    if (name == "auto") return -1;
    if (name == "grouped-5-front") return COEFFICIENT_CODING_GROUPED_FRONT;
    if (name == "masked-tail-8x8") return COEFFICIENT_CODING_MASKED_TAIL_8X8;
    if (name == "masked-tail-implicit2-48") {
        return COEFFICIENT_CODING_MASKED_TAIL_IMPLICIT2_48;
    }
    throw std::runtime_error(
        "Coefficient coding must be auto, grouped-5-front, masked-tail-8x8, "
        "or masked-tail-implicit2-48"
    );
}

struct RatedEncoding {
    GpuResult encoded;
    GpuResult decoded;
    uint64_t error = UINT64_MAX;
    int coefficient_coding = COEFFICIENT_CODING_LEGACY;
    bool zigzag_order = false;
    Preset preset{};
};

RatedEncoding encode_best_coding(
    const std::vector<uint8_t> &rgb,
    uint32_t width,
    uint32_t height,
    const Preset &preset,
    uint32_t quality,
    bool auto_quality,
    uint32_t candidate_count,
    int requested_coding,
    const std::string &component_budget
) {
    const bool compare_masked = requested_coding < 0 && preset.nominal_bpp >= 6.0;
    const int coding_count = compare_masked
        ? (preset.mode_code == 9000u ? 5 : 3) : 1;
    RatedEncoding best;

    for (const Preset &allocation : component_budget_presets(preset, component_budget)) {
        const int first_coding = requested_coding >= 0
            ? requested_coding : default_coefficient_coding(allocation);
        for (int coding_index = 0; coding_index < coding_count; ++coding_index) {
            const int coding = coding_index == 0 ? first_coding
                : coding_index <= 2 ? COEFFICIENT_CODING_MASKED_TAIL_8X8
                : COEFFICIENT_CODING_MASKED_TAIL_IMPLICIT2_48;
            const bool zigzag_order = coding_index == 0 || (coding_index & 1) != 0;
            GpuResult encoded = encode_gpu(
                rgb, width, height, allocation, quality, auto_quality, candidate_count,
                coding, zigzag_order
            );
            const DctInfo info = inspect_file(encoded.bytes);
            GpuResult decoded = decode_gpu(encoded.bytes, info);
            const uint64_t error = squared_error(rgb, decoded.bytes);
            if (error < best.error) {
                best.encoded = std::move(encoded);
                best.decoded = std::move(decoded);
                best.error = error;
                best.coefficient_coding = coding;
                best.zigzag_order = zigzag_order;
                best.preset = allocation;
            }
        }
    }
    return best;
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
        "  --preset BPP       0.75, 1, 1.5, 2, 3, 4.5, 6, 7.5, or 9 (default 1.5)\n"
        "  --quality N        Quantization quality 1..100 (default 72)\n"
        "  --find-quality     Search CUDA candidates and maximize RGB PSNR\n"
        "  --find-settings    Alias for --find-quality\n"
        "  --component-budget MODE  fixed, fast, or expanded (default fast)\n"
        "  --coefficient-coding NAME  auto, grouped-5-front, masked-tail-8x8,\n"
        "                             or masked-tail-implicit2-48\n"
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
    std::string component_budget = "fast";
    int requested_coding = -1;
    int device = 0;
    for (int index = 4; index < argc; ++index) {
        const std::string option = argv[index];
        if (option == "--preset" && index + 1 < argc) {
            if (!parse_preset_name(argv[++index], &preset)) {
                throw std::runtime_error("Preset must be 0.75, 1, 1.5, 2, 3, 4.5, 6, 7.5, or 9");
            }
        } else if (option == "--quality" && index + 1 < argc) {
            quality = parse_u32(argv[++index], "quality");
            if (quality < 1u || quality > 100u) {
                throw std::runtime_error("Quality must be from 1 through 100");
            }
        } else if (option == "--find-quality" || option == "--find-settings") {
            find_quality = true;
        } else if (option == "--component-budget" && index + 1 < argc) {
            component_budget = argv[++index];
            if (component_budget != "fixed" && component_budget != "fast" &&
                component_budget != "expanded") {
                throw std::runtime_error("Component budget must be fixed, fast, or expanded");
            }
        } else if (option == "--coefficient-coding" && index + 1 < argc) {
            requested_coding = parse_coefficient_coding(argv[++index]);
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
            RatedEncoding rated = encode_best_coding(
                rgb, width, height, preset, candidate, true, 0u, requested_coding,
                component_budget
            );
            const uint64_t error = rated.error;
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
            RatedEncoding rated = encode_best_coding(
                rgb, width, height, preset, candidate, true, 0u, requested_coding,
                component_budget
            );
            const uint64_t error = rated.error;
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
        RatedEncoding rated = encode_best_coding(
            rgb, width, height, preset, quality, true, candidate_count, requested_coding,
            component_budget
        );
        selected = std::move(rated.encoded);
        selected_decoded = std::move(rated.decoded);
        selected_error = rated.error;
    } else {
        RatedEncoding rated = encode_best_coding(
            rgb, width, height, preset, quality, false, 0u, requested_coding,
            component_budget
        );
        selected = std::move(rated.encoded);
        selected_decoded = std::move(rated.decoded);
        selected_error = rated.error;
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
    const DctInfo selected_info = inspect_file(selected.bytes);
    std::cout << ", " << coefficient_coding_name(selected_info.coefficient_coding)
              << ", " << (selected_info.zigzag_order ? "zigzag order" : "legacy order")
              << ", Y" << selected_info.preset.y_bytes
              << "+Cb" << selected_info.preset.cb_bytes
              << "+Cr" << selected_info.preset.cr_bytes
              << ", chroma 4:2:0"
              << ", " << selected.bytes.size() << " bytes, " << std::fixed
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
              << ", " << (info.zigzag_order ? "zigzag order" : "legacy order")
              << ", chroma " << (info.chroma_420 ? "4:2:0" : "4:2:2 (legacy)")
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
    const std::vector<uint8_t> file = read_binary_file(argv[2]);
    const DctInfo info = inspect_file(file);
    if (x >= info.width || y >= info.height) {
        throw std::runtime_error("Pixel coordinate is outside the image");
    }
    const uint32_t mcu_index = (y / 16u) * info.mcu_columns + (x / 16u);
    const size_t offset = HEADER_BYTES + static_cast<size_t>(mcu_index) * info.preset.bytes_per_mcu;
    const std::vector<uint8_t> record(
        file.begin() + static_cast<std::ptrdiff_t>(offset),
        file.begin() + static_cast<std::ptrdiff_t>(offset + info.preset.bytes_per_mcu)
    );
    const size_t library_offset = HEADER_BYTES + info.payload_bytes;
    const std::vector<uint8_t> library = info.library_enabled
        ? std::vector<uint8_t>(
            file.begin() + static_cast<std::ptrdiff_t>(library_offset),
            file.end()
        )
        : std::vector<uint8_t>();
    select_device(device);
    const std::array<uint8_t, 4> rgba = sample_pixel_gpu(record, library, info, x, y);
    std::cout << "RGBA(" << x << ',' << y << ") = "
              << static_cast<unsigned int>(rgba[0]) << ' '
              << static_cast<unsigned int>(rgba[1]) << ' '
              << static_cast<unsigned int>(rgba[2]) << ' '
              << static_cast<unsigned int>(rgba[3]) << '\n'
              << "MCU " << mcu_index << ", byte offset " << offset
              << ", uploaded " << info.preset.bytes_per_mcu + library.size() << " bytes\n";
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
              << " actual bpp, Y" << info.preset.y_bytes
              << "+Cb" << info.preset.cb_bytes << "+Cr" << info.preset.cr_bytes
              << ", chroma "
              << (info.chroma_420 ? "4:2:0" : "4:2:2 (legacy)") << ", "
              << coefficient_coding_name(info.coefficient_coding) << ", "
              << (info.zigzag_order ? "zigzag order" : "legacy order");
    if (info.auto_quality) {
        std::cout << ", auto quality (" << info.search_candidate_count << " candidates)";
    }
    if (info.library_enabled) {
        std::cout << ", DCT library " << info.library_bytes << " bytes (Y "
                  << info.y_library_count << ", Cb " << info.cb_library_count
                  << ", Cr " << info.cr_library_count << ')';
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
