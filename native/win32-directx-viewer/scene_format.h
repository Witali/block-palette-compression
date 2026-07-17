#pragma once

#include <cstdint>

namespace native_scene {

constexpr std::uint32_t kSceneVersion = 1;
constexpr std::uint32_t kTextureStreamVersion = 1;

enum TextureCodec : std::uint32_t {
    TextureCodecBpal = 1,
    TextureCodecDct = 2,
    TextureCodecAstc = 3,
};

enum MaterialFlags : std::uint32_t {
    MaterialDoubleSided = 1u << 0,
    MaterialTransparent = 1u << 1,
    MaterialAlphaTest = 1u << 2,
    MaterialEmissive = 1u << 3,
    MaterialHasBaseTexture = 1u << 4,
    MaterialHasBumpTexture = 1u << 5,
};

#pragma pack(push, 1)

struct SceneHeader {
    char magic[4];
    std::uint32_t version;
    std::uint32_t vertexCount;
    std::uint32_t indexCount;
    std::uint32_t drawCount;
    std::uint32_t materialCount;
    float boundsMin[3];
    float boundsMax[3];
    std::uint64_t codecBytes[3];
    std::uint32_t reserved[6];
};

struct MaterialRecord {
    char name[64];
    char baseTexture[48];
    char bumpTexture[48];
    float baseColor[4];
    float roughness;
    float metalness;
    std::uint32_t flags;
    float alphaCutoff;
};

struct DrawRecord {
    std::uint32_t firstIndex;
    std::uint32_t indexCount;
    std::uint32_t materialIndex;
    std::uint32_t reserved;
};

struct Vertex {
    float position[3];
    float normal[3];
    float uv[2];
};

struct TextureStreamHeader {
    char magic[4];
    std::uint32_t version;
    std::uint32_t codec;
    std::uint32_t width;
    std::uint32_t height;
    std::uint32_t dataBytes;
    std::uint32_t parameters[14];
};

#pragma pack(pop)

static_assert(sizeof(SceneHeader) == 96);
static_assert(sizeof(MaterialRecord) == 192);
static_assert(sizeof(DrawRecord) == 16);
static_assert(sizeof(Vertex) == 32);
static_assert(sizeof(TextureStreamHeader) == 80);

}  // namespace native_scene
