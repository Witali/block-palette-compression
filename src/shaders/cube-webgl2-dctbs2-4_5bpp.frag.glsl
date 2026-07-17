#version 300 es
/*
 * Generated WebGL2 compact cube fragment stage for DCTBS2 4.5 bpp.
 * Pixel indices, block-palette indices, and palette colors stay bit-packed in
 * R32UI textures and are decoded with exact integer fetches.
 */
precision highp float;
precision highp int;

in vec3 vNormal;
in vec3 vWorldPosition;
in vec2 vTexCoord;

uniform sampler2D uStoneTexture;
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
uniform highp int uDctCacheRecordTexels;
uniform highp int uDctCacheCbOffset;
uniform highp int uDctCacheCrOffset;
uniform bool uDctChroma420;
uniform vec3 uLightPosition;
uniform vec3 uLightColor;
uniform vec3 uAmbientColor;
uniform vec3 uViewPosition;
uniform float uSpecularStrength;
uniform float uShininess;

out vec4 fragmentColor;

const float DCT_PI = 3.1415926535897932384626433832795;
const int DCT_HEADER_BYTES = 64;
const int DCT_MCU_BYTES = 144;
const int DCT_Y_BYTES = 96;
const int DCT_CB_BYTES = 24;
const int DCT_Y_AC_COUNT = 148;
const int DCT_C_AC_COUNT = 33;
const int DCT_DECODE_MODE_FAST = 1;

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

// Zigzag plus four legacy significance scans trimmed for 4.5 bpp records.
const int DCT_SCAN_Y[740] = int[740](
  1, 16, 32, 17, 2, 3, 18, 33, 48, 64, 49, 34, 19, 4, 5, 20, 35,
  50, 65, 80, 96, 81, 66, 51, 36, 21, 6, 7, 22, 37, 52, 67, 82, 97,
  112, 128, 113, 98, 83, 68, 53, 38, 23, 8, 9, 24, 39, 54, 69, 84, 99,
  114, 129, 144, 160, 145, 130, 115, 100, 85, 70, 55, 40, 25, 10, 11, 26, 41,
  56, 71, 86, 101, 116, 131, 146, 161, 176, 192, 177, 162, 147, 132, 117, 102, 87,
  72, 57, 42, 27, 12, 13, 28, 43, 58, 73, 88, 103, 118, 133, 148, 163, 178,
  193, 208, 224, 209, 194, 179, 164, 149, 134, 119, 104, 89, 74, 59, 44, 29, 14,
  15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225, 240, 241,
  226, 211, 196, 181, 166, 151, 136, 121, 106, 91, 76, 61, 16, 1, 2, 17, 32,
  48, 33, 18, 3, 4, 19, 34, 49, 64, 80, 65, 50, 35, 20, 5, 6, 21,
  36, 51, 66, 81, 96, 112, 97, 82, 67, 52, 37, 22, 7, 8, 23, 38, 53,
  68, 83, 98, 113, 128, 144, 129, 114, 99, 84, 69, 54, 39, 24, 9, 10, 25,
  40, 55, 70, 85, 100, 115, 130, 145, 160, 176, 161, 146, 131, 116, 101, 86, 71,
  56, 41, 26, 11, 12, 27, 42, 57, 72, 87, 102, 117, 132, 147, 162, 177, 192,
  208, 193, 178, 163, 148, 133, 118, 103, 88, 73, 58, 43, 28, 13, 14, 29, 44,
  59, 74, 89, 104, 119, 134, 149, 164, 179, 194, 209, 224, 240, 225, 210, 195, 180,
  165, 150, 135, 120, 105, 90, 75, 60, 45, 30, 15, 31, 46, 61, 76, 91, 106,
  121, 136, 151, 166, 181, 196, 211, 1, 2, 16, 3, 17, 4, 18, 32, 5, 19,
  33, 6, 20, 34, 7, 48, 21, 35, 8, 49, 22, 36, 9, 50, 23, 64, 37,
  10, 51, 24, 65, 38, 11, 52, 25, 66, 39, 80, 12, 53, 26, 67, 40, 81,
  13, 54, 27, 68, 41, 82, 14, 55, 96, 28, 69, 42, 83, 15, 56, 97, 29,
  70, 43, 84, 57, 98, 30, 71, 112, 44, 85, 58, 99, 31, 72, 113, 45, 86,
  59, 100, 73, 114, 46, 87, 128, 60, 101, 74, 115, 47, 88, 129, 61, 102, 75,
  116, 89, 130, 62, 103, 144, 76, 117, 90, 131, 63, 104, 145, 77, 118, 91, 132,
  105, 146, 78, 119, 160, 92, 133, 106, 147, 79, 120, 161, 93, 134, 107, 148, 121,
  162, 94, 135, 176, 108, 149, 122, 163, 95, 136, 177, 109, 150, 123, 164, 137, 178,
  110, 151, 16, 32, 1, 48, 17, 64, 33, 2, 80, 49, 18, 96, 65, 34, 112,
  3, 81, 50, 128, 19, 97, 66, 144, 35, 113, 4, 82, 160, 51, 129, 20, 98,
  176, 67, 145, 36, 114, 5, 192, 83, 161, 52, 130, 21, 208, 99, 177, 68, 146,
  37, 224, 115, 6, 193, 84, 162, 53, 240, 131, 22, 209, 100, 178, 69, 147, 38,
  225, 116, 7, 194, 85, 163, 54, 241, 132, 23, 210, 101, 179, 70, 148, 39, 226,
  117, 8, 195, 86, 164, 55, 242, 133, 24, 211, 102, 180, 71, 149, 40, 227, 118,
  9, 196, 87, 165, 56, 243, 134, 25, 212, 103, 181, 72, 150, 41, 228, 119, 10,
  197, 88, 166, 57, 244, 135, 26, 213, 104, 182, 73, 151, 42, 229, 120, 11, 198,
  89, 167, 58, 245, 136, 27, 214, 105, 183, 74, 152, 43, 230, 121, 17, 1, 16,
  34, 18, 33, 2, 32, 51, 35, 50, 19, 49, 3, 48, 68, 52, 67, 36, 66,
  20, 65, 4, 64, 85, 69, 84, 53, 83, 37, 82, 21, 81, 5, 80, 102, 86,
  101, 70, 100, 54, 99, 38, 98, 22, 97, 6, 96, 119, 103, 118, 87, 117, 71,
  116, 55, 115, 39, 114, 23, 113, 7, 112, 136, 120, 135, 104, 134, 88, 133, 72,
  132, 56, 131, 40, 130, 24, 129, 8, 128, 153, 137, 152, 121, 151, 105, 150, 89,
  149, 73, 148, 57, 147, 41, 146, 25, 145, 9, 144, 170, 154, 169, 138, 168, 122,
  167, 106, 166, 90, 165, 74, 164, 58, 163, 42, 162, 26, 161, 10, 160, 187, 171,
  186, 155, 185, 139, 184, 123, 183, 107, 182, 91, 181, 75, 180, 59, 179, 43, 178,
  27, 177, 11, 176, 204, 188, 203, 172, 202
);

const int DCT_SCAN_C422[165] = int[165](
  1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19,
  26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 8,
  1, 2, 9, 16, 24, 17, 10, 3, 4, 11, 18, 25, 32, 40, 33, 26, 19,
  12, 5, 6, 13, 20, 27, 34, 41, 48, 56, 49, 42, 35, 28, 21, 1, 2,
  8, 3, 9, 4, 10, 16, 5, 11, 17, 6, 12, 18, 7, 24, 13, 19, 25,
  14, 20, 26, 15, 32, 21, 27, 33, 22, 28, 34, 23, 40, 29, 8, 16, 1,
  24, 9, 32, 17, 2, 40, 25, 10, 48, 33, 18, 56, 3, 41, 26, 64, 11,
  49, 34, 72, 19, 57, 4, 42, 80, 27, 65, 12, 50, 88, 9, 1, 8, 18,
  10, 17, 2, 16, 27, 19, 26, 11, 25, 3, 24, 36, 28, 35, 20, 34, 12,
  33, 4, 32, 45, 37, 44, 29, 43, 21, 42, 13, 41
);

const int DCT_SCAN_C420[165] = int[165](
  1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19,
  26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 8,
  1, 2, 9, 16, 24, 17, 10, 3, 4, 11, 18, 25, 32, 40, 33, 26, 19,
  12, 5, 6, 13, 20, 27, 34, 41, 48, 56, 49, 42, 35, 28, 21, 1, 2,
  8, 3, 9, 4, 10, 16, 5, 11, 17, 6, 12, 18, 7, 24, 13, 19, 25,
  14, 20, 26, 15, 32, 21, 27, 33, 22, 28, 34, 23, 40, 29, 8, 16, 1,
  24, 9, 32, 17, 2, 40, 25, 10, 48, 33, 18, 56, 3, 41, 26, 11, 49,
  34, 19, 57, 4, 42, 27, 12, 50, 35, 20, 58, 5, 43, 9, 1, 8, 18,
  10, 17, 2, 16, 27, 19, 26, 11, 25, 3, 24, 36, 28, 35, 20, 34, 12,
  33, 4, 32, 45, 37, 44, 29, 43, 21, 42, 13, 41
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

float dctQuantizationStep(int position, bool chroma, int height) {
  int width = chroma ? 8 : 16;
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
  int storedProfile = (dctByteAt(52) & 16u) != 0u ? profile : profile + 1;
  int dcScaleIndex = int((headerWord >> 24u) & 15u);
  int dc = dctSigned10((headerWord >> 14u) & 1023u);
  float scale0 = exp2(float((headerWord >> 11u) & 7u));
  float scale1 = exp2(float((headerWord >> 8u) & 7u));
  float scale2 = exp2(float((headerWord >> 5u) & 7u));
  float sum = 0.0;
  float correction = 0.0;

  addDctCompensated(
    float(dc) * exp2(float(dcScaleIndex)) * dctQuantizationStep(0, false, 16) *
      dctBasis(0, localX, 16) * dctBasis(0, localY, 16),
    sum,
    correction
  );

  uint currentWord = headerWord;
  uint nextWord = dctWordAt(recordOffset + 4);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 0];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 8);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 1];
    int stored = dctSigned5((currentWord >> 27u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 2];
    int stored = dctSigned5((currentWord >> 22u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 3];
    int stored = dctSigned5((currentWord >> 17u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 4];
    int stored = dctSigned5((currentWord >> 12u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 5];
    int stored = dctSigned5((currentWord >> 7u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 6];
    int stored = dctSigned5((currentWord >> 2u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 7];
    int stored = dctSigned5(((currentWord << 3u) | (nextWord >> 29u)) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 12);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 8];
    int stored = dctSigned5((currentWord >> 24u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 9];
    int stored = dctSigned5((currentWord >> 19u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 10];
    int stored = dctSigned5((currentWord >> 14u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 11];
    int stored = dctSigned5((currentWord >> 9u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 12];
    int stored = dctSigned5((currentWord >> 4u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 13];
    int stored = dctSigned5(((currentWord << 1u) | (nextWord >> 31u)) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 16);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 14];
    int stored = dctSigned5((currentWord >> 26u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 15];
    int stored = dctSigned5((currentWord >> 21u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 16];
    int stored = dctSigned5((currentWord >> 16u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 17];
    int stored = dctSigned5((currentWord >> 11u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 18];
    int stored = dctSigned5((currentWord >> 6u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 19];
    int stored = dctSigned5((currentWord >> 1u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 20];
    int stored = dctSigned5(((currentWord << 4u) | (nextWord >> 28u)) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 20);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 21];
    int stored = dctSigned5((currentWord >> 23u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 22];
    int stored = dctSigned5((currentWord >> 18u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 23];
    int stored = dctSigned5((currentWord >> 13u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 24];
    int stored = dctSigned5((currentWord >> 8u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 25];
    int stored = dctSigned5((currentWord >> 3u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 26];
    int stored = dctSigned5(((currentWord << 2u) | (nextWord >> 30u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 24);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 27];
    int stored = dctSigned5((currentWord >> 25u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 28];
    int stored = dctSigned5((currentWord >> 20u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 29];
    int stored = dctSigned5((currentWord >> 15u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 30];
    int stored = dctSigned5((currentWord >> 10u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 31];
    int stored = dctSigned5((currentWord >> 5u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 32];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 28);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 33];
    int stored = dctSigned5((currentWord >> 27u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 34];
    int stored = dctSigned5((currentWord >> 22u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 35];
    int stored = dctSigned5((currentWord >> 17u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 36];
    int stored = dctSigned5((currentWord >> 12u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 37];
    int stored = dctSigned5((currentWord >> 7u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 38];
    int stored = dctSigned5((currentWord >> 2u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 39];
    int stored = dctSigned5(((currentWord << 3u) | (nextWord >> 29u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 32);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 40];
    int stored = dctSigned5((currentWord >> 24u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 41];
    int stored = dctSigned5((currentWord >> 19u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 42];
    int stored = dctSigned5((currentWord >> 14u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 43];
    int stored = dctSigned5((currentWord >> 9u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 44];
    int stored = dctSigned5((currentWord >> 4u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 45];
    int stored = dctSigned5(((currentWord << 1u) | (nextWord >> 31u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 36);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 46];
    int stored = dctSigned5((currentWord >> 26u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 47];
    int stored = dctSigned5((currentWord >> 21u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 48];
    int stored = dctSigned5((currentWord >> 16u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 49];
    int stored = dctSigned5((currentWord >> 11u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 50];
    int stored = dctSigned5((currentWord >> 6u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 51];
    int stored = dctSigned5((currentWord >> 1u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 52];
    int stored = dctSigned5(((currentWord << 4u) | (nextWord >> 28u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 40);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 53];
    int stored = dctSigned5((currentWord >> 23u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 54];
    int stored = dctSigned5((currentWord >> 18u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 55];
    int stored = dctSigned5((currentWord >> 13u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 56];
    int stored = dctSigned5((currentWord >> 8u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 57];
    int stored = dctSigned5((currentWord >> 3u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 58];
    int stored = dctSigned5(((currentWord << 2u) | (nextWord >> 30u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 44);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 59];
    int stored = dctSigned5((currentWord >> 25u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 60];
    int stored = dctSigned5((currentWord >> 20u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 61];
    int stored = dctSigned5((currentWord >> 15u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 62];
    int stored = dctSigned5((currentWord >> 10u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 63];
    int stored = dctSigned5((currentWord >> 5u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 64];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 48);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 65];
    int stored = dctSigned5((currentWord >> 27u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 66];
    int stored = dctSigned5((currentWord >> 22u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 67];
    int stored = dctSigned5((currentWord >> 17u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 68];
    int stored = dctSigned5((currentWord >> 12u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 69];
    int stored = dctSigned5((currentWord >> 7u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 70];
    int stored = dctSigned5((currentWord >> 2u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 71];
    int stored = dctSigned5(((currentWord << 3u) | (nextWord >> 29u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 52);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 72];
    int stored = dctSigned5((currentWord >> 24u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 73];
    int stored = dctSigned5((currentWord >> 19u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 74];
    int stored = dctSigned5((currentWord >> 14u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 75];
    int stored = dctSigned5((currentWord >> 9u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 76];
    int stored = dctSigned5((currentWord >> 4u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 77];
    int stored = dctSigned5(((currentWord << 1u) | (nextWord >> 31u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 56);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 78];
    int stored = dctSigned5((currentWord >> 26u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 79];
    int stored = dctSigned5((currentWord >> 21u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 80];
    int stored = dctSigned5((currentWord >> 16u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 81];
    int stored = dctSigned5((currentWord >> 11u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 82];
    int stored = dctSigned5((currentWord >> 6u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 83];
    int stored = dctSigned5((currentWord >> 1u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 84];
    int stored = dctSigned5(((currentWord << 4u) | (nextWord >> 28u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 60);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 85];
    int stored = dctSigned5((currentWord >> 23u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 86];
    int stored = dctSigned5((currentWord >> 18u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 87];
    int stored = dctSigned5((currentWord >> 13u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 88];
    int stored = dctSigned5((currentWord >> 8u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 89];
    int stored = dctSigned5((currentWord >> 3u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 90];
    int stored = dctSigned5(((currentWord << 2u) | (nextWord >> 30u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 64);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 91];
    int stored = dctSigned5((currentWord >> 25u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 92];
    int stored = dctSigned5((currentWord >> 20u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 93];
    int stored = dctSigned5((currentWord >> 15u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 94];
    int stored = dctSigned5((currentWord >> 10u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 95];
    int stored = dctSigned5((currentWord >> 5u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 96];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 68);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 97];
    int stored = dctSigned5((currentWord >> 27u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 98];
    int stored = dctSigned5((currentWord >> 22u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 99];
    int stored = dctSigned5((currentWord >> 17u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 100];
    int stored = dctSigned5((currentWord >> 12u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 101];
    int stored = dctSigned5((currentWord >> 7u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 102];
    int stored = dctSigned5((currentWord >> 2u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 103];
    int stored = dctSigned5(((currentWord << 3u) | (nextWord >> 29u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 72);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 104];
    int stored = dctSigned5((currentWord >> 24u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 105];
    int stored = dctSigned5((currentWord >> 19u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 106];
    int stored = dctSigned5((currentWord >> 14u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 107];
    int stored = dctSigned5((currentWord >> 9u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 108];
    int stored = dctSigned5((currentWord >> 4u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 109];
    int stored = dctSigned5(((currentWord << 1u) | (nextWord >> 31u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 76);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 110];
    int stored = dctSigned5((currentWord >> 26u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 111];
    int stored = dctSigned5((currentWord >> 21u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 112];
    int stored = dctSigned5((currentWord >> 16u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 113];
    int stored = dctSigned5((currentWord >> 11u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 114];
    int stored = dctSigned5((currentWord >> 6u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 115];
    int stored = dctSigned5((currentWord >> 1u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 116];
    int stored = dctSigned5(((currentWord << 4u) | (nextWord >> 28u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 80);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 117];
    int stored = dctSigned5((currentWord >> 23u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 118];
    int stored = dctSigned5((currentWord >> 18u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 119];
    int stored = dctSigned5((currentWord >> 13u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 120];
    int stored = dctSigned5((currentWord >> 8u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 121];
    int stored = dctSigned5((currentWord >> 3u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 122];
    int stored = dctSigned5(((currentWord << 2u) | (nextWord >> 30u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 84);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 123];
    int stored = dctSigned5((currentWord >> 25u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 124];
    int stored = dctSigned5((currentWord >> 20u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 125];
    int stored = dctSigned5((currentWord >> 15u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 126];
    int stored = dctSigned5((currentWord >> 10u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 127];
    int stored = dctSigned5((currentWord >> 5u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 128];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 88);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 129];
    int stored = dctSigned5((currentWord >> 27u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 130];
    int stored = dctSigned5((currentWord >> 22u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 131];
    int stored = dctSigned5((currentWord >> 17u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 132];
    int stored = dctSigned5((currentWord >> 12u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 133];
    int stored = dctSigned5((currentWord >> 7u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 134];
    int stored = dctSigned5((currentWord >> 2u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 135];
    int stored = dctSigned5(((currentWord << 3u) | (nextWord >> 29u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 92);
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 136];
    int stored = dctSigned5((currentWord >> 24u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 137];
    int stored = dctSigned5((currentWord >> 19u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 138];
    int stored = dctSigned5((currentWord >> 14u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 139];
    int stored = dctSigned5((currentWord >> 9u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 140];
    int stored = dctSigned5((currentWord >> 4u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 141];
    int stored = dctSigned5(((currentWord << 1u) | (nextWord >> 31u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 142];
    int stored = dctSigned5((currentWord >> 26u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 143];
    int stored = dctSigned5((currentWord >> 21u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 144];
    int stored = dctSigned5((currentWord >> 16u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 145];
    int stored = dctSigned5((currentWord >> 11u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 146];
    int stored = dctSigned5((currentWord >> 6u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_Y[storedProfile * 148 + 147];
    int stored = dctSigned5((currentWord >> 1u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, false, 16) *
        dctBasis(position & 15, localX, 16) *
        dctBasis(position >> 4, localY, 16),
      sum,
      correction
    );
  }

  return sum + 128.0;
}

float sampleDctChroma422Record(int recordOffset, int localX, int localY) {
  uint headerWord = dctWordAt(recordOffset);
  int profile = int(headerWord >> 28u);
  int storedProfile = (dctByteAt(52) & 16u) != 0u ? profile : profile + 1;
  int dcScaleIndex = int((headerWord >> 24u) & 15u);
  int dc = dctSigned10((headerWord >> 14u) & 1023u);
  float scale0 = exp2(float((headerWord >> 11u) & 7u));
  float scale1 = exp2(float((headerWord >> 8u) & 7u));
  float scale2 = exp2(float((headerWord >> 5u) & 7u));
  float sum = 0.0;
  float correction = 0.0;

  addDctCompensated(
    float(dc) * exp2(float(dcScaleIndex)) * dctQuantizationStep(0, true, 16) *
      dctBasis(0, localX, 8) * dctBasis(0, localY, 16),
    sum,
    correction
  );

  uint currentWord = headerWord;
  uint nextWord = dctWordAt(recordOffset + 4);
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 0];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 8);
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 1];
    int stored = dctSigned5((currentWord >> 27u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 2];
    int stored = dctSigned5((currentWord >> 22u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 3];
    int stored = dctSigned5((currentWord >> 17u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 4];
    int stored = dctSigned5((currentWord >> 12u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 5];
    int stored = dctSigned5((currentWord >> 7u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 6];
    int stored = dctSigned5((currentWord >> 2u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 7];
    int stored = dctSigned5(((currentWord << 3u) | (nextWord >> 29u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 12);
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 8];
    int stored = dctSigned5((currentWord >> 24u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 9];
    int stored = dctSigned5((currentWord >> 19u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 10];
    int stored = dctSigned5((currentWord >> 14u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 11];
    int stored = dctSigned5((currentWord >> 9u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 12];
    int stored = dctSigned5((currentWord >> 4u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 13];
    int stored = dctSigned5(((currentWord << 1u) | (nextWord >> 31u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 16);
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 14];
    int stored = dctSigned5((currentWord >> 26u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 15];
    int stored = dctSigned5((currentWord >> 21u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 16];
    int stored = dctSigned5((currentWord >> 16u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 17];
    int stored = dctSigned5((currentWord >> 11u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 18];
    int stored = dctSigned5((currentWord >> 6u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 19];
    int stored = dctSigned5((currentWord >> 1u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 20];
    int stored = dctSigned5(((currentWord << 4u) | (nextWord >> 28u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 20);
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 21];
    int stored = dctSigned5((currentWord >> 23u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 22];
    int stored = dctSigned5((currentWord >> 18u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 23];
    int stored = dctSigned5((currentWord >> 13u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 24];
    int stored = dctSigned5((currentWord >> 8u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 25];
    int stored = dctSigned5((currentWord >> 3u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 26];
    int stored = dctSigned5(((currentWord << 2u) | (nextWord >> 30u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 27];
    int stored = dctSigned5((currentWord >> 25u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 28];
    int stored = dctSigned5((currentWord >> 20u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 29];
    int stored = dctSigned5((currentWord >> 15u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 30];
    int stored = dctSigned5((currentWord >> 10u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 31];
    int stored = dctSigned5((currentWord >> 5u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C422[storedProfile * 33 + 32];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 16) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }

  return sum + 128.0;
}

float sampleDctChroma420Record(int recordOffset, int localX, int localY) {
  uint headerWord = dctWordAt(recordOffset);
  int profile = int(headerWord >> 28u);
  int storedProfile = (dctByteAt(52) & 16u) != 0u ? profile : profile + 1;
  int dcScaleIndex = int((headerWord >> 24u) & 15u);
  int dc = dctSigned10((headerWord >> 14u) & 1023u);
  float scale0 = exp2(float((headerWord >> 11u) & 7u));
  float scale1 = exp2(float((headerWord >> 8u) & 7u));
  float scale2 = exp2(float((headerWord >> 5u) & 7u));
  float sum = 0.0;
  float correction = 0.0;

  addDctCompensated(
    float(dc) * exp2(float(dcScaleIndex)) * dctQuantizationStep(0, true, 8) *
      dctBasis(0, localX, 8) * dctBasis(0, localY, 8),
    sum,
    correction
  );

  uint currentWord = headerWord;
  uint nextWord = dctWordAt(recordOffset + 4);
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 0];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 8);
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 1];
    int stored = dctSigned5((currentWord >> 27u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 2];
    int stored = dctSigned5((currentWord >> 22u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 3];
    int stored = dctSigned5((currentWord >> 17u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 4];
    int stored = dctSigned5((currentWord >> 12u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 5];
    int stored = dctSigned5((currentWord >> 7u) & 31u);
    addDctCompensated(
      float(stored) * scale0 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 6];
    int stored = dctSigned5((currentWord >> 2u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 7];
    int stored = dctSigned5(((currentWord << 3u) | (nextWord >> 29u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 12);
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 8];
    int stored = dctSigned5((currentWord >> 24u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 9];
    int stored = dctSigned5((currentWord >> 19u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 10];
    int stored = dctSigned5((currentWord >> 14u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 11];
    int stored = dctSigned5((currentWord >> 9u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 12];
    int stored = dctSigned5((currentWord >> 4u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 13];
    int stored = dctSigned5(((currentWord << 1u) | (nextWord >> 31u)) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 16);
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 14];
    int stored = dctSigned5((currentWord >> 26u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 15];
    int stored = dctSigned5((currentWord >> 21u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 16];
    int stored = dctSigned5((currentWord >> 16u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 17];
    int stored = dctSigned5((currentWord >> 11u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 18];
    int stored = dctSigned5((currentWord >> 6u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 19];
    int stored = dctSigned5((currentWord >> 1u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 20];
    int stored = dctSigned5(((currentWord << 4u) | (nextWord >> 28u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  nextWord = dctWordAt(recordOffset + 20);
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 21];
    int stored = dctSigned5((currentWord >> 23u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 22];
    int stored = dctSigned5((currentWord >> 18u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 23];
    int stored = dctSigned5((currentWord >> 13u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 24];
    int stored = dctSigned5((currentWord >> 8u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 25];
    int stored = dctSigned5((currentWord >> 3u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 26];
    int stored = dctSigned5(((currentWord << 2u) | (nextWord >> 30u)) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  currentWord = nextWord;
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 27];
    int stored = dctSigned5((currentWord >> 25u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 28];
    int stored = dctSigned5((currentWord >> 20u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 29];
    int stored = dctSigned5((currentWord >> 15u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 30];
    int stored = dctSigned5((currentWord >> 10u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 31];
    int stored = dctSigned5((currentWord >> 5u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C420[storedProfile * 33 + 32];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
    addDctCompensated(
      float(stored) * scale2 * dctQuantizationStep(position, true, 8) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 8),
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

float sampleDirectDctChroma420(int recordOffset, int localX, int localY) {
  int floorX = (localX & 1) == 0 ? (localX >> 1) - 1 : localX >> 1;
  int floorY = (localY & 1) == 0 ? (localY >> 1) - 1 : localY >> 1;
  int x0 = clamp(floorX, 0, 7);
  int y0 = clamp(floorY, 0, 7);
  int x1 = clamp(floorX + 1, 0, 7);
  int y1 = clamp(floorY + 1, 0, 7);
  int fractionX = (localX & 1) == 0 ? 3 : 1;
  int fractionY = (localY & 1) == 0 ? 3 : 1;
  float top = float(4 - fractionX) * sampleDctChroma420Record(recordOffset, x0, y0) +
    float(fractionX) * sampleDctChroma420Record(recordOffset, x1, y0);
  float bottom = float(4 - fractionX) * sampleDctChroma420Record(recordOffset, x0, y1) +
    float(fractionX) * sampleDctChroma420Record(recordOffset, x1, y1);
  return (float(4 - fractionY) * top + float(fractionY) * bottom) / 16.0;
}

vec3 fetchDirectDctColor(ivec2 pixelCoord) {
  ivec2 pixel = clamp(pixelCoord, ivec2(0), uDctImageSize - 1);
  int mcuIndex = (pixel.y >> 4) * uDctMcuColumns + (pixel.x >> 4);
  int mcuOffset = DCT_HEADER_BYTES + mcuIndex * DCT_MCU_BYTES;
  ivec2 local = pixel & 15;
  float y = sampleDctLumaRecord(mcuOffset, local.x, local.y);
  float cb = uDctChroma420
    ? sampleDirectDctChroma420(mcuOffset + DCT_Y_BYTES, local.x, local.y)
    : sampleDctChroma422Record(mcuOffset + DCT_Y_BYTES, local.x >> 1, local.y);
  float cr = uDctChroma420
    ? sampleDirectDctChroma420(
        mcuOffset + DCT_Y_BYTES + DCT_CB_BYTES, local.x, local.y
      )
    : sampleDctChroma422Record(
        mcuOffset + DCT_Y_BYTES + DCT_CB_BYTES, local.x >> 1, local.y
      );
  return dctYCbCrToRgb(y, cb, cr);
}

float sampleCachedDctChroma(ivec2 mcuOrigin, int componentOffset, int localX, int localY) {
  if (!uDctChroma420) {
    return float(dctCachedByte(mcuOrigin, componentOffset + localY * 8 + (localX >> 1)));
  }
  int floorX = (localX & 1) == 0 ? (localX >> 1) - 1 : localX >> 1;
  int floorY = (localY & 1) == 0 ? (localY >> 1) - 1 : localY >> 1;
  int x0 = clamp(floorX, 0, 7);
  int y0 = clamp(floorY, 0, 7);
  int x1 = clamp(floorX + 1, 0, 7);
  int y1 = clamp(floorY + 1, 0, 7);
  int fractionX = (localX & 1) == 0 ? 3 : 1;
  int fractionY = (localY & 1) == 0 ? 3 : 1;
  float top = float(4 - fractionX) *
      float(dctCachedByte(mcuOrigin, componentOffset + y0 * 8 + x0)) +
    float(fractionX) * float(dctCachedByte(mcuOrigin, componentOffset + y0 * 8 + x1));
  float bottom = float(4 - fractionX) *
      float(dctCachedByte(mcuOrigin, componentOffset + y1 * 8 + x0)) +
    float(fractionX) * float(dctCachedByte(mcuOrigin, componentOffset + y1 * 8 + x1));
  return (float(4 - fractionY) * top + float(fractionY) * bottom) / 16.0;
}

vec3 fetchCachedDctColor(ivec2 pixelCoord) {
  ivec2 pixel = clamp(pixelCoord, ivec2(0), uDctImageSize - 1);
  int mcuIndex = (pixel.y >> 4) * uDctMcuColumns + (pixel.x >> 4);
  ivec2 mcuOrigin = ivec2(
    (mcuIndex % uDctCacheMcusPerRow) * uDctCacheRecordTexels,
    mcuIndex / uDctCacheMcusPerRow
  );
  ivec2 local = pixel & 15;
  float y = float(dctCachedByte(mcuOrigin, local.y * 16 + local.x));
  float cb = sampleCachedDctChroma(mcuOrigin, uDctCacheCbOffset, local.x, local.y);
  float cr = sampleCachedDctChroma(mcuOrigin, uDctCacheCrOffset, local.x, local.y);

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

void main() {
  vec3 normal = normalize(vNormal);
  vec3 lightDirection = normalize(uLightPosition - vWorldPosition);
  vec3 viewDirection = normalize(uViewPosition - vWorldPosition);
  float diffuse = max(dot(normal, lightDirection), 0.0);
  vec3 halfVector = normalize(lightDirection + viewDirection);
  float specularMask = texture(uSpecularTexture, vTexCoord).r;
  float specular = pow(max(dot(normal, halfVector), 0.0), max(uShininess, 1.0)) *
    uSpecularStrength * specularMask;
  vec3 stoneColor;

  if (uUseDctTexture > 0.5) {
    stoneColor = sampleDctTexture(vTexCoord);
  } else if (uUseBpalTexture > 0.5) {
    stoneColor = sampleBpalTexture(vTexCoord);
  } else {
    stoneColor = texture(uStoneTexture, vTexCoord).rgb;
  }
  vec3 color = stoneColor * (uAmbientColor + diffuse * uLightColor) + specular * uLightColor;

  fragmentColor = vec4(color, 1.0);
}
