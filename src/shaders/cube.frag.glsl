/*
 * Purpose: Fragment shader for the rotating cube's textured lighting.
 * Processing blocks:
 * - Sample the stone texture and generated specular map for material response.
 * - Combine ambient, diffuse, and glossy or matte highlights into the final color.
 */
precision highp float;

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying vec2 vTexCoord;

uniform sampler2D uStoneTexture;
uniform sampler2D uSpecularTexture;
uniform sampler2D uBpalPixelIndices;
uniform sampler2D uBpalBlockPalettes;
uniform sampler2D uBpalGlobalPalette;
uniform sampler2D uBpalPaletteSelectors;
uniform float uUseBpalTexture;
uniform vec2 uBpalImageSize;
uniform float uBpalBlockSize;
uniform float uBpalBlocksX;
uniform float uBpalLocalColorCount;
uniform float uBpalGlobalColorCount;
uniform vec2 uBpalPixelAtlasSize;
uniform vec2 uBpalBlockPaletteAtlasSize;
uniform vec2 uBpalPaletteAtlasSize;
uniform vec2 uBpalPaletteSelectorAtlasSize;
uniform vec3 uLightPosition;
uniform vec3 uLightColor;
uniform vec3 uAmbientColor;
uniform vec3 uViewPosition;
uniform float uSpecularStrength;
uniform float uShininess;

vec2 atlasTexCoord(float linearIndex, vec2 atlasSize) {
  float x = mod(linearIndex, atlasSize.x);
  float y = floor(linearIndex / atlasSize.x);

  return (vec2(x, y) + 0.5) / atlasSize;
}

vec3 fetchBpalColor(vec2 pixelCoord) {
  vec2 pixel = clamp(pixelCoord, vec2(0.0), uBpalImageSize - 1.0);
  float pixelIndex = pixel.y * uBpalImageSize.x + pixel.x;
  float localIndex = floor(
    texture2D(uBpalPixelIndices, atlasTexCoord(pixelIndex, uBpalPixelAtlasSize)).r * 255.0 + 0.5
  );
  vec2 block = floor(pixel / uBpalBlockSize);
  float blockIndex = block.y * uBpalBlocksX + block.x;
  float blockPaletteIndex = blockIndex * uBpalLocalColorCount + localIndex;
  vec2 packedGlobalIndex = texture2D(
    uBpalBlockPalettes,
    atlasTexCoord(blockPaletteIndex, uBpalBlockPaletteAtlasSize)
  ).rg;
  float globalIndex = floor(packedGlobalIndex.r * 255.0 + 0.5) +
    floor(packedGlobalIndex.g * 255.0 + 0.5) * 256.0;
  float paletteIndex = floor(
    texture2D(
      uBpalPaletteSelectors,
      atlasTexCoord(blockIndex, uBpalPaletteSelectorAtlasSize)
    ).r * 255.0 + 0.5
  );

  globalIndex += paletteIndex * uBpalGlobalColorCount;

  return texture2D(
    uBpalGlobalPalette,
    atlasTexCoord(globalIndex, uBpalPaletteAtlasSize)
  ).rgb;
}

vec3 sampleBpalTexture(vec2 uv) {
  vec2 sourceCoord = vec2(uv.x, 1.0 - uv.y) * uBpalImageSize - 0.5;
  vec2 topLeft = floor(sourceCoord);
  vec2 blend = fract(sourceCoord);
  vec3 top = mix(
    fetchBpalColor(topLeft),
    fetchBpalColor(topLeft + vec2(1.0, 0.0)),
    blend.x
  );
  vec3 bottom = mix(
    fetchBpalColor(topLeft + vec2(0.0, 1.0)),
    fetchBpalColor(topLeft + vec2(1.0, 1.0)),
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
  float specularMask = texture2D(uSpecularTexture, vTexCoord).r;
  float specular = pow(max(dot(normal, halfVector), 0.0), max(uShininess, 1.0)) *
    uSpecularStrength * specularMask;

  vec3 stoneColor;

  if (uUseBpalTexture > 0.5) {
    stoneColor = sampleBpalTexture(vTexCoord);
  } else {
    stoneColor = texture2D(uStoneTexture, vTexCoord).rgb;
  }
  vec3 color = stoneColor * (uAmbientColor + diffuse * uLightColor) + specular * uLightColor;
  gl_FragColor = vec4(color, 1.0);
}
