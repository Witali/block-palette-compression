# Native Win64 texture demo

`block_texture_demo.exe` is a self-contained 64-bit Windows desktop demo built
with the Win32 API and Direct3D 11. It renders a continuously rotating textured
cube and replaces its GPU texture immediately when another file is selected.
It does not embed a browser, WebView, Node.js, or JavaScript runtime.

## Texture support

- **BPAL v5** with explicit RGB/scalar palettes, including packed palettes;
- **BPLM v1**, with the stored mip chain uploaded directly to Direct3D;
- **DCTBS2 v2** fixed-record modes, including grouped, split-luma, and skip
  coefficient coding (prototype-library records are rejected with an explicit
  message);
- **BPDH v1** palette, DCT, and mixed coding-unit streams;
- standard Windows Imaging Component formats such as PNG, JPEG, BMP, and TIFF.

The bundled sample selector exercises BPAL, BPLM, DCTBS2, BPDH, and JPEG. The
**Upload...** button opens the native Windows file picker. A file can also be
dropped on the window. **Pause** or the Space key stops and resumes rotation.

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

Use `-Clean` for a clean rebuild and `-Configuration Debug` for a debug binary.

## Verification

`texture_codec_tests` decodes the repository samples natively and verifies
their dimensions, mip counts, and full-image FNV-1a checksums. The expected
checksums are generated from the JavaScript reference decoders, so the test
catches pixel-level compatibility regressions in every custom format path.
