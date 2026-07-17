#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>
#include <windowsx.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <DirectXMath.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "scene_format.h"

using DirectX::XMFLOAT3;
using DirectX::XMFLOAT4;
using DirectX::XMFLOAT4X4;
using DirectX::XMMATRIX;
using DirectX::XMVECTOR;
using Microsoft::WRL::ComPtr;

namespace {

constexpr wchar_t kWindowClass[] = L"BpalDirectXSceneViewer";
constexpr int kCodecComboId = 1001;
constexpr int kStatusLabelId = 1002;
constexpr int kFilterComboId = 1003;
constexpr int kAnisotropyComboId = 1004;
constexpr int kLodBiasComboId = 1005;
constexpr std::array<const char*, 4> kCodecDirectories = {"original", "bpal", "dct", "astc"};
constexpr std::array<const wchar_t*, 4> kCodecLabels = {L"Original BC1/BC7", L"BPAL", L"DCTBS2", L"ASTC"};
constexpr std::array<const wchar_t*, 4> kFilterLabels = {
    L"Filter: Nearest", L"Filter: Bilinear", L"Filter: Trilinear", L"Filter: Anisotropic"};
constexpr std::array<const wchar_t*, 4> kFilterNames = {
    L"Nearest", L"Bilinear", L"Trilinear", L"Anisotropic"};
constexpr std::array<const wchar_t*, 3> kAnisotropyLabels = {
    L"Anisotropy: 2x", L"Anisotropy: 4x", L"Anisotropy: 8x"};
constexpr std::array<float, 3> kAnisotropyValues = {2.0f, 4.0f, 8.0f};
constexpr std::array<const wchar_t*, 9> kLodBiasLabels = {
    L"LOD bias: -2.0", L"LOD bias: -1.5", L"LOD bias: -1.0",
    L"LOD bias: -0.5", L"LOD bias: 0.0", L"LOD bias: +0.5",
    L"LOD bias: +1.0", L"LOD bias: +1.5", L"LOD bias: +2.0"};
constexpr std::array<float, 9> kLodBiasValues = {
    -2.0f, -1.5f, -1.0f, -0.5f, 0.0f, 0.5f, 1.0f, 1.5f, 2.0f};

struct SceneConstants {
    XMFLOAT4X4 viewProjection;
    XMFLOAT4 lightDirectionExposure;
    XMFLOAT4 cameraPosition;
};

struct MaterialConstants {
    XMFLOAT4 baseColor;
    XMFLOAT4 parameters;
};

struct TextureDescriptorGpu {
    std::uint32_t header[4]{};
    std::uint32_t parameters[16]{};
};

struct TextureConstants {
    TextureDescriptorGpu streams[3];
};

struct FilterConstants {
    XMFLOAT4 parameters;
};

static_assert(sizeof(SceneConstants) % 16 == 0);
static_assert(sizeof(MaterialConstants) % 16 == 0);
static_assert(sizeof(TextureDescriptorGpu) == 80);
static_assert(sizeof(TextureConstants) % 16 == 0);
static_assert(sizeof(FilterConstants) % 16 == 0);

struct TextureGpuResource {
    ComPtr<ID3D11Buffer> buffer;
    ComPtr<ID3D11Texture2D> texture;
    ComPtr<ID3D11ShaderResourceView> view;
    TextureDescriptorGpu descriptor;
};

using TextureResourcePtr = std::shared_ptr<TextureGpuResource>;

struct MaterialTextures {
    TextureResourcePtr base;
    TextureResourcePtr alpha;
    TextureResourcePtr bump;
};

std::vector<std::uint8_t> ReadBinaryFile(const std::filesystem::path& filePath) {
    std::ifstream stream(filePath, std::ios::binary | std::ios::ate);
    if (!stream) throw std::runtime_error("Could not open file: " + filePath.string());
    const auto size = stream.tellg();
    if (size <= 0) throw std::runtime_error("File is empty: " + filePath.string());
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));
    stream.seekg(0);
    stream.read(reinterpret_cast<char*>(bytes.data()), size);
    if (!stream) throw std::runtime_error("Could not read file: " + filePath.string());
    return bytes;
}

std::string FixedString(const char* value, std::size_t capacity) {
    return std::string(value, strnlen_s(value, capacity));
}

std::wstring FormatBytes(std::uint64_t bytes) {
    wchar_t buffer[64]{};
    if (bytes >= 1024ull * 1024ull) {
        swprintf_s(buffer, L"%.1f MiB", static_cast<double>(bytes) / (1024.0 * 1024.0));
    } else {
        swprintf_s(buffer, L"%.1f KiB", static_cast<double>(bytes) / 1024.0);
    }
    return buffer;
}

void ThrowIfFailed(HRESULT result, const char* operation) {
    if (SUCCEEDED(result)) return;
    char message[160]{};
    sprintf_s(message, "%s failed with HRESULT 0x%08X", operation, static_cast<unsigned>(result));
    throw std::runtime_error(message);
}

std::filesystem::path ExecutableDirectory() {
    std::wstring buffer(32768, L'\0');
    const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (!length || length == buffer.size()) throw std::runtime_error("Could not resolve executable path");
    buffer.resize(length);
    return std::filesystem::path(buffer).parent_path();
}

class ViewerApp {
public:
    int Run(HINSTANCE instance, int showCommand) {
        const bool smokeTest = wcsstr(GetCommandLineW(), L"--smoke-test") != nullptr;
        RegisterWindow(instance);
        CreateMainWindow(instance, smokeTest ? SW_HIDE : showCommand, smokeTest);
        LocateAssets();
        LoadSceneFile();
        CreateDevice();
        CreatePipeline();
        CreateGeometryBuffers();
        ResetCamera();
        LoadCodec(0);

        if (smokeTest) {
            for (int codec = 0; codec < static_cast<int>(kCodecLabels.size()); ++codec) {
                LoadCodec(codec);
                for (int filter = 0; filter < static_cast<int>(kFilterLabels.size()); ++filter) {
                    filterMode_ = filter;
                    Render();
                }
            }
            return 0;
        }

        MSG message{};
        while (message.message != WM_QUIT) {
            if (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            } else {
                Render();
            }
        }
        return static_cast<int>(message.wParam);
    }

    LRESULT HandleMessage(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
        switch (message) {
        case WM_COMMAND:
            if (LOWORD(wParam) == kCodecComboId && HIWORD(wParam) == CBN_SELCHANGE) {
                const int selection = static_cast<int>(SendMessageW(codecCombo_, CB_GETCURSEL, 0, 0));
                try {
                    LoadCodec(std::clamp(selection, 0, 3));
                } catch (const std::exception& error) {
                    MessageBoxA(window_, error.what(), "Texture switch failed", MB_OK | MB_ICONERROR);
                    SendMessageW(codecCombo_, CB_SETCURSEL, codecIndex_, 0);
                }
                return 0;
            }
            if (LOWORD(wParam) == kFilterComboId && HIWORD(wParam) == CBN_SELCHANGE) {
                filterMode_ = std::clamp(
                    static_cast<int>(SendMessageW(filterCombo_, CB_GETCURSEL, 0, 0)),
                    0,
                    static_cast<int>(kFilterLabels.size()) - 1);
                UpdateFilterControls();
                return 0;
            }
            if (LOWORD(wParam) == kAnisotropyComboId && HIWORD(wParam) == CBN_SELCHANGE) {
                anisotropyIndex_ = std::clamp(
                    static_cast<int>(SendMessageW(anisotropyCombo_, CB_GETCURSEL, 0, 0)),
                    0,
                    static_cast<int>(kAnisotropyValues.size()) - 1);
                UpdateWindowTitle();
                return 0;
            }
            if (LOWORD(wParam) == kLodBiasComboId && HIWORD(wParam) == CBN_SELCHANGE) {
                lodBiasIndex_ = std::clamp(
                    static_cast<int>(SendMessageW(lodBiasCombo_, CB_GETCURSEL, 0, 0)),
                    0,
                    static_cast<int>(kLodBiasValues.size()) - 1);
                UpdateWindowTitle();
                return 0;
            }
            break;
        case WM_SIZE:
            if (device_ && wParam != SIZE_MINIMIZED) {
                const UINT width = LOWORD(lParam);
                const UINT height = HIWORD(lParam);
                Resize(width, height);
                PositionControls(width);
            }
            return 0;
        case WM_LBUTTONDOWN:
            dragging_ = true;
            previousMouse_ = {GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
            SetCapture(window);
            return 0;
        case WM_LBUTTONUP:
            dragging_ = false;
            if (GetCapture() == window) ReleaseCapture();
            return 0;
        case WM_MOUSEMOVE:
            if (dragging_) {
                const POINT current = {GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
                yaw_ += static_cast<float>(current.x - previousMouse_.x) * 0.006f;
                pitch_ = std::clamp(
                    pitch_ + static_cast<float>(current.y - previousMouse_.y) * 0.006f,
                    -1.25f,
                    1.25f);
                previousMouse_ = current;
            }
            return 0;
        case WM_MOUSEWHEEL: {
            const float notches = static_cast<float>(GET_WHEEL_DELTA_WPARAM(wParam)) / WHEEL_DELTA;
            distance_ = std::clamp(distance_ * std::pow(0.86f, notches), focusRadius_ * 0.08f, focusRadius_ * 8.0f);
            return 0;
        }
        case WM_KEYDOWN:
            if (wParam == 'R') ResetCamera();
            if (wParam == 'F') {
                filterMode_ = (filterMode_ + 1) % static_cast<int>(kFilterLabels.size());
                UpdateFilterControls();
            }
            if (wParam == 'A') {
                anisotropyIndex_ = (anisotropyIndex_ + 1) % static_cast<int>(kAnisotropyValues.size());
                SendMessageW(anisotropyCombo_, CB_SETCURSEL, anisotropyIndex_, 0);
                UpdateWindowTitle();
            }
            if (wParam == VK_OEM_4 || wParam == VK_OEM_6) {
                const int direction = wParam == VK_OEM_4 ? -1 : 1;
                lodBiasIndex_ = std::clamp(
                    lodBiasIndex_ + direction,
                    0,
                    static_cast<int>(kLodBiasValues.size()) - 1);
                SendMessageW(lodBiasCombo_, CB_SETCURSEL, lodBiasIndex_, 0);
                UpdateWindowTitle();
            }
            if (wParam >= '1' && wParam <= '4') {
                const int index = static_cast<int>(wParam - '1');
                SendMessageW(codecCombo_, CB_SETCURSEL, index, 0);
                try {
                    LoadCodec(index);
                } catch (const std::exception& error) {
                    MessageBoxA(window_, error.what(), "Texture switch failed", MB_OK | MB_ICONERROR);
                }
            }
            return 0;
        case WM_ERASEBKGND:
            return 1;
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
        }
        return DefWindowProcW(window, message, wParam, lParam);
    }

private:
    void RegisterWindow(HINSTANCE instance) {
        WNDCLASSEXW windowClass{};
        windowClass.cbSize = sizeof(windowClass);
        windowClass.style = CS_HREDRAW | CS_VREDRAW;
        windowClass.lpfnWndProc = WindowProcedure;
        windowClass.hInstance = instance;
        windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
        windowClass.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
        windowClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
        windowClass.lpszClassName = kWindowClass;
        ThrowIfFailed(RegisterClassExW(&windowClass) ? S_OK : HRESULT_FROM_WIN32(GetLastError()), "RegisterClassExW");
    }

    void CreateMainWindow(HINSTANCE instance, int showCommand, bool smokeTest) {
        RECT rectangle{0, 0, smokeTest ? 320 : 1440, smokeTest ? 240 : 900};
        AdjustWindowRectEx(&rectangle, WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN, FALSE, 0);
        window_ = CreateWindowExW(
            0,
            kWindowClass,
            L"Barcelona Pavilion - Direct3D 11",
            WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            rectangle.right - rectangle.left,
            rectangle.bottom - rectangle.top,
            nullptr,
            nullptr,
            instance,
            this);
        if (!window_) throw std::runtime_error("CreateWindowExW failed");

        codecCombo_ = CreateWindowExW(
            0, L"COMBOBOX", nullptr,
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | CBS_DROPDOWNLIST,
            0, 0, 240, 200,
            window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kCodecComboId)), instance, nullptr);
        filterCombo_ = CreateWindowExW(
            0, L"COMBOBOX", nullptr,
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | CBS_DROPDOWNLIST,
            0, 0, 190, 200,
            window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kFilterComboId)), instance, nullptr);
        anisotropyCombo_ = CreateWindowExW(
            0, L"COMBOBOX", nullptr,
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | CBS_DROPDOWNLIST,
            0, 0, 160, 160,
            window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kAnisotropyComboId)), instance, nullptr);
        lodBiasCombo_ = CreateWindowExW(
            0, L"COMBOBOX", nullptr,
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | CBS_DROPDOWNLIST,
            0, 0, 150, 220,
            window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kLodBiasComboId)), instance, nullptr);
        statusLabel_ = CreateWindowExW(
            0, L"STATIC", L"Drag: orbit   Wheel: zoom   1-4: texture   F: filter   A: anisotropy   [ ]: LOD bias",
            WS_CHILD | WS_VISIBLE | SS_LEFT,
            20, 20, 760, 24,
            window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kStatusLabelId)), instance, nullptr);
        const HFONT font = static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
        SendMessageW(codecCombo_, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
        SendMessageW(filterCombo_, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
        SendMessageW(anisotropyCombo_, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
        SendMessageW(lodBiasCombo_, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
        SendMessageW(statusLabel_, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
        for (const wchar_t* label : kCodecLabels) SendMessageW(codecCombo_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(label));
        for (const wchar_t* label : kFilterLabels) SendMessageW(filterCombo_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(label));
        for (const wchar_t* label : kAnisotropyLabels) {
            SendMessageW(anisotropyCombo_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(label));
        }
        for (const wchar_t* label : kLodBiasLabels) SendMessageW(lodBiasCombo_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(label));
        SendMessageW(codecCombo_, CB_SETCURSEL, 0, 0);
        SendMessageW(filterCombo_, CB_SETCURSEL, filterMode_, 0);
        SendMessageW(anisotropyCombo_, CB_SETCURSEL, anisotropyIndex_, 0);
        SendMessageW(lodBiasCombo_, CB_SETCURSEL, lodBiasIndex_, 0);
        UpdateFilterControls();

        ShowWindow(window_, showCommand);
        UpdateWindow(window_);
        RECT client{};
        GetClientRect(window_, &client);
        PositionControls(static_cast<UINT>(client.right));
    }

    void PositionControls(UINT width) const {
        constexpr int gap = 8;
        constexpr int codecWidth = 220;
        constexpr int filterWidth = 180;
        constexpr int anisotropyWidth = 150;
        constexpr int lodBiasWidth = 145;
        int right = std::max(20, static_cast<int>(width) - 20);
        right -= codecWidth;
        MoveWindow(codecCombo_, right, 16, codecWidth, 220, TRUE);
        right -= gap + filterWidth;
        MoveWindow(filterCombo_, right, 16, filterWidth, 200, TRUE);
        right -= gap + anisotropyWidth;
        MoveWindow(anisotropyCombo_, right, 16, anisotropyWidth, 160, TRUE);
        right -= gap + lodBiasWidth;
        MoveWindow(lodBiasCombo_, right, 16, lodBiasWidth, 220, TRUE);
        MoveWindow(statusLabel_, 20, 22, std::max(120, right - 40), 22, TRUE);
    }

    void UpdateFilterControls() const {
        SendMessageW(filterCombo_, CB_SETCURSEL, filterMode_, 0);
        EnableWindow(anisotropyCombo_, filterMode_ == 3);
        EnableWindow(lodBiasCombo_, filterMode_ >= 2);
        UpdateWindowTitle();
    }

    void LocateAssets() {
        assetsDirectory_ = ExecutableDirectory() / L"assets";
        if (std::filesystem::exists(assetsDirectory_ / L"barcelona.dxscene")) return;
        const auto repositoryCandidate = std::filesystem::current_path() / L"native" / L"win32-directx-viewer" / L"assets";
        if (std::filesystem::exists(repositoryCandidate / L"barcelona.dxscene")) {
            assetsDirectory_ = repositoryCandidate;
            return;
        }
        throw std::runtime_error("Could not locate assets/barcelona.dxscene next to the executable");
    }

    void LoadSceneFile() {
        const auto bytes = ReadBinaryFile(assetsDirectory_ / L"barcelona.dxscene");
        if (bytes.size() < sizeof(native_scene::SceneHeader)) throw std::runtime_error("Scene file is truncated");
        std::memcpy(&sceneHeader_, bytes.data(), sizeof(sceneHeader_));
        if (std::memcmp(sceneHeader_.magic, "DXSC", 4) != 0 || sceneHeader_.version != native_scene::kSceneVersion) {
            throw std::runtime_error("Unsupported native scene format");
        }

        const std::uint64_t expected = sizeof(native_scene::SceneHeader) +
            static_cast<std::uint64_t>(sceneHeader_.materialCount) * sizeof(native_scene::MaterialRecord) +
            static_cast<std::uint64_t>(sceneHeader_.drawCount) * sizeof(native_scene::DrawRecord) +
            static_cast<std::uint64_t>(sceneHeader_.vertexCount) * sizeof(native_scene::Vertex) +
            static_cast<std::uint64_t>(sceneHeader_.indexCount) * sizeof(std::uint32_t);
        if (expected != bytes.size()) throw std::runtime_error("Native scene byte layout is invalid");

        std::size_t offset = sizeof(sceneHeader_);
        materials_.resize(sceneHeader_.materialCount);
        std::memcpy(materials_.data(), bytes.data() + offset, materials_.size() * sizeof(materials_[0]));
        offset += materials_.size() * sizeof(materials_[0]);
        draws_.resize(sceneHeader_.drawCount);
        std::memcpy(draws_.data(), bytes.data() + offset, draws_.size() * sizeof(draws_[0]));
        offset += draws_.size() * sizeof(draws_[0]);
        vertices_.resize(sceneHeader_.vertexCount);
        std::memcpy(vertices_.data(), bytes.data() + offset, vertices_.size() * sizeof(vertices_[0]));
        offset += vertices_.size() * sizeof(vertices_[0]);
        indices_.resize(sceneHeader_.indexCount);
        std::memcpy(indices_.data(), bytes.data() + offset, indices_.size() * sizeof(indices_[0]));

        for (const auto& draw : draws_) {
            if (draw.materialIndex >= materials_.size() || draw.firstIndex + draw.indexCount > indices_.size()) {
                throw std::runtime_error("Native scene contains an invalid draw record");
            }
        }
    }

    void CreateDevice() {
        RECT client{};
        GetClientRect(window_, &client);
        DXGI_SWAP_CHAIN_DESC swapDescription{};
        swapDescription.BufferDesc.Width = std::max<LONG>(client.right, 1);
        swapDescription.BufferDesc.Height = std::max<LONG>(client.bottom, 1);
        swapDescription.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        swapDescription.SampleDesc.Count = 1;
        swapDescription.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        swapDescription.BufferCount = 2;
        swapDescription.OutputWindow = window_;
        swapDescription.Windowed = TRUE;
        swapDescription.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

        std::array<D3D_FEATURE_LEVEL, 2> levels = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
        D3D_FEATURE_LEVEL selectedLevel{};
        UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
#if defined(_DEBUG)
        flags |= D3D11_CREATE_DEVICE_DEBUG;
#endif
        HRESULT result = D3D11CreateDeviceAndSwapChain(
            nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags,
            levels.data(), static_cast<UINT>(levels.size()), D3D11_SDK_VERSION,
            &swapDescription, &swapChain_, &device_, &selectedLevel, &context_);
#if defined(_DEBUG)
        if (result == DXGI_ERROR_SDK_COMPONENT_MISSING) {
            flags &= ~D3D11_CREATE_DEVICE_DEBUG;
            result = D3D11CreateDeviceAndSwapChain(
                nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags,
                levels.data(), static_cast<UINT>(levels.size()), D3D11_SDK_VERSION,
                &swapDescription, &swapChain_, &device_, &selectedLevel, &context_);
        }
#endif
        ThrowIfFailed(result, "D3D11CreateDeviceAndSwapChain");
        Resize(static_cast<UINT>(client.right), static_cast<UINT>(client.bottom));
    }

    void CreatePipeline() {
        ComPtr<ID3DBlob> vertexBytecode;
        CompileShader("VSMain", "vs_5_0", vertexBytecode);
        ThrowIfFailed(device_->CreateVertexShader(
            vertexBytecode->GetBufferPointer(), vertexBytecode->GetBufferSize(), nullptr, &vertexShader_),
            "CreateVertexShader");
        constexpr std::array<const char*, 4> codecDefines = {"4", "1", "2", "3"};
        for (std::size_t index = 0; index < pixelShaders_.size(); ++index) {
            ComPtr<ID3DBlob> pixelBytecode;
            CompileShader("PSMain", "ps_5_0", pixelBytecode, codecDefines[index]);
            ThrowIfFailed(device_->CreatePixelShader(
                pixelBytecode->GetBufferPointer(), pixelBytecode->GetBufferSize(), nullptr, &pixelShaders_[index]),
                "CreatePixelShader");
        }

        const D3D11_INPUT_ELEMENT_DESC inputElements[] = {
            {"POSITION", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 0, D3D11_INPUT_PER_VERTEX_DATA, 0},
            {"NORMAL", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 12, D3D11_INPUT_PER_VERTEX_DATA, 0},
            {"TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 24, D3D11_INPUT_PER_VERTEX_DATA, 0},
        };
        ThrowIfFailed(device_->CreateInputLayout(
            inputElements, static_cast<UINT>(std::size(inputElements)),
            vertexBytecode->GetBufferPointer(), vertexBytecode->GetBufferSize(), &inputLayout_),
            "CreateInputLayout");

        sceneConstantBuffer_ = CreateConstantBuffer(sizeof(SceneConstants));
        materialConstantBuffer_ = CreateConstantBuffer(sizeof(MaterialConstants));
        textureConstantBuffer_ = CreateConstantBuffer(sizeof(TextureConstants));
        filterConstantBuffer_ = CreateConstantBuffer(sizeof(FilterConstants));

        D3D11_RASTERIZER_DESC rasterizerDescription{};
        rasterizerDescription.FillMode = D3D11_FILL_SOLID;
        rasterizerDescription.CullMode = D3D11_CULL_BACK;
        rasterizerDescription.FrontCounterClockwise = TRUE;
        rasterizerDescription.DepthClipEnable = TRUE;
        ThrowIfFailed(device_->CreateRasterizerState(&rasterizerDescription, &cullBack_), "CreateRasterizerState");
        rasterizerDescription.CullMode = D3D11_CULL_NONE;
        ThrowIfFailed(device_->CreateRasterizerState(&rasterizerDescription, &cullNone_), "CreateRasterizerState");

        D3D11_BLEND_DESC blendDescription{};
        blendDescription.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
        ThrowIfFailed(device_->CreateBlendState(&blendDescription, &opaqueBlend_), "CreateBlendState");
        blendDescription.RenderTarget[0].BlendEnable = TRUE;
        blendDescription.RenderTarget[0].SrcBlend = D3D11_BLEND_SRC_ALPHA;
        blendDescription.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
        blendDescription.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
        blendDescription.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE;
        blendDescription.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
        blendDescription.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
        ThrowIfFailed(device_->CreateBlendState(&blendDescription, &alphaBlend_), "CreateBlendState");

        D3D11_DEPTH_STENCIL_DESC depthDescription{};
        depthDescription.DepthEnable = TRUE;
        depthDescription.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ALL;
        depthDescription.DepthFunc = D3D11_COMPARISON_LESS_EQUAL;
        ThrowIfFailed(device_->CreateDepthStencilState(&depthDescription, &opaqueDepth_), "CreateDepthStencilState");
        depthDescription.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ZERO;
        ThrowIfFailed(device_->CreateDepthStencilState(&depthDescription, &transparentDepth_), "CreateDepthStencilState");

        fallbackTexture_ = CreateFallbackStream();
        fallbackOriginalTexture_ = CreateFallbackOriginalTexture();

        D3D11_SAMPLER_DESC samplerDescription{};
        samplerDescription.AddressU = D3D11_TEXTURE_ADDRESS_WRAP;
        samplerDescription.AddressV = D3D11_TEXTURE_ADDRESS_WRAP;
        samplerDescription.AddressW = D3D11_TEXTURE_ADDRESS_WRAP;
        samplerDescription.ComparisonFunc = D3D11_COMPARISON_NEVER;
        samplerDescription.MinLOD = 0;
        samplerDescription.MaxLOD = D3D11_FLOAT32_MAX;
        samplerDescription.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT;
        ThrowIfFailed(
            device_->CreateSamplerState(&samplerDescription, &originalSamplers_[0]),
            "CreateSamplerState(nearest)");
        samplerDescription.Filter = D3D11_FILTER_MIN_MAG_LINEAR_MIP_POINT;
        ThrowIfFailed(
            device_->CreateSamplerState(&samplerDescription, &originalSamplers_[1]),
            "CreateSamplerState(bilinear)");
        samplerDescription.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
        ThrowIfFailed(
            device_->CreateSamplerState(&samplerDescription, &originalSamplers_[2]),
            "CreateSamplerState(trilinear)");
        samplerDescription.Filter = D3D11_FILTER_ANISOTROPIC;
        for (std::size_t index = 0; index < kAnisotropyValues.size(); ++index) {
            samplerDescription.MaxAnisotropy = static_cast<UINT>(kAnisotropyValues[index]);
            ThrowIfFailed(
                device_->CreateSamplerState(&samplerDescription, &originalSamplers_[3 + index]),
                "CreateSamplerState(anisotropic)");
        }
    }

    void CompileShader(
        const char* entryPoint,
        const char* target,
        ComPtr<ID3DBlob>& bytecode,
        const char* activeCodec = nullptr) {
        ComPtr<ID3DBlob> errors;
        const D3D_SHADER_MACRO codecMacros[] = {
            {"ACTIVE_CODEC", activeCodec},
            {nullptr, nullptr},
        };
        UINT flags = D3DCOMPILE_ENABLE_STRICTNESS;
#if defined(_DEBUG)
        flags |= D3DCOMPILE_DEBUG | D3DCOMPILE_SKIP_OPTIMIZATION;
#else
        flags |= activeCodec && std::strcmp(activeCodec, "2") == 0
            ? D3DCOMPILE_SKIP_OPTIMIZATION
            : D3DCOMPILE_OPTIMIZATION_LEVEL3;
#endif
        const auto shaderPath = assetsDirectory_ / L"scene.hlsl";
        const HRESULT result = D3DCompileFromFile(
            shaderPath.c_str(),
            activeCodec ? codecMacros : nullptr,
            D3D_COMPILE_STANDARD_FILE_INCLUDE,
            entryPoint,
            target,
            flags,
            0,
            &bytecode,
            &errors);
        if (FAILED(result)) {
            const std::string detail = errors
                ? std::string(static_cast<const char*>(errors->GetBufferPointer()), errors->GetBufferSize())
                : "unknown shader compiler error";
            throw std::runtime_error(detail);
        }
    }

    ComPtr<ID3D11Buffer> CreateConstantBuffer(UINT byteWidth) {
        D3D11_BUFFER_DESC description{};
        description.ByteWidth = byteWidth;
        description.Usage = D3D11_USAGE_DEFAULT;
        description.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
        ComPtr<ID3D11Buffer> buffer;
        ThrowIfFailed(device_->CreateBuffer(&description, nullptr, &buffer), "CreateBuffer(constant)");
        return buffer;
    }

    void CreateGeometryBuffers() {
        D3D11_BUFFER_DESC vertexDescription{};
        vertexDescription.ByteWidth = static_cast<UINT>(vertices_.size() * sizeof(vertices_[0]));
        vertexDescription.Usage = D3D11_USAGE_IMMUTABLE;
        vertexDescription.BindFlags = D3D11_BIND_VERTEX_BUFFER;
        D3D11_SUBRESOURCE_DATA vertexData{vertices_.data(), 0, 0};
        ThrowIfFailed(device_->CreateBuffer(&vertexDescription, &vertexData, &vertexBuffer_), "CreateBuffer(vertices)");

        D3D11_BUFFER_DESC indexDescription{};
        indexDescription.ByteWidth = static_cast<UINT>(indices_.size() * sizeof(indices_[0]));
        indexDescription.Usage = D3D11_USAGE_IMMUTABLE;
        indexDescription.BindFlags = D3D11_BIND_INDEX_BUFFER;
        D3D11_SUBRESOURCE_DATA indexData{indices_.data(), 0, 0};
        ThrowIfFailed(device_->CreateBuffer(&indexDescription, &indexData, &indexBuffer_), "CreateBuffer(indices)");
    }

    void Resize(UINT width, UINT height) {
        if (!swapChain_ || !width || !height) return;
        context_->OMSetRenderTargets(0, nullptr, nullptr);
        renderTarget_.Reset();
        depthStencil_.Reset();
        depthTexture_.Reset();
        ThrowIfFailed(swapChain_->ResizeBuffers(0, width, height, DXGI_FORMAT_UNKNOWN, 0), "ResizeBuffers");

        ComPtr<ID3D11Texture2D> backBuffer;
        ThrowIfFailed(swapChain_->GetBuffer(0, IID_PPV_ARGS(&backBuffer)), "GetBuffer");
        ThrowIfFailed(device_->CreateRenderTargetView(backBuffer.Get(), nullptr, &renderTarget_), "CreateRenderTargetView");

        D3D11_TEXTURE2D_DESC depthDescription{};
        depthDescription.Width = width;
        depthDescription.Height = height;
        depthDescription.MipLevels = 1;
        depthDescription.ArraySize = 1;
        depthDescription.Format = DXGI_FORMAT_D24_UNORM_S8_UINT;
        depthDescription.SampleDesc.Count = 1;
        depthDescription.BindFlags = D3D11_BIND_DEPTH_STENCIL;
        ThrowIfFailed(device_->CreateTexture2D(&depthDescription, nullptr, &depthTexture_), "CreateTexture2D(depth)");
        ThrowIfFailed(device_->CreateDepthStencilView(depthTexture_.Get(), nullptr, &depthStencil_), "CreateDepthStencilView");

        viewport_ = {0.0f, 0.0f, static_cast<float>(width), static_cast<float>(height), 0.0f, 1.0f};
    }

    void LoadCodec(int index) {
        std::unordered_map<std::string, TextureResourcePtr> cache;
        std::vector<MaterialTextures> loaded(materials_.size());
        const bool original = index == 0;
        const auto directory = original
            ? assetsDirectory_ / L"original"
            : assetsDirectory_ / L"streams" / std::filesystem::path(kCodecDirectories[index]);

        for (std::size_t materialIndex = 0; materialIndex < materials_.size(); materialIndex += 1) {
            const auto& material = materials_[materialIndex];
            if (material.flags & native_scene::MaterialHasBaseTexture) {
                const std::string identifier = FixedString(material.baseTexture, sizeof(material.baseTexture));
                if (original) {
                    loaded[materialIndex].base = LoadCachedOriginal(directory, identifier, true, cache);
                } else {
                    loaded[materialIndex].base = LoadCachedStream(directory, identifier, cache);
                    const auto alphaPath = directory / std::filesystem::path(identifier + "-alpha.dxtx");
                    if (std::filesystem::exists(alphaPath)) {
                        loaded[materialIndex].alpha = LoadCachedStream(directory, identifier + "-alpha", cache);
                    }
                }
            }
            if (material.flags & native_scene::MaterialHasBumpTexture) {
                const std::string identifier = FixedString(material.bumpTexture, sizeof(material.bumpTexture));
                loaded[materialIndex].bump = original
                    ? LoadCachedOriginal(directory, identifier, false, cache)
                    : LoadCachedStream(directory, identifier, cache);
            }
        }
        materialTextures_ = std::move(loaded);
        codecIndex_ = index;
        UpdateWindowTitle();
    }

    TextureResourcePtr LoadCachedStream(
        const std::filesystem::path& directory,
        const std::string& identifier,
        std::unordered_map<std::string, TextureResourcePtr>& cache) {
        if (const auto found = cache.find(identifier); found != cache.end()) return found->second;
        auto texture = LoadTextureStream(directory / std::filesystem::path(identifier + ".dxtx"));
        cache.emplace(identifier, texture);
        return texture;
    }

    TextureResourcePtr LoadTextureStream(const std::filesystem::path& filePath) {
        const auto bytes = ReadBinaryFile(filePath);
        if (bytes.size() < sizeof(native_scene::TextureStreamHeader)) {
            throw std::runtime_error("Texture stream is truncated: " + filePath.string());
        }
        native_scene::TextureStreamHeader header{};
        std::memcpy(&header, bytes.data(), sizeof(header));
        if (
            std::memcmp(header.magic, "DXTX", 4) != 0 ||
            header.version != native_scene::kTextureStreamVersion ||
            header.codec < native_scene::TextureCodecBpal ||
            header.codec > native_scene::TextureCodecAstc ||
            !header.width || !header.height || !header.dataBytes ||
            (header.dataBytes & 3u) != 0u ||
            bytes.size() != sizeof(header) + header.dataBytes
        ) {
            throw std::runtime_error("Texture stream header is invalid: " + filePath.string());
        }

        D3D11_BUFFER_DESC description{};
        description.ByteWidth = header.dataBytes;
        description.Usage = D3D11_USAGE_IMMUTABLE;
        description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        description.MiscFlags = D3D11_RESOURCE_MISC_BUFFER_ALLOW_RAW_VIEWS;
        D3D11_SUBRESOURCE_DATA initialData{bytes.data() + sizeof(header), 0, 0};
        auto resource = std::make_shared<TextureGpuResource>();
        ThrowIfFailed(device_->CreateBuffer(&description, &initialData, &resource->buffer), "CreateBuffer(texture stream)");

        D3D11_SHADER_RESOURCE_VIEW_DESC viewDescription{};
        viewDescription.Format = DXGI_FORMAT_R32_TYPELESS;
        viewDescription.ViewDimension = D3D11_SRV_DIMENSION_BUFFEREX;
        viewDescription.BufferEx.FirstElement = 0;
        viewDescription.BufferEx.NumElements = header.dataBytes / 4;
        viewDescription.BufferEx.Flags = D3D11_BUFFEREX_SRV_FLAG_RAW;
        ThrowIfFailed(
            device_->CreateShaderResourceView(resource->buffer.Get(), &viewDescription, &resource->view),
            "CreateShaderResourceView(texture stream)");

        resource->descriptor.header[0] = header.codec;
        resource->descriptor.header[1] = header.width;
        resource->descriptor.header[2] = header.height;
        resource->descriptor.header[3] = header.dataBytes;
        std::copy(std::begin(header.parameters), std::end(header.parameters), resource->descriptor.parameters);
        return resource;
    }

    TextureResourcePtr LoadCachedOriginal(
        const std::filesystem::path& directory,
        const std::string& identifier,
        bool srgb,
        std::unordered_map<std::string, TextureResourcePtr>& cache) {
        const std::string cacheKey = std::string(srgb ? "color:" : "linear:") + identifier;
        if (const auto found = cache.find(cacheKey); found != cache.end()) return found->second;
        auto filePath = directory / std::filesystem::path(identifier + ".bc7.dds");
        if (!std::filesystem::exists(filePath)) {
            filePath = directory / std::filesystem::path(identifier + ".bc1.dds");
        }
        auto texture = LoadOriginalTexture(filePath, srgb);
        cache.emplace(cacheKey, texture);
        return texture;
    }

    TextureResourcePtr LoadOriginalTexture(const std::filesystem::path& filePath, bool srgb) {
        const auto bytes = ReadBinaryFile(filePath);
        if (bytes.size() < 128 || std::memcmp(bytes.data(), "DDS ", 4) != 0) {
            throw std::runtime_error("Original DDS header is invalid: " + filePath.string());
        }
        const auto read32 = [&bytes](std::size_t offset) {
            std::uint32_t value{};
            if (offset + sizeof(value) > bytes.size()) return value;
            std::memcpy(&value, bytes.data() + offset, sizeof(value));
            return value;
        };
        const std::uint32_t height = read32(12);
        const std::uint32_t width = read32(16);
        std::size_t dataOffset{};
        std::uint32_t blockBytes{};
        DXGI_FORMAT format{};
        if (std::memcmp(bytes.data() + 84, "DXT1", 4) == 0) {
            dataOffset = 128;
            blockBytes = 8;
            format = srgb ? DXGI_FORMAT_BC1_UNORM_SRGB : DXGI_FORMAT_BC1_UNORM;
        } else if (
            bytes.size() >= 148 &&
            std::memcmp(bytes.data() + 84, "DX10", 4) == 0 &&
            read32(128) == 98
        ) {
            dataOffset = 148;
            blockBytes = 16;
            format = srgb ? DXGI_FORMAT_BC7_UNORM_SRGB : DXGI_FORMAT_BC7_UNORM;
        } else {
            throw std::runtime_error("Original DDS is not BC1 or BC7: " + filePath.string());
        }
        if (
            !width || !height ||
            width > D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION ||
            height > D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION
        ) {
            throw std::runtime_error("Original DDS dimensions are invalid: " + filePath.string());
        }
        const std::uint64_t blocksX = (static_cast<std::uint64_t>(width) + 3) / 4;
        const std::uint64_t blocksY = (static_cast<std::uint64_t>(height) + 3) / 4;
        const std::uint32_t storageWidth = (width + 3u) & ~3u;
        const std::uint32_t storageHeight = (height + 3u) & ~3u;
        const std::uint64_t dataBytes = blocksX * blocksY * blockBytes;
        if (dataOffset + dataBytes != bytes.size() || dataBytes > UINT_MAX) {
            throw std::runtime_error("Original DDS dimensions are invalid: " + filePath.string());
        }

        D3D11_TEXTURE2D_DESC description{};
        description.Width = storageWidth;
        description.Height = storageHeight;
        description.MipLevels = 1;
        description.ArraySize = 1;
        description.Format = format;
        description.SampleDesc.Count = 1;
        description.Usage = D3D11_USAGE_IMMUTABLE;
        description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        D3D11_SUBRESOURCE_DATA initialData{
            bytes.data() + dataOffset,
            static_cast<UINT>(blocksX * blockBytes),
            static_cast<UINT>(dataBytes),
        };
        auto resource = std::make_shared<TextureGpuResource>();
        ThrowIfFailed(
            device_->CreateTexture2D(&description, &initialData, &resource->texture),
            "CreateTexture2D(BC1/BC7 original)");
        ThrowIfFailed(
            device_->CreateShaderResourceView(resource->texture.Get(), nullptr, &resource->view),
            "CreateShaderResourceView(BC1/BC7 original)");
        resource->descriptor.header[0] = 4;
        resource->descriptor.header[1] = width;
        resource->descriptor.header[2] = height;
        resource->descriptor.header[3] = static_cast<std::uint32_t>(dataBytes);
        resource->descriptor.parameters[0] = storageWidth;
        resource->descriptor.parameters[1] = storageHeight;
        return resource;
    }

    TextureResourcePtr CreateFallbackStream() {
        const std::uint32_t zero = 0;
        D3D11_BUFFER_DESC description{};
        description.ByteWidth = sizeof(zero);
        description.Usage = D3D11_USAGE_IMMUTABLE;
        description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        description.MiscFlags = D3D11_RESOURCE_MISC_BUFFER_ALLOW_RAW_VIEWS;
        D3D11_SUBRESOURCE_DATA initialData{&zero, 0, 0};
        auto resource = std::make_shared<TextureGpuResource>();
        ThrowIfFailed(device_->CreateBuffer(&description, &initialData, &resource->buffer), "CreateBuffer(fallback stream)");

        D3D11_SHADER_RESOURCE_VIEW_DESC viewDescription{};
        viewDescription.Format = DXGI_FORMAT_R32_TYPELESS;
        viewDescription.ViewDimension = D3D11_SRV_DIMENSION_BUFFEREX;
        viewDescription.BufferEx.NumElements = 1;
        viewDescription.BufferEx.Flags = D3D11_BUFFEREX_SRV_FLAG_RAW;
        ThrowIfFailed(
            device_->CreateShaderResourceView(resource->buffer.Get(), &viewDescription, &resource->view),
            "CreateShaderResourceView(fallback stream)");
        return resource;
    }

    TextureResourcePtr CreateFallbackOriginalTexture() {
        const std::uint8_t whiteBc1Block[8] = {0xff, 0xff, 0x00, 0x00, 0, 0, 0, 0};
        D3D11_TEXTURE2D_DESC description{};
        description.Width = 4;
        description.Height = 4;
        description.MipLevels = 1;
        description.ArraySize = 1;
        description.Format = DXGI_FORMAT_BC1_UNORM;
        description.SampleDesc.Count = 1;
        description.Usage = D3D11_USAGE_IMMUTABLE;
        description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        D3D11_SUBRESOURCE_DATA initialData{whiteBc1Block, sizeof(whiteBc1Block), sizeof(whiteBc1Block)};
        auto resource = std::make_shared<TextureGpuResource>();
        ThrowIfFailed(
            device_->CreateTexture2D(&description, &initialData, &resource->texture),
            "CreateTexture2D(fallback BC1)");
        ThrowIfFailed(
            device_->CreateShaderResourceView(resource->texture.Get(), nullptr, &resource->view),
            "CreateShaderResourceView(fallback BC1)");
        return resource;
    }

    void ResetCamera() {
        focusTarget_ = XMFLOAT3(
            (sceneHeader_.boundsMin[0] + sceneHeader_.boundsMax[0]) * 0.5f,
            (sceneHeader_.boundsMin[1] + sceneHeader_.boundsMax[1]) * 0.5f,
            (sceneHeader_.boundsMin[2] + sceneHeader_.boundsMax[2]) * 0.5f);
        const float sizeX = sceneHeader_.boundsMax[0] - sceneHeader_.boundsMin[0];
        const float sizeY = sceneHeader_.boundsMax[1] - sceneHeader_.boundsMin[1];
        const float sizeZ = sceneHeader_.boundsMax[2] - sceneHeader_.boundsMin[2];
        focusRadius_ = std::max(std::sqrt(sizeX * sizeX + sizeY * sizeY + sizeZ * sizeZ) * 0.5f, 1.0f);
        yaw_ = 0.82f;
        pitch_ = 0.48f;
        distance_ = focusRadius_ / std::sin(DirectX::XM_PIDIV4 * 0.5f) * 0.68f;
    }

    XMFLOAT3 CameraPosition() const {
        const float horizontal = std::cos(pitch_) * distance_;
        return XMFLOAT3(
            focusTarget_.x + std::sin(yaw_) * horizontal,
            focusTarget_.y + std::sin(pitch_) * distance_,
            focusTarget_.z + std::cos(yaw_) * horizontal);
    }

    void Render() {
        if (!renderTarget_ || !depthStencil_ || materialTextures_.size() != materials_.size()) return;
        const float clearColor[] = {0.043f, 0.067f, 0.071f, 1.0f};
        context_->ClearRenderTargetView(renderTarget_.Get(), clearColor);
        context_->ClearDepthStencilView(depthStencil_.Get(), D3D11_CLEAR_DEPTH | D3D11_CLEAR_STENCIL, 1.0f, 0);
        context_->OMSetRenderTargets(1, renderTarget_.GetAddressOf(), depthStencil_.Get());
        context_->RSSetViewports(1, &viewport_);

        const XMFLOAT3 camera = CameraPosition();
        const XMVECTOR eye = DirectX::XMLoadFloat3(&camera);
        const XMVECTOR target = DirectX::XMLoadFloat3(&focusTarget_);
        const XMMATRIX view = DirectX::XMMatrixLookAtRH(eye, target, DirectX::XMVectorSet(0, 1, 0, 0));
        const float aspect = viewport_.Width / std::max(viewport_.Height, 1.0f);
        const XMMATRIX projection = DirectX::XMMatrixPerspectiveFovRH(
            DirectX::XM_PIDIV4, aspect, std::max(focusRadius_ / 1000.0f, 0.02f), focusRadius_ * 40.0f);
        SceneConstants sceneConstants{};
        DirectX::XMStoreFloat4x4(&sceneConstants.viewProjection, DirectX::XMMatrixTranspose(view * projection));
        sceneConstants.lightDirectionExposure = XMFLOAT4(0.35f, -1.0f, 0.28f, 1.12f);
        sceneConstants.cameraPosition = XMFLOAT4(camera.x, camera.y, camera.z, 1.0f);
        context_->UpdateSubresource(sceneConstantBuffer_.Get(), 0, nullptr, &sceneConstants, 0, 0);
        FilterConstants filterConstants{};
        filterConstants.parameters = XMFLOAT4(
            static_cast<float>(filterMode_),
            kAnisotropyValues[anisotropyIndex_],
            kLodBiasValues[lodBiasIndex_],
            0.0f);
        context_->UpdateSubresource(filterConstantBuffer_.Get(), 0, nullptr, &filterConstants, 0, 0);

        const UINT stride = sizeof(native_scene::Vertex);
        const UINT offset = 0;
        context_->IASetInputLayout(inputLayout_.Get());
        context_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        context_->IASetVertexBuffers(0, 1, vertexBuffer_.GetAddressOf(), &stride, &offset);
        context_->IASetIndexBuffer(indexBuffer_.Get(), DXGI_FORMAT_R32_UINT, 0);
        context_->VSSetShader(vertexShader_.Get(), nullptr, 0);
        context_->VSSetConstantBuffers(0, 1, sceneConstantBuffer_.GetAddressOf());
        context_->PSSetShader(pixelShaders_[codecIndex_].Get(), nullptr, 0);
        context_->PSSetConstantBuffers(0, 1, sceneConstantBuffer_.GetAddressOf());
        context_->PSSetConstantBuffers(1, 1, materialConstantBuffer_.GetAddressOf());
        context_->PSSetConstantBuffers(2, 1, textureConstantBuffer_.GetAddressOf());
        context_->PSSetConstantBuffers(3, 1, filterConstantBuffer_.GetAddressOf());
        const int samplerIndex = filterMode_ < 3 ? filterMode_ : 3 + anisotropyIndex_;
        context_->PSSetSamplers(0, 1, originalSamplers_[samplerIndex].GetAddressOf());

        const float blendFactor[4] = {0, 0, 0, 0};
        for (int transparentPass = 0; transparentPass < 2; transparentPass += 1) {
            context_->OMSetBlendState(transparentPass ? alphaBlend_.Get() : opaqueBlend_.Get(), blendFactor, 0xffffffff);
            context_->OMSetDepthStencilState(transparentPass ? transparentDepth_.Get() : opaqueDepth_.Get(), 0);

            for (const auto& draw : draws_) {
                const auto& material = materials_[draw.materialIndex];
                const bool transparent = (material.flags & native_scene::MaterialTransparent) != 0;
                if (transparent != (transparentPass != 0)) continue;
                context_->RSSetState((material.flags & native_scene::MaterialDoubleSided) ? cullNone_.Get() : cullBack_.Get());

                MaterialConstants materialConstants{};
                materialConstants.baseColor = XMFLOAT4(
                    material.baseColor[0], material.baseColor[1], material.baseColor[2], material.baseColor[3]);
                materialConstants.parameters = XMFLOAT4(
                    (material.flags & native_scene::MaterialHasBaseTexture) ? 1.0f : 0.0f,
                    (material.flags & native_scene::MaterialHasBumpTexture) ? 1.0f : 0.0f,
                    material.alphaCutoff,
                    (material.flags & native_scene::MaterialEmissive) ? 1.0f : 0.0f);
                context_->UpdateSubresource(materialConstantBuffer_.Get(), 0, nullptr, &materialConstants, 0, 0);

                const auto& materialStreams = materialTextures_[draw.materialIndex];
                const TextureResourcePtr& fallback = codecIndex_ == 0
                    ? fallbackOriginalTexture_
                    : fallbackTexture_;
                const TextureResourcePtr streams[] = {
                    materialStreams.base ? materialStreams.base : fallback,
                    materialStreams.alpha ? materialStreams.alpha : fallback,
                    materialStreams.bump ? materialStreams.bump : fallback,
                };
                TextureConstants textureConstants{};
                ID3D11ShaderResourceView* resources[3]{};
                for (std::size_t streamIndex = 0; streamIndex < std::size(streams); ++streamIndex) {
                    textureConstants.streams[streamIndex] = streams[streamIndex]->descriptor;
                    resources[streamIndex] = streams[streamIndex]->view.Get();
                }
                context_->UpdateSubresource(textureConstantBuffer_.Get(), 0, nullptr, &textureConstants, 0, 0);
                context_->PSSetShaderResources(0, static_cast<UINT>(std::size(resources)), resources);
                context_->DrawIndexed(draw.indexCount, draw.firstIndex, 0);
            }
        }

        swapChain_->Present(1, 0);
    }

    void UpdateWindowTitle() const {
        std::wstring title = L"Barcelona Pavilion - Direct3D 11 - ";
        title += kCodecLabels[codecIndex_];
        title += L" (";
        title += FormatBytes(sceneHeader_.codecBytes[codecIndex_]);
        title += L" texture data) - ";
        title += kFilterNames[filterMode_];
        if (filterMode_ == 3) {
            wchar_t anisotropy[16]{};
            swprintf_s(anisotropy, L" %.0fx", kAnisotropyValues[anisotropyIndex_]);
            title += anisotropy;
        }
        if (filterMode_ >= 2) {
            wchar_t lodBias[32]{};
            swprintf_s(lodBias, L" - LOD bias %+.1f", kLodBiasValues[lodBiasIndex_]);
            title += lodBias;
        }
        SetWindowTextW(window_, title.c_str());
    }

    static LRESULT CALLBACK WindowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
        ViewerApp* app = reinterpret_cast<ViewerApp*>(GetWindowLongPtrW(window, GWLP_USERDATA));
        if (message == WM_NCCREATE) {
            const auto create = reinterpret_cast<CREATESTRUCTW*>(lParam);
            app = static_cast<ViewerApp*>(create->lpCreateParams);
            SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(app));
            app->window_ = window;
        }
        return app ? app->HandleMessage(window, message, wParam, lParam) : DefWindowProcW(window, message, wParam, lParam);
    }

    HWND window_{};
    HWND codecCombo_{};
    HWND filterCombo_{};
    HWND anisotropyCombo_{};
    HWND lodBiasCombo_{};
    HWND statusLabel_{};
    std::filesystem::path assetsDirectory_;
    native_scene::SceneHeader sceneHeader_{};
    std::vector<native_scene::MaterialRecord> materials_;
    std::vector<native_scene::DrawRecord> draws_;
    std::vector<native_scene::Vertex> vertices_;
    std::vector<std::uint32_t> indices_;
    std::vector<MaterialTextures> materialTextures_;

    ComPtr<ID3D11Device> device_;
    ComPtr<ID3D11DeviceContext> context_;
    ComPtr<IDXGISwapChain> swapChain_;
    ComPtr<ID3D11RenderTargetView> renderTarget_;
    ComPtr<ID3D11Texture2D> depthTexture_;
    ComPtr<ID3D11DepthStencilView> depthStencil_;
    ComPtr<ID3D11VertexShader> vertexShader_;
    std::array<ComPtr<ID3D11PixelShader>, 4> pixelShaders_;
    ComPtr<ID3D11InputLayout> inputLayout_;
    ComPtr<ID3D11Buffer> vertexBuffer_;
    ComPtr<ID3D11Buffer> indexBuffer_;
    ComPtr<ID3D11Buffer> sceneConstantBuffer_;
    ComPtr<ID3D11Buffer> materialConstantBuffer_;
    ComPtr<ID3D11Buffer> textureConstantBuffer_;
    ComPtr<ID3D11Buffer> filterConstantBuffer_;
    ComPtr<ID3D11RasterizerState> cullBack_;
    ComPtr<ID3D11RasterizerState> cullNone_;
    ComPtr<ID3D11BlendState> opaqueBlend_;
    ComPtr<ID3D11BlendState> alphaBlend_;
    ComPtr<ID3D11DepthStencilState> opaqueDepth_;
    ComPtr<ID3D11DepthStencilState> transparentDepth_;
    std::array<ComPtr<ID3D11SamplerState>, 6> originalSamplers_;
    TextureResourcePtr fallbackTexture_;
    TextureResourcePtr fallbackOriginalTexture_;
    D3D11_VIEWPORT viewport_{};

    XMFLOAT3 focusTarget_{};
    float focusRadius_{1.0f};
    float yaw_{0.82f};
    float pitch_{0.48f};
    float distance_{10.0f};
    bool dragging_{};
    POINT previousMouse_{};
    int codecIndex_{};
    int filterMode_{2};
    int anisotropyIndex_{1};
    int lodBiasIndex_{4};
};

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int showCommand) {
    try {
        ViewerApp app;
        return app.Run(instance, showCommand);
    } catch (const std::exception& error) {
        MessageBoxA(nullptr, error.what(), "Native scene viewer failed", MB_OK | MB_ICONERROR);
        return 1;
    }
}
