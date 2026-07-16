#include "shader_texture.h"

#include "codec_internal.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>

namespace texture_demo::detail {
namespace {

constexpr std::size_t kHeaderBytes = 48;
constexpr std::uint8_t kFlagBpal = 1;
constexpr std::uint8_t kFlagDct = 2;
constexpr std::uint32_t kUnit = 16;
constexpr std::uint32_t kMapStride = 4;
constexpr std::uint32_t kDctStride = 6 * 64;
constexpr std::array<int, 64> kZigZag = {
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
};
constexpr std::array<std::array<std::int32_t, 8>, 8> kBasis = {{
    {{11585, 16069, 15137, 13623, 11585, 9102, 6270, 3196}},
    {{11585, 13623, 6270, -3196, -11585, -16069, -15137, -9102}},
    {{11585, 9102, -6270, -16069, -11585, 3196, 15137, 13623}},
    {{11585, 3196, -15137, -9102, 11585, 13623, -6270, -16069}},
    {{11585, -3196, -15137, 9102, 11585, -13623, -6270, 16069}},
    {{11585, -9102, -6270, 16069, -11585, -3196, 15137, -13623}},
    {{11585, -13623, 6270, 3196, -11585, 16069, -15137, 9102}},
    {{11585, -16069, 15137, -13623, 11585, -9102, 6270, -3196}},
}};

std::int64_t RoundDivide(std::int64_t value, std::int64_t divisor) {
    return value >= 0 ? (value + divisor / 2) / divisor : -((-value + divisor / 2) / divisor);
}

bool ReadUnsignedGolomb(internal::MsbBitReader& reader, std::uint32_t& value) {
    std::uint32_t leading = 0;
    std::uint32_t bit = 0;
    do {
        if (!reader.Read(1, bit) || (bit == 0 && ++leading > 30)) return false;
    } while (bit == 0);
    std::uint32_t suffix = 0;
    if (!reader.Read(leading, suffix)) return false;
    value = (1u << leading) + suffix - 1u;
    return true;
}

bool ReadSignedGolomb(internal::MsbBitReader& reader, std::int32_t& value) {
    std::uint32_t encoded = 0;
    if (!ReadUnsignedGolomb(reader, encoded)) return false;
    value = (encoded & 1u) != 0
        ? static_cast<std::int32_t>((encoded + 1u) / 2u)
        : -static_cast<std::int32_t>(encoded / 2u);
    return true;
}

bool ReadDctMacroblock(
    internal::MsbBitReader& reader,
    std::array<std::array<std::int16_t, 64>, 6>& blocks,
    std::wstring& error
) {
    for (auto& block : blocks) {
        std::int32_t dc = 0;
        if (!ReadSignedGolomb(reader, dc) || dc < -32768 || dc > 32767) {
            error = L"Invalid BPDH DCT DC coefficient";
            return false;
        }
        block.fill(0);
        block[0] = static_cast<std::int16_t>(dc);
        int zigzag = 1;
        while (true) {
            std::uint32_t end = 0;
            if (!reader.Read(1, end)) {
                error = L"Truncated BPDH DCT block";
                return false;
            }
            if (end != 0) break;
            std::uint32_t run = 0;
            std::int32_t coefficient = 0;
            if (!ReadUnsignedGolomb(reader, run) || run > 63 ||
                zigzag + static_cast<int>(run) >= 64 ||
                !ReadSignedGolomb(reader, coefficient) || coefficient == 0 ||
                coefficient < -32768 || coefficient > 32767) {
                error = L"Invalid BPDH DCT AC coefficient";
                return false;
            }
            zigzag += static_cast<int>(run);
            block[kZigZag[zigzag++]] = static_cast<std::int16_t>(coefficient);
        }
    }
    return true;
}

std::array<std::uint8_t, 64> InverseDct(
    const std::array<std::int16_t, 64>& quantized,
    const std::uint8_t* table
) {
    std::array<std::int64_t, 64> horizontal{};
    std::array<std::uint8_t, 64> samples{};
    for (int v = 0; v < 8; ++v) {
        for (int x = 0; x < 8; ++x) {
            std::int64_t sum = 0;
            for (int u = 0; u < 8; ++u) {
                sum += static_cast<std::int64_t>(quantized[v * 8 + u]) *
                    table[v * 8 + u] * kBasis[x][u];
            }
            horizontal[v * 8 + x] = RoundDivide(sum, 16384);
        }
    }
    for (int y = 0; y < 8; ++y) {
        for (int x = 0; x < 8; ++x) {
            std::int64_t sum = 0;
            for (int v = 0; v < 8; ++v) sum += horizontal[v * 8 + x] * kBasis[y][v];
            samples[y * 8 + x] = static_cast<std::uint8_t>(
                std::clamp<std::int64_t>(RoundDivide(sum, 4 * 16384) + 128, 0, 255));
        }
    }
    return samples;
}

std::uint32_t AppendAligned(std::vector<std::uint8_t>& data, std::size_t bytes) {
    data.resize((data.size() + 3u) & ~std::size_t(3u));
    const auto offset = static_cast<std::uint32_t>(data.size());
    data.resize(data.size() + bytes);
    return offset;
}

void WriteU16(std::vector<std::uint8_t>& data, std::size_t offset, std::uint32_t value) {
    data[offset] = static_cast<std::uint8_t>(value);
    data[offset + 1] = static_cast<std::uint8_t>(value >> 8u);
}

std::uint32_t Unpack565(std::uint16_t value) {
    const auto r = static_cast<std::uint32_t>(std::floor(((value >> 11u) & 31u) * 255.0 / 31.0 + 0.5));
    const auto g = static_cast<std::uint32_t>(std::floor(((value >> 5u) & 63u) * 255.0 / 63.0 + 0.5));
    const auto b = static_cast<std::uint32_t>(std::floor((value & 31u) * 255.0 / 31.0 + 0.5));
    return r | g << 8u | b << 16u | 255u << 24u;
}

}  // namespace

bool ParseBpdhShader(
    const std::uint8_t* bytes,
    std::size_t byte_count,
    ShaderTexture& texture,
    std::wstring& error
) {
    if (byte_count < kHeaderBytes || std::memcmp(bytes, "BPDH", 4) != 0 ||
        bytes[4] != 1 || bytes[6] != 4 || bytes[7] != 0) {
        error = L"Invalid or unsupported BPDH header";
        return false;
    }
    const std::uint8_t mode_flags = bytes[5];
    const bool has_bpal = (mode_flags & kFlagBpal) != 0;
    const bool has_dct = (mode_flags & kFlagDct) != 0;
    const std::uint32_t width = internal::ReadU32Le(bytes + 8);
    const std::uint32_t height = internal::ReadU32Le(bytes + 12);
    const std::uint32_t local_bits = bytes[16];
    const std::uint32_t global_bits = bytes[17];
    const std::uint32_t palette_bits = bytes[18];
    const std::uint32_t color_bits = bytes[19];
    if ((mode_flags & ~(kFlagBpal | kFlagDct)) != 0 || (!has_bpal && !has_dct) ||
        width == 0 || height == 0 || width > internal::kMaximumTextureDimension ||
        height > internal::kMaximumTextureDimension || local_bits < 1 || local_bits > 8 ||
        global_bits < 1 || global_bits > 12 || palette_bits > 7 ||
        (color_bits != 16 && color_bits != 24)) {
        error = L"Invalid BPDH metadata";
        return false;
    }
    const std::uint32_t local_count = 1u << local_bits;
    const std::uint32_t global_count = 1u << global_bits;
    const std::uint32_t palette_count = 1u << palette_bits;
    const std::uint32_t blocks_x = (width + 15u) / 16u;
    const std::uint32_t blocks_y = (height + 15u) / 16u;
    const std::uint32_t block_count = blocks_x * blocks_y;
    const std::uint32_t palette_bytes = internal::ReadU32Le(bytes + 20);
    const std::uint32_t mode_bytes = internal::ReadU32Le(bytes + 24);
    const std::uint32_t bpal_bytes = internal::ReadU32Le(bytes + 28);
    const std::uint32_t bpal_bits = internal::ReadU32Le(bytes + 32);
    const std::uint32_t quant_bytes = internal::ReadU32Le(bytes + 36);
    const std::uint32_t dct_bytes = internal::ReadU32Le(bytes + 40);
    const std::uint32_t dct_bits = internal::ReadU32Le(bytes + 44);
    const std::uint64_t sections = static_cast<std::uint64_t>(palette_bytes) + mode_bytes +
        bpal_bytes + quant_bytes + dct_bytes;
    if (kHeaderBytes + sections != byte_count || bpal_bytes != (bpal_bits + 7u) / 8u ||
        dct_bytes != (dct_bits + 7u) / 8u ||
        palette_bytes != (has_bpal ? palette_count * global_count * color_bits / 8u : 0u) ||
        quant_bytes != (has_dct ? 128u : 0u) ||
        mode_bytes != (has_bpal && has_dct ? (block_count + 7u) / 8u : 0u)) {
        error = L"BPDH section layout is inconsistent";
        return false;
    }
    const std::size_t palette_source = kHeaderBytes;
    const std::size_t quant_source = palette_source + palette_bytes;
    const std::size_t mode_source = quant_source + quant_bytes;
    const std::size_t bpal_source = mode_source + mode_bytes;
    const std::size_t dct_source = bpal_source + bpal_bytes;

    std::vector<std::uint8_t> modes(block_count, has_dct && !has_bpal ? 1u : 0u);
    if (has_bpal && has_dct) {
        for (std::uint32_t block = 0; block < block_count; ++block) {
            modes[block] = (bytes[mode_source + block / 8u] >> (7u - block % 8u)) & 1u;
        }
    }
    const std::uint32_t bpal_count = static_cast<std::uint32_t>(
        std::count(modes.begin(), modes.end(), 0u));
    const std::uint32_t dct_count = block_count - bpal_count;
    if ((has_bpal && bpal_count == 0) || (has_dct && dct_count == 0)) {
        error = L"BPDH mode map does not match flags";
        return false;
    }

    texture = {};
    texture.kind = ShaderTextureKind::Bpdh;
    texture.format = L"BPDH v1 (shader coordinate cache)";
    texture.width = width;
    texture.height = height;
    texture.mip_count = 1;
    texture.source_bytes = byte_count;
    const std::uint32_t palette_offset = AppendAligned(texture.data,
        static_cast<std::size_t>(palette_count) * global_count * 4u);
    std::size_t source = palette_source;
    for (std::uint32_t index = 0; index < palette_count * global_count; ++index) {
        std::uint32_t color = 0;
        if (color_bits == 16) {
            color = Unpack565(static_cast<std::uint16_t>(bytes[source] << 8u | bytes[source + 1]));
            source += 2;
        } else {
            color = bytes[source] | static_cast<std::uint32_t>(bytes[source + 1]) << 8u |
                static_cast<std::uint32_t>(bytes[source + 2]) << 16u | 255u << 24u;
            source += 3;
        }
        std::memcpy(texture.data.data() + palette_offset + index * 4u, &color, sizeof(color));
    }
    const std::uint32_t map_offset = AppendAligned(texture.data,
        static_cast<std::size_t>(block_count) * kMapStride);
    const std::uint32_t bpal_stride = 1u + local_count * 2u + 256u;
    const std::uint32_t bpal_offset = AppendAligned(texture.data,
        static_cast<std::size_t>(bpal_count) * bpal_stride);
    const std::uint32_t dct_offset = AppendAligned(texture.data,
        static_cast<std::size_t>(dct_count) * kDctStride);

    internal::MsbBitReader bpal_reader(bytes + bpal_source, bpal_bytes, bpal_bits);
    std::uint32_t bpal_record = 0;
    std::uint32_t dct_record = 0;
    for (std::uint32_t block = 0; block < block_count; ++block) {
        const std::size_t map = map_offset + static_cast<std::size_t>(block) * kMapStride;
        if (modes[block] != 0) {
            texture.data[map] = 1;
            texture.data[map + 1] = static_cast<std::uint8_t>(dct_record);
            texture.data[map + 2] = static_cast<std::uint8_t>(dct_record >> 8u);
            texture.data[map + 3] = static_cast<std::uint8_t>(dct_record >> 16u);
            ++dct_record;
            continue;
        }
        texture.data[map] = 0;
        texture.data[map + 1] = static_cast<std::uint8_t>(bpal_record);
        texture.data[map + 2] = static_cast<std::uint8_t>(bpal_record >> 8u);
        texture.data[map + 3] = static_cast<std::uint8_t>(bpal_record >> 16u);
        const std::size_t record = bpal_offset + static_cast<std::size_t>(bpal_record) * bpal_stride;
        std::uint32_t value = 0;
        if (!bpal_reader.Read(palette_bits, value) || value >= palette_count) {
            error = L"Invalid BPDH palette selector";
            return false;
        }
        texture.data[record] = static_cast<std::uint8_t>(value);
        for (std::uint32_t local = 0; local < local_count; ++local) {
            if (!bpal_reader.Read(global_bits, value) || value >= global_count) {
                error = L"Invalid BPDH block palette index";
                return false;
            }
            WriteU16(texture.data, record + 1u + local * 2u, value);
        }
        const std::uint32_t block_x = block % blocks_x;
        const std::uint32_t block_y = block / blocks_x;
        for (std::uint32_t local_y = 0; local_y < 16; ++local_y) {
            const std::uint32_t y = block_y * 16u + local_y;
            if (y >= height) break;
            for (std::uint32_t local_x = 0; local_x < 16; ++local_x) {
                const std::uint32_t x = block_x * 16u + local_x;
                if (x >= width) break;
                if (!bpal_reader.Read(local_bits, value) || value >= local_count) {
                    error = L"Invalid BPDH local pixel index";
                    return false;
                }
                texture.data[record + 1u + local_count * 2u + local_y * 16u + local_x] =
                    static_cast<std::uint8_t>(value);
            }
        }
        ++bpal_record;
    }
    if (bpal_reader.offset() != bpal_reader.length()) {
        error = L"BPDH palette bitstream length mismatch";
        return false;
    }

    internal::MsbBitReader dct_reader(bytes + dct_source, dct_bytes, dct_bits);
    dct_record = 0;
    for (std::uint32_t block = 0; block < block_count; ++block) {
        if (modes[block] == 0) continue;
        std::array<std::array<std::int16_t, 64>, 6> coefficients{};
        if (!ReadDctMacroblock(dct_reader, coefficients, error)) return false;
        const std::size_t record = dct_offset + static_cast<std::size_t>(dct_record++) * kDctStride;
        for (int component = 0; component < 6; ++component) {
            const auto samples = InverseDct(
                coefficients[component],
                bytes + quant_source + (component < 4 ? 0 : 64));
            std::copy(samples.begin(), samples.end(), texture.data.begin() + record + component * 64u);
        }
    }
    if (dct_reader.offset() != dct_reader.length()) {
        error = L"BPDH DCT bitstream length mismatch";
        return false;
    }
    texture.data.resize((texture.data.size() + 3u) & ~std::size_t(3u));
    texture.metadata = {
        static_cast<std::uint32_t>(texture.kind), width, height, 1u,
        palette_offset, 0u, 0u, 0u,
        blocks_x, local_count, global_count, palette_count,
        map_offset, bpal_offset, bpal_stride, dct_offset, kDctStride,
        bpal_count, dct_count,
    };
    return true;
}

}  // namespace texture_demo::detail
