#pragma once

#include "texture_loader.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

namespace texture_demo::internal {

constexpr std::uint32_t kMaximumTextureDimension = 16384;

inline std::uint32_t ReadU32Le(const std::uint8_t* bytes) {
    return static_cast<std::uint32_t>(bytes[0]) |
        static_cast<std::uint32_t>(bytes[1]) << 8u |
        static_cast<std::uint32_t>(bytes[2]) << 16u |
        static_cast<std::uint32_t>(bytes[3]) << 24u;
}

inline std::uint16_t ReadU16Le(const std::uint8_t* bytes) {
    return static_cast<std::uint16_t>(bytes[0]) |
        static_cast<std::uint16_t>(bytes[1]) << 8u;
}

inline bool CheckedRgbaSize(
    std::uint32_t width,
    std::uint32_t height,
    std::size_t& size,
    std::wstring& error
) {
    if (width == 0 || height == 0 ||
        width > kMaximumTextureDimension || height > kMaximumTextureDimension) {
        error = L"Texture dimensions are outside the Direct3D 11 limit";
        return false;
    }
    const std::uint64_t total = static_cast<std::uint64_t>(width) * height * 4u;
    if (total > std::numeric_limits<std::size_t>::max()) {
        error = L"Decoded texture is too large";
        return false;
    }
    size = static_cast<std::size_t>(total);
    return true;
}

inline std::uint8_t ClampByte(double value) {
    const double rounded = value < 0.0
        ? -static_cast<double>(static_cast<std::int64_t>(-value + 0.5))
        : static_cast<double>(static_cast<std::int64_t>(value + 0.5));
    return static_cast<std::uint8_t>(std::clamp(rounded, 0.0, 255.0));
}

class MsbBitReader {
public:
    MsbBitReader(
        const std::uint8_t* bytes,
        std::size_t byte_count,
        std::uint64_t bit_length = std::numeric_limits<std::uint64_t>::max()
    ) : bytes_(bytes), byte_count_(byte_count) {
        const std::uint64_t available = static_cast<std::uint64_t>(byte_count) * 8u;
        bit_length_ = std::min(available, bit_length);
    }

    bool Read(std::uint32_t bit_count, std::uint32_t& value) {
        if (bit_count > 32 || bit_offset_ + bit_count > bit_length_) {
            return false;
        }
        value = 0;
        for (std::uint32_t bit = 0; bit < bit_count; ++bit) {
            const std::size_t byte_index = static_cast<std::size_t>(bit_offset_ >> 3u);
            const std::uint32_t bit_index = 7u - static_cast<std::uint32_t>(bit_offset_ & 7u);
            value = (value << 1u) | ((bytes_[byte_index] >> bit_index) & 1u);
            ++bit_offset_;
        }
        return true;
    }

    bool ReadSigned(std::uint32_t bit_count, std::int32_t& value) {
        std::uint32_t encoded = 0;
        if (bit_count == 0 || !Read(bit_count, encoded)) {
            return false;
        }
        const std::uint32_t sign = 1u << (bit_count - 1u);
        value = (encoded & sign) != 0
            ? static_cast<std::int32_t>(encoded) - static_cast<std::int32_t>(1u << bit_count)
            : static_cast<std::int32_t>(encoded);
        return true;
    }

    std::uint64_t offset() const { return bit_offset_; }
    std::uint64_t length() const { return bit_length_; }

private:
    const std::uint8_t* bytes_ = nullptr;
    std::size_t byte_count_ = 0;
    std::uint64_t bit_offset_ = 0;
    std::uint64_t bit_length_ = 0;
};

bool DecodeBpal(
    const std::uint8_t* bytes,
    std::size_t byte_count,
    TextureImage& image,
    std::wstring& error
);

bool DecodeBplm(
    const std::uint8_t* bytes,
    std::size_t byte_count,
    TextureImage& image,
    std::wstring& error
);

bool DecodeDctbs2(
    const std::uint8_t* bytes,
    std::size_t byte_count,
    TextureImage& image,
    std::wstring& error
);

bool DecodeBpdh(
    const std::uint8_t* bytes,
    std::size_t byte_count,
    TextureImage& image,
    std::wstring& error
);

}  // namespace texture_demo::internal
