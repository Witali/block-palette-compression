#include "shader_texture.h"

#include <windows.h>
#include <commdlg.h>
#include <d3d12.h>
#include <dxgi1_6.h>
#include <DirectXMath.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
using namespace DirectX;

namespace {

constexpr wchar_t kWindowClass[] = L"BlockTextureDirectX12Demo";
constexpr UINT kFrameCount = 2;
constexpr UINT kUploadId = 1001;
constexpr UINT kPauseId = 1002;
constexpr UINT kPresetId = 1003;
constexpr UINT kToolbarHeight = 64;

struct Vertex {
    XMFLOAT3 position;
    XMFLOAT3 normal;
    XMFLOAT2 uv;
};

struct SceneConstants {
    XMFLOAT4X4 model_view_projection;
    XMFLOAT4X4 model;
    XMFLOAT4 light_position;
    XMFLOAT4 camera_position;
    XMFLOAT4 light_color;
    XMFLOAT4 ambient_color;
    std::array<XMFLOAT4, 4> padding{};
};

struct TextureConstants {
    std::array<std::uint32_t, texture_demo::kShaderMetadataCapacityWords> words{};
};

static_assert(sizeof(SceneConstants) == 256);
static_assert(sizeof(TextureConstants) % 256 == 0);

constexpr std::array<Vertex, 24> kVertices = {{
    {{-1,-1,-1},{0,0,-1},{0,1}}, {{-1,1,-1},{0,0,-1},{0,0}},
    {{1,1,-1},{0,0,-1},{1,0}}, {{1,-1,-1},{0,0,-1},{1,1}},
    {{1,-1,1},{0,0,1},{0,1}}, {{1,1,1},{0,0,1},{0,0}},
    {{-1,1,1},{0,0,1},{1,0}}, {{-1,-1,1},{0,0,1},{1,1}},
    {{-1,-1,1},{-1,0,0},{0,1}}, {{-1,1,1},{-1,0,0},{0,0}},
    {{-1,1,-1},{-1,0,0},{1,0}}, {{-1,-1,-1},{-1,0,0},{1,1}},
    {{1,-1,-1},{1,0,0},{0,1}}, {{1,1,-1},{1,0,0},{0,0}},
    {{1,1,1},{1,0,0},{1,0}}, {{1,-1,1},{1,0,0},{1,1}},
    {{-1,1,-1},{0,1,0},{0,1}}, {{-1,1,1},{0,1,0},{0,0}},
    {{1,1,1},{0,1,0},{1,0}}, {{1,1,-1},{0,1,0},{1,1}},
    {{-1,-1,1},{0,-1,0},{0,1}}, {{-1,-1,-1},{0,-1,0},{0,0}},
    {{1,-1,-1},{0,-1,0},{1,0}}, {{1,-1,1},{0,-1,0},{1,1}},
}};

constexpr std::array<std::uint16_t, 36> kIndices = {{
    0,1,2, 0,2,3, 4,5,6, 4,6,7,
    8,9,10, 8,10,11, 12,13,14, 12,14,15,
    16,17,18, 16,18,19, 20,21,22, 20,22,23,
}};

D3D12_HEAP_PROPERTIES HeapProperties(D3D12_HEAP_TYPE type) {
    D3D12_HEAP_PROPERTIES properties{};
    properties.Type = type;
    properties.CPUPageProperty = D3D12_CPU_PAGE_PROPERTY_UNKNOWN;
    properties.MemoryPoolPreference = D3D12_MEMORY_POOL_UNKNOWN;
    properties.CreationNodeMask = 1;
    properties.VisibleNodeMask = 1;
    return properties;
}

D3D12_RESOURCE_DESC BufferDescription(UINT64 bytes) {
    D3D12_RESOURCE_DESC description{};
    description.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    description.Width = bytes;
    description.Height = 1;
    description.DepthOrArraySize = 1;
    description.MipLevels = 1;
    description.SampleDesc.Count = 1;
    description.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    return description;
}

D3D12_RESOURCE_BARRIER Transition(
    ID3D12Resource* resource,
    D3D12_RESOURCE_STATES before,
    D3D12_RESOURCE_STATES after
) {
    D3D12_RESOURCE_BARRIER barrier{};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = resource;
    barrier.Transition.StateBefore = before;
    barrier.Transition.StateAfter = after;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    return barrier;
}

std::wstring HrMessage(const wchar_t* operation, HRESULT result) {
    wchar_t detail[512]{};
    FormatMessageW(
        FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr,
        static_cast<DWORD>(result),
        0,
        detail,
        static_cast<DWORD>(std::size(detail)),
        nullptr);
    return std::wstring(operation) + L" failed (0x" +
        [&]() {
            wchar_t hex[16]{};
            swprintf_s(hex, L"%08X", static_cast<unsigned>(result));
            return std::wstring(hex);
        }() + L"): " + detail;
}

std::filesystem::path ModuleDirectory() {
    std::array<wchar_t, 32768> path{};
    const DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    return std::filesystem::path(std::wstring(path.data(), length)).parent_path();
}

class DemoApplication;
DemoApplication* g_application = nullptr;

class DemoApplication {
public:
    ~DemoApplication() {
        if (queue_ && fence_) WaitForGpu();
        if (scene_mapped_) scene_constants_->Unmap(0, nullptr);
        if (texture_mapped_) texture_constants_->Unmap(0, nullptr);
        if (fence_event_) CloseHandle(fence_event_);
    }

    bool Initialize(HINSTANCE instance, int show) {
        WNDCLASSEXW window_class{};
        window_class.cbSize = sizeof(window_class);
        window_class.style = CS_HREDRAW | CS_VREDRAW;
        window_class.lpfnWndProc = WindowProc;
        window_class.hInstance = instance;
        window_class.hCursor = LoadCursor(nullptr, IDC_ARROW);
        window_class.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
        window_class.lpszClassName = kWindowClass;
        if (!RegisterClassExW(&window_class)) return Fail(L"Could not register the window class");

        RECT rectangle{0, 0, 1180, 780};
        AdjustWindowRect(&rectangle, WS_OVERLAPPEDWINDOW, FALSE);
        window_ = CreateWindowExW(
            0, kWindowClass, L"Block Palette Compression - Native DirectX 12",
            WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN, CW_USEDEFAULT, CW_USEDEFAULT,
            rectangle.right - rectangle.left, rectangle.bottom - rectangle.top,
            nullptr, nullptr, instance, nullptr);
        if (!window_) return Fail(L"Could not create the application window");

        CreateControls();
        RECT client{};
        GetClientRect(window_, &client);
        LayoutChildren(static_cast<UINT>(client.right), static_cast<UINT>(client.bottom));
        if (!InitializeD3d()) return false;
        LoadPreset(0);
        ShowWindow(window_, show);
        UpdateWindow(window_);
        started_ = std::chrono::steady_clock::now();
        return true;
    }

    int Run() {
        MSG message{};
        while (message.message != WM_QUIT) {
            if (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            } else if (!minimized_) {
                Render();
            } else {
                WaitMessage();
            }
        }
        return static_cast<int>(message.wParam);
    }

    LRESULT OnMessage(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
        switch (message) {
        case WM_COMMAND:
            if (LOWORD(wparam) == kUploadId && HIWORD(wparam) == BN_CLICKED) OpenTexture();
            if (LOWORD(wparam) == kPauseId && HIWORD(wparam) == BN_CLICKED) TogglePause();
            if (LOWORD(wparam) == kPresetId && HIWORD(wparam) == CBN_SELCHANGE) {
                LoadPreset(static_cast<int>(SendMessageW(preset_, CB_GETCURSEL, 0, 0)));
            }
            return 0;
        case WM_SIZE:
            minimized_ = wparam == SIZE_MINIMIZED;
            if (!minimized_ && device_ && swap_chain_) {
                const UINT client_width = std::max<UINT>(1u, LOWORD(lparam));
                const UINT client_height = std::max<UINT>(1u, HIWORD(lparam));
                const UINT render_width = client_width;
                const UINT render_height = std::max<UINT>(1u,
                    client_height > kToolbarHeight ? client_height - kToolbarHeight : 1u);
                Resize(render_width, render_height);
                LayoutChildren(client_width, client_height);
            }
            return 0;
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
        default:
            return DefWindowProcW(window, message, wparam, lparam);
        }
    }

private:
    static LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
        return g_application
            ? g_application->OnMessage(window, message, wparam, lparam)
            : DefWindowProcW(window, message, wparam, lparam);
    }

    bool Fail(const std::wstring& message) {
        MessageBoxW(window_, message.c_str(), L"DirectX 12 Demo", MB_OK | MB_ICONERROR);
        return false;
    }

    bool Check(HRESULT result, const wchar_t* operation) {
        return SUCCEEDED(result) || Fail(HrMessage(operation, result));
    }

    void CreateControls() {
        upload_ = CreateWindowExW(0, L"BUTTON", L"Upload...", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
            10, 10, 110, 34, window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kUploadId)), nullptr, nullptr);
        pause_ = CreateWindowExW(0, L"BUTTON", L"Pause", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
            130, 10, 90, 34, window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kPauseId)), nullptr, nullptr);
        preset_ = CreateWindowExW(0, L"COMBOBOX", nullptr,
            WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST | WS_VSCROLL,
            230, 10, 315, 180, window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kPresetId)), nullptr, nullptr);
        status_ = CreateWindowExW(0, L"STATIC", L"Initializing DirectX 12...",
            WS_CHILD | WS_VISIBLE | SS_LEFT | SS_CENTERIMAGE,
            557, 10, 585, 34, window_, nullptr, nullptr, nullptr);
        render_window_ = CreateWindowExW(0, L"STATIC", nullptr,
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | SS_BLACKRECT,
            0, kToolbarHeight, 1, 1, window_, nullptr, nullptr, nullptr);
        SendMessageW(preset_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"BPAL v5 - stone"));
        SendMessageW(preset_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"BPLM v1 - stone + mips"));
        SendMessageW(preset_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"DCTBS2 - stone 1.5 bpp"));
        SendMessageW(preset_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"BPDH - Alaska landscape"));
        SendMessageW(preset_, CB_SETCURSEL, 0, 0);
    }

    void LayoutChildren(UINT client_width, UINT client_height) {
        width_ = std::max<UINT>(1u, client_width);
        height_ = std::max<UINT>(1u,
            client_height > kToolbarHeight ? client_height - kToolbarHeight : 1u);
        if (status_) {
            MoveWindow(status_, 557, 10,
                std::max<int>(120, static_cast<int>(client_width) - 567), 34, TRUE);
        }
        if (render_window_) {
            MoveWindow(render_window_, 0, kToolbarHeight, width_, height_, TRUE);
        }
    }

    bool InitializeD3d() {
        UINT factory_flags = 0;
#if defined(_DEBUG)
        ComPtr<ID3D12Debug> debug;
        if (SUCCEEDED(D3D12GetDebugInterface(IID_PPV_ARGS(&debug)))) {
            debug->EnableDebugLayer();
            factory_flags = DXGI_CREATE_FACTORY_DEBUG;
        }
#endif
        if (!Check(CreateDXGIFactory2(factory_flags, IID_PPV_ARGS(&factory_)), L"CreateDXGIFactory2")) return false;
        for (UINT index = 0;; ++index) {
            ComPtr<IDXGIAdapter1> adapter;
            if (factory_->EnumAdapterByGpuPreference(
                    index, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, IID_PPV_ARGS(&adapter)) == DXGI_ERROR_NOT_FOUND) break;
            DXGI_ADAPTER_DESC1 description{};
            adapter->GetDesc1(&description);
            if ((description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) == 0 &&
                SUCCEEDED(D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&device_)))) break;
        }
        if (!device_) {
            ComPtr<IDXGIAdapter> warp;
            if (!Check(factory_->EnumWarpAdapter(IID_PPV_ARGS(&warp)), L"EnumWarpAdapter") ||
                !Check(D3D12CreateDevice(warp.Get(), D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&device_)), L"D3D12CreateDevice")) {
                return false;
            }
        }

        D3D12_COMMAND_QUEUE_DESC queue_description{};
        queue_description.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
        if (!Check(device_->CreateCommandQueue(&queue_description, IID_PPV_ARGS(&queue_)), L"CreateCommandQueue")) return false;

        DXGI_SWAP_CHAIN_DESC1 swap_description{};
        swap_description.Width = width_;
        swap_description.Height = height_;
        swap_description.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        swap_description.SampleDesc.Count = 1;
        swap_description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        swap_description.BufferCount = kFrameCount;
        swap_description.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
        ComPtr<IDXGISwapChain1> swap_chain;
        if (!Check(factory_->CreateSwapChainForHwnd(
                queue_.Get(), render_window_, &swap_description, nullptr, nullptr, &swap_chain), L"CreateSwapChainForHwnd")) return false;
        factory_->MakeWindowAssociation(window_, DXGI_MWA_NO_ALT_ENTER);
        if (!Check(swap_chain.As(&swap_chain_), L"Query IDXGISwapChain3")) return false;
        frame_index_ = swap_chain_->GetCurrentBackBufferIndex();

        D3D12_DESCRIPTOR_HEAP_DESC rtv_description{};
        rtv_description.NumDescriptors = kFrameCount;
        rtv_description.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
        if (!Check(device_->CreateDescriptorHeap(&rtv_description, IID_PPV_ARGS(&rtv_heap_)), L"Create RTV heap")) return false;
        rtv_stride_ = device_->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
        D3D12_DESCRIPTOR_HEAP_DESC dsv_description{};
        dsv_description.NumDescriptors = 1;
        dsv_description.Type = D3D12_DESCRIPTOR_HEAP_TYPE_DSV;
        if (!Check(device_->CreateDescriptorHeap(&dsv_description, IID_PPV_ARGS(&dsv_heap_)), L"Create DSV heap")) return false;

        if (!Check(device_->CreateCommandAllocator(
                D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&allocator_)), L"CreateCommandAllocator") ||
            !Check(device_->CreateCommandList(
                0, D3D12_COMMAND_LIST_TYPE_DIRECT, allocator_.Get(), nullptr,
                IID_PPV_ARGS(&command_list_)), L"CreateCommandList")) return false;
        command_list_->Close();

        if (!CreateRenderTargets() || !CreateDepthBuffer() || !CreatePipeline() ||
            !CreateGeometry() || !CreateConstantBuffers()) return false;
        if (!Check(device_->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence_)), L"CreateFence")) return false;
        fence_event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        return fence_event_ != nullptr || Fail(L"Could not create the GPU fence event");
    }

    bool CreateRenderTargets() {
        D3D12_CPU_DESCRIPTOR_HANDLE handle = rtv_heap_->GetCPUDescriptorHandleForHeapStart();
        for (UINT index = 0; index < kFrameCount; ++index) {
            if (!Check(swap_chain_->GetBuffer(index, IID_PPV_ARGS(&render_targets_[index])), L"Get swap-chain buffer")) return false;
            device_->CreateRenderTargetView(render_targets_[index].Get(), nullptr, handle);
            handle.ptr += rtv_stride_;
        }
        return true;
    }

    bool CreateDepthBuffer() {
        D3D12_RESOURCE_DESC description{};
        description.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
        description.Width = width_;
        description.Height = height_;
        description.DepthOrArraySize = 1;
        description.MipLevels = 1;
        description.Format = DXGI_FORMAT_D32_FLOAT;
        description.SampleDesc.Count = 1;
        description.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;
        description.Flags = D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL;
        D3D12_CLEAR_VALUE clear{};
        clear.Format = DXGI_FORMAT_D32_FLOAT;
        clear.DepthStencil.Depth = 1.0f;
        const auto heap = HeapProperties(D3D12_HEAP_TYPE_DEFAULT);
        if (!Check(device_->CreateCommittedResource(
                &heap, D3D12_HEAP_FLAG_NONE, &description, D3D12_RESOURCE_STATE_DEPTH_WRITE,
                &clear, IID_PPV_ARGS(&depth_)), L"Create depth buffer")) return false;
        D3D12_DEPTH_STENCIL_VIEW_DESC view{};
        view.Format = DXGI_FORMAT_D32_FLOAT;
        view.ViewDimension = D3D12_DSV_DIMENSION_TEXTURE2D;
        device_->CreateDepthStencilView(depth_.Get(), &view, dsv_heap_->GetCPUDescriptorHandleForHeapStart());
        return true;
    }

    bool ReadShader(const std::filesystem::path& path, std::vector<std::uint8_t>& bytes) {
        std::ifstream stream(path, std::ios::binary | std::ios::ate);
        if (!stream) return Fail(L"Could not open the precompiled shader:\n" + path.wstring());
        const std::streamoff size = stream.tellg();
        if (size <= 0) return Fail(L"Precompiled shader is empty:\n" + path.wstring());
        bytes.resize(static_cast<std::size_t>(size));
        stream.seekg(0, std::ios::beg);
        if (!stream.read(reinterpret_cast<char*>(bytes.data()), size)) {
            return Fail(L"Could not read the precompiled shader:\n" + path.wstring());
        }
        return true;
    }

    bool CreatePipeline() {
        const auto directory = ModuleDirectory();
        std::vector<std::uint8_t> vertex_shader;
        std::array<std::vector<std::uint8_t>, 3> pixel_shaders;
        if (!ReadShader(directory / L"texture_vs.cso", vertex_shader) ||
            !ReadShader(directory / L"texture_bpal_ps.cso", pixel_shaders[0]) ||
            !ReadShader(directory / L"texture_dct_ps.cso", pixel_shaders[1]) ||
            !ReadShader(directory / L"texture_bpdh_ps.cso", pixel_shaders[2])) return false;

        std::array<D3D12_ROOT_PARAMETER, 3> parameters{};
        parameters[0].ParameterType = D3D12_ROOT_PARAMETER_TYPE_CBV;
        parameters[0].Descriptor.ShaderRegister = 0;
        parameters[0].ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
        parameters[1].ParameterType = D3D12_ROOT_PARAMETER_TYPE_CBV;
        parameters[1].Descriptor.ShaderRegister = 1;
        parameters[1].ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;
        parameters[2].ParameterType = D3D12_ROOT_PARAMETER_TYPE_SRV;
        parameters[2].Descriptor.ShaderRegister = 0;
        parameters[2].ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;
        D3D12_ROOT_SIGNATURE_DESC signature_description{};
        signature_description.NumParameters = static_cast<UINT>(parameters.size());
        signature_description.pParameters = parameters.data();
        signature_description.Flags = D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;
        ComPtr<ID3DBlob> serialized;
        ComPtr<ID3DBlob> errors;
        if (!Check(D3D12SerializeRootSignature(
                &signature_description, D3D_ROOT_SIGNATURE_VERSION_1, &serialized, &errors),
                L"D3D12SerializeRootSignature") ||
            !Check(device_->CreateRootSignature(
                0, serialized->GetBufferPointer(), serialized->GetBufferSize(),
                IID_PPV_ARGS(&root_signature_)), L"CreateRootSignature")) return false;

        const std::array<D3D12_INPUT_ELEMENT_DESC, 3> input = {{
            {"POSITION", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, offsetof(Vertex, position), D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
            {"NORMAL", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, offsetof(Vertex, normal), D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
            {"TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT, 0, offsetof(Vertex, uv), D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
        }};
        D3D12_GRAPHICS_PIPELINE_STATE_DESC description{};
        description.pRootSignature = root_signature_.Get();
        description.VS = {vertex_shader.data(), vertex_shader.size()};
        description.InputLayout = {input.data(), static_cast<UINT>(input.size())};
        description.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
        description.RTVFormats[0] = DXGI_FORMAT_R8G8B8A8_UNORM;
        description.NumRenderTargets = 1;
        description.DSVFormat = DXGI_FORMAT_D32_FLOAT;
        description.SampleDesc.Count = 1;
        description.SampleMask = UINT_MAX;
        description.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
        description.RasterizerState.CullMode = D3D12_CULL_MODE_NONE;
        description.RasterizerState.DepthClipEnable = TRUE;
        description.BlendState.RenderTarget[0].RenderTargetWriteMask = D3D12_COLOR_WRITE_ENABLE_ALL;
        description.DepthStencilState.DepthEnable = TRUE;
        description.DepthStencilState.DepthWriteMask = D3D12_DEPTH_WRITE_MASK_ALL;
        description.DepthStencilState.DepthFunc = D3D12_COMPARISON_FUNC_LESS;
        description.DepthStencilState.StencilEnable = FALSE;
        for (std::size_t index = 0; index < pipelines_.size(); ++index) {
            description.PS = {pixel_shaders[index].data(), pixel_shaders[index].size()};
            if (!Check(device_->CreateGraphicsPipelineState(
                    &description, IID_PPV_ARGS(&pipelines_[index])), L"CreateGraphicsPipelineState")) return false;
        }
        return true;
    }

    bool CreateUploadBuffer(UINT64 bytes, ComPtr<ID3D12Resource>& resource, const wchar_t* operation) {
        const auto heap = HeapProperties(D3D12_HEAP_TYPE_UPLOAD);
        const auto description = BufferDescription(bytes);
        return Check(device_->CreateCommittedResource(
            &heap, D3D12_HEAP_FLAG_NONE, &description, D3D12_RESOURCE_STATE_GENERIC_READ,
            nullptr, IID_PPV_ARGS(&resource)), operation);
    }

    bool CreateGpuBuffer(
        UINT64 bytes,
        D3D12_RESOURCE_STATES initial_state,
        ComPtr<ID3D12Resource>& resource,
        const wchar_t* operation
    ) {
        const auto heap = HeapProperties(D3D12_HEAP_TYPE_DEFAULT);
        const auto description = BufferDescription(bytes);
        return Check(device_->CreateCommittedResource(
            &heap, D3D12_HEAP_FLAG_NONE, &description, initial_state,
            nullptr, IID_PPV_ARGS(&resource)), operation);
    }

    bool CreateGeometry() {
        if (!CreateUploadBuffer(sizeof(kVertices), vertex_buffer_, L"Create vertex buffer") ||
            !CreateUploadBuffer(sizeof(kIndices), index_buffer_, L"Create index buffer")) return false;
        void* mapped = nullptr;
        vertex_buffer_->Map(0, nullptr, &mapped);
        std::memcpy(mapped, kVertices.data(), sizeof(kVertices));
        vertex_buffer_->Unmap(0, nullptr);
        index_buffer_->Map(0, nullptr, &mapped);
        std::memcpy(mapped, kIndices.data(), sizeof(kIndices));
        index_buffer_->Unmap(0, nullptr);
        vertex_view_ = {vertex_buffer_->GetGPUVirtualAddress(), sizeof(kVertices), sizeof(Vertex)};
        index_view_ = {index_buffer_->GetGPUVirtualAddress(), sizeof(kIndices), DXGI_FORMAT_R16_UINT};
        return true;
    }

    bool CreateConstantBuffers() {
        if (!CreateUploadBuffer(sizeof(SceneConstants), scene_constants_, L"Create scene constants") ||
            !CreateUploadBuffer(sizeof(TextureConstants), texture_constants_, L"Create texture constants")) return false;
        if (!Check(scene_constants_->Map(0, nullptr, reinterpret_cast<void**>(&scene_mapped_)), L"Map scene constants") ||
            !Check(texture_constants_->Map(0, nullptr, reinterpret_cast<void**>(&texture_mapped_)), L"Map texture constants")) return false;
        return true;
    }

    bool UploadTexture(const texture_demo::ShaderTexture& texture) {
        if (texture.data.empty()) {
            return Fail(L"Texture decoder produced an empty shader payload");
        }
        if (texture.metadata.size() > texture_mapped_->words.size()) {
            return Fail(L"Texture has too many mip levels for the shader metadata buffer");
        }
        const std::uint32_t kind = static_cast<std::uint32_t>(texture.kind);
        if (kind == 0 || kind > pipelines_.size() || !pipelines_[kind - 1]) {
            return Fail(L"Texture selected an unavailable shader decoder");
        }
        WaitForGpu();
        ComPtr<ID3D12Resource> resource;
        ComPtr<ID3D12Resource> staging;
        if (!CreateGpuBuffer(
                texture.data.size(), D3D12_RESOURCE_STATE_COPY_DEST,
                resource, L"Create GPU shader texture buffer") ||
            !CreateUploadBuffer(texture.data.size(), staging, L"Create texture staging buffer")) return false;
        void* mapped = nullptr;
        if (!Check(staging->Map(0, nullptr, &mapped), L"Map texture staging buffer")) return false;
        std::memcpy(mapped, texture.data.data(), texture.data.size());
        staging->Unmap(0, nullptr);
        if (!Check(allocator_->Reset(), L"Reset texture upload allocator") ||
            !Check(command_list_->Reset(allocator_.Get(), nullptr), L"Reset texture upload command list")) return false;
        command_list_->CopyBufferRegion(resource.Get(), 0, staging.Get(), 0, texture.data.size());
        auto to_shader = Transition(
            resource.Get(), D3D12_RESOURCE_STATE_COPY_DEST, D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE);
        command_list_->ResourceBarrier(1, &to_shader);
        if (!Check(command_list_->Close(), L"Close texture upload command list")) return false;
        ID3D12CommandList* lists[] = {command_list_.Get()};
        queue_->ExecuteCommandLists(1, lists);
        WaitForGpu();
        texture_buffer_ = std::move(resource);
        texture_mapped_->words.fill(0);
        std::copy(texture.metadata.begin(), texture.metadata.end(), texture_mapped_->words.begin());
        active_texture_ = texture;
        const double source_mb = texture.source_bytes / 1048576.0;
        const double gpu_mb = texture.data.size() / 1048576.0;
        wchar_t status[512]{};
        swprintf_s(status, L"%s  •  %u × %u  •  %u mip(s)  •  source %.2f MiB  •  GPU %.2f MiB  •  shader texel decode",
            texture.format.c_str(), texture.width, texture.height, texture.mip_count, source_mb, gpu_mb);
        SetWindowTextW(status_, status);
        return true;
    }

    bool LoadTexture(const std::filesystem::path& path) {
        texture_demo::ShaderTexture texture;
        std::wstring error;
        if (!texture_demo::LoadShaderTextureFile(path.wstring(), texture, error)) {
            return Fail(L"Could not load texture:\n" + path.wstring() + L"\n\n" + error);
        }
        return UploadTexture(texture);
    }

    void LoadPreset(int index) {
        const std::array<const wchar_t*, 4> files = {
            L"stone-texture-wic-2.38bpp.bpal",
            L"stone-texture-wic.bplm",
            L"stone-texture-wic-1.5bpp.dctbs2",
            L"landscape-alaska.bpdh",
        };
        if (index < 0 || index >= static_cast<int>(files.size())) return;
        LoadTexture(ModuleDirectory() / L"assets" / files[index]);
    }

    void OpenTexture() {
        std::array<wchar_t, 32768> path{};
        OPENFILENAMEW dialog{};
        dialog.lStructSize = sizeof(dialog);
        dialog.hwndOwner = window_;
        dialog.lpstrFilter = L"Project textures (*.bpal;*.bplm;*.dctbs2;*.bpdh)\0*.bpal;*.bplm;*.dctbs2;*.bpdh\0All files (*.*)\0*.*\0";
        dialog.lpstrFile = path.data();
        dialog.nMaxFile = static_cast<DWORD>(path.size());
        dialog.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST;
        if (GetOpenFileNameW(&dialog)) LoadTexture(path.data());
    }

    void TogglePause() {
        const auto now = std::chrono::steady_clock::now();
        if (paused_) {
            started_ = now - std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                std::chrono::duration<float>(paused_seconds_));
            paused_ = false;
            SetWindowTextW(pause_, L"Pause");
        } else {
            paused_seconds_ = std::chrono::duration<float>(now - started_).count();
            paused_ = true;
            SetWindowTextW(pause_, L"Resume");
        }
    }

    void UpdateConstants() {
        const float seconds = paused_ ? paused_seconds_ :
            std::chrono::duration<float>(std::chrono::steady_clock::now() - started_).count();
        const XMMATRIX model = XMMatrixRotationY(seconds * 0.62f) * XMMatrixRotationX(seconds * 0.31f);
        const XMVECTOR eye = XMVectorSet(0.0f, 0.4f, -4.4f, 1.0f);
        const XMMATRIX view = XMMatrixLookAtLH(eye, XMVectorZero(), XMVectorSet(0, 1, 0, 0));
        const XMMATRIX projection = XMMatrixPerspectiveFovLH(
            XMConvertToRadians(48.0f), static_cast<float>(width_) / height_, 0.1f, 100.0f);
        XMStoreFloat4x4(&scene_mapped_->model, model);
        XMStoreFloat4x4(&scene_mapped_->model_view_projection, model * view * projection);
        scene_mapped_->light_position = {2.7f, 3.4f, -2.5f, 1.0f};
        scene_mapped_->camera_position = {0.0f, 0.4f, -4.4f, 1.0f};
        scene_mapped_->light_color = {1.20f, 1.12f, 1.02f, 1.0f};
        scene_mapped_->ambient_color = {0.42f, 0.45f, 0.51f, 1.0f};
    }

    void Render() {
        if (!texture_buffer_) return;
        UpdateConstants();
        const std::uint32_t kind = static_cast<std::uint32_t>(active_texture_.kind);
        if (kind == 0 || kind > pipelines_.size()) return;
        if (FAILED(allocator_->Reset()) ||
            FAILED(command_list_->Reset(allocator_.Get(), pipelines_[kind - 1].Get()))) return;
        auto to_render = Transition(render_targets_[frame_index_].Get(),
            D3D12_RESOURCE_STATE_PRESENT, D3D12_RESOURCE_STATE_RENDER_TARGET);
        command_list_->ResourceBarrier(1, &to_render);
        D3D12_CPU_DESCRIPTOR_HANDLE rtv = rtv_heap_->GetCPUDescriptorHandleForHeapStart();
        rtv.ptr += static_cast<SIZE_T>(frame_index_) * rtv_stride_;
        const D3D12_CPU_DESCRIPTOR_HANDLE dsv = dsv_heap_->GetCPUDescriptorHandleForHeapStart();
        const float clear[] = {0.018f, 0.026f, 0.039f, 1.0f};
        command_list_->ClearRenderTargetView(rtv, clear, 0, nullptr);
        command_list_->ClearDepthStencilView(dsv, D3D12_CLEAR_FLAG_DEPTH, 1.0f, 0, 0, nullptr);
        D3D12_VIEWPORT viewport{0, 0, static_cast<float>(width_), static_cast<float>(height_), 0, 1};
        D3D12_RECT scissor{0, 0, static_cast<LONG>(width_), static_cast<LONG>(height_)};
        command_list_->RSSetViewports(1, &viewport);
        command_list_->RSSetScissorRects(1, &scissor);
        command_list_->OMSetRenderTargets(1, &rtv, FALSE, &dsv);
        command_list_->SetGraphicsRootSignature(root_signature_.Get());
        command_list_->SetGraphicsRootConstantBufferView(0, scene_constants_->GetGPUVirtualAddress());
        command_list_->SetGraphicsRootConstantBufferView(1, texture_constants_->GetGPUVirtualAddress());
        command_list_->SetGraphicsRootShaderResourceView(2, texture_buffer_->GetGPUVirtualAddress());
        command_list_->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        command_list_->IASetVertexBuffers(0, 1, &vertex_view_);
        command_list_->IASetIndexBuffer(&index_view_);
        command_list_->DrawIndexedInstanced(static_cast<UINT>(kIndices.size()), 1, 0, 0, 0);
        auto to_present = Transition(render_targets_[frame_index_].Get(),
            D3D12_RESOURCE_STATE_RENDER_TARGET, D3D12_RESOURCE_STATE_PRESENT);
        command_list_->ResourceBarrier(1, &to_present);
        if (FAILED(command_list_->Close())) return;
        ID3D12CommandList* lists[] = {command_list_.Get()};
        queue_->ExecuteCommandLists(1, lists);
        if (SUCCEEDED(swap_chain_->Present(1, 0))) {
            WaitForGpu();
            frame_index_ = swap_chain_->GetCurrentBackBufferIndex();
        }
    }

    void WaitForGpu() {
        if (!queue_ || !fence_ || !fence_event_) return;
        const UINT64 value = ++fence_value_;
        if (FAILED(queue_->Signal(fence_.Get(), value))) return;
        if (fence_->GetCompletedValue() < value) {
            fence_->SetEventOnCompletion(value, fence_event_);
            WaitForSingleObject(fence_event_, INFINITE);
        }
    }

    void Resize(UINT width, UINT height) {
        if (width == width_ && height == height_) return;
        WaitForGpu();
        for (auto& target : render_targets_) target.Reset();
        depth_.Reset();
        width_ = width;
        height_ = height;
        if (FAILED(swap_chain_->ResizeBuffers(kFrameCount, width_, height_,
                DXGI_FORMAT_R8G8B8A8_UNORM, 0))) return;
        frame_index_ = swap_chain_->GetCurrentBackBufferIndex();
        CreateRenderTargets();
        CreateDepthBuffer();
    }

    HWND window_ = nullptr;
    HWND render_window_ = nullptr;
    HWND upload_ = nullptr;
    HWND pause_ = nullptr;
    HWND preset_ = nullptr;
    HWND status_ = nullptr;
    UINT width_ = 1;
    UINT height_ = 1;
    bool minimized_ = false;
    bool paused_ = false;
    float paused_seconds_ = 0;
    std::chrono::steady_clock::time_point started_{};

    ComPtr<IDXGIFactory6> factory_;
    ComPtr<ID3D12Device> device_;
    ComPtr<ID3D12CommandQueue> queue_;
    ComPtr<IDXGISwapChain3> swap_chain_;
    ComPtr<ID3D12DescriptorHeap> rtv_heap_;
    ComPtr<ID3D12DescriptorHeap> dsv_heap_;
    std::array<ComPtr<ID3D12Resource>, kFrameCount> render_targets_;
    ComPtr<ID3D12Resource> depth_;
    ComPtr<ID3D12CommandAllocator> allocator_;
    ComPtr<ID3D12GraphicsCommandList> command_list_;
    ComPtr<ID3D12RootSignature> root_signature_;
    std::array<ComPtr<ID3D12PipelineState>, 3> pipelines_;
    ComPtr<ID3D12Resource> vertex_buffer_;
    ComPtr<ID3D12Resource> index_buffer_;
    ComPtr<ID3D12Resource> scene_constants_;
    ComPtr<ID3D12Resource> texture_constants_;
    ComPtr<ID3D12Resource> texture_buffer_;
    ComPtr<ID3D12Fence> fence_;
    D3D12_VERTEX_BUFFER_VIEW vertex_view_{};
    D3D12_INDEX_BUFFER_VIEW index_view_{};
    SceneConstants* scene_mapped_ = nullptr;
    TextureConstants* texture_mapped_ = nullptr;
    HANDLE fence_event_ = nullptr;
    UINT64 fence_value_ = 0;
    UINT frame_index_ = 0;
    UINT rtv_stride_ = 0;
    texture_demo::ShaderTexture active_texture_;
};

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show) {
    const HRESULT com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    DemoApplication application;
    g_application = &application;
    const int result = application.Initialize(instance, show) ? application.Run() : 1;
    g_application = nullptr;
    if (SUCCEEDED(com)) CoUninitialize();
    return result;
}
