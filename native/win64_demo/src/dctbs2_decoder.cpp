#include "codec_internal.h"

#include <array>
#include <cmath>
#include <cstring>
#include <numeric>

namespace texture_demo::internal {
namespace {

constexpr std::size_t kHeaderBytes = 64;
constexpr std::uint32_t kFlagSplitLuma = 2;
constexpr std::uint32_t kFlagLibrary = 4;
constexpr std::uint32_t kFlagChroma420 = 8;
constexpr std::uint32_t kFlagZigzagOrder = 16;
constexpr std::uint32_t kCodingMask = 15u << 8u;
constexpr std::uint32_t kSupportedFlags =
    1u | kFlagSplitLuma | kFlagLibrary | kFlagChroma420 | kFlagZigzagOrder | kCodingMask;
constexpr std::array<int, 8> kScales = {1, 2, 4, 8, 16, 32, 64, 128};
constexpr std::array<int, 64> kLumaQuantization = {
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99,
};
constexpr std::array<int, 64> kChromaQuantization = {
    17, 18, 24, 47, 99, 99, 99, 99,
    18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
};

enum class SkipMode { None, Single, Dual };

struct Coding {
    int mantissa_bits;
    int group_count;
    bool front_grouping;
    SkipMode skip_mode;
};

constexpr std::array<Coding, 6> kCodings = {{
    {6, 0, false, SkipMode::None},
    {5, 2, false, SkipMode::None},
    {5, 3, true, SkipMode::None},
    {5, 2, false, SkipMode::Single},
    {5, 2, false, SkipMode::Dual},
    {5, 3, true, SkipMode::Dual},
}};

struct Preset {
    std::uint32_t mode;
    std::uint32_t bytes_per_mcu;
    std::uint32_t y_bytes;
    std::uint32_t cb_bytes;
    std::uint32_t cr_bytes;
    double bits_per_pixel;
};

constexpr std::array<Preset, 7> kPresets = {{
    {6000, 192, 128, 32, 32, 6.0},
    {4500, 144, 96, 24, 24, 4.5},
    {3000, 96, 64, 16, 16, 3.0},
    {2000, 64, 32, 16, 16, 2.0},
    {1500, 48, 24, 12, 12, 1.5},
    {1000, 32, 16, 8, 8, 1.0},
    {750, 24, 12, 6, 6, 0.75},
}};

struct ScanPosition {
    int position;
    int u;
    int v;
    double score;
};

struct SkipLayout {
    int token_count = 0;
    int coarse_count = 0;
    bool dual_scale = false;
};

double ScanScore(int profile, int u, int v) {
    if (profile == 1) return u + v * 2.4;
    if (profile == 2) return u * 2.4 + v;
    if (profile == 3) return std::max(u, v) * 1.45 + std::abs(u - v) * 0.1;
    return u + v + (((u + v) % 2 == 0) ? v : u) * 0.001;
}

double SkipScanScore(int profile, double u, double v) {
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

std::vector<int> CreateScan(int profile, int width, int height, bool skip) {
    std::vector<ScanPosition> positions;
    positions.reserve(static_cast<std::size_t>(width * height - 1));
    for (int v = 0; v < height; ++v) {
        for (int u = 0; u < width; ++u) {
            if (u == 0 && v == 0) continue;
            const double score = skip
                ? SkipScanScore(
                    profile,
                    width > 1 ? static_cast<double>(u) / (width - 1) : 0.0,
                    height > 1 ? static_cast<double>(v) / (height - 1) : 0.0)
                : ScanScore(profile, u, v);
            positions.push_back({v * width + u, u, v, score});
        }
    }
    std::sort(positions.begin(), positions.end(), [skip](const auto& left, const auto& right) {
        if (left.score != right.score) return left.score < right.score;
        const int left_diagonal = left.u + left.v;
        const int right_diagonal = right.u + right.v;
        if (left_diagonal != right_diagonal) return left_diagonal < right_diagonal;
        if (left.v != right.v) return left.v < right.v;
        return left.u < right.u;
    });
    std::vector<int> scan;
    scan.reserve(positions.size());
    for (const auto& item : positions) scan.push_back(item.position);
    return scan;
}

std::vector<int> CreateZigzagScan(int width, int height) {
    std::vector<int> scan;
    scan.reserve(static_cast<std::size_t>(width * height - 1));
    for (int diagonal = 0; diagonal <= width + height - 2; ++diagonal) {
        const int minimum_u = std::max(0, diagonal - height + 1);
        const int maximum_u = std::min(width - 1, diagonal);
        if ((diagonal & 1) == 0) {
            for (int u = minimum_u; u <= maximum_u; ++u) {
                const int v = diagonal - u;
                if (u != 0 || v != 0) scan.push_back(v * width + u);
            }
        } else {
            for (int u = maximum_u; u >= minimum_u; --u) {
                const int v = diagonal - u;
                if (u != 0 || v != 0) scan.push_back(v * width + u);
            }
        }
    }
    return scan;
}

std::vector<int> CreateProfileScan(
    int profile,
    int width,
    int height,
    bool skip,
    bool zigzag_order
) {
    if (zigzag_order) {
        if (profile == 0) return CreateZigzagScan(width, height);
        --profile;
    }
    return CreateScan(profile, width, height, skip);
}

double QuantizationStep(int u, int v, int width, int height, int quality, bool chroma) {
    const auto& table = chroma ? kChromaQuantization : kLumaQuantization;
    const int table_x = std::min(7, static_cast<int>(std::floor(
        static_cast<double>(u) * 7.0 / std::max(1, width - 1) + 0.5)));
    const int table_y = std::min(7, static_cast<int>(std::floor(
        static_cast<double>(v) * 7.0 / std::max(1, height - 1) + 0.5)));
    const double quality_scale = quality < 50 ? 50.0 / quality : 2.0 - quality * 0.02;
    const double dimension_scale = std::sqrt(static_cast<double>(width * height) / 64.0);
    return std::max(1.0, table[table_y * 8 + table_x] * quality_scale * dimension_scale);
}

SkipLayout GetSkipLayout(int byte_count, int width, int height, SkipMode mode) {
    const int payload_bits = byte_count * 8 - 18;
    if (mode == SkipMode::Single) {
        const int count = payload_bits / 8;
        return {count, count, false};
    }
    int token_count = 0;
    int coarse_count = 0;
    if (byte_count == 32) {
        token_count = 32;
        coarse_count = 16;
    } else if (byte_count == 24) {
        token_count = 24;
        coarse_count = width == 16 && height == 16 ? 12 : 11;
    } else if (byte_count == 16) {
        token_count = width == 16 && height == 16 ? 15 : 14;
        coarse_count = width == 16 && height == 16 ? 7 : 8;
    } else {
        token_count = payload_bits / 7;
        coarse_count = (token_count + 1) / 2;
        while (token_count > 0 && coarse_count * 8 + (token_count - coarse_count) * 6 > payload_bits) {
            --token_count;
            coarse_count = (token_count + 1) / 2;
        }
    }
    return {token_count, coarse_count, true};
}

std::vector<double> CreateBasis(int size) {
    std::vector<double> basis(static_cast<std::size_t>(size * size));
    constexpr double kPi = 3.14159265358979323846;
    for (int frequency = 0; frequency < size; ++frequency) {
        const double normalization = frequency == 0
            ? std::sqrt(1.0 / size)
            : std::sqrt(2.0 / size);
        for (int position = 0; position < size; ++position) {
            basis[frequency * size + position] = normalization *
                std::cos(kPi * (2 * position + 1) * frequency / (2 * size));
        }
    }
    return basis;
}

std::vector<double> InverseDct(const std::vector<double>& coefficients, int width, int height) {
    const auto basis_width = CreateBasis(width);
    const auto basis_height = CreateBasis(height);
    std::vector<double> vertical(static_cast<std::size_t>(width * height));
    std::vector<double> output(static_cast<std::size_t>(width * height));
    for (int y = 0; y < height; ++y) {
        for (int u = 0; u < width; ++u) {
            double sum = 0.0;
            for (int v = 0; v < height; ++v) {
                sum += basis_height[v * height + y] * coefficients[v * width + u];
            }
            vertical[y * width + u] = sum;
        }
    }
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            double sum = 0.0;
            for (int u = 0; u < width; ++u) {
                sum += vertical[y * width + u] * basis_width[u * width + x];
            }
            output[y * width + x] = sum;
        }
    }
    return output;
}

bool DecodeComponent(
    const std::uint8_t* bytes,
    int byte_count,
    int width,
    int height,
    int quality,
    bool chroma,
    const Coding& coding,
    bool zigzag_order,
    std::vector<double>& coefficients,
    std::wstring& error
) {
    MsbBitReader reader(bytes, static_cast<std::size_t>(byte_count));
    std::uint32_t header = 0;
    std::int32_t dc = 0;
    if (!reader.Read(8, header) || !reader.ReadSigned(10, dc)) {
        error = L"Truncated DCTBS2 component record";
        return false;
    }
    const int packed_profile = static_cast<int>(header >> 4u);
    const int packed_scale = static_cast<int>(header & 15u);
    const bool skip_record = coding.skip_mode != SkipMode::None && (packed_scale & 8) != 0;
    const int profile = packed_profile;
    const int scale_index = packed_scale & 7;
    if (profile >= (skip_record ? (zigzag_order ? 9 : 8) : (zigzag_order ? 5 : 4)) ||
        (!skip_record && packed_scale >= 8)) {
        error = L"Invalid DCTBS2 component profile";
        return false;
    }
    coefficients.assign(static_cast<std::size_t>(width * height), 0.0);
    coefficients[0] = dc * QuantizationStep(0, 0, width, height, quality, chroma) * kScales[scale_index];

    if (skip_record) {
        const SkipLayout layout = GetSkipLayout(byte_count, width, height, coding.skip_mode);
        const auto scan = CreateProfileScan(profile, width, height, true, zigzag_order);
        int scan_index = 0;
        if (layout.token_count < 1) {
            error = L"DCTBS2 component is too small for skip coding";
            return false;
        }
        for (int token = 0; token < layout.token_count; ++token) {
            if (scan_index >= static_cast<int>(scan.size())) {
                error = L"Invalid DCTBS2 skip traversal";
                return false;
            }
            const bool fine = layout.dual_scale && token >= layout.coarse_count;
            const int bits = fine ? 4 : 6;
            const int token_scale = fine ? (scale_index >= 3 ? 1 : 0) : scale_index;
            std::int32_t stored = 0;
            std::uint32_t skip = 0;
            if (!reader.ReadSigned(bits, stored) || !reader.Read(2, skip)) {
                error = L"Truncated DCTBS2 skip token";
                return false;
            }
            const int position = scan[scan_index];
            const int u = position % width;
            const int v = position / width;
            coefficients[position] = stored * QuantizationStep(u, v, width, height, quality, chroma) *
                kScales[token_scale];
            scan_index += static_cast<int>(skip) + 1;
        }
        return true;
    }

    int ac_count = 0;
    std::vector<int> group_ends;
    if (coding.group_count > 0) {
        ac_count = std::max(0, (byte_count * 8 - 18 - coding.group_count * 3) / coding.mantissa_bits);
        if (coding.front_grouping) {
            group_ends = {(ac_count + 5) / 6, (ac_count + 1) / 2, ac_count};
        } else {
            for (int group = 0; group < coding.group_count; ++group) {
                group_ends.push_back((group + 1) * ac_count / coding.group_count);
            }
        }
    } else {
        ac_count = std::max(0, (byte_count * 8 - 18) / 6);
        group_ends = {ac_count};
    }
    const auto scan = CreateProfileScan(profile, width, height, false, zigzag_order);
    if (ac_count > static_cast<int>(scan.size())) {
        error = L"DCTBS2 component coefficient count is invalid";
        return false;
    }

    std::vector<int> group_scales;
    if (coding.group_count > 0) {
        for (int group = 0; group < coding.group_count; ++group) {
            std::uint32_t value = 0;
            if (!reader.Read(3, value)) {
                error = L"Truncated DCTBS2 scale group";
                return false;
            }
            group_scales.push_back(static_cast<int>(value));
        }
    } else {
        group_scales.push_back(scale_index);
    }

    int start = 0;
    for (std::size_t group = 0; group < group_ends.size(); ++group) {
        for (int index = start; index < group_ends[group]; ++index) {
            std::int32_t stored = 0;
            if (!reader.ReadSigned(coding.mantissa_bits, stored)) {
                error = L"Truncated DCTBS2 coefficient data";
                return false;
            }
            const int position = scan[index];
            const int u = position % width;
            const int v = position / width;
            coefficients[position] = stored * QuantizationStep(u, v, width, height, quality, chroma) *
                kScales[group_scales[group]];
        }
        start = group_ends[group];
    }
    return true;
}

bool DecodeLuma(
    const std::uint8_t* bytes,
    int byte_count,
    int quality,
    bool split,
    const Coding& coding,
    bool zigzag_order,
    std::vector<double>& plane,
    std::wstring& error
) {
    if (!split) {
        std::vector<double> coefficients;
        if (!DecodeComponent(
                bytes, byte_count, 16, 16, quality, false, coding, zigzag_order,
                coefficients, error)) {
            return false;
        }
        plane = InverseDct(coefficients, 16, 16);
        return true;
    }
    if (byte_count % 4 != 0) {
        error = L"Invalid split-luma DCTBS2 record";
        return false;
    }
    const int block_bytes = byte_count / 4;
    plane.assign(256, 0.0);
    for (int block = 0; block < 4; ++block) {
        std::vector<double> coefficients;
        if (!DecodeComponent(
                bytes + block * block_bytes,
                block_bytes,
                8,
                8,
                quality,
                false,
                coding,
                zigzag_order,
                coefficients,
                error)) {
            return false;
        }
        const auto samples = InverseDct(coefficients, 8, 8);
        const int block_x = block % 2;
        const int block_y = block / 2;
        for (int y = 0; y < 8; ++y) {
            for (int x = 0; x < 8; ++x) {
                plane[(block_y * 8 + y) * 16 + block_x * 8 + x] = samples[y * 8 + x];
            }
        }
    }
    return true;
}

double SampleChroma(
    const std::vector<double>& plane,
    int local_x,
    int local_y,
    bool chroma420
) {
    if (!chroma420) {
        return plane[static_cast<std::size_t>(local_y) * 8u + local_x / 2];
    }
    const int floor_x = local_x % 2 == 0 ? local_x / 2 - 1 : local_x / 2;
    const int floor_y = local_y % 2 == 0 ? local_y / 2 - 1 : local_y / 2;
    const int x0 = std::clamp(floor_x, 0, 7);
    const int y0 = std::clamp(floor_y, 0, 7);
    const int x1 = std::clamp(floor_x + 1, 0, 7);
    const int y1 = std::clamp(floor_y + 1, 0, 7);
    const int fraction_x = local_x % 2 == 0 ? 3 : 1;
    const int fraction_y = local_y % 2 == 0 ? 3 : 1;
    const auto sample = [&plane](int x, int y) {
        return plane[static_cast<std::size_t>(y) * 8u + x];
    };
    const double top = (4 - fraction_x) * sample(x0, y0) + fraction_x * sample(x1, y0);
    const double bottom = (4 - fraction_x) * sample(x0, y1) + fraction_x * sample(x1, y1);
    return ((4 - fraction_y) * top + fraction_y * bottom) / 16.0;
}

}  // namespace

bool DecodeDctbs2(
    const std::uint8_t* bytes,
    std::size_t byte_count,
    TextureImage& image,
    std::wstring& error
) {
    static constexpr std::uint8_t kMagic[8] = {'D', 'C', 'T', 'B', 'S', '2', 0, 0};
    if (byte_count < kHeaderBytes || std::memcmp(bytes, kMagic, 8) != 0 || ReadU32Le(bytes + 8) != 2) {
        error = L"Invalid or unsupported DCTBS2 header";
        return false;
    }
    const std::uint32_t mode = ReadU32Le(bytes + 12);
    const auto preset_it = std::find_if(kPresets.begin(), kPresets.end(), [mode](const auto& value) {
        return value.mode == mode;
    });
    if (preset_it == kPresets.end()) {
        error = L"Unsupported DCTBS2 bitrate mode";
        return false;
    }
    const Preset& preset = *preset_it;
    const std::uint32_t width = ReadU32Le(bytes + 16);
    const std::uint32_t height = ReadU32Le(bytes + 20);
    const std::uint32_t columns = (width + 15u) / 16u;
    const std::uint32_t rows = (height + 15u) / 16u;
    const std::uint32_t quality = ReadU32Le(bytes + 48);
    const std::uint32_t flags = ReadU32Le(bytes + 52);
    const std::uint32_t payload_bytes = ReadU32Le(bytes + 56);
    const std::uint32_t library_bytes = (flags & kFlagLibrary) != 0 ? ReadU32Le(bytes + 60) : 0;
    const std::uint32_t coding_index = (flags & kCodingMask) >> 8u;
    std::size_t rgba_size = 0;
    if (!CheckedRgbaSize(width, height, rgba_size, error)) return false;
    if (quality < 1 || quality > 100 || coding_index >= kCodings.size() ||
        (flags & ~kSupportedFlags) != 0 ||
        ReadU32Le(bytes + 24) != columns || ReadU32Le(bytes + 28) != rows ||
        ReadU32Le(bytes + 32) != preset.bytes_per_mcu ||
        ReadU32Le(bytes + 36) != preset.y_bytes ||
        ReadU32Le(bytes + 40) != preset.cb_bytes ||
        ReadU32Le(bytes + 44) != preset.cr_bytes ||
        payload_bytes != static_cast<std::uint64_t>(columns) * rows * preset.bytes_per_mcu ||
        byte_count != kHeaderBytes + static_cast<std::uint64_t>(payload_bytes) + library_bytes) {
        error = L"DCTBS2 layout is inconsistent with its header";
        return false;
    }
    if ((flags & kFlagLibrary) != 0) {
        error = L"This demo does not yet support DCTBS2 prototype-library records";
        return false;
    }
    const bool split = (flags & kFlagSplitLuma) != 0;
    const bool chroma420 = (flags & kFlagChroma420) != 0;
    const bool zigzag_order = (flags & kFlagZigzagOrder) != 0;
    const int chroma_height = chroma420 ? 8 : 16;
    if (split && preset.bits_per_pixel < 3.0) {
        error = L"Invalid DCTBS2 split-luma mode";
        return false;
    }

    MipLevel level;
    level.width = width;
    level.height = height;
    level.rgba.resize(rgba_size);
    const Coding& coding = kCodings[coding_index];

    for (std::uint32_t mcu = 0; mcu < columns * rows; ++mcu) {
        const std::uint8_t* record = bytes + kHeaderBytes + static_cast<std::size_t>(mcu) * preset.bytes_per_mcu;
        std::vector<double> y_plane;
        std::vector<double> cb_coefficients;
        std::vector<double> cr_coefficients;
        if (!DecodeLuma(
                record, preset.y_bytes, quality, split, coding, zigzag_order,
                y_plane, error) ||
            !DecodeComponent(
                record + preset.y_bytes,
                preset.cb_bytes,
                8,
                chroma_height,
                quality,
                true,
                coding,
                zigzag_order,
                cb_coefficients,
                error) ||
            !DecodeComponent(
                record + preset.y_bytes + preset.cb_bytes,
                preset.cr_bytes,
                8,
                chroma_height,
                quality,
                true,
                coding,
                zigzag_order,
                cr_coefficients,
                error)) {
            return false;
        }
        const auto cb_plane = InverseDct(cb_coefficients, 8, chroma_height);
        const auto cr_plane = InverseDct(cr_coefficients, 8, chroma_height);
        const std::uint32_t mcu_x = mcu % columns;
        const std::uint32_t mcu_y = mcu / columns;
        for (std::uint32_t local_y = 0; local_y < 16; ++local_y) {
            const std::uint32_t y = mcu_y * 16u + local_y;
            if (y >= height) break;
            for (std::uint32_t local_x = 0; local_x < 16; ++local_x) {
                const std::uint32_t x = mcu_x * 16u + local_x;
                if (x >= width) break;
                const double yy = y_plane[static_cast<std::size_t>(local_y) * 16u + local_x] + 128.0;
                const double cb = SampleChroma(
                    cb_plane, static_cast<int>(local_x), static_cast<int>(local_y), chroma420
                );
                const double cr = SampleChroma(
                    cr_plane, static_cast<int>(local_x), static_cast<int>(local_y), chroma420
                );
                const std::size_t out = (static_cast<std::size_t>(y) * width + x) * 4u;
                level.rgba[out] = ClampByte(yy + 1.402 * cr);
                level.rgba[out + 1] = ClampByte(yy - 0.344136 * cb - 0.714136 * cr);
                level.rgba[out + 2] = ClampByte(yy + 1.772 * cb);
                level.rgba[out + 3] = 255;
            }
        }
    }

    image = {};
    image.format = L"DCTBS2 v2";
    image.mips.push_back(std::move(level));
    return true;
}

}  // namespace texture_demo::internal
