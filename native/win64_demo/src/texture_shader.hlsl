ByteAddressBuffer TextureData : register(t0);

cbuffer SceneConstants : register(b0) {
  row_major float4x4 ModelViewProjection;
  row_major float4x4 Model;
  float4 LightPosition;
  float4 CameraPosition;
  float4 LightColor;
  float4 AmbientColor;
};

cbuffer TextureConstants : register(b1) {
  // Keep this in sync with kShaderMetadataCapacityWords in shader_texture.h.
  uint4 PackedMeta[768];
};

uint Meta(uint index) {
  return PackedMeta[index >> 2u][index & 3u];
}

struct VertexInput {
  float3 position : POSITION;
  float3 normal : NORMAL;
  float2 uv : TEXCOORD0;
};

struct PixelInput {
  float4 position : SV_POSITION;
  float3 worldPosition : POSITION0;
  float3 normal : NORMAL;
  float2 uv : TEXCOORD0;
};

PixelInput VSMain(VertexInput input) {
  PixelInput output;
  output.position = mul(float4(input.position, 1.0), ModelViewProjection);
  output.worldPosition = mul(float4(input.position, 1.0), Model).xyz;
  output.normal = normalize(mul(float4(input.normal, 0.0), Model).xyz);
  output.uv = input.uv;
  return output;
}

uint LoadByte(uint offset) {
  uint word = TextureData.Load(offset & ~3u);
  return (word >> ((offset & 3u) * 8u)) & 255u;
}

uint LoadU16(uint offset) {
  return LoadByte(offset) | (LoadByte(offset + 1u) << 8u);
}

float3 UnpackRgba(uint rgba) {
  return float3(rgba & 255u, (rgba >> 8u) & 255u, (rgba >> 16u) & 255u) / 255.0;
}

float3 FetchBpalPixel(int2 coordinate, uint level) {
  uint base = 8u + min(level, Meta(3u) - 1u) * 12u;
  uint width = Meta(base);
  uint height = Meta(base + 1u);
  uint blockSize = Meta(base + 2u);
  uint blocksX = Meta(base + 3u);
  uint selectorOffset = Meta(base + 4u);
  uint blockOffset = Meta(base + 5u);
  uint pixelOffset = Meta(base + 6u);
  uint flags = Meta(base + 7u);
  uint localCount = Meta(base + 8u);
  uint globalCount = Meta(base + 9u);
  int2 pixel = clamp(coordinate, int2(0, 0), int2(width - 1u, height - 1u));
  uint pixelIndex = uint(pixel.y) * width + uint(pixel.x);
  uint flattened;
  if ((flags & 1u) != 0u) {
    flattened = LoadU16(pixelOffset + pixelIndex * 2u);
  } else {
    uint block = (uint(pixel.y) / blockSize) * blocksX + uint(pixel.x) / blockSize;
    uint localIndex = LoadByte(pixelOffset + pixelIndex);
    uint selector = LoadByte(selectorOffset + block);
    uint global = LoadU16(blockOffset + (block * localCount + localIndex) * 2u);
    flattened = selector * globalCount + global;
  }
  return UnpackRgba(TextureData.Load(Meta(4u) + flattened * 4u));
}

float3 SampleBpal(float2 uv) {
  float footprint = max(length(ddx(uv) * float2(Meta(1u), Meta(2u))),
                        length(ddy(uv) * float2(Meta(1u), Meta(2u))));
  uint level = min((uint)max(0.0, floor(log2(max(1.0, footprint)) + 0.5)), Meta(3u) - 1u);
  uint base = 8u + level * 12u;
  float2 size = float2(Meta(base), Meta(base + 1u));
  float2 source = float2(uv.x, 1.0 - uv.y) * size - 0.5;
  int2 topLeft = int2(floor(source));
  float2 blend = frac(source);
  float3 top = lerp(FetchBpalPixel(topLeft, level),
                    FetchBpalPixel(topLeft + int2(1, 0), level), blend.x);
  float3 bottom = lerp(FetchBpalPixel(topLeft + int2(0, 1), level),
                       FetchBpalPixel(topLeft + int2(1, 1), level), blend.x);
  return lerp(top, bottom, blend.y);
}

int RoundDivide(int value, int divisor) {
  return value >= 0 ? (value + divisor / 2) / divisor : -((-value + divisor / 2) / divisor);
}

uint BpdhSample(uint record, uint component, uint x, uint y) {
  return LoadByte(record + component * 64u + y * 8u + x);
}

int BpdhChroma(uint record, uint component, uint x, uint y) {
  int floorX = (x & 1u) == 0u ? int(x / 2u) - 1 : int(x / 2u);
  int floorY = (y & 1u) == 0u ? int(y / 2u) - 1 : int(y / 2u);
  uint x0 = uint(clamp(floorX, 0, 7));
  uint y0 = uint(clamp(floorY, 0, 7));
  uint x1 = uint(clamp(floorX + 1, 0, 7));
  uint y1 = uint(clamp(floorY + 1, 0, 7));
  int fx = (x & 1u) == 0u ? 3 : 1;
  int fy = (y & 1u) == 0u ? 3 : 1;
  int top = (4 - fx) * int(BpdhSample(record, component, x0, y0)) +
            fx * int(BpdhSample(record, component, x1, y0));
  int bottom = (4 - fx) * int(BpdhSample(record, component, x0, y1)) +
               fx * int(BpdhSample(record, component, x1, y1));
  return RoundDivide((4 - fy) * top + fy * bottom, 16);
}

float3 FetchBpdhPixel(int2 coordinate) {
  uint width = Meta(1u);
  uint height = Meta(2u);
  int2 pixel = clamp(coordinate, int2(0, 0), int2(width - 1u, height - 1u));
  uint2 local = uint2(pixel) & 15u;
  uint block = (uint(pixel.y) / 16u) * Meta(8u) + uint(pixel.x) / 16u;
  uint map = TextureData.Load(Meta(12u) + block * 4u);
  uint mode = map & 255u;
  uint recordIndex = map >> 8u;
  if (mode == 0u) {
    uint record = Meta(13u) + recordIndex * Meta(14u);
    uint selector = LoadByte(record);
    uint localIndex = LoadByte(record + 1u + Meta(9u) * 2u + local.y * 16u + local.x);
    uint global = LoadU16(record + 1u + localIndex * 2u);
    return UnpackRgba(TextureData.Load(Meta(4u) + (selector * Meta(10u) + global) * 4u));
  }
  uint record = Meta(15u) + recordIndex * Meta(16u);
  uint component = (local.y / 8u) * 2u + local.x / 8u;
  int y = int(BpdhSample(record, component, local.x & 7u, local.y & 7u));
  int cb = BpdhChroma(record, 4u, local.x, local.y) - 128;
  int cr = BpdhChroma(record, 5u, local.x, local.y) - 128;
  return float3(
    clamp(y + RoundDivide(91881 * cr, 65536), 0, 255),
    clamp(y + RoundDivide(-22554 * cb - 46802 * cr, 65536), 0, 255),
    clamp(y + RoundDivide(116130 * cb, 65536), 0, 255)) / 255.0;
}

float3 SampleBpdh(float2 uv) {
  int2 pixel = int2(floor(float2(uv.x, 1.0 - uv.y) * float2(Meta(1u), Meta(2u))));
  return FetchBpdhPixel(pixel);
}

static const int QuantY[64] = {
  16,11,10,16,24,40,51,61, 12,12,14,19,26,58,60,55,
  14,13,16,24,40,57,69,56, 14,17,22,29,51,87,80,62,
  18,22,37,56,68,109,103,77, 24,35,55,64,81,104,113,92,
  49,64,78,87,103,121,120,101, 72,92,95,98,112,100,103,99
};
static const int QuantC[64] = {
  17,18,24,47,99,99,99,99, 18,21,26,66,99,99,99,99,
  24,26,56,99,99,99,99,99, 47,66,99,99,99,99,99,99,
  99,99,99,99,99,99,99,99, 99,99,99,99,99,99,99,99,
  99,99,99,99,99,99,99,99, 99,99,99,99,99,99,99,99
};
static const int ScanY[132] = {
  16,1,2,17,32,48,33,18,3,4,19,34,49,64,80,65,50,35,20,5,6,21,36,51,66,81,96,112,97,82,67,52,37,
  1,2,16,3,17,4,18,32,5,19,33,6,20,34,7,48,21,35,8,49,22,36,9,50,23,64,37,10,51,24,65,38,11,
  16,32,1,48,17,64,33,2,80,49,18,96,65,34,112,3,81,50,128,19,97,66,144,35,113,4,82,160,51,129,20,98,176,
  17,1,16,34,18,33,2,32,51,35,50,19,49,3,48,68,52,67,36,66,20,65,4,64,85,69,84,53,83,37,82,21,81
};
static const int ScanC[52] = {
  8,1,2,9,16,24,17,10,3,4,11,18,25,
  1,2,8,3,9,4,10,16,5,11,17,6,12,
  8,16,1,24,9,32,17,2,40,25,10,48,33,
  9,1,8,18,10,17,2,16,27,19,26,11,25
};

uint ReadDctBits(uint record, uint bitOffset, uint bitCount) {
  uint value = 0u;
  [loop] for (uint bit = 0u; bit < bitCount; ++bit) {
    uint absolute = bitOffset + bit;
    uint source = LoadByte(record + absolute / 8u);
    value = (value << 1u) | ((source >> (7u - absolute % 8u)) & 1u);
  }
  return value;
}

int ReadDctSigned(uint record, uint bitOffset, uint bitCount) {
  uint raw = ReadDctBits(record, bitOffset, bitCount);
  uint sign = 1u << (bitCount - 1u);
  return (raw & sign) == 0u ? int(raw) : int(raw) - int(1u << bitCount);
}

float DctBasis(int frequency, int coordinate, int size) {
  float alpha = frequency == 0 ? sqrt(1.0 / size) : sqrt(2.0 / size);
  return alpha * cos(3.141592653589793 * (2 * coordinate + 1) * frequency / (2 * size));
}

float QuantStep(int position, bool chroma) {
  int width = chroma ? 8 : 16;
  int u = position % width;
  int v = position / width;
  int tx = min(7, (u * 7 + (width - 1) / 2) / (width - 1));
  int ty = min(7, (v * 7 + 7) / 15);
  int quality = int(Meta(14u));
  float scale = quality < 50 ? 50.0 / quality : 2.0 - quality * 0.02;
  float dimension = sqrt(width * 16.0 / 64.0);
  return max(1.0, (chroma ? QuantC[ty * 8 + tx] : QuantY[ty * 8 + tx]) * scale * dimension);
}

int DctScale(uint record, int count, int index) {
  int first = (count + 5) / 6;
  int second = (count + 1) / 2;
  int group = index < first ? 0 : (index < second ? 1 : 2);
  return int(ReadDctBits(record, 18u + uint(group) * 3u, 3u));
}

float SampleDctRecord(uint record, int x, int y, bool chroma) {
  uint header = LoadByte(record);
  int profile = int(header >> 4u);
  int dcScale = int(header & 15u);
  int width = chroma ? 8 : 16;
  int count = chroma ? 13 : 33;
  float sum = ReadDctSigned(record, 8u, 10u) * exp2((float)dcScale) *
    QuantStep(0, chroma) * DctBasis(0, x, width) * DctBasis(0, y, 16);
  [loop] for (int index = 0; index < count; ++index) {
    int position = chroma ? ScanC[profile * count + index] : ScanY[profile * count + index];
    int u = position % width;
    int v = position / width;
    int stored = ReadDctSigned(record, 27u + uint(index) * 5u, 5u);
    sum += stored * exp2((float)DctScale(record, count, index)) * QuantStep(position, chroma) *
      DctBasis(u, x, width) * DctBasis(v, y, 16);
  }
  return sum + 128.0;
}

float3 SampleDct(float2 uv) {
  int2 pixel = clamp(int2(floor(float2(uv.x, 1.0 - uv.y) * float2(Meta(1u), Meta(2u)))),
                     int2(0, 0), int2(Meta(1u) - 1u, Meta(2u) - 1u));
  uint mcu = (uint(pixel.y) / 16u) * Meta(8u) + uint(pixel.x) / 16u;
  uint record = 64u + mcu * Meta(10u);
  int2 local = pixel & 15;
  float y = SampleDctRecord(record, local.x, local.y, false);
  float cb = SampleDctRecord(record + Meta(11u), local.x / 2, local.y, true) - 128.0;
  float cr = SampleDctRecord(record + Meta(11u) + Meta(12u), local.x / 2, local.y, true) - 128.0;
  return saturate(float3(y + 1.402 * cr,
                         y - 0.344136 * cb - 0.714136 * cr,
                         y + 1.772 * cb) / 255.0);
}

float4 ShadePixel(PixelInput input, float3 albedo) {
  float3 normal = normalize(input.normal);
  float3 lightDirection = normalize(LightPosition.xyz - input.worldPosition);
  float3 viewDirection = normalize(CameraPosition.xyz - input.worldPosition);
  float diffuse = max(dot(normal, lightDirection), 0.0);
  float3 halfVector = normalize(lightDirection + viewDirection);
  float specular = pow(max(dot(normal, halfVector), 0.0), 42.0) * 0.42;
  float rim = pow(1.0 - saturate(dot(normal, viewDirection)), 3.0) * 0.10;
  float3 color = albedo * (AmbientColor.rgb + LightColor.rgb * diffuse) +
                 LightColor.rgb * specular + rim;
  color = color / (1.0 + color * 0.12);
  color = pow(saturate(color), 1.0 / 2.2);
  return float4(color, 1.0);
}

float4 PSBpal(PixelInput input) : SV_TARGET {
  return ShadePixel(input, SampleBpal(input.uv));
}

float4 PSDct(PixelInput input) : SV_TARGET {
  return ShadePixel(input, SampleDct(input.uv));
}

float4 PSBpdh(PixelInput input) : SV_TARGET {
  return ShadePixel(input, SampleBpdh(input.uv));
}
