#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace texture_demo {

struct MipLevel {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::vector<std::uint8_t> rgba;
};

struct TextureImage {
    std::wstring format;
    std::vector<MipLevel> mips;
};

bool LoadTextureFile(
    const std::wstring& path,
    TextureImage& image,
    std::wstring& error
);

bool DecodeTextureBytes(
    const std::vector<std::uint8_t>& bytes,
    TextureImage& image,
    std::wstring& error
);

}  // namespace texture_demo
