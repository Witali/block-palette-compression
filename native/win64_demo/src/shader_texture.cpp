#include "shader_texture.h"

#include "codec_internal.h"
#include "bpal5.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <fstream>
#include <limits>

namespace texture_demo {
namespace detail {
bool ParseBpdhShader(
    const std::uint8_t* bytes,
    std::size_t byte_count,
    ShaderTexture& texture,
    std::wstring& error
);
}
namespace {

using internal::MsbBitReader;
using internal::ReadU16Le;
using internal::ReadU32Le;

constexpr std::uint32_t kDirectIndices = 1u;
constexpr std::size_t kBplmHeaderBytes = 12;
constexpr std::size_t kBplmLevelHeaderBytes = 16;

struct BpalGuard {
    bpal5_image image{};
    ~BpalGuard() { bpal5_image_free(&image); }
};

std::wstring Widen(const char* text) {
    std::wstring result;
    while (text != nullptr && *text != '\0') result.push_back(static_cast<unsigned char>(*text++));
    return result;
}

void AlignData(std::vector<std::uint8_t>& data, std::size_t alignment) {
    data.resize((data.size() + alignment - 1u) & ~(alignment - 1u));
}

template <typename T>
std::uint32_t AppendValues(std::vector<std::uint8_t>& data, const T* values, std::size_t count) {
    AlignData(data, alignof(T));
    const auto offset = static_cast<std::uint32_t>(data.size());
    const auto* first = reinterpret_cast<const std::uint8_t*>(values);
    data.insert(data.end(), first, first + count * sizeof(T));
    return offset;
}

void AddMipMetadata(
    ShaderTexture& texture,
    std::uint32_t width,
    std::uint32_t height,
    std::uint32_t block_size,
    std::uint32_t blocks_x,
    std::uint32_t selector_offset,
    std::uint32_t block_offset,
    std::uint32_t pixel_offset,
    std::uint32_t flags,
    std::uint32_t local_count,
    std::uint32_t global_count,
    std::uint32_t palette_count
) {
    const std::array<std::uint32_t, 12> words = {
        width, height, block_size, blocks_x,
        selector_offset, block_offset, pixel_offset, flags,
        local_count, global_count, palette_count, 0u,
    };
    texture.metadata.insert(texture.metadata.end(), words.begin(), words.end());
}

bool AppendParsedBpal(const bpal5_image& image, ShaderTexture& texture) {
    const std::uint32_t selector_offset = AppendValues(
        texture.data, image.block_palette_selectors, image.block_count);
    const std::uint32_t block_offset = AppendValues(
        texture.data,
        image.block_palette_indices,
        static_cast<std::size_t>(image.block_count) * image.local_color_count);
    const std::uint32_t pixel_offset = AppendValues(
        texture.data,
        image.pixel_indices,
        static_cast<std::size_t>(image.width) * image.height);
    AddMipMetadata(
        texture,
        image.width,
        image.height,
        image.block_size,
        image.blocks_x,
        selector_offset,
        block_offset,
        pixel_offset,
        0,
        image.local_color_count,
        image.global_color_count,
        image.palette_count);
    return true;
}

bool ParseBpal(
    const std::uint8_t* bytes,
    std::size_t byte_count,
    ShaderTexture& texture,
    std::wstring& error,
    bool bplm_base
) {
    BpalGuard parsed;
    char codec_error[256]{};
    if (!bpal5_parse(bytes, byte_count, &parsed.image, codec_error, sizeof(codec_error))) {
        error = Widen(codec_error);
        return false;
    }
    texture = {};
    texture.kind = ShaderTextureKind::Bpal;
    texture.format = bplm_base ? L"BPLM v1" : L"BPAL v5";
    texture.width = parsed.image.width;
    texture.height = parsed.image.height;
    texture.mip_count = 1;
    texture.source_bytes = byte_count;
    texture.metadata = {
        static_cast<std::uint32_t>(ShaderTextureKind::Bpal),
        texture.width,
        texture.height,
        1u,
        0u, 0u, 0u, 0u,
    };
    texture.metadata[4] = AppendValues(
        texture.data,
        parsed.image.palette_rgba,
        static_cast<std::size_t>(parsed.image.palette_count) * parsed.image.global_color_count);
    return AppendParsedBpal(parsed.image, texture);
}

bool ReadBoundedIndex(
    MsbBitReader& reader,
    std::uint32_t bits,
    std::uint32_t limit,
    std::uint32_t& value
) {
    return reader.Read(bits, value) && value < limit;
}

bool ParseBplm(
    const std::uint8_t* bytes,
    std::size_t byte_count,
    ShaderTexture& texture,
    std::wstring& error
) {
    if (byte_count < kBplmHeaderBytes || std::memcmp(bytes, "BPLM", 4) != 0 ||
        bytes[4] != 1 || bytes[5] == 0 || ReadU16Le(bytes + 6) != 0) {
        error = L"Invalid or unsupported BPLM header";
        return false;
    }
    const std::uint32_t base_bytes = ReadU32Le(bytes + 8);
    if (base_bytes == 0 || base_bytes > byte_count - kBplmHeaderBytes ||
        !ParseBpal(bytes + kBplmHeaderBytes, base_bytes, texture, error, true)) {
        return false;
    }
    const std::uint32_t mip_count = bytes[5];
    BpalGuard base;
    char codec_error[256]{};
    if (!bpal5_parse(bytes + kBplmHeaderBytes, base_bytes, &base.image, codec_error, sizeof(codec_error))) {
        error = Widen(codec_error);
        return false;
    }

    std::size_t offset = kBplmHeaderBytes + base_bytes;
    std::uint32_t previous_width = base.image.width;
    std::uint32_t previous_height = base.image.height;
    std::uint32_t previous_block = base.image.block_size;
    for (std::uint32_t mip = 1; mip < mip_count; ++mip) {
        if (offset > byte_count || byte_count - offset < kBplmLevelHeaderBytes) {
            error = L"Truncated BPLM mip header";
            return false;
        }
        const std::uint32_t width = ReadU32Le(bytes + offset);
        const std::uint32_t height = ReadU32Le(bytes + offset + 4);
        const std::uint32_t block_size = ReadU16Le(bytes + offset + 8);
        const std::uint32_t flags = ReadU16Le(bytes + offset + 10);
        const std::uint32_t payload_bytes = ReadU32Le(bytes + offset + 12);
        if (width != std::max(1u, previous_width / 2u) ||
            height != std::max(1u, previous_height / 2u) ||
            block_size != std::max(1u, previous_block / 2u) || flags != 0) {
            error = L"Invalid BPLM mip progression";
            return false;
        }
        const std::uint32_t local_count = std::min(
            base.image.local_color_count, block_size * block_size);
        const bool direct = local_count == block_size * block_size;
        std::uint32_t local_bits = 0;
        for (std::uint32_t n = local_count; n > 1; n >>= 1u) ++local_bits;
        const std::uint32_t blocks_x = (width + block_size - 1u) / block_size;
        const std::uint32_t blocks_y = (height + block_size - 1u) / block_size;
        const std::size_t block_count = static_cast<std::size_t>(blocks_x) * blocks_y;
        const std::size_t pixel_count = static_cast<std::size_t>(width) * height;
        const std::uint64_t payload_bits = direct
            ? static_cast<std::uint64_t>(pixel_count) *
                (base.image.global_index_bits + base.image.palette_index_bits)
            : static_cast<std::uint64_t>(block_count) * base.image.palette_index_bits +
                static_cast<std::uint64_t>(block_count) * local_count * base.image.global_index_bits +
                static_cast<std::uint64_t>(pixel_count) * local_bits;
        const std::size_t payload_offset = offset + kBplmLevelHeaderBytes;
        if (payload_bytes != (payload_bits + 7u) / 8u || payload_offset > byte_count ||
            payload_bytes > byte_count - payload_offset) {
            error = L"Invalid BPLM mip payload";
            return false;
        }
        MsbBitReader reader(bytes + payload_offset, payload_bytes, payload_bits);
        if (direct) {
            std::vector<std::uint16_t> indices(pixel_count);
            const std::uint32_t limit = base.image.palette_count * base.image.global_color_count;
            for (auto& index : indices) {
                std::uint32_t value = 0;
                if (!ReadBoundedIndex(
                        reader,
                        base.image.global_index_bits + base.image.palette_index_bits,
                        limit,
                        value)) {
                    error = L"Invalid direct BPLM index";
                    return false;
                }
                index = static_cast<std::uint16_t>(value);
            }
            const std::uint32_t index_offset = AppendValues(texture.data, indices.data(), indices.size());
            AddMipMetadata(texture, width, height, block_size, blocks_x, 0, 0, index_offset,
                kDirectIndices, local_count, base.image.global_color_count, base.image.palette_count);
        } else {
            std::vector<std::uint8_t> selectors(block_count);
            std::vector<std::uint16_t> block_indices(block_count * local_count);
            std::vector<std::uint8_t> pixel_indices(pixel_count);
            for (auto& selector : selectors) {
                std::uint32_t value = 0;
                if (!ReadBoundedIndex(reader, base.image.palette_index_bits, base.image.palette_count, value)) {
                    error = L"Invalid BPLM palette selector";
                    return false;
                }
                selector = static_cast<std::uint8_t>(value);
            }
            for (auto& index : block_indices) {
                std::uint32_t value = 0;
                if (!ReadBoundedIndex(reader, base.image.global_index_bits, base.image.global_color_count, value)) {
                    error = L"Invalid BPLM block index";
                    return false;
                }
                index = static_cast<std::uint16_t>(value);
            }
            for (auto& index : pixel_indices) {
                std::uint32_t value = 0;
                if (!ReadBoundedIndex(reader, local_bits, local_count, value)) {
                    error = L"Invalid BPLM pixel index";
                    return false;
                }
                index = static_cast<std::uint8_t>(value);
            }
            const auto selector_offset = AppendValues(texture.data, selectors.data(), selectors.size());
            const auto block_offset = AppendValues(texture.data, block_indices.data(), block_indices.size());
            const auto pixel_offset = AppendValues(texture.data, pixel_indices.data(), pixel_indices.size());
            AddMipMetadata(texture, width, height, block_size, blocks_x,
                selector_offset, block_offset, pixel_offset, 0,
                local_count, base.image.global_color_count, base.image.palette_count);
        }
        offset = payload_offset + payload_bytes;
        previous_width = width;
        previous_height = height;
        previous_block = block_size;
    }
    if (offset != byte_count) {
        error = L"BPLM file has trailing data";
        return false;
    }
    texture.mip_count = mip_count;
    texture.source_bytes = byte_count;
    texture.metadata[3] = mip_count;
    return true;
}

bool ParseDctbs2(
    const std::uint8_t* bytes,
    std::size_t byte_count,
    ShaderTexture& texture,
    std::wstring& error
) {
    if (byte_count < 64 || std::memcmp(bytes, "DCTBS2\0\0", 8) != 0 || ReadU32Le(bytes + 8) != 2) {
        error = L"Invalid or unsupported DCTBS2 header";
        return false;
    }
    const std::uint32_t width = ReadU32Le(bytes + 16);
    const std::uint32_t height = ReadU32Le(bytes + 20);
    const std::uint32_t payload = ReadU32Le(bytes + 56);
    const std::uint32_t flags = ReadU32Le(bytes + 52);
    if (width == 0 || height == 0 || payload != byte_count - 64 ||
        ReadU32Le(bytes + 12) != 1500 || ReadU32Le(bytes + 32) != 48 ||
        ReadU32Le(bytes + 36) != 24 || ReadU32Le(bytes + 40) != 12 ||
        ReadU32Le(bytes + 44) != 12 || (flags & (15u << 8u)) != (2u << 8u) ||
        (flags & 6u) != 0) {
        error = L"Direct HLSL decoder requires baseline DCTBS2 1.5 bpp grouped-front records";
        return false;
    }
    texture = {};
    texture.kind = ShaderTextureKind::Dctbs2;
    texture.format = L"DCTBS2 v2 (shader direct)";
    texture.width = width;
    texture.height = height;
    texture.mip_count = 1;
    texture.source_bytes = byte_count;
    texture.data.assign(bytes, bytes + byte_count);
    AlignData(texture.data, 4);
    texture.metadata = {
        static_cast<std::uint32_t>(texture.kind), width, height, 1u,
        0u, 0u, 0u, 0u,
        ReadU32Le(bytes + 24), ReadU32Le(bytes + 28), ReadU32Le(bytes + 32),
        ReadU32Le(bytes + 36), ReadU32Le(bytes + 40), ReadU32Le(bytes + 44),
        ReadU32Le(bytes + 48), flags,
    };
    return true;
}

bool ReadFile(const std::wstring& path, std::vector<std::uint8_t>& bytes, std::wstring& error) {
    std::ifstream stream(path, std::ios::binary | std::ios::ate);
    if (!stream) {
        error = L"Could not open texture file";
        return false;
    }
    const auto end = stream.tellg();
    if (end <= 0 || static_cast<std::uint64_t>(end) > std::numeric_limits<std::size_t>::max()) {
        error = L"Texture file is empty or too large";
        return false;
    }
    bytes.resize(static_cast<std::size_t>(end));
    stream.seekg(0);
    if (!stream.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()))) {
        error = L"Could not read texture file";
        return false;
    }
    return true;
}

}  // namespace

bool DecodeShaderTextureBytes(
    const std::vector<std::uint8_t>& bytes,
    ShaderTexture& texture,
    std::wstring& error
) {
    error.clear();
    if (bytes.size() >= 4 && std::memcmp(bytes.data(), "BPAL", 4) == 0) {
        return ParseBpal(bytes.data(), bytes.size(), texture, error, false);
    }
    if (bytes.size() >= 4 && std::memcmp(bytes.data(), "BPLM", 4) == 0) {
        return ParseBplm(bytes.data(), bytes.size(), texture, error);
    }
    if (bytes.size() >= 8 && std::memcmp(bytes.data(), "DCTBS2\0\0", 8) == 0) {
        return ParseDctbs2(bytes.data(), bytes.size(), texture, error);
    }
    if (bytes.size() >= 4 && std::memcmp(bytes.data(), "BPDH", 4) == 0) {
        return detail::ParseBpdhShader(bytes.data(), bytes.size(), texture, error);
    }
    error = L"Shader decoder supports BPAL, BPLM, DCTBS2, and BPDH files";
    return false;
}

bool LoadShaderTextureFile(
    const std::wstring& path,
    ShaderTexture& texture,
    std::wstring& error
) {
    std::vector<std::uint8_t> bytes;
    return ReadFile(path, bytes, error) && DecodeShaderTextureBytes(bytes, texture, error);
}

}  // namespace texture_demo
