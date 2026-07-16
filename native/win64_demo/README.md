# Native Win64 DirectX 12 texture demo

`block_texture_demo.exe` is a self-contained 64-bit Windows desktop demo built
with the Win32 API and DirectX 12. It renders a continuously rotating textured
cube and replaces its shader-readable texture buffer immediately when another
file is selected.
It does not embed a browser, WebView, Node.js, or JavaScript runtime.

Project textures are not expanded to a full RGB or RGBA bitmap. The CPU only
validates the container and prepares compact palette/index tables. The pixel
shader receives them through a `ByteAddressBuffer` and reconstructs the texel
requested by the rasterizer:

- BPAL/BPLM perform palette and block-index lookup per coordinate, including
  stored BPLM mip selection;
- DCTBS2 keeps the original fixed-size MCU records and performs bounded IDCT
  for the requested texel;
- BPDH stores palette records plus block-local Y/Cb/Cr component samples. RGB
  conversion is performed only for the requested texel.

## Texture support

- **BPAL v5** with explicit RGB/scalar palettes, including packed palettes;
- **BPLM v1**, with the stored mip chain uploaded directly to Direct3D;
- **DCTBS2 v2** 1.5 bpp grouped-front fixed records, decoded directly in HLSL;
- **BPDH v1** palette, DCT, and mixed coding-unit streams;

The bundled sample selector exercises BPAL, BPLM, DCTBS2, and BPDH. The
**Upload...** button opens the native Windows file picker. A file can also be
selected while rendering. **Pause** stops and resumes rotation.

## Build

Install Visual Studio with the **Desktop development with C++** workload, then
run this command from the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File native/win64_demo/build.ps1 -Configuration Release
```

The script configures an x64 Ninja build using the Visual Studio toolchain,
builds with the static MSVC runtime, copies the bundled samples, and runs the
codec compatibility test. The resulting application is:

```text
native/win64_demo/build-x64/block_texture_demo.exe
```

Use `-Clean` for a clean rebuild, `-Configuration Debug` for a debug binary,
or `-Target shader_texture_tests` to build one target.

## Verification

`texture_codec_tests` decodes the repository samples natively and verifies
their dimensions, mip counts, and full-image FNV-1a checksums. The expected
checksums are generated from the JavaScript reference decoders, so the test
catches pixel-level compatibility regressions in every custom format path.

`shader_texture_tests` separately verifies that every project format produces
valid coordinate-decoder metadata and a GPU payload smaller than a full RGBA
bitmap. The Release executable also has a runtime smoke test during development.
