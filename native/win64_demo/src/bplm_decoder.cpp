#include "codec_internal.h"

#include "bpal5.h"

#include <cstring>
#include <memory>

namespace texture_demo::internal {
namespace {

constexpr std::size_t kHeaderBytes = 12;
constexpr std::size_t kLevelHeaderBytes = 16;

struct BpalImageGuard {
    bpal5_image image{};
    ~BpalImageGuard() { bpal5_image_free(&image); }
};

std::wstring WidenAscii(const char* text) {
    std::wstring result;
    while (text != nullptr && *text != '\0') {
        result.push_back(static_cast<unsigned char>(*text));
        ++text;
    }
    return result;
}

bool DecodeBaseMip(
    const bpal5_image& base,
    MipLevel& level,
    std::wstring& error
) {
    std::uint8_t* rgba = nullptr;
    std::size_t rgba_size = 0;
    char codec_error[256]{};
    if (!bpal5_decode_rgba(
            &base,
            0,
            &rgba,
            &rgba_size,
            codec_error,
            sizeof(codec_error))) {
        error = WidenAscii(codec_error);
        return false;
    }
    level.width = base.width;
    level.height = base.height;
    level.rgba.assign(rgba, rgba + rgba_size);
    bpal5_free(rgba);
    return true;
}

bool ReadIndex(MsbBitReader& reader, std::uint32_t bits, std::uint32_t limit, std::uint32_t& value) {
    return reader.Read(bits, value) && value < limit;
}

void WritePaletteColor(
    std::vector<std::uint8_t>& rgba,
    std::size_t pixel,
    std::uint32_t packed
) {
    const std::size_t offset = pixel * 4u;
    rgba[offset] = static_cast<std::uint8_t>(packed & 255u);
    rgba[offset + 1] = static_cast<std::uint8_t>((packed >> 8u) & 255u);
    rgba[offset + 2] = static_cast<std::uint8_t>((packed >> 16u) & 255u);
    rgba[offset + 3] = 255;
}

}  // namespace

bool DecodeBplm(
    const std::uint8_t* bytes,
    std::size_t byte_count,
    TextureImage& image,
    std::wstring& error
) {
    if (byte_count < kHeaderBytes || std::memcmp(bytes, "BPLM", 4) != 0) {
        error = L"Invalid or truncated BPLM header";
        return false;
    }
    const std::uint8_t version = bytes[4];
    const std::uint8_t mip_count = bytes[5];
    const std::uint16_t flags = ReadU16Le(bytes + 6);
    const std::uint32_t base_bytes = ReadU32Le(bytes + 8);
    if (version != 1 || mip_count == 0 || flags != 0 ||
        base_bytes == 0 || base_bytes > byte_count - kHeaderBytes) {
        error = L"Unsupported or inconsistent BPLM metadata";
        return false;
    }

    BpalImageGuard base;
    char codec_error[256]{};
    if (!bpal5_parse(
            bytes + kHeaderBytes,
            base_bytes,
            &base.image,
            codec_error,
            sizeof(codec_error))) {
        error = L"BPLM base BPAL: " + WidenAscii(codec_error);
        return false;
    }

    TextureImage decoded;
    decoded.format = L"BPLM v1";
    MipLevel base_level;
    if (!DecodeBaseMip(base.image, base_level, error)) {
        return false;
    }
    decoded.mips.push_back(std::move(base_level));

    std::size_t offset = kHeaderBytes + base_bytes;
    std::uint32_t previous_width = base.image.width;
    std::uint32_t previous_height = base.image.height;
    std::uint32_t previous_block_size = base.image.block_size;

    for (std::uint32_t mip = 1; mip < mip_count; ++mip) {
        if (offset > byte_count || byte_count - offset < kLevelHeaderBytes) {
            error = L"Truncated BPLM mip header";
            return false;
        }
        const std::uint32_t width = ReadU32Le(bytes + offset);
        const std::uint32_t height = ReadU32Le(bytes + offset + 4);
        const std::uint32_t block_size = ReadU16Le(bytes + offset + 8);
        const std::uint16_t level_flags = ReadU16Le(bytes + offset + 10);
        const std::uint32_t payload_bytes = ReadU32Le(bytes + offset + 12);
        const std::uint32_t expected_width = std::max(1u, previous_width / 2u);
        const std::uint32_t expected_height = std::max(1u, previous_height / 2u);
        const std::uint32_t expected_block = std::max(1u, previous_block_size / 2u);
        if (width != expected_width || height != expected_height ||
            block_size != expected_block || level_flags != 0 ||
            block_size == 0 || (block_size & (block_size - 1u)) != 0) {
            error = L"Invalid BPLM mip progression";
            return false;
        }

        const std::uint32_t local_colors = std::min(
            base.image.local_color_count,
            block_size * block_size
        );
        const bool direct = local_colors == block_size * block_size;
        std::uint32_t local_bits = 0;
        for (std::uint32_t value = local_colors; value > 1; value >>= 1u) {
            ++local_bits;
        }
        const std::uint32_t blocks_x = (width + block_size - 1u) / block_size;
        const std::uint32_t blocks_y = (height + block_size - 1u) / block_size;
        const std::uint64_t block_count = static_cast<std::uint64_t>(blocks_x) * blocks_y;
        const std::uint64_t pixel_count = static_cast<std::uint64_t>(width) * height;
        const std::uint64_t entry_count = direct
            ? pixel_count
            : block_count * local_colors;
        const std::uint64_t payload_bits = direct
            ? pixel_count * (base.image.global_index_bits + base.image.palette_index_bits)
            : block_count * base.image.palette_index_bits +
                entry_count * base.image.global_index_bits + pixel_count * local_bits;
        const std::uint64_t expected_payload_bytes = (payload_bits + 7u) / 8u;
        const std::size_t payload_offset = offset + kLevelHeaderBytes;
        if (payload_bytes != expected_payload_bytes || payload_offset > byte_count ||
            payload_bytes > byte_count - payload_offset) {
            error = L"BPLM mip payload size does not match its header";
            return false;
        }

        std::size_t rgba_size = 0;
        if (!CheckedRgbaSize(width, height, rgba_size, error)) {
            return false;
        }
        MipLevel level;
        level.width = width;
        level.height = height;
        level.rgba.resize(rgba_size);
        MsbBitReader reader(bytes + payload_offset, payload_bytes, payload_bits);

        if (direct) {
            const std::uint32_t palette_limit = base.image.palette_count * base.image.global_color_count;
            for (std::size_t pixel = 0; pixel < static_cast<std::size_t>(pixel_count); ++pixel) {
                std::uint32_t global = 0;
                if (!ReadIndex(
                        reader,
                        base.image.global_index_bits + base.image.palette_index_bits,
                        palette_limit,
                        global)) {
                    error = L"Invalid direct BPLM palette index";
                    return false;
                }
                WritePaletteColor(level.rgba, pixel, base.image.palette_rgba[global]);
            }
        } else {
            std::vector<std::uint8_t> selectors(static_cast<std::size_t>(block_count));
            std::vector<std::uint16_t> block_indices(static_cast<std::size_t>(entry_count));
            std::vector<std::uint8_t> pixel_indices(static_cast<std::size_t>(pixel_count));
            for (auto& selector : selectors) {
                std::uint32_t value = 0;
                if (!ReadIndex(reader, base.image.palette_index_bits, base.image.palette_count, value)) {
                    error = L"Invalid BPLM palette selector";
                    return false;
                }
                selector = static_cast<std::uint8_t>(value);
            }
            for (auto& index : block_indices) {
                std::uint32_t value = 0;
                if (!ReadIndex(reader, base.image.global_index_bits, base.image.global_color_count, value)) {
                    error = L"Invalid BPLM block palette index";
                    return false;
                }
                index = static_cast<std::uint16_t>(value);
            }
            for (auto& index : pixel_indices) {
                std::uint32_t value = 0;
                if (!ReadIndex(reader, local_bits, local_colors, value)) {
                    error = L"Invalid BPLM local pixel index";
                    return false;
                }
                index = static_cast<std::uint8_t>(value);
            }

            for (std::uint32_t y = 0; y < height; ++y) {
                for (std::uint32_t x = 0; x < width; ++x) {
                    const std::size_t pixel = static_cast<std::size_t>(y) * width + x;
                    const std::size_t block = static_cast<std::size_t>(y / block_size) * blocks_x + x / block_size;
                    const std::uint32_t global =
                        selectors[block] * base.image.global_color_count +
                        block_indices[block * local_colors + pixel_indices[pixel]];
                    WritePaletteColor(level.rgba, pixel, base.image.palette_rgba[global]);
                }
            }
        }

        decoded.mips.push_back(std::move(level));
        offset = payload_offset + payload_bytes;
        previous_width = width;
        previous_height = height;
        previous_block_size = block_size;
    }

    if (offset != byte_count) {
        error = L"BPLM file has trailing data";
        return false;
    }
    image = std::move(decoded);
    return true;
}

}  // namespace texture_demo::internal
