/*
 * Purpose: WebGL1 fragment shader dedicated to coordinate-based BPDH sampling.
 * BPAL and DCTBS2 paths live in their own programs, so this shader contains no
 * format-selection branch in its fragment hot path.
 */
precision highp float;

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying vec2 vTexCoord;

uniform sampler2D uSpecularTexture;
uniform sampler2D uBpdhData;
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
uniform vec3 uLightPosition;
uniform vec3 uLightColor;
uniform vec3 uAmbientColor;
uniform vec3 uViewPosition;
uniform float uSpecularStrength;
uniform float uShininess;

vec2 bpdhAtlasTexCoord(float texelIndex) {
  float x = mod(texelIndex, uBpdhDataAtlasSize.x);
  float y = floor(texelIndex / uBpdhDataAtlasSize.x);

  return (vec2(x, y) + 0.5) / uBpdhDataAtlasSize;
}

float fetchBpdhByte(float byteIndex) {
  float texelIndex = floor(byteIndex / 4.0);
  float channel = mod(byteIndex, 4.0);
  vec4 value = texture2D(uBpdhData, bpdhAtlasTexCoord(texelIndex));

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

void main() {
  vec3 normal = normalize(vNormal);
  vec3 lightDirection = normalize(uLightPosition - vWorldPosition);
  vec3 viewDirection = normalize(uViewPosition - vWorldPosition);
  float diffuse = max(dot(normal, lightDirection), 0.0);
  vec3 halfVector = normalize(lightDirection + viewDirection);
  float specularMask = texture2D(uSpecularTexture, vTexCoord).r;
  float specular = pow(max(dot(normal, halfVector), 0.0), max(uShininess, 1.0)) *
    uSpecularStrength * specularMask;
  vec3 stoneColor = sampleBpdhTexture(vTexCoord);
  vec3 color = stoneColor * (uAmbientColor + diffuse * uLightColor) + specular * uLightColor;

  gl_FragColor = vec4(color, 1.0);
}
