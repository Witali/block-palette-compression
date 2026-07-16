#include "texture_loader.h"

#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace {

struct TestCase {
    const wchar_t* relative_path;
    const wchar_t* format;
    std::uint32_t width;
    std::uint32_t height;
    std::size_t minimum_mips;
    std::uint64_t checksum;
};

std::uint64_t PixelChecksum(const texture_demo::MipLevel& level) {
    std::uint64_t hash = 1469598103934665603ull;
    for (std::uint8_t value : level.rgba) {
        hash ^= value;
        hash *= 1099511628211ull;
    }
    return hash;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
    if (argc != 2) {
        std::wcerr << L"Usage: texture_codec_tests REPOSITORY_ROOT\n";
        return 2;
    }
    const std::wstring root = argv[1];
    const std::vector<TestCase> tests = {
        {L"assets\\bpal\\stone-texture-wic-2.38bpp.bpal", L"BPAL v5", 1100, 734, 1, 0xd718879d0217b1bcull},
        {L"assets\\bpal\\stone-texture-wic.bplm", L"BPLM v1", 1100, 734, 2, 0xe6592f76096802e4ull},
        {L"assets\\dct\\stone-texture-wic-1.5bpp.dctbs2", L"DCTBS2 v2", 1100, 734, 1, 0x9c37623e609fa63eull},
        {L"assets\\bpdh\\landscape-alaska.bpdh", L"BPDH v1", 1280, 1983, 1, 0x917745d79f476e42ull},
    };

    bool passed = true;
    for (const auto& test : tests) {
        texture_demo::TextureImage image;
        std::wstring error;
        const std::wstring path = root + L"\\" + test.relative_path;
        if (!texture_demo::LoadTextureFile(path, image, error)) {
            std::wcerr << L"FAIL " << test.relative_path << L": " << error << L"\n";
            passed = false;
            continue;
        }
        if (image.format != test.format || image.mips.size() < test.minimum_mips ||
            image.mips[0].width != test.width || image.mips[0].height != test.height ||
            image.mips[0].rgba.size() != static_cast<std::size_t>(test.width) * test.height * 4u ||
            PixelChecksum(image.mips[0]) != test.checksum) {
            std::wcerr << L"FAIL " << test.relative_path << L": decoded metadata mismatch\n";
            passed = false;
            continue;
        }
        std::wcout << L"PASS " << test.relative_path << L" (" << image.format << L", "
                   << image.mips.size() << L" mip(s), checksum 0x" << std::hex
                   << PixelChecksum(image.mips[0]) << std::dec << L")\n";
    }
    return passed ? 0 : 1;
}
