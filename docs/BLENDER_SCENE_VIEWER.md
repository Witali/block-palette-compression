# Blender scene viewer

`scene-viewer.html` displays the Barcelona Pavilion scene exported from
`pavillon_barcelone_v1.2.blend`. The original scene is obtained from Blender's
[official demo archive](https://download.blender.org/demo/test/pabellon_barcelona_v1.scene_.zip);
the `.blend` is not stored in this repository. The page loads texture-free glTF
geometry and assigns one of four complete texture sets at runtime:

- the original-resolution images in standard GPU compression: BC1/DXT1 for
  opaque textures and BC7 for the two textures with alpha;
- BPAL v5 with 8 x 8 blocks, 8 block-local colors, and a 256-color shared palette;
- DCTBS2 at the 3 bpp preset, quality 88, with 4:2:0 chroma;
- ASTC with 6 x 6 blocks and the medium `astcenc` quality preset.

All 17 source images are present in every runtime format. The original JPEG and
PNG files, the `.blend`, and other scene authoring data stay outside Git. The
two RGBA source images
also have separate BPAL and DCTBS2 alpha streams because those RGB codecs do
not store alpha in their base payloads. BC7 and ASTC keep RGBA in one stream.
Source images larger than 1024 pixels on either axis are resized for predictable web
memory use while preserving their aspect ratio.

The browser never expands a selected texture into an RGBA image before use.
BC1 and BC7 DDS blocks are uploaded as WebGL compressed textures and sampled by
the GPU's hardware texture units. BPAL, DCTBS2, and ASTC are uploaded as packed
`RGBA8UI` data textures. A codec-specific WebGL2 fragment shader uses
`texelFetch` to read the compressed records needed for the current UV
coordinate and reconstructs only that fragment's texel. Alpha and bump streams
follow the same shader-only path; there is no full-image RGBA texture cache.
The shared ASTC runtime stream uses valid 6 x 6 void-extent blocks whose RGBA
endpoint is the setup-time average of that block. This portable shader subset
trades quality for direct sampling on WebGL2 systems without an ASTC extension.

The original Blender file contains large particle systems: 20,000 pebbles,
300 lotus plants, and 322 copies of a 113,000-polygon tree. The exporter keeps
the scene composition but uses browser-oriented particle limits and a tree LOD
before writing glTF. Ordinary JPEG and PNG references are stripped from glTF,
so the viewer can only render material images through the selected codec.

## Rebuild assets

The build requires Python with Pillow, Node.js, and a Blender 4.5-compatible
executable. Run setup first to download and extract the original scene under
the Git-ignored `.tmp` directory and automatically rebuild the runtime assets:

```powershell
.\setup.ps1 -SkipCuda
```

The setup command runs the equivalent explicit build:

```powershell
python tools/build-blender-scene-assets.py `
  .tmp\barcelona-source\3d\pavillon_barcelone_v1.2.blend `
  assets\scenes\barcelona `
  --blender path\to\blender.exe `
  --node path\to\node.exe `
  --max-dimension 1024
node tools/build-win32-scene-assets.mjs
```

The command exports `scene.gltf` and `scene.bin`, converts every file in the
source scene's adjacent `textures` directory, and writes `manifest.json` with
material assignments, dimensions, codec settings, and compressed byte totals.
The second command creates the shared `.dxtx` GPU streams and generated WebGL2
sampler used by both the browser and Direct3D viewers.
