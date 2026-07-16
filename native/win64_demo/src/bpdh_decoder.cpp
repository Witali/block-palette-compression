#include "codec_internal.h"

#include <array>
#include <cmath>
#include <cstring>

namespace texture_demo::internal {
namespace {

constexpr std::size_t kHeaderBytes = 48;
constexpr std::uint8_t kFlagBpal = 1;
constexpr std::uint8_t kFlagDct = 2;
constexpr std::uint32_t kCodingUnit = 16;
constexpr std::array<int, 64> kZigZag = {
    0, 1, 8, 16, 9, 2, 3, 10,
    17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63,
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
    return value >= 0
        ? (value + divisor / 2) / divisor
        : -((-value + divisor / 2) / divisor);
}

std::uint8_t ClampIntByte(std::int64_t value) {
    return static_cast<std::uint8_t>(std::clamp<std::int64_t>(value, 0, 255));
}

std::array<std::int64_t, 64> InverseDctBlock(
    const std::array<std::int16_t, 64>& quantized,
    const std::uint8_t* table
) {
    std::array<std::int64_t, 64> horizontal{};
    std::array<std::int64_t, 64> samples{};
    for (int v = 0; v < 8; ++v) {
        for (int x = 0; x < 8; ++x) {
            std::int64_t sum = 0;
            for (int u = 0; u < 8; ++u) {
                const std::int64_t coefficient =
                    static_cast<std::int64_t>(quantized[v * 8 + u]) * table[v * 8 + u];
                sum += coefficient * kBasis[x][u];
            }
            horizontal[v * 8 + x] = RoundDivide(sum, 16384);
        }
    }
    for (int y = 0; y < 8; ++y) {
        for (int x = 0; x < 8; ++x) {
            std::int64_t sum = 0;
            for (int v = 0; v < 8; ++v) {
                sum += horizontal[v * 8 + x] * kBasis[y][v];
            }
            samples[y * 8 + x] = std::clamp<std::int64_t>(
                RoundDivide(sum, 4 * 16384) + 128,
                0,
                255
            );
        }
    }
    return samples;
}

std::int64_t SampleChroma(const std::array<std::int64_t, 64>& samples, int x, int y) {
    const int floor_x = x % 2 == 0 ? x / 2 - 1 : x / 2;
    const int floor_y = y % 2 == 0 ? y / 2 - 1 : y / 2;
    const int x0 = std::clamp(floor_x, 0, 7);
    const int y0 = std::clamp(floor_y, 0, 7);
    const int x1 = std::clamp(floor_x + 1, 0, 7);
    const int y1 = std::clamp(floor_y + 1, 0, 7);
    const int fraction_x = x % 2 == 0 ? 3 : 1;
    const int fraction_y = y % 2 == 0 ? 3 : 1;
    const std::int64_t top = (4 - fraction_x) * samples[y0 * 8 + x0] +
        fraction_x * samples[y0 * 8 + x1];
    const std::int64_t bottom = (4 - fraction_x) * samples[y1 * 8 + x0] +
        fraction_x * samples[y1 * 8 + x1];
    return RoundDivide((4 - fraction_y) * top + fraction_y * bottom, 16);
}

bool ReadUnsignedGolomb(MsbBitReader& reader, std::uint32_t& value) {
    std::uint32_t leading = 0;
    std::uint32_t bit = 0;
    while (true) {
        if (!reader.Read(1, bit)) return false;
        if (bit != 0) break;
        if (++leading > 30) return false;
    }
    std::uint32_t suffix = 0;
    if (!reader.Read(leading, suffix)) return false;
    value = (1u << leading) + suffix - 1u;
    return true;
}

bool ReadSignedGolomb(MsbBitReader& reader, std::int32_t& value) {
    std::uint32_t encoded = 0;
    if (!ReadUnsignedGolomb(reader, encoded)) return false;
    value = (encoded & 1u) != 0
        ? static_cast<std::int32_t>((encoded + 1u) / 2u)
        : -static_cast<std::int32_t>(encoded / 2u);
    return true;
}

bool ReadDctMacroblock(
    MsbBitReader& reader,
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
            block[kZigZag[zigzag]] = static_cast<std::int16_t>(coefficient);
            ++zigzag;
        }
    }
    return true;
}

void PaintDctMacroblock(
    MipLevel& level,
    std::uint32_t block_x,
    std::uint32_t block_y,
    const std::array<std::array<std::int16_t, 64>, 6>& blocks,
    const std::uint8_t* luma_table,
    const std::uint8_t* chroma_table
) {
    std::array<std::array<std::int64_t, 64>, 6> samples{};
    for (int block = 0; block < 6; ++block) {
        samples[block] = InverseDctBlock(blocks[block], block < 4 ? luma_table : chroma_table);
    }
    for (int local_y = 0; local_y < 16; ++local_y) {
        const std::uint32_t y = block_y * 16u + local_y;
        if (y >= level.height) break;
        for (int local_x = 0; local_x < 16; ++local_x) {
            const std::uint32_t x = block_x * 16u + local_x;
            if (x >= level.width) break;
            const int luma_block = (local_y / 8) * 2 + local_x / 8;
            const int luma_index = (local_y % 8) * 8 + local_x % 8;
            const std::int64_t luma = samples[luma_block][luma_index];
            const std::int64_t cb = SampleChroma(samples[4], local_x, local_y) - 128;
            const std::int64_t cr = SampleChroma(samples[5], local_x, local_y) - 128;
            const std::size_t offset = (static_cast<std::size_t>(y) * level.width + x) * 4u;
            level.rgba[offset] = ClampIntByte(luma + RoundDivide(91881 * cr, 65536));
            level.rgba[offset + 1] = ClampIntByte(
                luma + RoundDivide(-22554 * cb - 46802 * cr, 65536));
            level.rgba[offset + 2] = ClampIntByte(luma + RoundDivide(116130 * cb, 65536));
            level.rgba[offset + 3] = 255;
        }
    }
}

std::uint32_t Unpack565(std::uint16_t value) {
    const std::uint32_t red = static_cast<std::uint32_t>(std::floor(((value >> 11u) & 31u) * 255.0 / 31.0 + 0.5));
    const std::uint32_t green = static_cast<std::uint32_t>(std::floor(((value >> 5u) & 63u) * 255.0 / 63.0 + 0.5));
    const std::uint32_t blue = static_cast<std::uint32_t>(std::floor((value & 31u) * 255.0 / 31.0 + 0.5));
    return red | green << 8u | blue << 16u | 255u << 24u;
}

}  // namespace

bool DecodeBpdh(
    const std::uint8_t* bytes,
    std::size_t byte_count,
    TextureImage& image,
    std::wstring& error
) {
    if (byte_count < kHeaderBytes || std::memcmp(bytes, "BPDH", 4) != 0 ||
        bytes[4] != 1 || bytes[6] != 4 || bytes[7] != 0) {
        error = L"Invalid or unsupported BPDH header";
        return false;
    }
    const std::uint8_t flags = bytes[5];
    const bool has_bpal = (flags & kFlagBpal) != 0;
    const bool has_dct = (flags & kFlagDct) != 0;
    if ((flags & ~(kFlagBpal | kFlagDct)) != 0 || (!has_bpal && !has_dct)) {
        error = L"Invalid BPDH mode flags";
        return false;
    }
    const std::uint32_t width = ReadU32Le(bytes + 8);
    const std::uint32_t height = ReadU32Le(bytes + 12);
    const std::uint32_t local_bits = bytes[16];
    const std::uint32_t global_bits = bytes[17];
    const std::uint32_t palette_bits = bytes[18];
    const std::uint32_t color_bits = bytes[19];
    std::size_t rgba_size = 0;
    if (!CheckedRgbaSize(width, height, rgba_size, error)) return false;
    if (local_bits < 1 || local_bits > 8 || global_bits < 1 || global_bits > 12 ||
        palette_bits > 7 || (color_bits != 16 && color_bits != 24)) {
        error = L"Invalid BPDH palette metadata";
        return false;
    }

    const std::uint32_t local_count = 1u << local_bits;
    const std::uint32_t global_count = 1u << global_bits;
    const std::uint32_t palette_count = 1u << palette_bits;
    const std::uint32_t blocks_x = (width + 15u) / 16u;
    const std::uint32_t blocks_y = (height + 15u) / 16u;
    const std::uint32_t block_count = blocks_x * blocks_y;
    const std::uint32_t palette_bytes = ReadU32Le(bytes + 20);
    const std::uint32_t mode_bytes = ReadU32Le(bytes + 24);
    const std::uint32_t bpal_bytes = ReadU32Le(bytes + 28);
    const std::uint32_t bpal_bit_count = ReadU32Le(bytes + 32);
    const std::uint32_t quant_bytes = ReadU32Le(bytes + 36);
    const std::uint32_t dct_bytes = ReadU32Le(bytes + 40);
    const std::uint32_t dct_bits = ReadU32Le(bytes + 44);
    const std::uint64_t section_bytes = static_cast<std::uint64_t>(palette_bytes) + quant_bytes +
        mode_bytes + bpal_bytes + dct_bytes;
    if (kHeaderBytes + section_bytes != byte_count || bpal_bytes != (bpal_bit_count + 7u) / 8u ||
        dct_bytes != (dct_bits + 7u) / 8u) {
        error = L"BPDH section lengths are inconsistent";
        return false;
    }

    const std::size_t palette_offset = kHeaderBytes;
    const std::size_t quant_offset = palette_offset + palette_bytes;
    const std::size_t mode_offset = quant_offset + quant_bytes;
    const std::size_t bpal_offset = mode_offset + mode_bytes;
    const std::size_t dct_offset = bpal_offset + bpal_bytes;
    const std::uint32_t expected_palette_bytes = has_bpal
        ? palette_count * global_count * color_bits / 8u
        : 0;
    const std::uint32_t expected_mode_bytes = has_bpal && has_dct ? (block_count + 7u) / 8u : 0;
    if (palette_bytes != expected_palette_bytes || mode_bytes != expected_mode_bytes ||
        quant_bytes != (has_dct ? 128u : 0u)) {
        error = L"BPDH section layout does not match its modes";
        return false;
    }

    std::vector<std::uint8_t> modes(block_count, has_dct && !has_bpal ? 1u : 0u);
    if (has_bpal && has_dct) {
        for (std::uint32_t block = 0; block < block_count; ++block) {
            modes[block] = (bytes[mode_offset + block / 8u] >> (7u - block % 8u)) & 1u;
        }
    }
    const std::uint32_t bpal_blocks = static_cast<std::uint32_t>(
        std::count(modes.begin(), modes.end(), 0u));
    if ((has_bpal && bpal_blocks == 0) || (has_dct && bpal_blocks == block_count)) {
        error = L"BPDH mode map does not match its flags";
        return false;
    }

    std::uint64_t expected_bpal_bits = 0;
    for (std::uint32_t block = 0; block < block_count; ++block) {
        if (modes[block] != 0) continue;
        const std::uint32_t block_x = block % blocks_x;
        const std::uint32_t block_y = block / blocks_x;
        const std::uint32_t pixels_x = std::min(16u, width - block_x * 16u);
        const std::uint32_t pixels_y = std::min(16u, height - block_y * 16u);
        expected_bpal_bits += palette_bits + local_count * global_bits +
            static_cast<std::uint64_t>(pixels_x) * pixels_y * local_bits;
    }
    if (expected_bpal_bits != bpal_bit_count) {
        error = L"BPDH BPAL payload length is invalid";
        return false;
    }

    std::vector<std::uint32_t> palette(static_cast<std::size_t>(palette_count) * global_count);
    std::size_t palette_cursor = palette_offset;
    for (auto& color : palette) {
        if (color_bits == 16) {
            color = Unpack565(static_cast<std::uint16_t>(
                bytes[palette_cursor] << 8u | bytes[palette_cursor + 1]));
            palette_cursor += 2;
        } else {
            color = bytes[palette_cursor] |
                static_cast<std::uint32_t>(bytes[palette_cursor + 1]) << 8u |
                static_cast<std::uint32_t>(bytes[palette_cursor + 2]) << 16u |
                255u << 24u;
            palette_cursor += 3;
        }
    }

    std::vector<std::uint8_t> selectors(block_count);
    std::vector<std::uint16_t> block_indices(static_cast<std::size_t>(block_count) * local_count);
    std::vector<std::uint8_t> pixel_indices(static_cast<std::size_t>(width) * height);
    MsbBitReader bpal_reader(bytes + bpal_offset, bpal_bytes, bpal_bit_count);
    for (std::uint32_t block = 0; block < block_count; ++block) {
        if (modes[block] != 0) continue;
        std::uint32_t value = 0;
        if (!bpal_reader.Read(palette_bits, value) || value >= palette_count) {
            error = L"Invalid BPDH palette selector";
            return false;
        }
        selectors[block] = static_cast<std::uint8_t>(value);
        for (std::uint32_t local = 0; local < local_count; ++local) {
            if (!bpal_reader.Read(global_bits, value) || value >= global_count) {
                error = L"Invalid BPDH block palette index";
                return false;
            }
            block_indices[static_cast<std::size_t>(block) * local_count + local] =
                static_cast<std::uint16_t>(value);
        }
        const std::uint32_t start_x = (block % blocks_x) * 16u;
        const std::uint32_t start_y = (block / blocks_x) * 16u;
        const std::uint32_t end_x = std::min(start_x + 16u, width);
        const std::uint32_t end_y = std::min(start_y + 16u, height);
        for (std::uint32_t y = start_y; y < end_y; ++y) {
            for (std::uint32_t x = start_x; x < end_x; ++x) {
                if (!bpal_reader.Read(local_bits, value) || value >= local_count) {
                    error = L"Invalid BPDH local pixel index";
                    return false;
                }
                pixel_indices[static_cast<std::size_t>(y) * width + x] = static_cast<std::uint8_t>(value);
            }
        }
    }
    if (bpal_reader.offset() != bpal_reader.length()) {
        error = L"BPDH BPAL bitstream length mismatch";
        return false;
    }

    MipLevel level;
    level.width = width;
    level.height = height;
    level.rgba.resize(rgba_size);
    for (std::uint32_t block = 0; block < block_count; ++block) {
        const std::uint32_t block_x = block % blocks_x;
        const std::uint32_t block_y = block / blocks_x;
        if (modes[block] == 0) {
            const std::uint32_t start_x = block_x * 16u;
            const std::uint32_t start_y = block_y * 16u;
            for (std::uint32_t y = start_y; y < std::min(start_y + 16u, height); ++y) {
                for (std::uint32_t x = start_x; x < std::min(start_x + 16u, width); ++x) {
                    const std::size_t pixel = static_cast<std::size_t>(y) * width + x;
                    const std::uint32_t global = selectors[block] * global_count +
                        block_indices[static_cast<std::size_t>(block) * local_count + pixel_indices[pixel]];
                    const std::uint32_t color = palette[global];
                    const std::size_t out = pixel * 4u;
                    level.rgba[out] = static_cast<std::uint8_t>(color);
                    level.rgba[out + 1] = static_cast<std::uint8_t>(color >> 8u);
                    level.rgba[out + 2] = static_cast<std::uint8_t>(color >> 16u);
                    level.rgba[out + 3] = 255;
                }
            }
        }
    }

    MsbBitReader dct_reader(bytes + dct_offset, dct_bytes, dct_bits);
    for (std::uint32_t block = 0; block < block_count; ++block) {
        if (modes[block] == 0) continue;
        std::array<std::array<std::int16_t, 64>, 6> coefficients{};
        if (!ReadDctMacroblock(dct_reader, coefficients, error)) return false;
        PaintDctMacroblock(
            level,
            block % blocks_x,
            block / blocks_x,
            coefficients,
            bytes + quant_offset,
            bytes + quant_offset + 64
        );
    }
    if (dct_reader.offset() != dct_reader.length()) {
        error = L"BPDH DCT bitstream length mismatch";
        return false;
    }

    image = {};
    image.format = L"BPDH v1";
    image.mips.push_back(std::move(level));
    return true;
}

}  // namespace texture_demo::internal
