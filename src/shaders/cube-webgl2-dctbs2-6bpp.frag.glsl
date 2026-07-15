#version 300 es
/*
 * Generated WebGL2 compact cube fragment stage for DCTBS2 6 bpp.
 * Pixel indices, block-palette indices, and palette colors stay bit-packed in
 * R32UI textures and are decoded with exact integer fetches.
 */
precision highp float;
precision highp int;

in vec3 vNormal;
in vec3 vTangent;
in vec3 vBitangent;
in vec3 vWorldPosition;
in vec2 vTexCoord;

uniform sampler2D uStoneTexture;
uniform sampler2D uHeightTexture;
uniform sampler2D uSpecularTexture;
uniform highp usampler2D uBpalPixelIndices;
uniform highp usampler2D uBpalBlockPalettes;
uniform highp usampler2D uBpalGlobalPalette;
uniform highp usampler2D uBpalPaletteSelectors;
uniform highp usampler2D uDctData;
uniform float uUseBpalTexture;
uniform float uUseDctTexture;
uniform highp uvec2 uBpalImageSize;
uniform highp uint uBpalBlockSize;
uniform highp uint uBpalBlocksX;
uniform highp uint uBpalLocalColorCount;
uniform highp uint uBpalGlobalColorCount;
uniform highp uint uBpalLocalIndexBits;
uniform highp uint uBpalGlobalIndexBits;
uniform highp uint uBpalPaletteIndexBits;
uniform highp uint uBpalPaletteColorBits;
uniform highp uvec2 uBpalPixelAtlasSize;
uniform highp uvec2 uBpalBlockPaletteAtlasSize;
uniform highp uvec2 uBpalPaletteAtlasSize;
uniform highp uvec2 uBpalPaletteSelectorAtlasSize;
uniform highp ivec2 uDctImageSize;
uniform highp int uDctMcuColumns;
uniform highp int uDctQuality;
uniform highp int uDctDataTexWidth;
uniform highp int uDctDecodeMode;
uniform highp int uDctCacheMcusPerRow;
uniform sampler2D uBpdhData;
uniform float uUseBpdhTexture;
uniform vec2 uBpdhImageSize;
uniform float uBpdhBlocksX;
uniform float uBpdhLocalColorCount;
uniform float uBpdhGlobalColorCount;
uniform float uBpdhBlockMapOffset;
uniform float uBpdhBpalRecordsOffset;
uniform float uBpdhBpalRecordStride;
uniform float uBpdhDctRecordsOffset;
uniform float uBpdhDctRecordStride;
uniform vec2 uBpdhDataAtlasSize;
uniform vec2 uHeightTexelSize;
uniform float uHeightStrength;
uniform vec3 uLightPosition;
uniform vec3 uLightColor;
uniform vec3 uAmbientColor;
uniform vec3 uViewPosition;
uniform float uSpecularStrength;
uniform float uShininess;

out vec4 fragmentColor;

const float DCT_PI = 3.1415926535897932384626433832795;
const int DCT_HEADER_BYTES = 64;
const int DCT_MCU_BYTES = 192;
const int DCT_Y_BYTES = 128;
const int DCT_CB_BYTES = 32;
const int DCT_Y_AC_COUNT = 199;
const int DCT_C_AC_COUNT = 45;
const int DCT_DECODE_MODE_FAST = 1;
const int DCT_CACHE_MCU_BYTES = 512;
const int DCT_CACHE_MCU_TEXELS = 128;
const int DCT_CACHE_CB_OFFSET = 256;
const int DCT_CACHE_CR_OFFSET = 384;

const int DCT_QUANT_Y[64] = int[64](
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99
);

const int DCT_QUANT_C[64] = int[64](
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99
);

// Four deterministic significance scans trimmed for 6 bpp records.
const int DCT_SCAN_Y[796] = int[796](
  16, 1, 2, 17, 32, 48, 33, 18, 3, 4, 19, 34, 49, 64, 80, 65, 50,
  35, 20, 5, 6, 21, 36, 51, 66, 81, 96, 112, 97, 82, 67, 52, 37, 22,
  7, 8, 23, 38, 53, 68, 83, 98, 113, 128, 144, 129, 114, 99, 84, 69, 54,
  39, 24, 9, 10, 25, 40, 55, 70, 85, 100, 115, 130, 145, 160, 176, 161, 146,
  131, 116, 101, 86, 71, 56, 41, 26, 11, 12, 27, 42, 57, 72, 87, 102, 117,
  132, 147, 162, 177, 192, 208, 193, 178, 163, 148, 133, 118, 103, 88, 73, 58, 43,
  28, 13, 14, 29, 44, 59, 74, 89, 104, 119, 134, 149, 164, 179, 194, 209, 224,
  240, 225, 210, 195, 180, 165, 150, 135, 120, 105, 90, 75, 60, 45, 30, 15, 31,
  46, 61, 76, 91, 106, 121, 136, 151, 166, 181, 196, 211, 226, 241, 242, 227, 212,
  197, 182, 167, 152, 137, 122, 107, 92, 77, 62, 47, 63, 78, 93, 108, 123, 138,
  153, 168, 183, 198, 213, 228, 243, 244, 229, 214, 199, 184, 169, 154, 139, 124, 109,
  94, 79, 95, 110, 125, 140, 155, 170, 185, 200, 215, 230, 1, 2, 16, 3, 17,
  4, 18, 32, 5, 19, 33, 6, 20, 34, 7, 48, 21, 35, 8, 49, 22, 36,
  9, 50, 23, 64, 37, 10, 51, 24, 65, 38, 11, 52, 25, 66, 39, 80, 12,
  53, 26, 67, 40, 81, 13, 54, 27, 68, 41, 82, 14, 55, 96, 28, 69, 42,
  83, 15, 56, 97, 29, 70, 43, 84, 57, 98, 30, 71, 112, 44, 85, 58, 99,
  31, 72, 113, 45, 86, 59, 100, 73, 114, 46, 87, 128, 60, 101, 74, 115, 47,
  88, 129, 61, 102, 75, 116, 89, 130, 62, 103, 144, 76, 117, 90, 131, 63, 104,
  145, 77, 118, 91, 132, 105, 146, 78, 119, 160, 92, 133, 106, 147, 79, 120, 161,
  93, 134, 107, 148, 121, 162, 94, 135, 176, 108, 149, 122, 163, 95, 136, 177, 109,
  150, 123, 164, 137, 178, 110, 151, 192, 124, 165, 138, 179, 111, 152, 193, 125, 166,
  139, 180, 153, 194, 126, 167, 208, 140, 181, 154, 195, 127, 168, 209, 141, 182, 155,
  196, 169, 210, 142, 183, 156, 224, 197, 170, 211, 143, 184, 157, 225, 198, 171, 212,
  185, 158, 226, 199, 240, 172, 213, 16, 32, 1, 48, 17, 64, 33, 2, 80, 49,
  18, 96, 65, 34, 112, 3, 81, 50, 128, 19, 97, 66, 144, 35, 113, 4, 82,
  160, 51, 129, 20, 98, 176, 67, 145, 36, 114, 5, 192, 83, 161, 52, 130, 21,
  208, 99, 177, 68, 146, 37, 224, 115, 6, 193, 84, 162, 53, 240, 131, 22, 209,
  100, 178, 69, 147, 38, 225, 116, 7, 194, 85, 163, 54, 241, 132, 23, 210, 101,
  179, 70, 148, 39, 226, 117, 8, 195, 86, 164, 55, 242, 133, 24, 211, 102, 180,
  71, 149, 40, 227, 118, 9, 196, 87, 165, 56, 243, 134, 25, 212, 103, 181, 72,
  150, 41, 228, 119, 10, 197, 88, 166, 57, 244, 135, 26, 213, 104, 182, 73, 151,
  42, 229, 120, 11, 198, 89, 167, 58, 245, 136, 27, 214, 105, 183, 74, 152, 43,
  230, 121, 12, 199, 90, 168, 59, 246, 137, 28, 215, 106, 184, 75, 153, 44, 231,
  122, 13, 200, 91, 169, 60, 247, 138, 29, 216, 107, 185, 76, 154, 45, 232, 123,
  201, 14, 92, 170, 61, 248, 139, 217, 30, 108, 186, 77, 155, 233, 46, 124, 15,
  202, 93, 17, 1, 16, 34, 18, 33, 2, 32, 51, 35, 50, 19, 49, 3, 48,
  68, 52, 67, 36, 66, 20, 65, 4, 64, 85, 69, 84, 53, 83, 37, 82, 21,
  81, 5, 80, 102, 86, 101, 70, 100, 54, 99, 38, 98, 22, 97, 6, 96, 119,
  103, 118, 87, 117, 71, 116, 55, 115, 39, 114, 23, 113, 7, 112, 136, 120, 135,
  104, 134, 88, 133, 72, 132, 56, 131, 40, 130, 24, 129, 8, 128, 153, 137, 152,
  121, 151, 105, 150, 89, 149, 73, 148, 57, 147, 41, 146, 25, 145, 9, 144, 170,
  154, 169, 138, 168, 122, 167, 106, 166, 90, 165, 74, 164, 58, 163, 42, 162, 26,
  161, 10, 160, 187, 171, 186, 155, 185, 139, 184, 123, 183, 107, 182, 91, 181, 75,
  180, 59, 179, 43, 178, 27, 177, 11, 176, 204, 188, 203, 172, 202, 156, 201, 140,
  200, 124, 199, 108, 198, 92, 197, 76, 196, 60, 195, 44, 194, 28, 193, 12, 192,
  221, 205, 220, 189, 219, 173, 218, 157, 217, 141, 216, 125, 215, 109, 214, 93, 213,
  77, 212, 61, 211, 45, 210, 29, 209, 13, 208, 238, 222, 237, 206
);

const int DCT_SCAN_C[180] = int[180](
  8, 1, 2, 9, 16, 24, 17, 10, 3, 4, 11, 18, 25, 32, 40, 33, 26,
  19, 12, 5, 6, 13, 20, 27, 34, 41, 48, 56, 49, 42, 35, 28, 21, 14,
  7, 15, 22, 29, 36, 43, 50, 57, 64, 72, 65, 1, 2, 8, 3, 9, 4,
  10, 16, 5, 11, 17, 6, 12, 18, 7, 24, 13, 19, 25, 14, 20, 26, 15,
  32, 21, 27, 33, 22, 28, 34, 23, 40, 29, 35, 41, 30, 36, 42, 31, 48,
  37, 43, 49, 38, 44, 8, 16, 1, 24, 9, 32, 17, 2, 40, 25, 10, 48,
  33, 18, 56, 3, 41, 26, 64, 11, 49, 34, 72, 19, 57, 4, 42, 80, 27,
  65, 12, 50, 88, 35, 73, 20, 58, 5, 96, 43, 81, 28, 66, 13, 104, 9,
  1, 8, 18, 10, 17, 2, 16, 27, 19, 26, 11, 25, 3, 24, 36, 28, 35,
  20, 34, 12, 33, 4, 32, 45, 37, 44, 29, 43, 21, 42, 13, 41, 5, 40,
  54, 46, 53, 38, 52, 30, 51, 22, 50, 14
);

uint dctByteAt(int byteOffset) {
  int texelIndex = byteOffset >> 2;
  ivec2 coordinate = ivec2(
    texelIndex % uDctDataTexWidth,
    texelIndex / uDctDataTexWidth
  );
  uvec4 texel = texelFetch(uDctData, coordinate, 0);
  int lane = byteOffset & 3;
  return lane == 0 ? texel.r : lane == 1 ? texel.g : lane == 2 ? texel.b : texel.a;
}

uint dctCachedByte(ivec2 mcuOrigin, int byteOffset) {
  uvec4 texel = texelFetch(
    uDctData,
    mcuOrigin + ivec2(byteOffset >> 2, 0),
    0
  );
  int lane = byteOffset & 3;
  return lane == 0 ? texel.r : lane == 1 ? texel.g : lane == 2 ? texel.b : texel.a;
}

uint dctWordAt(int byteOffset) {
  int texelIndex = byteOffset >> 2;
  ivec2 coordinate = ivec2(
    texelIndex % uDctDataTexWidth,
    texelIndex / uDctDataTexWidth
  );
  uvec4 bytes = texelFetch(uDctData, coordinate, 0);
  return (bytes.r << 24u) | (bytes.g << 16u) | (bytes.b << 8u) | bytes.a;
}

uint readDctBits(int byteOffset, int bitOffset, int bitCount) {
  int absoluteBit = (byteOffset << 3) + bitOffset;
  int wordByteOffset = (absoluteBit >> 5) << 2;
  uint wordBit = uint(absoluteBit & 31);
  uint value = dctWordAt(wordByteOffset) << wordBit;

  if (int(wordBit) + bitCount > 32) {
    value |= dctWordAt(wordByteOffset + 4) >> (32u - wordBit);
  }

  uint mask = (1u << uint(bitCount)) - 1u;
  return (value >> uint(32 - bitCount)) & mask;
}

int readSignedDctBits(int byteOffset, int bitOffset, int bitCount) {
  uint raw = readDctBits(byteOffset, bitOffset, bitCount);
  uint sign = 1u << uint(bitCount - 1);
  return (raw & sign) == 0u ? int(raw) : int(raw) - int(1u << uint(bitCount));
}

float dctBasis(int frequency, int coordinate, int size) {
  float alpha = frequency == 0 ? sqrt(1.0 / float(size)) : sqrt(2.0 / float(size));
  return alpha * cos(
    DCT_PI * float((2 * coordinate + 1) * frequency) / float(2 * size)
  );
}

float dctQuantizationStep(int position, bool chroma) {
  int width = chroma ? 8 : 16;
  int height = 16;
  int u = position % width;
  int v = position / width;
  int tableX = min(7, int(floor(float(u * 7) / float(width - 1) + 0.5)));
  int tableY = min(7, int(floor(float(v * 7) / float(height - 1) + 0.5)));
  float qualityScale = uDctQuality < 50
    ? 50.0 / float(uDctQuality)
    : 2.0 - float(uDctQuality) * 0.02;
  float dimensionScale = sqrt(float(width * height) / 64.0);
  int tableValue = chroma
    ? DCT_QUANT_C[tableY * 8 + tableX]
    : DCT_QUANT_Y[tableY * 8 + tableX];
  return max(1.0, float(tableValue) * qualityScale * dimensionScale);
}

// <dctbs2-profile-decoder>
// Generated baseline grouped-5-front decoder: fixed record sizes, no format branches.
int dctSigned10(uint raw) {
  return (raw & 512u) == 0u ? int(raw) : int(raw) - 1024;
}

int dctSigned5(uint raw) {
  return (raw & 16u) == 0u ? int(raw) : int(raw) - 32;
}

void addDctCompensated(float value, inout float sum, inout float correction) {
  float adjusted = value - correction;
  float next = sum + adjusted;
  correction = (next - sum) - adjusted;
  sum = next;
}

float sampleDctLumaRecord(int recordOffset, int localX, int localY) {
  uint headerWord = dctWordAt(recordOffset);
  int profile = int(headerWord >> 28u);
  int dcScaleIndex = int((headerWord >> 24u) & 15u);
  int dc = dctSigned10((headerWord >> 14u) & 1023u);
  float scale0 = exp2(float((headerWord >> 11u) & 7u));
  float scale1 = exp2(float((headerWord >> 8u) & 7u));
  float scale2 = exp2(float((headerWord >> 5u) & 7u));
  float sum = 0.0;
  float correction = 0.0;

  addDctCompensated(
    float(dc) * exp2(float(dcScaleIndex)) * dctQuantizationStep(0, false) *
      dctBasis(0, localX, 16) * dctBasis(0, localY, 16),
    sum,
    correction
  );

  uint currentWord = headerWord;
  uint nextWord = dctWordAt(recordOffset + 4);
  {
    int position = DCT_SCAN_Y[profile * 199 + 0];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 8);
  {
    int position = DCT_SCAN_Y[profile * 199 + 1];
    int stored = dctSigned5((currentWord >> 27u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 2];
    int stored = dctSigned5((currentWord >> 22u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 3];
    int stored = dctSigned5((currentWord >> 17u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 4];
    int stored = dctSigned5((currentWord >> 12u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 5];
    int stored = dctSigned5((currentWord >> 7u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 6];
    int stored = dctSigned5((currentWord >> 2u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 7];
    int stored = dctSigned5(((currentWord << 3u) | (nextWord >> 29u)) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 12);
  {
    int position = DCT_SCAN_Y[profile * 199 + 8];
    int stored = dctSigned5((currentWord >> 24u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 9];
    int stored = dctSigned5((currentWord >> 19u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 10];
    int stored = dctSigned5((currentWord >> 14u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 11];
    int stored = dctSigned5((currentWord >> 9u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 12];
    int stored = dctSigned5((currentWord >> 4u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 13];
    int stored = dctSigned5(((currentWord << 1u) | (nextWord >> 31u)) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 16);
  {
    int position = DCT_SCAN_Y[profile * 199 + 14];
    int stored = dctSigned5((currentWord >> 26u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 15];
    int stored = dctSigned5((currentWord >> 21u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 16];
    int stored = dctSigned5((currentWord >> 16u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 17];
    int stored = dctSigned5((currentWord >> 11u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 18];
    int stored = dctSigned5((currentWord >> 6u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 19];
    int stored = dctSigned5((currentWord >> 1u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 20];
    int stored = dctSigned5(((currentWord << 4u) | (nextWord >> 28u)) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 20);
  {
    int position = DCT_SCAN_Y[profile * 199 + 21];
    int stored = dctSigned5((currentWord >> 23u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 22];
    int stored = dctSigned5((currentWord >> 18u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 23];
    int stored = dctSigned5((currentWord >> 13u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 24];
    int stored = dctSigned5((currentWord >> 8u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 25];
    int stored = dctSigned5((currentWord >> 3u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 26];
    int stored = dctSigned5(((currentWord << 2u) | (nextWord >> 30u)) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 24);
  {
    int position = DCT_SCAN_Y[profile * 199 + 27];
    int stored = dctSigned5((currentWord >> 25u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 28];
    int stored = dctSigned5((currentWord >> 20u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 29];
    int stored = dctSigned5((currentWord >> 15u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 30];
    int stored = dctSigned5((currentWord >> 10u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 31];
    int stored = dctSigned5((currentWord >> 5u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 32];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 28);
  {
    int position = DCT_SCAN_Y[profile * 199 + 33];
    int stored = dctSigned5((currentWord >> 27u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 34];
    int stored = dctSigned5((currentWord >> 22u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 35];
    int stored = dctSigned5((currentWord >> 17u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 36];
    int stored = dctSigned5((currentWord >> 12u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 37];
    int stored = dctSigned5((currentWord >> 7u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 38];
    int stored = dctSigned5((currentWord >> 2u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 39];
    int stored = dctSigned5(((currentWord << 3u) | (nextWord >> 29u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 32);
  {
    int position = DCT_SCAN_Y[profile * 199 + 40];
    int stored = dctSigned5((currentWord >> 24u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 41];
    int stored = dctSigned5((currentWord >> 19u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 42];
    int stored = dctSigned5((currentWord >> 14u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 43];
    int stored = dctSigned5((currentWord >> 9u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 44];
    int stored = dctSigned5((currentWord >> 4u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 45];
    int stored = dctSigned5(((currentWord << 1u) | (nextWord >> 31u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 36);
  {
    int position = DCT_SCAN_Y[profile * 199 + 46];
    int stored = dctSigned5((currentWord >> 26u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 47];
    int stored = dctSigned5((currentWord >> 21u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 48];
    int stored = dctSigned5((currentWord >> 16u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 49];
    int stored = dctSigned5((currentWord >> 11u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 50];
    int stored = dctSigned5((currentWord >> 6u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 51];
    int stored = dctSigned5((currentWord >> 1u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 52];
    int stored = dctSigned5(((currentWord << 4u) | (nextWord >> 28u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 40);
  {
    int position = DCT_SCAN_Y[profile * 199 + 53];
    int stored = dctSigned5((currentWord >> 23u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 54];
    int stored = dctSigned5((currentWord >> 18u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 55];
    int stored = dctSigned5((currentWord >> 13u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 56];
    int stored = dctSigned5((currentWord >> 8u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 57];
    int stored = dctSigned5((currentWord >> 3u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 58];
    int stored = dctSigned5(((currentWord << 2u) | (nextWord >> 30u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 44);
  {
    int position = DCT_SCAN_Y[profile * 199 + 59];
    int stored = dctSigned5((currentWord >> 25u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 60];
    int stored = dctSigned5((currentWord >> 20u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 61];
    int stored = dctSigned5((currentWord >> 15u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 62];
    int stored = dctSigned5((currentWord >> 10u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 63];
    int stored = dctSigned5((currentWord >> 5u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 64];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 48);
  {
    int position = DCT_SCAN_Y[profile * 199 + 65];
    int stored = dctSigned5((currentWord >> 27u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 66];
    int stored = dctSigned5((currentWord >> 22u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 67];
    int stored = dctSigned5((currentWord >> 17u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 68];
    int stored = dctSigned5((currentWord >> 12u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 69];
    int stored = dctSigned5((currentWord >> 7u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 70];
    int stored = dctSigned5((currentWord >> 2u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 71];
    int stored = dctSigned5(((currentWord << 3u) | (nextWord >> 29u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 52);
  {
    int position = DCT_SCAN_Y[profile * 199 + 72];
    int stored = dctSigned5((currentWord >> 24u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 73];
    int stored = dctSigned5((currentWord >> 19u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 74];
    int stored = dctSigned5((currentWord >> 14u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 75];
    int stored = dctSigned5((currentWord >> 9u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 76];
    int stored = dctSigned5((currentWord >> 4u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 77];
    int stored = dctSigned5(((currentWord << 1u) | (nextWord >> 31u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 56);
  {
    int position = DCT_SCAN_Y[profile * 199 + 78];
    int stored = dctSigned5((currentWord >> 26u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 79];
    int stored = dctSigned5((currentWord >> 21u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 80];
    int stored = dctSigned5((currentWord >> 16u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 81];
    int stored = dctSigned5((currentWord >> 11u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 82];
    int stored = dctSigned5((currentWord >> 6u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 83];
    int stored = dctSigned5((currentWord >> 1u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 84];
    int stored = dctSigned5(((currentWord << 4u) | (nextWord >> 28u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 60);
  {
    int position = DCT_SCAN_Y[profile * 199 + 85];
    int stored = dctSigned5((currentWord >> 23u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 86];
    int stored = dctSigned5((currentWord >> 18u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 87];
    int stored = dctSigned5((currentWord >> 13u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 88];
    int stored = dctSigned5((currentWord >> 8u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 89];
    int stored = dctSigned5((currentWord >> 3u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 90];
    int stored = dctSigned5(((currentWord << 2u) | (nextWord >> 30u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 64);
  {
    int position = DCT_SCAN_Y[profile * 199 + 91];
    int stored = dctSigned5((currentWord >> 25u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 92];
    int stored = dctSigned5((currentWord >> 20u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 93];
    int stored = dctSigned5((currentWord >> 15u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 94];
    int stored = dctSigned5((currentWord >> 10u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 95];
    int stored = dctSigned5((currentWord >> 5u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 96];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 68);
  {
    int position = DCT_SCAN_Y[profile * 199 + 97];
    int stored = dctSigned5((currentWord >> 27u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 98];
    int stored = dctSigned5((currentWord >> 22u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 99];
    int stored = dctSigned5((currentWord >> 17u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 100];
    int stored = dctSigned5((currentWord >> 12u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 101];
    int stored = dctSigned5((currentWord >> 7u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 102];
    int stored = dctSigned5((currentWord >> 2u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 103];
    int stored = dctSigned5(((currentWord << 3u) | (nextWord >> 29u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 72);
  {
    int position = DCT_SCAN_Y[profile * 199 + 104];
    int stored = dctSigned5((currentWord >> 24u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 105];
    int stored = dctSigned5((currentWord >> 19u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 106];
    int stored = dctSigned5((currentWord >> 14u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 107];
    int stored = dctSigned5((currentWord >> 9u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 108];
    int stored = dctSigned5((currentWord >> 4u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 109];
    int stored = dctSigned5(((currentWord << 1u) | (nextWord >> 31u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 76);
  {
    int position = DCT_SCAN_Y[profile * 199 + 110];
    int stored = dctSigned5((currentWord >> 26u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 111];
    int stored = dctSigned5((currentWord >> 21u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 112];
    int stored = dctSigned5((currentWord >> 16u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 113];
    int stored = dctSigned5((currentWord >> 11u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 114];
    int stored = dctSigned5((currentWord >> 6u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 115];
    int stored = dctSigned5((currentWord >> 1u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 116];
    int stored = dctSigned5(((currentWord << 4u) | (nextWord >> 28u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 80);
  {
    int position = DCT_SCAN_Y[profile * 199 + 117];
    int stored = dctSigned5((currentWord >> 23u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 118];
    int stored = dctSigned5((currentWord >> 18u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 119];
    int stored = dctSigned5((currentWord >> 13u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 120];
    int stored = dctSigned5((currentWord >> 8u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 121];
    int stored = dctSigned5((currentWord >> 3u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 122];
    int stored = dctSigned5(((currentWord << 2u) | (nextWord >> 30u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 84);
  {
    int position = DCT_SCAN_Y[profile * 199 + 123];
    int stored = dctSigned5((currentWord >> 25u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 124];
    int stored = dctSigned5((currentWord >> 20u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 125];
    int stored = dctSigned5((currentWord >> 15u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 126];
    int stored = dctSigned5((currentWord >> 10u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 127];
    int stored = dctSigned5((currentWord >> 5u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 128];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 88);
  {
    int position = DCT_SCAN_Y[profile * 199 + 129];
    int stored = dctSigned5((currentWord >> 27u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 130];
    int stored = dctSigned5((currentWord >> 22u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 131];
    int stored = dctSigned5((currentWord >> 17u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 132];
    int stored = dctSigned5((currentWord >> 12u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 133];
    int stored = dctSigned5((currentWord >> 7u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 134];
    int stored = dctSigned5((currentWord >> 2u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 135];
    int stored = dctSigned5(((currentWord << 3u) | (nextWord >> 29u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 92);
  {
    int position = DCT_SCAN_Y[profile * 199 + 136];
    int stored = dctSigned5((currentWord >> 24u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 137];
    int stored = dctSigned5((currentWord >> 19u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 138];
    int stored = dctSigned5((currentWord >> 14u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 139];
    int stored = dctSigned5((currentWord >> 9u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 140];
    int stored = dctSigned5((currentWord >> 4u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 141];
    int stored = dctSigned5(((currentWord << 1u) | (nextWord >> 31u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 96);
  {
    int position = DCT_SCAN_Y[profile * 199 + 142];
    int stored = dctSigned5((currentWord >> 26u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 143];
    int stored = dctSigned5((currentWord >> 21u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 144];
    int stored = dctSigned5((currentWord >> 16u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 145];
    int stored = dctSigned5((currentWord >> 11u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 146];
    int stored = dctSigned5((currentWord >> 6u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 147];
    int stored = dctSigned5((currentWord >> 1u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 148];
    int stored = dctSigned5(((currentWord << 4u) | (nextWord >> 28u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 100);
  {
    int position = DCT_SCAN_Y[profile * 199 + 149];
    int stored = dctSigned5((currentWord >> 23u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 150];
    int stored = dctSigned5((currentWord >> 18u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 151];
    int stored = dctSigned5((currentWord >> 13u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 152];
    int stored = dctSigned5((currentWord >> 8u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 153];
    int stored = dctSigned5((currentWord >> 3u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 154];
    int stored = dctSigned5(((currentWord << 2u) | (nextWord >> 30u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 104);
  {
    int position = DCT_SCAN_Y[profile * 199 + 155];
    int stored = dctSigned5((currentWord >> 25u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 156];
    int stored = dctSigned5((currentWord >> 20u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 157];
    int stored = dctSigned5((currentWord >> 15u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 158];
    int stored = dctSigned5((currentWord >> 10u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 159];
    int stored = dctSigned5((currentWord >> 5u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 160];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 108);
  {
    int position = DCT_SCAN_Y[profile * 199 + 161];
    int stored = dctSigned5((currentWord >> 27u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 162];
    int stored = dctSigned5((currentWord >> 22u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 163];
    int stored = dctSigned5((currentWord >> 17u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 164];
    int stored = dctSigned5((currentWord >> 12u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 165];
    int stored = dctSigned5((currentWord >> 7u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 166];
    int stored = dctSigned5((currentWord >> 2u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 167];
    int stored = dctSigned5(((currentWord << 3u) | (nextWord >> 29u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 112);
  {
    int position = DCT_SCAN_Y[profile * 199 + 168];
    int stored = dctSigned5((currentWord >> 24u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 169];
    int stored = dctSigned5((currentWord >> 19u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 170];
    int stored = dctSigned5((currentWord >> 14u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 171];
    int stored = dctSigned5((currentWord >> 9u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 172];
    int stored = dctSigned5((currentWord >> 4u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 173];
    int stored = dctSigned5(((currentWord << 1u) | (nextWord >> 31u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 116);
  {
    int position = DCT_SCAN_Y[profile * 199 + 174];
    int stored = dctSigned5((currentWord >> 26u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 175];
    int stored = dctSigned5((currentWord >> 21u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 176];
    int stored = dctSigned5((currentWord >> 16u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 177];
    int stored = dctSigned5((currentWord >> 11u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 178];
    int stored = dctSigned5((currentWord >> 6u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 179];
    int stored = dctSigned5((currentWord >> 1u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 180];
    int stored = dctSigned5(((currentWord << 4u) | (nextWord >> 28u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 120);
  {
    int position = DCT_SCAN_Y[profile * 199 + 181];
    int stored = dctSigned5((currentWord >> 23u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 182];
    int stored = dctSigned5((currentWord >> 18u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 183];
    int stored = dctSigned5((currentWord >> 13u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 184];
    int stored = dctSigned5((currentWord >> 8u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 185];
    int stored = dctSigned5((currentWord >> 3u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 186];
    int stored = dctSigned5(((currentWord << 2u) | (nextWord >> 30u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 124);
  {
    int position = DCT_SCAN_Y[profile * 199 + 187];
    int stored = dctSigned5((currentWord >> 25u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 188];
    int stored = dctSigned5((currentWord >> 20u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 189];
    int stored = dctSigned5((currentWord >> 15u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 190];
    int stored = dctSigned5((currentWord >> 10u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 191];
    int stored = dctSigned5((currentWord >> 5u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 192];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  {
    int position = DCT_SCAN_Y[profile * 199 + 193];
    int stored = dctSigned5((currentWord >> 27u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 194];
    int stored = dctSigned5((currentWord >> 22u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 195];
    int stored = dctSigned5((currentWord >> 17u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 196];
    int stored = dctSigned5((currentWord >> 12u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 197];
    int stored = dctSigned5((currentWord >> 7u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[profile * 199 + 198];
    int stored = dctSigned5((currentWord >> 2u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }

  return sum + 128.0;
}

float sampleDctChromaRecord(int recordOffset, int localX, int localY) {
  uint headerWord = dctWordAt(recordOffset);
  int profile = int(headerWord >> 28u);
  int dcScaleIndex = int((headerWord >> 24u) & 15u);
  int dc = dctSigned10((headerWord >> 14u) & 1023u);
  float scale0 = exp2(float((headerWord >> 11u) & 7u));
  float scale1 = exp2(float((headerWord >> 8u) & 7u));
  float scale2 = exp2(float((headerWord >> 5u) & 7u));
  float sum = 0.0;
  float correction = 0.0;

  addDctCompensated(
    float(dc) * exp2(float(dcScaleIndex)) * dctQuantizationStep(0, true) *
      dctBasis(0, localX, 8) * dctBasis(0, localY, 16),
    sum,
    correction
  );

  uint currentWord = headerWord;
  uint nextWord = dctWordAt(recordOffset + 4);
  {
    int position = DCT_SCAN_C[profile * 45 + 0];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 8);
  {
    int position = DCT_SCAN_C[profile * 45 + 1];
    int stored = dctSigned5((currentWord >> 27u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 2];
    int stored = dctSigned5((currentWord >> 22u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 3];
    int stored = dctSigned5((currentWord >> 17u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 4];
    int stored = dctSigned5((currentWord >> 12u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 5];
    int stored = dctSigned5((currentWord >> 7u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 6];
    int stored = dctSigned5((currentWord >> 2u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 7];
    int stored = dctSigned5(((currentWord << 3u) | (nextWord >> 29u)) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 12);
  {
    int position = DCT_SCAN_C[profile * 45 + 8];
    int stored = dctSigned5((currentWord >> 24u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 9];
    int stored = dctSigned5((currentWord >> 19u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 10];
    int stored = dctSigned5((currentWord >> 14u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 11];
    int stored = dctSigned5((currentWord >> 9u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 12];
    int stored = dctSigned5((currentWord >> 4u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 13];
    int stored = dctSigned5(((currentWord << 1u) | (nextWord >> 31u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 16);
  {
    int position = DCT_SCAN_C[profile * 45 + 14];
    int stored = dctSigned5((currentWord >> 26u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 15];
    int stored = dctSigned5((currentWord >> 21u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 16];
    int stored = dctSigned5((currentWord >> 16u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 17];
    int stored = dctSigned5((currentWord >> 11u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 18];
    int stored = dctSigned5((currentWord >> 6u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 19];
    int stored = dctSigned5((currentWord >> 1u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 20];
    int stored = dctSigned5(((currentWord << 4u) | (nextWord >> 28u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 20);
  {
    int position = DCT_SCAN_C[profile * 45 + 21];
    int stored = dctSigned5((currentWord >> 23u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 22];
    int stored = dctSigned5((currentWord >> 18u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 23];
    int stored = dctSigned5((currentWord >> 13u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 24];
    int stored = dctSigned5((currentWord >> 8u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 25];
    int stored = dctSigned5((currentWord >> 3u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 26];
    int stored = dctSigned5(((currentWord << 2u) | (nextWord >> 30u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 24);
  {
    int position = DCT_SCAN_C[profile * 45 + 27];
    int stored = dctSigned5((currentWord >> 25u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 28];
    int stored = dctSigned5((currentWord >> 20u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 29];
    int stored = dctSigned5((currentWord >> 15u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 30];
    int stored = dctSigned5((currentWord >> 10u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 31];
    int stored = dctSigned5((currentWord >> 5u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 32];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 28);
  {
    int position = DCT_SCAN_C[profile * 45 + 33];
    int stored = dctSigned5((currentWord >> 27u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 34];
    int stored = dctSigned5((currentWord >> 22u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 35];
    int stored = dctSigned5((currentWord >> 17u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 36];
    int stored = dctSigned5((currentWord >> 12u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 37];
    int stored = dctSigned5((currentWord >> 7u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 38];
    int stored = dctSigned5((currentWord >> 2u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 39];
    int stored = dctSigned5(((currentWord << 3u) | (nextWord >> 29u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  {
    int position = DCT_SCAN_C[profile * 45 + 40];
    int stored = dctSigned5((currentWord >> 24u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 41];
    int stored = dctSigned5((currentWord >> 19u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 42];
    int stored = dctSigned5((currentWord >> 14u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 43];
    int stored = dctSigned5((currentWord >> 9u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 45 + 44];
    int stored = dctSigned5((currentWord >> 4u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }

  return sum + 128.0;
}
// </dctbs2-profile-decoder>

vec3 dctYCbCrToRgb(float y, float cb, float cr) {
  cb -= 128.0;
  cr -= 128.0;
  return clamp(vec3(
    y + 1.402 * cr,
    y - 0.344136 * cb - 0.714136 * cr,
    y + 1.772 * cb
  ) / 255.0, 0.0, 1.0);
}

vec3 fetchDirectDctColor(ivec2 pixelCoord) {
  ivec2 pixel = clamp(pixelCoord, ivec2(0), uDctImageSize - 1);
  int mcuIndex = (pixel.y >> 4) * uDctMcuColumns + (pixel.x >> 4);
  int mcuOffset = DCT_HEADER_BYTES + mcuIndex * DCT_MCU_BYTES;
  ivec2 local = pixel & 15;
  float y = sampleDctLumaRecord(mcuOffset, local.x, local.y);
  float cb = sampleDctChromaRecord(
    mcuOffset + DCT_Y_BYTES,
    local.x >> 1,
    local.y
  );
  float cr = sampleDctChromaRecord(
    mcuOffset + DCT_Y_BYTES + DCT_CB_BYTES,
    local.x >> 1,
    local.y
  );
  return dctYCbCrToRgb(y, cb, cr);
}

vec3 fetchCachedDctColor(ivec2 pixelCoord) {
  ivec2 pixel = clamp(pixelCoord, ivec2(0), uDctImageSize - 1);
  int mcuIndex = (pixel.y >> 4) * uDctMcuColumns + (pixel.x >> 4);
  ivec2 mcuOrigin = ivec2(
    (mcuIndex % uDctCacheMcusPerRow) * DCT_CACHE_MCU_TEXELS,
    mcuIndex / uDctCacheMcusPerRow
  );
  ivec2 local = pixel & 15;
  int chromaIndex = local.y * 8 + (local.x >> 1);
  float y = float(dctCachedByte(mcuOrigin, local.y * 16 + local.x));
  float cb = float(dctCachedByte(mcuOrigin, DCT_CACHE_CB_OFFSET + chromaIndex));
  float cr = float(dctCachedByte(mcuOrigin, DCT_CACHE_CR_OFFSET + chromaIndex));

  return dctYCbCrToRgb(y, cb, cr);
}

vec3 fetchDctColor(ivec2 pixelCoord) {
  return uDctDecodeMode == DCT_DECODE_MODE_FAST
    ? fetchCachedDctColor(pixelCoord)
    : fetchDirectDctColor(pixelCoord);
}

vec3 sampleDctTexture(vec2 uv) {
  vec2 clampedUv = clamp(vec2(uv.x, 1.0 - uv.y), vec2(0.0), vec2(0.99999994));
  return fetchDctColor(ivec2(floor(clampedUv * vec2(uDctImageSize))));
}

uint fetchAtlasWord(highp usampler2D atlas, uvec2 atlasSize, uint wordIndex) {
  uvec2 coord = uvec2(wordIndex % atlasSize.x, wordIndex / atlasSize.x);
  return texelFetch(atlas, ivec2(coord), 0).r;
}

uint fetchPackedValue(
  highp usampler2D atlas,
  uvec2 atlasSize,
  uint valueIndex,
  uint bitsPerValue
) {
  uint bitOffset = valueIndex * bitsPerValue;
  uint wordIndex = bitOffset >> 5u;
  uint wordBit = bitOffset & 31u;
  uint value = fetchAtlasWord(atlas, atlasSize, wordIndex) >> wordBit;

  if (wordBit + bitsPerValue > 32u) {
    value |= fetchAtlasWord(atlas, atlasSize, wordIndex + 1u) << (32u - wordBit);
  }

  return value & ((1u << bitsPerValue) - 1u);
}

vec3 decodePaletteColor(uint packedColor) {
  if (uBpalPaletteColorBits == 16u) {
    return vec3(
      float((packedColor >> 11u) & 31u) / 31.0,
      float((packedColor >> 5u) & 63u) / 63.0,
      float(packedColor & 31u) / 31.0
    );
  }

  return vec3(
    float(packedColor & 255u),
    float((packedColor >> 8u) & 255u),
    float((packedColor >> 16u) & 255u)
  ) / 255.0;
}

vec3 fetchBpalColor(ivec2 pixelCoord) {
  ivec2 pixel = clamp(pixelCoord, ivec2(0), ivec2(uBpalImageSize) - 1);
  uint pixelIndex = uint(pixel.y) * uBpalImageSize.x + uint(pixel.x);
  uint localIndex = fetchPackedValue(
    uBpalPixelIndices,
    uBpalPixelAtlasSize,
    pixelIndex,
    uBpalLocalIndexBits
  );
  uvec2 block = uvec2(pixel) / uBpalBlockSize;
  uint blockIndex = block.y * uBpalBlocksX + block.x;
  uint blockPaletteIndex = blockIndex * uBpalLocalColorCount + localIndex;
  uint globalIndex = fetchPackedValue(
    uBpalBlockPalettes,
    uBpalBlockPaletteAtlasSize,
    blockPaletteIndex,
    uBpalGlobalIndexBits
  );
  uint paletteIndex = 0u;

  if (uBpalPaletteIndexBits > 0u) {
    paletteIndex = fetchPackedValue(
      uBpalPaletteSelectors,
      uBpalPaletteSelectorAtlasSize,
      blockIndex,
      uBpalPaletteIndexBits
    );
  }

  globalIndex += paletteIndex * uBpalGlobalColorCount;
  uint packedColor = fetchPackedValue(
    uBpalGlobalPalette,
    uBpalPaletteAtlasSize,
    globalIndex,
    uBpalPaletteColorBits
  );

  return decodePaletteColor(packedColor);
}

vec3 sampleBpalTexture(vec2 uv) {
  vec2 sourceCoord = vec2(uv.x, 1.0 - uv.y) * vec2(uBpalImageSize) - 0.5;
  ivec2 topLeft = ivec2(floor(sourceCoord));
  vec2 blend = fract(sourceCoord);
  vec3 top = mix(
    fetchBpalColor(topLeft),
    fetchBpalColor(topLeft + ivec2(1, 0)),
    blend.x
  );
  vec3 bottom = mix(
    fetchBpalColor(topLeft + ivec2(0, 1)),
    fetchBpalColor(topLeft + ivec2(1, 1)),
    blend.x
  );

  return mix(top, bottom, blend.y);
}

vec2 bpdhAtlasTexCoord(float texelIndex) {
  float x = mod(texelIndex, uBpdhDataAtlasSize.x);
  float y = floor(texelIndex / uBpdhDataAtlasSize.x);

  return (vec2(x, y) + 0.5) / uBpdhDataAtlasSize;
}

float fetchBpdhByte(float byteIndex) {
  float texelIndex = floor(byteIndex / 4.0);
  float channel = mod(byteIndex, 4.0);
  vec4 value = texture(uBpdhData, bpdhAtlasTexCoord(texelIndex));

  if (channel < 0.5) {
    return floor(value.r * 255.0 + 0.5);
  }
  if (channel < 1.5) {
    return floor(value.g * 255.0 + 0.5);
  }
  if (channel < 2.5) {
    return floor(value.b * 255.0 + 0.5);
  }
  return floor(value.a * 255.0 + 0.5);
}

float fetchBpdhUint16(float byteOffset) {
  return fetchBpdhByte(byteOffset) + fetchBpdhByte(byteOffset + 1.0) * 256.0;
}

float fetchBpdhUint24(float byteOffset) {
  return fetchBpdhUint16(byteOffset) + fetchBpdhByte(byteOffset + 2.0) * 65536.0;
}

float bpdhRoundDivide(float value, float divisor) {
  return value >= 0.0
    ? floor((value + divisor * 0.5) / divisor)
    : -floor((-value + divisor * 0.5) / divisor);
}

float fetchBpdhDctSample(float recordBase, float component, float x, float y) {
  return fetchBpdhByte(recordBase + component * 64.0 + y * 8.0 + x);
}

float sampleBpdhChroma(float recordBase, float component, vec2 localPixel) {
  vec2 halfPixel = floor(localPixel * 0.5);
  bool evenX = mod(localPixel.x, 2.0) < 0.5;
  bool evenY = mod(localPixel.y, 2.0) < 0.5;
  float floorX = evenX ? halfPixel.x - 1.0 : halfPixel.x;
  float floorY = evenY ? halfPixel.y - 1.0 : halfPixel.y;
  float x0 = clamp(floorX, 0.0, 7.0);
  float y0 = clamp(floorY, 0.0, 7.0);
  float x1 = clamp(floorX + 1.0, 0.0, 7.0);
  float y1 = clamp(floorY + 1.0, 0.0, 7.0);
  float fractionX = evenX ? 3.0 : 1.0;
  float fractionY = evenY ? 3.0 : 1.0;
  float top = (4.0 - fractionX) * fetchBpdhDctSample(recordBase, component, x0, y0) +
    fractionX * fetchBpdhDctSample(recordBase, component, x1, y0);
  float bottom = (4.0 - fractionX) * fetchBpdhDctSample(recordBase, component, x0, y1) +
    fractionX * fetchBpdhDctSample(recordBase, component, x1, y1);

  return bpdhRoundDivide((4.0 - fractionY) * top + fractionY * bottom, 16.0);
}

vec3 fetchBpdhColor(vec2 pixelCoord) {
  vec2 pixel = clamp(floor(pixelCoord), vec2(0.0), uBpdhImageSize - 1.0);
  vec2 localPixel = mod(pixel, 16.0);
  vec2 block = floor(pixel / 16.0);
  float blockIndex = block.y * uBpdhBlocksX + block.x;
  float mapOffset = uBpdhBlockMapOffset + blockIndex * 4.0;
  float mode = fetchBpdhByte(mapOffset);
  float recordIndex = fetchBpdhUint24(mapOffset + 1.0);

  if (mode < 0.5) {
    float recordBase = uBpdhBpalRecordsOffset + recordIndex * uBpdhBpalRecordStride;
    float paletteSelector = fetchBpdhByte(recordBase);
    float pixelOffset = recordBase + 1.0 + uBpdhLocalColorCount * 2.0;
    float localIndex = fetchBpdhByte(pixelOffset + localPixel.y * 16.0 + localPixel.x);
    float globalIndex = fetchBpdhUint16(recordBase + 1.0 + localIndex * 2.0);
    float colorOffset = (paletteSelector * uBpdhGlobalColorCount + globalIndex) * 3.0;

    return vec3(
      fetchBpdhByte(colorOffset),
      fetchBpdhByte(colorOffset + 1.0),
      fetchBpdhByte(colorOffset + 2.0)
    ) / 255.0;
  }

  float recordBase = uBpdhDctRecordsOffset + recordIndex * uBpdhDctRecordStride;
  float lumaComponent = floor(localPixel.y / 8.0) * 2.0 + floor(localPixel.x / 8.0);
  float luma = fetchBpdhDctSample(
    recordBase,
    lumaComponent,
    mod(localPixel.x, 8.0),
    mod(localPixel.y, 8.0)
  );
  float chromaBlue = sampleBpdhChroma(recordBase, 4.0, localPixel) - 128.0;
  float chromaRed = sampleBpdhChroma(recordBase, 5.0, localPixel) - 128.0;
  vec3 color = vec3(
    luma + bpdhRoundDivide(91881.0 * chromaRed, 65536.0),
    luma + bpdhRoundDivide(-22554.0 * chromaBlue - 46802.0 * chromaRed, 65536.0),
    luma + bpdhRoundDivide(116130.0 * chromaBlue, 65536.0)
  );

  return clamp(color, 0.0, 255.0) / 255.0;
}

vec3 sampleBpdhTexture(vec2 uv) {
  vec2 sourceCoord = floor(vec2(uv.x, 1.0 - uv.y) * uBpdhImageSize);

  return fetchBpdhColor(sourceCoord);
}

vec3 applyHeightNormal(vec2 uv, vec3 normal, vec3 tangent, vec3 bitangent) {
  float heightCenter = texture(uHeightTexture, uv).r;
  float heightRight = texture(uHeightTexture, uv + vec2(uHeightTexelSize.x, 0.0)).r;
  float heightUp = texture(uHeightTexture, uv + vec2(0.0, uHeightTexelSize.y)).r;
  vec2 slope = vec2(heightRight - heightCenter, heightUp - heightCenter) * uHeightStrength * 9.0;
  vec3 tangentSpaceNormal = normalize(vec3(-slope.x, -slope.y, 1.0));

  return normalize(mat3(tangent, bitangent, normal) * tangentSpaceNormal);
}

void main() {
  vec3 normal = normalize(vNormal);
  vec3 tangent = normalize(vTangent - normal * dot(vTangent, normal));
  vec3 bitangent = normalize(vBitangent - normal * dot(vBitangent, normal));
  vec3 lightDirection = normalize(uLightPosition - vWorldPosition);
  vec3 viewDirection = normalize(uViewPosition - vWorldPosition);
  vec2 viewOffset = vec2(dot(viewDirection, tangent), dot(viewDirection, bitangent));
  float height = texture(uHeightTexture, vTexCoord).r;
  vec2 reliefTexCoord = vTexCoord - viewOffset * (height - 0.5) * uHeightStrength * 0.055;

  normal = applyHeightNormal(reliefTexCoord, normal, tangent, bitangent);
  float diffuse = max(dot(normal, lightDirection), 0.0);
  vec3 halfVector = normalize(lightDirection + viewDirection);
  float specularMask = texture(uSpecularTexture, reliefTexCoord).r;
  float specular = pow(max(dot(normal, halfVector), 0.0), max(uShininess, 1.0)) *
    uSpecularStrength * specularMask;
  vec3 stoneColor;

  if (uUseDctTexture > 0.5) {
    stoneColor = sampleDctTexture(reliefTexCoord);
  } else if (uUseBpdhTexture > 0.5) {
    stoneColor = sampleBpdhTexture(reliefTexCoord);
  } else if (uUseBpalTexture > 0.5) {
    stoneColor = sampleBpalTexture(reliefTexCoord);
  } else {
    stoneColor = texture(uStoneTexture, reliefTexCoord).rgb;
  }
  vec3 color = stoneColor * (uAmbientColor + diffuse * uLightColor) + specular * uLightColor;

  fragmentColor = vec4(color, 1.0);
}
