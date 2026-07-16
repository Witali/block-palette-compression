#include "codec_internal.h"

#include "bpal5.h"

#include <windows.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <cstring>
#include <fstream>
#include <memory>

namespace texture_demo {
namespace {

using Microsoft::WRL::ComPtr;

std::wstring Widen(const char* text) {
    if (text == nullptr || *text == '\0') {
        return L"Unknown codec error";
    }
    const int length = MultiByteToWideChar(CP_UTF8, 0, text, -1, nullptr, 0);
    if (length <= 1) {
        return L"Unknown codec error";
    }
    std::wstring result(static_cast<std::size_t>(length), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text, -1, result.data(), length);
    result.pop_back();
    return result;
}

bool LoadWic(const std::wstring& path, TextureImage& image, std::wstring& error) {
    ComPtr<IWICImagingFactory> factory;
    HRESULT result = CoCreateInstance(
        CLSID_WICImagingFactory,
        nullptr,
        CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(&factory)
    );
    if (FAILED(result)) {
        error = L"Windows Imaging Component is unavailable";
        return false;
    }

    ComPtr<IWICBitmapDecoder> decoder;
    result = factory->CreateDecoderFromFilename(
        path.c_str(),
        nullptr,
        GENERIC_READ,
        WICDecodeMetadataCacheOnLoad,
        &decoder
    );
    if (FAILED(result)) {
        error = L"WIC could not decode this image";
        return false;
    }

    ComPtr<IWICBitmapFrameDecode> frame;
    result = decoder->GetFrame(0, &frame);
    if (FAILED(result)) {
        error = L"WIC could not read the first image frame";
        return false;
    }

    UINT width = 0;
    UINT height = 0;
    result = frame->GetSize(&width, &height);
    std::size_t rgba_size = 0;
    if (FAILED(result) || !internal::CheckedRgbaSize(width, height, rgba_size, error)) {
        if (FAILED(result)) {
            error = L"WIC returned invalid image dimensions";
        }
        return false;
    }

    ComPtr<IWICFormatConverter> converter;
    result = factory->CreateFormatConverter(&converter);
    if (SUCCEEDED(result)) {
        result = converter->Initialize(
            frame.Get(),
            GUID_WICPixelFormat32bppRGBA,
            WICBitmapDitherTypeNone,
            nullptr,
            0.0,
            WICBitmapPaletteTypeCustom
        );
    }
    if (FAILED(result)) {
        error = L"WIC could not convert the image to RGBA";
        return false;
    }

    MipLevel level;
    level.width = width;
    level.height = height;
    level.rgba.resize(rgba_size);
    result = converter->CopyPixels(
        nullptr,
        width * 4u,
        static_cast<UINT>(level.rgba.size()),
        level.rgba.data()
    );
    if (FAILED(result)) {
        error = L"WIC could not copy decoded pixels";
        return false;
    }

    image = {};
    image.format = L"WIC image";
    image.mips.push_back(std::move(level));
    return true;
}

}  // namespace

namespace internal {

bool DecodeBpal(
    const std::uint8_t* bytes,
    std::size_t byte_count,
    TextureImage& image,
    std::wstring& error
) {
    bpal5_image decoded{};
    char codec_error[256]{};
    if (!bpal5_parse(bytes, byte_count, &decoded, codec_error, sizeof(codec_error))) {
        error = Widen(codec_error);
        return false;
    }

    std::uint8_t* rgba = nullptr;
    std::size_t rgba_size = 0;
    const bool ok = bpal5_decode_rgba(
        &decoded,
        0,
        &rgba,
        &rgba_size,
        codec_error,
        sizeof(codec_error)
    ) != 0;
    if (!ok) {
        error = Widen(codec_error);
        bpal5_image_free(&decoded);
        return false;
    }

    MipLevel level;
    level.width = decoded.width;
    level.height = decoded.height;
    level.rgba.assign(rgba, rgba + rgba_size);
    bpal5_free(rgba);
    bpal5_image_free(&decoded);

    image = {};
    image.format = L"BPAL v5";
    image.mips.push_back(std::move(level));
    return true;
}

}  // namespace internal

bool DecodeTextureBytes(
    const std::vector<std::uint8_t>& bytes,
    TextureImage& image,
    std::wstring& error
) {
    if (bytes.size() < 4) {
        error = L"The selected file is empty or truncated";
        return false;
    }
    const auto* data = bytes.data();
    if (std::memcmp(data, "BPAL", 4) == 0) {
        return internal::DecodeBpal(data, bytes.size(), image, error);
    }
    if (std::memcmp(data, "BPLM", 4) == 0) {
        return internal::DecodeBplm(data, bytes.size(), image, error);
    }
    if (std::memcmp(data, "BPDH", 4) == 0) {
        return internal::DecodeBpdh(data, bytes.size(), image, error);
    }
    static constexpr std::uint8_t kDctMagic[8] = {
        'D', 'C', 'T', 'B', 'S', '2', 0, 0,
    };
    if (bytes.size() >= 8 && std::memcmp(data, kDctMagic, 8) == 0) {
        return internal::DecodeDctbs2(data, bytes.size(), image, error);
    }
    error = L"The file is not a supported project texture container";
    return false;
}

bool LoadTextureFile(
    const std::wstring& path,
    TextureImage& image,
    std::wstring& error
) {
    std::ifstream input(path, std::ios::binary | std::ios::ate);
    if (!input) {
        error = L"Could not open the selected file";
        return false;
    }
    const std::streampos end = input.tellg();
    if (end <= 0 || static_cast<std::uint64_t>(end) > 1024ull * 1024ull * 1024ull) {
        error = L"The selected file has an invalid or unsupported size";
        return false;
    }
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(end));
    input.seekg(0, std::ios::beg);
    input.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    if (!input) {
        error = L"Could not read the selected file";
        return false;
    }

    const bool project_texture =
        std::memcmp(bytes.data(), "BPAL", 4) == 0 ||
        std::memcmp(bytes.data(), "BPLM", 4) == 0 ||
        std::memcmp(bytes.data(), "BPDH", 4) == 0 ||
        (bytes.size() >= 8 && std::memcmp(bytes.data(), "DCTBS2\0\0", 8) == 0);
    if (project_texture) return DecodeTextureBytes(bytes, image, error);

    if (LoadWic(path, image, error)) {
        return true;
    }
    return false;
}

}  // namespace texture_demo
