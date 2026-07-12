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
uniform float uUseBpalTexture;
uniform highp uvec2 uBpalImageSize;
uniform highp uint uBpalBlockSize;
uniform highp uint uBpalBlocksX;
uniform highp uint uBpalLocalColorCount;
uniform highp uint uBpalLocalIndexBits;
uniform highp uint uBpalGlobalIndexBits;
uniform highp uint uBpalPaletteColorBits;
uniform highp uvec2 uBpalPixelAtlasSize;
uniform highp uvec2 uBpalBlockPaletteAtlasSize;
uniform highp uvec2 uBpalPaletteAtlasSize;
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
  vec3 stoneColor = uUseBpalTexture > 0.5
    ? sampleBpalTexture(reliefTexCoord)
    : texture(uStoneTexture, reliefTexCoord).rgb;
  vec3 color = stoneColor * (uAmbientColor + diffuse * uLightColor) + specular * uLightColor;

  fragmentColor = vec4(color, 1.0);
}
