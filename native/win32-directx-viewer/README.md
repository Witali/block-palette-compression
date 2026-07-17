# Win32 Direct3D 11 scene viewer

`BarcelonaPavilionViewer.exe` is a native Unicode Win32 application. It uses
Direct3D 11 directly, without a browser, WebView, Node.js, or a JavaScript
runtime. The application loads the Barcelona Pavilion geometry and switches
between original-resolution BC1/BC7, BPAL, DCTBS2, and ASTC textures while the
scene is running.

The fragment shaders obtain every visible texel from compressed data stored in
Direct3D resources. The runtime does not create an RGBA or other fully decoded
texture cache:

- the original mode uploads DDS blocks directly as `DXGI_FORMAT_BC1` for the
  15 opaque textures and `DXGI_FORMAT_BC7` for the two alpha textures;

- BPAL reads the packed pixel index, block palette, and palette selector bits,
  then performs the two palette lookups. The build tool appends only the small
  decoded global palette used as the final lookup table.
- DCTBS2 reads the fixed 3 bpp MCU record and evaluates the luma and chroma DCT
  coefficients for the requested coordinate in HLSL. Chroma is sampled at the
  nearest 4:2:0 coordinate to keep scene rendering practical.
- ASTC reads standard 16-byte 6x6 void-extent blocks and returns their encoded
  UNORM16 RGBA endpoint. The asset builder creates this restricted, valid ASTC
  subset by averaging each 6x6 block; it is intentionally lower quality than a
  complete ASTC partition/weight decoder.

Four specialized pixel shaders are compiled at startup so switching formats
does not leave a per-pixel codec dispatch in the hot path. Bump values are also
sampled from the selected compressed stream; screen-space derivatives provide
the height gradient without decoding neighboring texels into a cache.

## Controls

- left mouse drag: orbit;
- mouse wheel: zoom;
- `R`: reset the camera;
- `1`, `2`, `3`, `4`: select original BC1/BC7, BPAL, DCTBS2, or ASTC.

## Rebuild assets

From the repository root:

```powershell
npm run build:native-scene-assets
```

This reads `assets/scenes/barcelona/scene.gltf`, `scene.bin`, and the compressed
scene textures. It writes:

- `assets/barcelona.dxscene`, containing the baked scene geometry;
- `assets/original/*.dds`, containing original-resolution BC1/BC7 GPU textures;
- `assets/streams/<codec>/*.dxtx`, containing an 80-byte Direct3D metadata
  header followed by the compressed bytes uploaded to a raw buffer;
- `assets/scene.hlsl`, generated from `scene.hlsl.in` plus the canonical DCT
  coefficient scan tables.

The DCT scene inputs must use fixed 3 bpp `grouped-5-front`, merged 16x16 luma,
and 4:2:0 chroma. `tools/encode-scene-textures.mjs` produces that layout.

## Build

Open `NativeSceneViewer.sln` in Visual Studio 2026 and build `Release | x64`, or
run:

```powershell
& "C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\MSBuild.exe" `
  native\win32-directx-viewer\NativeSceneViewer.sln `
  /m /p:Configuration=Release /p:Platform=x64
```

The executable and copied runtime assets are written to
`build/x64/Release/`.

The hidden smoke test creates the Direct3D device, compiles all shader variants,
uploads the complete scene, loads all four texture sets, and renders one frame
for each format:

```powershell
native\win32-directx-viewer\build\x64\Release\BarcelonaPavilionViewer.exe --smoke-test
```
