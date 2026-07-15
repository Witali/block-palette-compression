#version 300 es
/*
 * Generated WebGL2 compact cube fragment stage for DCTBS2 1.5 bpp.
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
const int DCT_MCU_BYTES = 48;
const int DCT_Y_BYTES = 24;
const int DCT_CB_BYTES = 12;
const int DCT_Y_AC_COUNT = 33;
const int DCT_C_AC_COUNT = 13;
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

// Four deterministic significance scans trimmed for 1.5 bpp records.
const int DCT_SCAN_Y[132] = int[132](
  16, 1, 2, 17, 32, 48, 33, 18, 3, 4, 19, 34, 49, 64, 80, 65, 50,
  35, 20, 5, 6, 21, 36, 51, 66, 81, 96, 112, 97, 82, 67, 52, 37, 1,
  2, 16, 3, 17, 4, 18, 32, 5, 19, 33, 6, 20, 34, 7, 48, 21, 35,
  8, 49, 22, 36, 9, 50, 23, 64, 37, 10, 51, 24, 65, 38, 11, 16, 32,
  1, 48, 17, 64, 33, 2, 80, 49, 18, 96, 65, 34, 112, 3, 81, 50, 128,
  19, 97, 66, 144, 35, 113, 4, 82, 160, 51, 129, 20, 98, 176, 17, 1, 16,
  34, 18, 33, 2, 32, 51, 35, 50, 19, 49, 3, 48, 68, 52, 67, 36, 66,
  20, 65, 4, 64, 85, 69, 84, 53, 83, 37, 82, 21, 81
);

const int DCT_SCAN_C[52] = int[52](
  8, 1, 2, 9, 16, 24, 17, 10, 3, 4, 11, 18, 25, 1, 2, 8, 3,
  9, 4, 10, 16, 5, 11, 17, 6, 12, 8, 16, 1, 24, 9, 32, 17, 2,
  40, 25, 10, 48, 33, 9, 1, 8, 18, 10, 17, 2, 16, 27, 19, 26, 11,
  25
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
    int position = DCT_SCAN_Y[profile * 33 + 0];
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
    int position = DCT_SCAN_Y[profile * 33 + 1];
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
    int position = DCT_SCAN_Y[profile * 33 + 2];
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
    int position = DCT_SCAN_Y[profile * 33 + 3];
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
    int position = DCT_SCAN_Y[profile * 33 + 4];
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
    int position = DCT_SCAN_Y[profile * 33 + 5];
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
    int position = DCT_SCAN_Y[profile * 33 + 6];
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
    int position = DCT_SCAN_Y[profile * 33 + 7];
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
  nextWord = dctWordAt(recordOffset + 12);
  {
    int position = DCT_SCAN_Y[profile * 33 + 8];
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
    int position = DCT_SCAN_Y[profile * 33 + 9];
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
    int position = DCT_SCAN_Y[profile * 33 + 10];
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
    int position = DCT_SCAN_Y[profile * 33 + 11];
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
    int position = DCT_SCAN_Y[profile * 33 + 12];
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
    int position = DCT_SCAN_Y[profile * 33 + 13];
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
  nextWord = dctWordAt(recordOffset + 16);
  {
    int position = DCT_SCAN_Y[profile * 33 + 14];
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
    int position = DCT_SCAN_Y[profile * 33 + 15];
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
    int position = DCT_SCAN_Y[profile * 33 + 16];
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
    int position = DCT_SCAN_Y[profile * 33 + 17];
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
    int position = DCT_SCAN_Y[profile * 33 + 18];
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
    int position = DCT_SCAN_Y[profile * 33 + 19];
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
    int position = DCT_SCAN_Y[profile * 33 + 20];
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
  nextWord = dctWordAt(recordOffset + 20);
  {
    int position = DCT_SCAN_Y[profile * 33 + 21];
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
    int position = DCT_SCAN_Y[profile * 33 + 22];
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
    int position = DCT_SCAN_Y[profile * 33 + 23];
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
    int position = DCT_SCAN_Y[profile * 33 + 24];
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
    int position = DCT_SCAN_Y[profile * 33 + 25];
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
    int position = DCT_SCAN_Y[profile * 33 + 26];
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
  {
    int position = DCT_SCAN_Y[profile * 33 + 27];
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
    int position = DCT_SCAN_Y[profile * 33 + 28];
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
    int position = DCT_SCAN_Y[profile * 33 + 29];
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
    int position = DCT_SCAN_Y[profile * 33 + 30];
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
    int position = DCT_SCAN_Y[profile * 33 + 31];
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
    int position = DCT_SCAN_Y[profile * 33 + 32];
    int stored = dctSigned5((currentWord >> 0u) & 31u);
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
    int position = DCT_SCAN_C[profile * 13 + 0];
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
    int position = DCT_SCAN_C[profile * 13 + 1];
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
    int position = DCT_SCAN_C[profile * 13 + 2];
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
    int position = DCT_SCAN_C[profile * 13 + 3];
    int stored = dctSigned5((currentWord >> 17u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 13 + 4];
    int stored = dctSigned5((currentWord >> 12u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 13 + 5];
    int stored = dctSigned5((currentWord >> 7u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 13 + 6];
    int stored = dctSigned5((currentWord >> 2u) & 31u);
    addDctCompensated(
      float(stored) * scale1 * dctQuantizationStep(position, true) *
        dctBasis(position & 7, localX, 8) *
        dctBasis(position >> 3, localY, 16),
      sum,
      correction
    );
  }
  {
    int position = DCT_SCAN_C[profile * 13 + 7];
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
    int position = DCT_SCAN_C[profile * 13 + 8];
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
    int position = DCT_SCAN_C[profile * 13 + 9];
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
    int position = DCT_SCAN_C[profile * 13 + 10];
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
    int position = DCT_SCAN_C[profile * 13 + 11];
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
    int position = DCT_SCAN_C[profile * 13 + 12];
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
