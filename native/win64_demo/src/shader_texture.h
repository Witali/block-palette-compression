#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace texture_demo {

// The uploaded payload contains compressed/indexed texture data.  It never
// contains a width*height RGB(A) bitmap for project formats.
enum class ShaderTextureKind : std::uint32_t {
    Bpal = 1,
    Dctbs2 = 2,
    Bpdh = 3,
};

struct ShaderTexture {
    ShaderTextureKind kind = ShaderTextureKind::Bpal;
    std::wstring format;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t mip_count = 0;
    std::size_t source_bytes = 0;
    std::vector<std::uint8_t> data;
    std::vector<std::uint32_t> metadata;
};

// Metadata common prefix.
// [0] kind, [1] width, [2] height, [3] mip count, [4] palette byte offset.
// BPAL/BPLM then use 12 words per mip beginning at word 8:
// width, height, block size, blocks X,
// selector offset, block-table offset, pixel-index offset, flags,
// local colors, global colors, palette count, reserved.
// Flag bit 0 means pixel-index records are direct uint16 flattened palette indices.
// DCTBS2 uses words 8..15 for MCU columns/rows/record sizes/quality/flags.
// BPDH uses words 8..18 for block and compact-record offsets/strides.

bool LoadShaderTextureFile(
    const std::wstring& path,
    ShaderTexture& texture,
    std::wstring& error
);

bool DecodeShaderTextureBytes(
    const std::vector<std::uint8_t>& bytes,
    ShaderTexture& texture,
    std::wstring& error
);

}  // namespace texture_demo
