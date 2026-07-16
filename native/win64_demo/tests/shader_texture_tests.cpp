#include "shader_texture.h"
#include "texture_loader.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

namespace {

struct TestCase {
    const wchar_t* path;
    texture_demo::ShaderTextureKind kind;
    std::uint32_t width;
    std::uint32_t height;
    std::uint32_t minimum_mips;
};

std::uint32_t LoadWord(const texture_demo::ShaderTexture& texture, std::size_t offset) {
    std::uint32_t value = 0;
    std::memcpy(&value, texture.data.data() + offset, sizeof(value));
    return value;
}

std::uint32_t LoadU16(const texture_demo::ShaderTexture& texture, std::size_t offset) {
    return texture.data[offset] | static_cast<std::uint32_t>(texture.data[offset + 1]) << 8u;
}

std::int64_t RoundDivide(std::int64_t value, std::int64_t divisor) {
    return value >= 0 ? (value + divisor / 2) / divisor : -((-value + divisor / 2) / divisor);
}

std::uint32_t SampleBpdhComponent(
    const texture_demo::ShaderTexture& texture,
    std::size_t record,
    std::uint32_t component,
    std::uint32_t x,
    std::uint32_t y
) {
    return texture.data[record + component * 64u + y * 8u + x];
}

std::int64_t SampleBpdhChroma(
    const texture_demo::ShaderTexture& texture,
    std::size_t record,
    std::uint32_t component,
    std::uint32_t x,
    std::uint32_t y
) {
    const int floor_x = (x & 1u) == 0 ? static_cast<int>(x / 2u) - 1 : static_cast<int>(x / 2u);
    const int floor_y = (y & 1u) == 0 ? static_cast<int>(y / 2u) - 1 : static_cast<int>(y / 2u);
    const auto x0 = static_cast<std::uint32_t>(std::clamp(floor_x, 0, 7));
    const auto y0 = static_cast<std::uint32_t>(std::clamp(floor_y, 0, 7));
    const auto x1 = static_cast<std::uint32_t>(std::clamp(floor_x + 1, 0, 7));
    const auto y1 = static_cast<std::uint32_t>(std::clamp(floor_y + 1, 0, 7));
    const int fraction_x = (x & 1u) == 0 ? 3 : 1;
    const int fraction_y = (y & 1u) == 0 ? 3 : 1;
    const std::int64_t top = (4 - fraction_x) * SampleBpdhComponent(texture, record, component, x0, y0) +
        fraction_x * SampleBpdhComponent(texture, record, component, x1, y0);
    const std::int64_t bottom = (4 - fraction_x) * SampleBpdhComponent(texture, record, component, x0, y1) +
        fraction_x * SampleBpdhComponent(texture, record, component, x1, y1);
    return RoundDivide((4 - fraction_y) * top + fraction_y * bottom, 16);
}

std::uint32_t PackRgb(std::int64_t red, std::int64_t green, std::int64_t blue) {
    const auto clamp = [](std::int64_t value) {
        return static_cast<std::uint32_t>(std::clamp<std::int64_t>(value, 0, 255));
    };
    return clamp(red) | clamp(green) << 8u | clamp(blue) << 16u | 255u << 24u;
}

std::uint32_t SampleShaderPayload(
    const texture_demo::ShaderTexture& texture,
    std::uint32_t x,
    std::uint32_t y
) {
    const auto& meta = texture.metadata;
    if (texture.kind == texture_demo::ShaderTextureKind::Bpal) {
        const std::size_t base = 8;
        const std::uint32_t width = meta[base];
        const std::uint32_t block_size = meta[base + 2];
        const std::uint32_t blocks_x = meta[base + 3];
        const std::uint32_t pixel = y * width + x;
        std::uint32_t flattened = 0;
        if ((meta[base + 7] & 1u) != 0) {
            flattened = LoadU16(texture, meta[base + 6] + pixel * 2u);
        } else {
            const std::uint32_t block = (y / block_size) * blocks_x + x / block_size;
            const std::uint32_t local = texture.data[meta[base + 6] + pixel];
            const std::uint32_t selector = texture.data[meta[base + 4] + block];
            const std::uint32_t global = LoadU16(
                texture,
                meta[base + 5] + (block * meta[base + 8] + local) * 2u);
            flattened = selector * meta[base + 9] + global;
        }
        return LoadWord(texture, meta[4] + flattened * 4u);
    }

    const std::uint32_t local_x = x & 15u;
    const std::uint32_t local_y = y & 15u;
    const std::uint32_t block = (y / 16u) * meta[8] + x / 16u;
    const std::uint32_t map = LoadWord(texture, meta[12] + block * 4u);
    const std::uint32_t mode = map & 255u;
    const std::uint32_t record_index = map >> 8u;
    if (mode == 0) {
        const std::size_t record = meta[13] + static_cast<std::size_t>(record_index) * meta[14];
        const std::uint32_t selector = texture.data[record];
        const std::uint32_t local = texture.data[record + 1u + meta[9] * 2u + local_y * 16u + local_x];
        const std::uint32_t global = LoadU16(texture, record + 1u + local * 2u);
        return LoadWord(texture, meta[4] + (selector * meta[10] + global) * 4u);
    }
    const std::size_t record = meta[15] + static_cast<std::size_t>(record_index) * meta[16];
    const std::uint32_t component = (local_y / 8u) * 2u + local_x / 8u;
    const std::int64_t luma = SampleBpdhComponent(
        texture, record, component, local_x & 7u, local_y & 7u);
    const std::int64_t cb = SampleBpdhChroma(texture, record, 4, local_x, local_y) - 128;
    const std::int64_t cr = SampleBpdhChroma(texture, record, 5, local_x, local_y) - 128;
    return PackRgb(
        luma + RoundDivide(91881 * cr, 65536),
        luma + RoundDivide(-22554 * cb - 46802 * cr, 65536),
        luma + RoundDivide(116130 * cb, 65536));
}

bool MatchesSparseReference(
    const std::wstring& path,
    const texture_demo::ShaderTexture& texture,
    std::wstring& error
) {
    if (texture.kind == texture_demo::ShaderTextureKind::Dctbs2) return true;
    texture_demo::TextureImage reference;
    if (!texture_demo::LoadTextureFile(path, reference, error)) return false;
    const std::array<std::array<std::uint32_t, 2>, 5> coordinates = {{
        {{0, 0}},
        {{texture.width / 3u, texture.height / 5u}},
        {{texture.width / 2u, texture.height / 2u}},
        {{texture.width * 4u / 5u, texture.height * 3u / 4u}},
        {{texture.width - 1u, texture.height - 1u}},
    }};
    for (const auto& coordinate : coordinates) {
        const std::size_t pixel = static_cast<std::size_t>(coordinate[1]) * texture.width + coordinate[0];
        std::uint32_t expected = 0;
        std::memcpy(&expected, reference.mips[0].rgba.data() + pixel * 4u, sizeof(expected));
        if (SampleShaderPayload(texture, coordinate[0], coordinate[1]) != expected) {
            error = L"coordinate payload sample differs from reference RGBA";
            return false;
        }
    }
    return true;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
    if (argc != 2) return 2;
    const std::wstring root = argv[1];
    const std::vector<TestCase> tests = {
        {L"assets\\bpal\\stone-texture-wic-2.38bpp.bpal", texture_demo::ShaderTextureKind::Bpal, 1100, 734, 1},
        {L"assets\\bpal\\stone-texture-wic.bplm", texture_demo::ShaderTextureKind::Bpal, 1100, 734, 2},
        {L"assets\\dct\\stone-texture-wic-1.5bpp.dctbs2", texture_demo::ShaderTextureKind::Dctbs2, 1100, 734, 1},
        {L"assets\\bpdh\\landscape-alaska.bpdh", texture_demo::ShaderTextureKind::Bpdh, 1280, 1983, 1},
    };
    bool passed = true;
    for (const auto& test : tests) {
        texture_demo::ShaderTexture texture;
        std::wstring error;
        const std::wstring path = root + L"\\" + test.path;
        if (!texture_demo::LoadShaderTextureFile(path, texture, error)) {
            std::wcerr << L"FAIL " << test.path << L": " << error << L"\n";
            passed = false;
            continue;
        }
        const std::uint64_t rgba_bytes = static_cast<std::uint64_t>(test.width) * test.height * 4u;
        if (texture.kind != test.kind || texture.width != test.width ||
            texture.height != test.height || texture.mip_count < test.minimum_mips ||
            texture.data.empty() || texture.metadata.size() < 16 ||
            texture.metadata.size() > texture_demo::kShaderMetadataCapacityWords ||
            texture.data.size() >= rgba_bytes) {
            std::wcerr << L"FAIL " << test.path << L": shader payload metadata mismatch\n";
            passed = false;
            continue;
        }
        if (!MatchesSparseReference(path, texture, error)) {
            std::wcerr << L"FAIL " << test.path << L": " << error << L"\n";
            passed = false;
            continue;
        }
        std::wcout << L"PASS " << test.path << L": " << texture.data.size()
                   << L" GPU bytes, no RGBA bitmap\n";
    }
    return passed ? 0 : 1;
}
