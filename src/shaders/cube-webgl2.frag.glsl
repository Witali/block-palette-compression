#version 300 es
/*
 * WebGL2 compact BPAL fragment stage.
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
uniform float uUseBpalTexture;
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

  if (uUseBpdhTexture > 0.5) {
    stoneColor = sampleBpdhTexture(reliefTexCoord);
  } else if (uUseBpalTexture > 0.5) {
    stoneColor = sampleBpalTexture(reliefTexCoord);
  } else {
    stoneColor = texture(uStoneTexture, reliefTexCoord).rgb;
  }
  vec3 color = stoneColor * (uAmbientColor + diffuse * uLightColor) + specular * uLightColor;

  fragmentColor = vec4(color, 1.0);
}
