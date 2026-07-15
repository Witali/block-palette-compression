# DCTBS2 WebGL 2 fragment shaders

These shaders provide direct random-access sampling of the current DCTBS2 v2
bitstream. They were adapted from the attached `dctbs_fragment_shaders.zip`,
but are not bit-compatible copies of those files. The attachment targets an
older 256-byte-header `.dctb` layout with planar component streams and embedded
quantization tables. The current format uses a 64-byte header, interleaved
fixed-size MCUs, quality-derived quantization, four significance scans, and
grouped binary exponents.

Each rate has a separately validated fragment shader:

| Payload rate | Fragment shader |
| ---: | --- |
| 0.75 bpp | `dctbs2-0_75bpp.frag.glsl` |
| 1 bpp | `dctbs2-1bpp.frag.glsl` |
| 1.5 bpp | `dctbs2-1_5bpp.frag.glsl` |
| 2 bpp | `dctbs2-2bpp.frag.glsl` |
| 3 bpp | `dctbs2-3bpp.frag.glsl` |
| 4.5 bpp | `dctbs2-4_5bpp.frag.glsl` |
| 6 bpp | `dctbs2-6bpp.frag.glsl` |

Use `dctbs2-fullscreen.vert.glsl` for a full-screen draw. The fragment shaders
support legacy and both grouped-exponent coefficient codings, regular or split
8x8 luma, and DCT prototype-library versions 1 through 9. This includes the
three-entry header library, 16/32-entry sidecar libraries, and spectral-split
sidecar libraries. The shader calculates the MCU, sidecar index, and prototype
address directly; it never reads another image MCU.

## Input texture

Upload the complete `.dctbs2` file, including its 64-byte header and optional
library, to an integer `RGBA8UI` texture. Four consecutive file bytes occupy
one texel in RGBA order. Pad the final texel with zeroes.

```js
const texelCount = Math.ceil(bytes.length / 4);
const textureWidth = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), texelCount);
const textureHeight = Math.ceil(texelCount / textureWidth);
const padded = new Uint8Array(textureWidth * textureHeight * 4);
padded.set(bytes);

gl.bindTexture(gl.TEXTURE_2D, texture);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texImage2D(
  gl.TEXTURE_2D,
  0,
  gl.RGBA8UI,
  textureWidth,
  textureHeight,
  0,
  gl.RGBA_INTEGER,
  gl.UNSIGNED_BYTE,
  padded
);
```

Required uniforms:

```glsl
uniform highp usampler2D uDctData;
uniform int uDataTexWidth;
uniform bool uFlipY;
```

Use nearest filtering and disable mipmaps. Set `uFlipY` to `true` for the usual
top-left image orientation when drawing a full-screen image. A rate-specific
shader outputs magenta when the main header does not match its expected DCTBS2
mode or fixed MCU layout.

## Demo Cube integration

`cube.html` can switch its WebGL2 material source from BPAL/BPLM to the bundled
`assets/dct/stone-texture-wic-1.5bpp.dctbs2` file. Its default **Fast** mode
decodes every MCU once during texture loading and uploads a component-only
`RGBA8UI` atlas containing 256 Y, 128 Cb, and 128 Cr bytes per MCU. The atlas
uses 512 bytes per MCU (2 bytes per source pixel), keeps complete MCU records
on atlas rows, and replaces per-fragment IDCT with three integer texture reads
plus YCbCr-to-RGB conversion. The compressed stream is not duplicated on the
GPU and no RGBA image is uploaded. Component samples are deterministically
rounded and clamped to eight bits while building the cache; this can differ
slightly from the floating-point direct-IDCT path at extreme values.

The optional **Low memory** mode uploads the baseline 1.5 bpp stream directly
and evaluates the requested 16x16 Y and 8x16 Cb/Cr inverse-DCT samples per
fragment. Cube uses the generated
`cube-webgl2-dctbs2-1_5bpp.frag.glsl` program. It is specialized for the
grouped-5-front, unsplit, non-library layout: Y and chroma coefficient code is
fully unrolled, fixed group scales are loaded once, and no checks for other
DCTBS2 layout variants remain in the GPU path. Packed fields are extracted
from two rolling 32-bit words with shifts and masks instead of reading one bit
at a time. Only those two words are live while a component is evaluated, which
limits register pressure without adding a second GPU texture.

The generator also emits an equivalent Cube program for every payload profile:
`cube-webgl2-dctbs2-{0_75,1,1_5,2,3,4_5,6}bpp.frag.glsl`. The renderer factory
selects one with its `dctProfile` option and defaults to `1.5`. The current Cube
page and texture adapter intentionally accept only the baseline 1.5 bpp asset;
the other generated programs make profile specialization explicit and ready
for future Cube assets. The seven standalone `dctbs2-*.frag.glsl` shaders remain
the complete format decoders.

## Regeneration

The coefficient scans, seven complete fragment shaders, and seven specialized
Cube shaders are generated deterministically from
`tools/generate-dctbs2-shaders.js`:

```text
npm run generate:dct-shaders
```

The generator uses the same scan ordering, quantization tables, record sizes,
and library-version rules as `src/dct/dct-format.js`. The automated test suite
checks that every committed shader matches the generator output.
