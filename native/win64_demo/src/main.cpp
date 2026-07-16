#include "texture_loader.h"

#include <windows.h>
#include <commdlg.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <directxmath.h>
#include <shellapi.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <string>
#include <vector>

namespace {

using DirectX::XMFLOAT2;
using DirectX::XMFLOAT3;
using DirectX::XMFLOAT4;
using DirectX::XMFLOAT4X4;
using DirectX::XMMATRIX;
using Microsoft::WRL::ComPtr;

constexpr wchar_t kWindowClass[] = L"BlockTextureWin64Demo";
constexpr UINT_PTR kRenderTimer = 1;
constexpr int kUploadButton = 1001;
constexpr int kSampleCombo = 1002;
constexpr int kPauseButton = 1003;
constexpr int kStatusLabel = 1004;

struct Vertex {
    XMFLOAT3 position;
    XMFLOAT3 normal;
    XMFLOAT2 uv;
};

struct SceneConstants {
    XMFLOAT4X4 world_view_projection;
    XMFLOAT4X4 world;
    XMFLOAT4 light_direction;
};

struct SampleTexture {
    const wchar_t* label;
    const wchar_t* filename;
};

constexpr std::array<SampleTexture, 5> kSamples = {{
    {L"BPAL v5 — stone", L"stone-texture-wic-2.38bpp.bpal"},
    {L"BPLM v1 — stone + stored mips", L"stone-texture-wic.bplm"},
    {L"DCTBS2 v2 — stone", L"stone-texture-wic-1.5bpp.dctbs2"},
    {L"BPDH v1 — landscape", L"landscape-alaska.bpdh"},
    {L"JPEG — Windows WIC", L"stone-texture-small.jpg"},
}};

constexpr char kShaderSource[] = R"(
cbuffer Scene : register(b0) {
    row_major float4x4 worldViewProjection;
    row_major float4x4 world;
    float4 lightDirection;
};

struct VertexInput {
    float3 position : POSITION;
    float3 normal : NORMAL;
    float2 uv : TEXCOORD0;
};

struct PixelInput {
    float4 position : SV_POSITION;
    float3 normal : NORMAL;
    float2 uv : TEXCOORD0;
};

PixelInput VSMain(VertexInput input) {
    PixelInput output;
    output.position = mul(float4(input.position, 1.0), worldViewProjection);
    output.normal = mul(float4(input.normal, 0.0), world).xyz;
    output.uv = input.uv;
    return output;
}

Texture2D cubeTexture : register(t0);
SamplerState cubeSampler : register(s0);

float4 PSMain(PixelInput input) : SV_TARGET {
    float3 normal = normalize(input.normal);
    float diffuse = saturate(dot(normal, normalize(-lightDirection.xyz)));
    float lighting = 0.28 + diffuse * 0.72;
    float4 color = cubeTexture.Sample(cubeSampler, input.uv);
    return float4(color.rgb * lighting, color.a);
}
)";

std::wstring HresultMessage(HRESULT result) {
    wchar_t* message = nullptr;
    const DWORD flags = FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
        FORMAT_MESSAGE_IGNORE_INSERTS;
    FormatMessageW(
        flags,
        nullptr,
        static_cast<DWORD>(result),
        MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        reinterpret_cast<wchar_t*>(&message),
        0,
        nullptr
    );
    std::wstring text = message != nullptr ? message : L"Unknown Direct3D error";
    if (message != nullptr) LocalFree(message);
    while (!text.empty() && (text.back() == L'\r' || text.back() == L'\n')) text.pop_back();
    return text;
}

std::filesystem::path ExecutableDirectory() {
    std::wstring path(32768, L'\0');
    const DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    path.resize(length);
    return std::filesystem::path(path).parent_path();
}

texture_demo::TextureImage MakeCheckerboard() {
    texture_demo::TextureImage image;
    image.format = L"Procedural fallback";
    texture_demo::MipLevel level;
    level.width = 256;
    level.height = 256;
    level.rgba.resize(static_cast<std::size_t>(level.width) * level.height * 4u);
    for (std::uint32_t y = 0; y < level.height; ++y) {
        for (std::uint32_t x = 0; x < level.width; ++x) {
            const bool bright = ((x / 32u) ^ (y / 32u)) % 2u != 0;
            const std::size_t offset = (static_cast<std::size_t>(y) * level.width + x) * 4u;
            level.rgba[offset] = bright ? 60 : 14;
            level.rgba[offset + 1] = bright ? 190 : 48;
            level.rgba[offset + 2] = bright ? 220 : 68;
            level.rgba[offset + 3] = 255;
        }
    }
    image.mips.push_back(std::move(level));
    return image;
}

class DemoApplication {
public:
    explicit DemoApplication(HINSTANCE instance) : instance_(instance) {}

    int Run(int show_command) {
        WNDCLASSEXW window_class{};
        window_class.cbSize = sizeof(window_class);
        window_class.style = CS_HREDRAW | CS_VREDRAW;
        window_class.lpfnWndProc = WindowProc;
        window_class.hInstance = instance_;
        window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
        window_class.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
        window_class.hIconSm = window_class.hIcon;
        window_class.lpszClassName = kWindowClass;
        if (!RegisterClassExW(&window_class)) return 1;

        window_ = CreateWindowExW(
            0,
            kWindowClass,
            L"Block Texture Formats — Native Win64 Demo",
            WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            1180,
            820,
            nullptr,
            nullptr,
            instance_,
            this
        );
        if (window_ == nullptr) return 1;

        CreateControls();
        DragAcceptFiles(window_, TRUE);
        if (!CreateDeviceResources()) {
            MessageBoxW(window_, last_error_.c_str(), L"Direct3D initialization failed", MB_ICONERROR);
            return 1;
        }
        LoadInitialTexture();
        ShowWindow(window_, show_command);
        UpdateWindow(window_);
        SetTimer(window_, kRenderTimer, 16, nullptr);

        MSG message{};
        while (GetMessageW(&message, nullptr, 0, 0) > 0) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        return static_cast<int>(message.wParam);
    }

private:
    static LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
        DemoApplication* app = nullptr;
        if (message == WM_NCCREATE) {
            const auto* create = reinterpret_cast<CREATESTRUCTW*>(lparam);
            app = static_cast<DemoApplication*>(create->lpCreateParams);
            SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(app));
            app->window_ = window;
        } else {
            app = reinterpret_cast<DemoApplication*>(GetWindowLongPtrW(window, GWLP_USERDATA));
        }
        return app != nullptr ? app->HandleMessage(message, wparam, lparam) :
            DefWindowProcW(window, message, wparam, lparam);
    }

    LRESULT HandleMessage(UINT message, WPARAM wparam, LPARAM lparam) {
        switch (message) {
        case WM_COMMAND:
            if (LOWORD(wparam) == kUploadButton && HIWORD(wparam) == BN_CLICKED) {
                ShowUploadDialog();
                return 0;
            }
            if (LOWORD(wparam) == kPauseButton && HIWORD(wparam) == BN_CLICKED) {
                paused_ = !paused_;
                SetWindowTextW(pause_button_, paused_ ? L"Resume" : L"Pause");
                return 0;
            }
            if (LOWORD(wparam) == kSampleCombo && HIWORD(wparam) == CBN_SELCHANGE) {
                const LRESULT selected = SendMessageW(sample_combo_, CB_GETCURSEL, 0, 0);
                if (selected >= 0 && selected < static_cast<LRESULT>(kSamples.size())) {
                    LoadSample(static_cast<std::size_t>(selected));
                }
                return 0;
            }
            break;
        case WM_DROPFILES: {
            const HDROP drop = reinterpret_cast<HDROP>(wparam);
            std::wstring path(32768, L'\0');
            const UINT length = DragQueryFileW(drop, 0, path.data(), static_cast<UINT>(path.size()));
            path.resize(length);
            DragFinish(drop);
            if (!path.empty()) LoadTexture(path);
            return 0;
        }
        case WM_KEYDOWN:
            if (wparam == VK_SPACE) {
                paused_ = !paused_;
                SetWindowTextW(pause_button_, paused_ ? L"Resume" : L"Pause");
                return 0;
            }
            break;
        case WM_SIZE:
            LayoutControls(LOWORD(lparam), HIWORD(lparam));
            if (device_ && wparam != SIZE_MINIMIZED) ResizeSwapChain(LOWORD(lparam), HIWORD(lparam));
            return 0;
        case WM_TIMER:
            if (wparam == kRenderTimer) {
                Render();
                return 0;
            }
            break;
        case WM_CTLCOLORSTATIC: {
            const HDC context = reinterpret_cast<HDC>(wparam);
            SetTextColor(context, RGB(235, 241, 248));
            SetBkColor(context, RGB(22, 28, 38));
            return reinterpret_cast<LRESULT>(panel_brush_);
        }
        case WM_ERASEBKGND:
            return 1;
        case WM_DESTROY:
            KillTimer(window_, kRenderTimer);
            if (panel_brush_ != nullptr) {
                DeleteObject(panel_brush_);
                panel_brush_ = nullptr;
            }
            PostQuitMessage(0);
            return 0;
        default:
            break;
        }
        return DefWindowProcW(window_, message, wparam, lparam);
    }

    void CreateControls() {
        panel_brush_ = CreateSolidBrush(RGB(22, 28, 38));
        upload_button_ = CreateWindowExW(
            0, L"BUTTON", L"Upload…", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
            0, 0, 110, 34, window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kUploadButton)), instance_, nullptr);
        pause_button_ = CreateWindowExW(
            0, L"BUTTON", L"Pause", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
            0, 0, 90, 34, window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kPauseButton)), instance_, nullptr);
        sample_combo_ = CreateWindowExW(
            0, L"COMBOBOX", nullptr,
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | CBS_DROPDOWNLIST | WS_VSCROLL,
            0, 0, 310, 400, window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kSampleCombo)), instance_, nullptr);
        status_label_ = CreateWindowExW(
            0, L"STATIC", L"Loading texture…", WS_CHILD | WS_VISIBLE | SS_LEFT | SS_CENTERIMAGE,
            0, 0, 400, 34, window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kStatusLabel)), instance_, nullptr);
        for (const auto& sample : kSamples) {
            SendMessageW(sample_combo_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(sample.label));
        }
        SendMessageW(sample_combo_, CB_SETCURSEL, 1, 0);

        const HFONT font = static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
        for (HWND control : {upload_button_, pause_button_, sample_combo_, status_label_}) {
            SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
        }
        RECT client{};
        GetClientRect(window_, &client);
        LayoutControls(client.right, client.bottom);
    }

    void LayoutControls(int width, int) const {
        const int margin = 14;
        MoveWindow(upload_button_, margin, margin, 110, 34, TRUE);
        MoveWindow(pause_button_, margin + 120, margin, 90, 34, TRUE);
        MoveWindow(sample_combo_, margin + 220, margin, 315, 400, TRUE);
        MoveWindow(status_label_, margin + 548, margin, std::max(160, width - margin * 2 - 548), 34, TRUE);
    }

    bool CreateDeviceResources() {
        RECT client{};
        GetClientRect(window_, &client);
        DXGI_SWAP_CHAIN_DESC swap_description{};
        swap_description.BufferDesc.Width = std::max(1L, client.right);
        swap_description.BufferDesc.Height = std::max(1L, client.bottom);
        swap_description.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        swap_description.SampleDesc.Count = 1;
        swap_description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        swap_description.BufferCount = 2;
        swap_description.OutputWindow = window_;
        swap_description.Windowed = TRUE;
        swap_description.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

        const std::array<D3D_FEATURE_LEVEL, 3> levels = {
            D3D_FEATURE_LEVEL_11_0,
            D3D_FEATURE_LEVEL_10_1,
            D3D_FEATURE_LEVEL_10_0,
        };
        UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
#if defined(_DEBUG)
        flags |= D3D11_CREATE_DEVICE_DEBUG;
#endif
        D3D_FEATURE_LEVEL selected{};
        HRESULT result = D3D11CreateDeviceAndSwapChain(
            nullptr,
            D3D_DRIVER_TYPE_HARDWARE,
            nullptr,
            flags,
            levels.data(),
            static_cast<UINT>(levels.size()),
            D3D11_SDK_VERSION,
            &swap_description,
            &swap_chain_,
            &device_,
            &selected,
            &context_
        );
#if defined(_DEBUG)
        if (result == DXGI_ERROR_SDK_COMPONENT_MISSING) {
            flags &= ~D3D11_CREATE_DEVICE_DEBUG;
            result = D3D11CreateDeviceAndSwapChain(
                nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags,
                levels.data(), static_cast<UINT>(levels.size()), D3D11_SDK_VERSION,
                &swap_description, &swap_chain_, &device_, &selected, &context_);
        }
#endif
        if (FAILED(result)) {
            last_error_ = L"Could not create a Direct3D 11 device: " + HresultMessage(result);
            return false;
        }
        if (!CreateRenderTargets() || !CreatePipeline()) return false;
        previous_frame_ = std::chrono::steady_clock::now();
        return true;
    }

    bool CreateRenderTargets() {
        ComPtr<ID3D11Texture2D> back_buffer;
        HRESULT result = swap_chain_->GetBuffer(0, IID_PPV_ARGS(&back_buffer));
        if (SUCCEEDED(result)) result = device_->CreateRenderTargetView(back_buffer.Get(), nullptr, &render_target_);
        if (FAILED(result)) {
            last_error_ = L"Could not create the back-buffer view: " + HresultMessage(result);
            return false;
        }
        D3D11_TEXTURE2D_DESC back_description{};
        back_buffer->GetDesc(&back_description);
        D3D11_TEXTURE2D_DESC depth_description{};
        depth_description.Width = back_description.Width;
        depth_description.Height = back_description.Height;
        depth_description.MipLevels = 1;
        depth_description.ArraySize = 1;
        depth_description.Format = DXGI_FORMAT_D24_UNORM_S8_UINT;
        depth_description.SampleDesc.Count = 1;
        depth_description.BindFlags = D3D11_BIND_DEPTH_STENCIL;
        ComPtr<ID3D11Texture2D> depth;
        result = device_->CreateTexture2D(&depth_description, nullptr, &depth);
        if (SUCCEEDED(result)) result = device_->CreateDepthStencilView(depth.Get(), nullptr, &depth_view_);
        if (FAILED(result)) {
            last_error_ = L"Could not create the depth buffer: " + HresultMessage(result);
            return false;
        }
        viewport_width_ = back_description.Width;
        viewport_height_ = back_description.Height;
        return true;
    }

    bool CompileShader(const char* entry, const char* target, ComPtr<ID3DBlob>& bytecode) {
        ComPtr<ID3DBlob> errors;
        const HRESULT result = D3DCompile(
            kShaderSource,
            sizeof(kShaderSource) - 1,
            "native_cube.hlsl",
            nullptr,
            nullptr,
            entry,
            target,
            D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3,
            0,
            &bytecode,
            &errors
        );
        if (FAILED(result)) {
            const char* text = errors ? static_cast<const char*>(errors->GetBufferPointer()) : "Unknown shader error";
            std::string narrow(text, errors ? errors->GetBufferSize() : std::strlen(text));
            last_error_.assign(narrow.begin(), narrow.end());
            return false;
        }
        return true;
    }

    bool CreatePipeline() {
        ComPtr<ID3DBlob> vertex_bytecode;
        ComPtr<ID3DBlob> pixel_bytecode;
        if (!CompileShader("VSMain", "vs_4_0", vertex_bytecode) ||
            !CompileShader("PSMain", "ps_4_0", pixel_bytecode)) return false;
        HRESULT result = device_->CreateVertexShader(
            vertex_bytecode->GetBufferPointer(), vertex_bytecode->GetBufferSize(), nullptr, &vertex_shader_);
        if (SUCCEEDED(result)) result = device_->CreatePixelShader(
            pixel_bytecode->GetBufferPointer(), pixel_bytecode->GetBufferSize(), nullptr, &pixel_shader_);
        const std::array<D3D11_INPUT_ELEMENT_DESC, 3> layout = {{
            {"POSITION", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, offsetof(Vertex, position), D3D11_INPUT_PER_VERTEX_DATA, 0},
            {"NORMAL", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, offsetof(Vertex, normal), D3D11_INPUT_PER_VERTEX_DATA, 0},
            {"TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT, 0, offsetof(Vertex, uv), D3D11_INPUT_PER_VERTEX_DATA, 0},
        }};
        if (SUCCEEDED(result)) result = device_->CreateInputLayout(
            layout.data(), static_cast<UINT>(layout.size()),
            vertex_bytecode->GetBufferPointer(), vertex_bytecode->GetBufferSize(), &input_layout_);
        if (FAILED(result)) {
            last_error_ = L"Could not create the shader pipeline: " + HresultMessage(result);
            return false;
        }

        const std::array<Vertex, 24> vertices = {{
            {{-1,-1,-1},{0,0,-1},{0,1}}, {{-1, 1,-1},{0,0,-1},{0,0}},
            {{ 1, 1,-1},{0,0,-1},{1,0}}, {{ 1,-1,-1},{0,0,-1},{1,1}},
            {{ 1,-1, 1},{0,0, 1},{0,1}}, {{ 1, 1, 1},{0,0, 1},{0,0}},
            {{-1, 1, 1},{0,0, 1},{1,0}}, {{-1,-1, 1},{0,0, 1},{1,1}},
            {{-1,-1, 1},{-1,0,0},{0,1}}, {{-1, 1, 1},{-1,0,0},{0,0}},
            {{-1, 1,-1},{-1,0,0},{1,0}}, {{-1,-1,-1},{-1,0,0},{1,1}},
            {{ 1,-1,-1},{ 1,0,0},{0,1}}, {{ 1, 1,-1},{ 1,0,0},{0,0}},
            {{ 1, 1, 1},{ 1,0,0},{1,0}}, {{ 1,-1, 1},{ 1,0,0},{1,1}},
            {{-1, 1,-1},{0, 1,0},{0,1}}, {{-1, 1, 1},{0, 1,0},{0,0}},
            {{ 1, 1, 1},{0, 1,0},{1,0}}, {{ 1, 1,-1},{0, 1,0},{1,1}},
            {{-1,-1, 1},{0,-1,0},{0,1}}, {{-1,-1,-1},{0,-1,0},{0,0}},
            {{ 1,-1,-1},{0,-1,0},{1,0}}, {{ 1,-1, 1},{0,-1,0},{1,1}},
        }};
        constexpr std::array<std::uint16_t, 36> indices = {{
            0,1,2, 0,2,3, 4,5,6, 4,6,7, 8,9,10, 8,10,11,
            12,13,14, 12,14,15, 16,17,18, 16,18,19, 20,21,22, 20,22,23,
        }};
        D3D11_BUFFER_DESC vertex_description{};
        vertex_description.ByteWidth = sizeof(vertices);
        vertex_description.Usage = D3D11_USAGE_IMMUTABLE;
        vertex_description.BindFlags = D3D11_BIND_VERTEX_BUFFER;
        D3D11_SUBRESOURCE_DATA vertex_data{vertices.data(), 0, 0};
        result = device_->CreateBuffer(&vertex_description, &vertex_data, &vertex_buffer_);
        D3D11_BUFFER_DESC index_description{};
        index_description.ByteWidth = sizeof(indices);
        index_description.Usage = D3D11_USAGE_IMMUTABLE;
        index_description.BindFlags = D3D11_BIND_INDEX_BUFFER;
        D3D11_SUBRESOURCE_DATA index_data{indices.data(), 0, 0};
        if (SUCCEEDED(result)) result = device_->CreateBuffer(&index_description, &index_data, &index_buffer_);
        D3D11_BUFFER_DESC constant_description{};
        constant_description.ByteWidth = sizeof(SceneConstants);
        constant_description.Usage = D3D11_USAGE_DEFAULT;
        constant_description.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
        if (SUCCEEDED(result)) result = device_->CreateBuffer(&constant_description, nullptr, &constant_buffer_);

        D3D11_SAMPLER_DESC sampler_description{};
        sampler_description.Filter = D3D11_FILTER_ANISOTROPIC;
        sampler_description.AddressU = D3D11_TEXTURE_ADDRESS_WRAP;
        sampler_description.AddressV = D3D11_TEXTURE_ADDRESS_WRAP;
        sampler_description.AddressW = D3D11_TEXTURE_ADDRESS_WRAP;
        sampler_description.MaxAnisotropy = 8;
        sampler_description.MaxLOD = D3D11_FLOAT32_MAX;
        if (SUCCEEDED(result)) result = device_->CreateSamplerState(&sampler_description, &sampler_);
        D3D11_RASTERIZER_DESC rasterizer_description{};
        rasterizer_description.FillMode = D3D11_FILL_SOLID;
        rasterizer_description.CullMode = D3D11_CULL_NONE;
        rasterizer_description.DepthClipEnable = TRUE;
        if (SUCCEEDED(result)) result = device_->CreateRasterizerState(&rasterizer_description, &rasterizer_);
        if (FAILED(result)) {
            last_error_ = L"Could not create cube resources: " + HresultMessage(result);
            return false;
        }
        return true;
    }

    void ResizeSwapChain(UINT width, UINT height) {
        if (width == 0 || height == 0) return;
        context_->OMSetRenderTargets(0, nullptr, nullptr);
        render_target_.Reset();
        depth_view_.Reset();
        const HRESULT result = swap_chain_->ResizeBuffers(0, width, height, DXGI_FORMAT_UNKNOWN, 0);
        if (FAILED(result) || !CreateRenderTargets()) {
            SetStatus(L"Resize failed: " + HresultMessage(result));
        }
    }

    bool UploadTexture(const texture_demo::TextureImage& image, std::wstring& error) {
        if (image.mips.empty()) {
            error = L"Decoded texture has no mip levels";
            return false;
        }
        D3D11_TEXTURE2D_DESC description{};
        description.Width = image.mips[0].width;
        description.Height = image.mips[0].height;
        description.ArraySize = 1;
        description.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        description.SampleDesc.Count = 1;
        description.Usage = D3D11_USAGE_DEFAULT;
        description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        const bool stored_mips = image.mips.size() > 1;
        description.MipLevels = stored_mips ? static_cast<UINT>(image.mips.size()) : 0;
        if (!stored_mips) {
            description.BindFlags |= D3D11_BIND_RENDER_TARGET;
            description.MiscFlags = D3D11_RESOURCE_MISC_GENERATE_MIPS;
        }

        std::vector<D3D11_SUBRESOURCE_DATA> initial_data;
        if (stored_mips) {
            initial_data.reserve(image.mips.size());
            for (const auto& mip : image.mips) {
                initial_data.push_back({mip.rgba.data(), mip.width * 4u, 0});
            }
        }
        ComPtr<ID3D11Texture2D> texture;
        HRESULT result = device_->CreateTexture2D(
            &description,
            stored_mips ? initial_data.data() : nullptr,
            &texture
        );
        if (FAILED(result)) {
            error = L"Direct3D could not allocate the texture: " + HresultMessage(result);
            return false;
        }
        D3D11_SHADER_RESOURCE_VIEW_DESC view_description{};
        view_description.Format = description.Format;
        view_description.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D;
        view_description.Texture2D.MostDetailedMip = 0;
        view_description.Texture2D.MipLevels = stored_mips ? description.MipLevels : UINT(-1);
        ComPtr<ID3D11ShaderResourceView> view;
        result = device_->CreateShaderResourceView(texture.Get(), &view_description, &view);
        if (FAILED(result)) {
            error = L"Direct3D could not create the texture view: " + HresultMessage(result);
            return false;
        }
        if (!stored_mips) {
            context_->UpdateSubresource(texture.Get(), 0, nullptr, image.mips[0].rgba.data(),
                image.mips[0].width * 4u, 0);
            context_->GenerateMips(view.Get());
        }
        texture_view_ = std::move(view);
        return true;
    }

    void LoadInitialTexture() {
        LoadSample(1);
        if (!texture_view_) {
            auto fallback = MakeCheckerboard();
            std::wstring error;
            UploadTexture(fallback, error);
            SetStatus(L"Bundled samples were not found; using a procedural texture");
        }
    }

    void LoadSample(std::size_t index) {
        const auto path = ExecutableDirectory() / L"assets" / kSamples[index].filename;
        LoadTexture(path.wstring());
    }

    void LoadTexture(const std::wstring& path) {
        SetStatus(L"Decoding " + std::filesystem::path(path).filename().wstring() + L"…");
        texture_demo::TextureImage image;
        std::wstring error;
        if (!texture_demo::LoadTextureFile(path, image, error)) {
            SetStatus(L"Load failed");
            MessageBoxW(window_, error.c_str(), L"Texture load failed", MB_ICONERROR);
            return;
        }
        if (!UploadTexture(image, error)) {
            SetStatus(L"GPU upload failed");
            MessageBoxW(window_, error.c_str(), L"Texture upload failed", MB_ICONERROR);
            return;
        }
        const auto& base = image.mips[0];
        std::wstring status = image.format + L"  •  " + std::to_wstring(base.width) + L" × " +
            std::to_wstring(base.height) + L"  •  " + std::to_wstring(image.mips.size()) + L" mip";
        if (image.mips.size() != 1) status += L"s";
        status += L"  •  " + std::filesystem::path(path).filename().wstring();
        SetStatus(status);
    }

    void ShowUploadDialog() {
        std::wstring filename(32768, L'\0');
        constexpr wchar_t filter[] =
            L"All supported textures\0*.bpal;*.bplm;*.dctbs2;*.bpdh;*.png;*.jpg;*.jpeg;*.bmp;*.tif;*.tiff\0"
            L"Project textures\0*.bpal;*.bplm;*.dctbs2;*.bpdh\0"
            L"Standard images (WIC)\0*.png;*.jpg;*.jpeg;*.bmp;*.tif;*.tiff\0"
            L"All files\0*.*\0\0";
        OPENFILENAMEW dialog{};
        dialog.lStructSize = sizeof(dialog);
        dialog.hwndOwner = window_;
        dialog.lpstrFilter = filter;
        dialog.lpstrFile = filename.data();
        dialog.nMaxFile = static_cast<DWORD>(filename.size());
        dialog.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_HIDEREADONLY;
        dialog.lpstrTitle = L"Upload a texture to the rotating cube";
        if (GetOpenFileNameW(&dialog)) LoadTexture(filename.c_str());
    }

    void SetStatus(const std::wstring& text) const {
        SetWindowTextW(status_label_, text.c_str());
    }

    void Render() {
        if (!render_target_ || viewport_width_ == 0 || viewport_height_ == 0) return;
        const auto now = std::chrono::steady_clock::now();
        const float delta = std::chrono::duration<float>(now - previous_frame_).count();
        previous_frame_ = now;
        if (!paused_) angle_ += std::min(delta, 0.1f) * 0.72f;

        const float clear[4] = {0.035f, 0.052f, 0.078f, 1.0f};
        context_->ClearRenderTargetView(render_target_.Get(), clear);
        context_->ClearDepthStencilView(depth_view_.Get(), D3D11_CLEAR_DEPTH | D3D11_CLEAR_STENCIL, 1.0f, 0);
        ID3D11RenderTargetView* target = render_target_.Get();
        context_->OMSetRenderTargets(1, &target, depth_view_.Get());
        D3D11_VIEWPORT viewport{0, 0, static_cast<float>(viewport_width_),
            static_cast<float>(viewport_height_), 0, 1};
        context_->RSSetViewports(1, &viewport);
        context_->RSSetState(rasterizer_.Get());

        const XMMATRIX world = DirectX::XMMatrixRotationX(angle_ * 0.63f) *
            DirectX::XMMatrixRotationY(angle_);
        const XMMATRIX view = DirectX::XMMatrixLookAtLH(
            DirectX::XMVectorSet(0, 0.15f, -4.2f, 1),
            DirectX::XMVectorZero(),
            DirectX::XMVectorSet(0, 1, 0, 0));
        const float aspect = static_cast<float>(viewport_width_) / viewport_height_;
        const XMMATRIX projection = DirectX::XMMatrixPerspectiveFovLH(
            DirectX::XMConvertToRadians(50.0f), aspect, 0.1f, 100.0f);
        SceneConstants constants{};
        DirectX::XMStoreFloat4x4(&constants.world, world);
        DirectX::XMStoreFloat4x4(&constants.world_view_projection, world * view * projection);
        constants.light_direction = {-0.55f, -0.75f, 0.45f, 0};
        context_->UpdateSubresource(constant_buffer_.Get(), 0, nullptr, &constants, 0, 0);

        constexpr UINT stride = sizeof(Vertex);
        constexpr UINT offset = 0;
        ID3D11Buffer* vertex = vertex_buffer_.Get();
        context_->IASetInputLayout(input_layout_.Get());
        context_->IASetVertexBuffers(0, 1, &vertex, &stride, &offset);
        context_->IASetIndexBuffer(index_buffer_.Get(), DXGI_FORMAT_R16_UINT, 0);
        context_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        context_->VSSetShader(vertex_shader_.Get(), nullptr, 0);
        ID3D11Buffer* constants_buffer = constant_buffer_.Get();
        context_->VSSetConstantBuffers(0, 1, &constants_buffer);
        context_->PSSetShader(pixel_shader_.Get(), nullptr, 0);
        ID3D11ShaderResourceView* texture = texture_view_.Get();
        context_->PSSetShaderResources(0, 1, &texture);
        ID3D11SamplerState* sampler = sampler_.Get();
        context_->PSSetSamplers(0, 1, &sampler);
        context_->DrawIndexed(36, 0, 0);
        swap_chain_->Present(1, 0);
    }

    HINSTANCE instance_ = nullptr;
    HWND window_ = nullptr;
    HWND upload_button_ = nullptr;
    HWND pause_button_ = nullptr;
    HWND sample_combo_ = nullptr;
    HWND status_label_ = nullptr;
    HBRUSH panel_brush_ = nullptr;
    bool paused_ = false;
    float angle_ = 0.0f;
    UINT viewport_width_ = 0;
    UINT viewport_height_ = 0;
    std::wstring last_error_;
    std::chrono::steady_clock::time_point previous_frame_{};

    ComPtr<ID3D11Device> device_;
    ComPtr<ID3D11DeviceContext> context_;
    ComPtr<IDXGISwapChain> swap_chain_;
    ComPtr<ID3D11RenderTargetView> render_target_;
    ComPtr<ID3D11DepthStencilView> depth_view_;
    ComPtr<ID3D11VertexShader> vertex_shader_;
    ComPtr<ID3D11PixelShader> pixel_shader_;
    ComPtr<ID3D11InputLayout> input_layout_;
    ComPtr<ID3D11Buffer> vertex_buffer_;
    ComPtr<ID3D11Buffer> index_buffer_;
    ComPtr<ID3D11Buffer> constant_buffer_;
    ComPtr<ID3D11SamplerState> sampler_;
    ComPtr<ID3D11RasterizerState> rasterizer_;
    ComPtr<ID3D11ShaderResourceView> texture_view_;
};

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show_command) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    const HRESULT com_result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    DemoApplication application(instance);
    const int result = application.Run(show_command);
    if (SUCCEEDED(com_result)) CoUninitialize();
    return result;
}
