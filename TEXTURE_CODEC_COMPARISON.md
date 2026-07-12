# BPAL/BPLM compared with texture compression formats

[Russian version](./TEXTURE_CODEC_COMPARISON_ru.md)

Research date: July 12, 2026.

## Executive summary

BPAL is an interesting experimental format for opaque LDR images in which the
same colors or nearby shades are reused across different parts of the image.
Its main strength is a flexible file size: one shared palette is amortized over
the complete image, while each block stores only a small subset of that
palette. Files currently included in the repository range from 1.75 to 4.52
bits per pixel without mip levels.

However, BPAL/BPLM cannot yet be considered a direct replacement for BCn, ETC2,
or ASTC. Those formats are decoded by dedicated GPU hardware and filtered by a
regular texture sampler. The current WebGL implementation expands BPAL data
into three uncompressed atlases and reconstructs every texel in the fragment
shader. A small file therefore does not imply equally low GPU memory usage or
equivalent sampling speed.

The practical conclusion is:

- BPAL/BPLM is already useful as a research codec, an opaque texture delivery
  format, and a format for fully controlled WebGL renderers;
- BC7/BC5 on desktop, ASTC on modern mobile GPUs, and ETC2 as a mobile fallback
  remain preferable for conventional production rendering;
- for a single portable file, BPLM is best compared not with one particular
  hardware format but with KTX2 + Basis Universal, which is transcoded at load
  time into a format supported by the target GPU.

## What is being compared

A texture codec has three independent metrics:

1. **Storage and transmission size** — the size of `.bpal`, `.bplm`, `.ktx2`,
   `.dds`, and other files.
2. **GPU memory size and memory traffic** — the amount of data after it has
   been prepared for sampling.
3. **Cost of one texture sample** — the number of memory reads, decoding
   operations, and the filtering method.

Conventional PNG/JPEG/WebP/AVIF files primarily optimize the first metric: once
decoded, they normally become RGB/RGBA textures. BCn, ETC2, ASTC, and PVRTC
optimize the second and third metrics: data stays compressed in GPU memory and
supports random access to a small block. This distinction is explicitly
described by [Imagination Technologies documentation][img-texture-compression].

BPAL sits between these categories: its file representation is compact, but
the GPU uses a custom data structure and a programmable decoder.

## BPAL and BPLM structure

BPAL v3 stores:

- a 14-byte header;
- one shared palette of 8–4096 colors in RGB565 or RGB888;
- 2, 4, 8, or 16 shared-palette indices for every 4×4–64×64 block;
- one local color index for every pixel in its block.

For a `W × H` image, an `S × S` block, `L` local colors, `G` shared colors,
and `C` bits per color, BPAL size is:

```text
14 bytes
+ G × C bits
+ ceil(W / S) × ceil(H / S) × L × log2(G) bits
+ W × H × log2(L) bits
```

For large images, the supported settings produce approximately 1.001 to 16
bits per pixel before the one-time shared palette and header. This is a range
of configuration rates, not a range of equivalent quality levels.

BPLM v1 adds a precomputed mip chain to one complete base BPAL image. Width,
height, and block size are halved at every level. All levels use the palette
from the base image. The number of local colors is limited to the number of
pixels in a block. When those values are equal, the level stores only one
direct shared-palette index per pixel, with no local palette or local indices.

Implementation details are available in the [codec description](./BLOCK_PALETTE_README.md),
the [BPAL v3 specification](./BLOCK_PALETTE_FORMAT.md), and the
[BPLM v1 specification](./BPLM_FORMAT.md).

## Overall comparison

The rates below describe the base mip level. A complete conventional mip chain
at a fixed bpp usually adds about one third to the size. The ratio differs for
BPAL/BPLM because of the shared palette, headers, shrinking block size, and
direct mode in small mip levels.

| Format | Base-level rate | Channels and range | GPU sampling | Strengths | Limitations |
| --- | ---: | --- | --- | --- | --- |
| **BPAL v3** | Variable; 1.75–4.52 bpp in the current file set | LDR RGB; RGB565 or RGB888; no alpha | Custom shader or prior reconstruction only | Flexible rate; the shared palette exploits color reuse between blocks; arbitrary dimensions; simple deterministic bitstream | No hardware decoder; no alpha/HDR/R/RG modes; quality depends on global quantization and a fixed number of block colors; nonstandard format |
| **BPLM v1** | Variable; `stone-texture-wic.bplm` is 3.175 bpp with 11 levels | Same as BPAL | Custom shader; mip filtering is implemented manually | Ready-to-use mip chain; one shared palette; direct indices at small levels | The base level comes first, which is inconvenient for low-mip-first streaming; the base palette constrains every mip; the current shader supports at most 16 levels |
| **BC1 / DXT1** | 4 bpp (8 bytes per 4×4 block) | RGB or RGB + 1-bit alpha | Native | Very cheap and widely used desktop format; half the size of BC3/BC7 | Low-precision RGB565 endpoints; visible gradient artifacts; only 1-bit alpha |
| **BC2/BC3 / DXT3/DXT5** | 8 bpp (16 bytes per 4×4 block) | RGB + alpha | Native | Standard desktop RGBA; BC3 handles smooth alpha better than BC1 | The color part retains BC1 limitations; BC2 is usually less useful than BC3; fixed 8 bpp |
| **BC4 / BC5 (RGTC)** | 4 / 8 bpp | One / two signed or unsigned channels | Native | Good choice for masks, height maps, and normal maps; does not spend bits on unused RGB channels | Not a general RGB/RGBA codec; WebGL requires `EXT_texture_compression_rgtc` |
| **BC6H / BC7 (BPTC)** | 8 bpp | BC6H: HDR RGB without alpha; BC7: LDR RGB/RGBA | Native | BC7 provides high LDR quality and multiple block modes; BC6H covers HDR | More complex and slower encoding; fixed 8 bpp; WebGL requires `EXT_texture_compression_bptc` |
| **ETC2 / EAC** | 4 bpp for RGB, punch-through alpha, and R11; 8 bpp for RGBA and RG11 | RGB/RGBA, signed/unsigned R/RG | Native | OpenGL ES 3.0 core format family; suitable for mobile; separate data and alpha formats | Less rate flexibility than ASTC; 4 bpp quality depends on content; WebGL availability must be checked through an extension |
| **ASTC 2D** | 8.00–0.89 bpp, blocks from 4×4 to 12×12 | R/RG/RGB/RGBA, LDR/sRGB; optional HDR profile | Native | Widest quality/size choice among standard GPU formats; alpha shares the same 128-bit block; modes are selected per block | Support depends on the GPU/profile; complex encoding; the largest blocks sharply reduce fine-detail quality |
| **PVRTC1** | 2 or 4 bpp | RGB/RGBA | Native on supported PowerVR hardware | Very low fixed rate, including RGBA | The WebGL extension is deprecated; requires power-of-two dimensions; Khronos recommends ETC or ASTC |
| **KTX2 + Basis Universal** | Variable transmission rate; UASTC LDR without supercompression is 8 bpp, while ETC1S targets smaller files | Portable LDR RGB/RGBA; the current implementation also includes HDR modes | Transcode first, then sample a native target format | One distributable file for different GPUs; mip, cubemap, array, streaming, and metadata support; the target gets hardware filtering | The original ETC1S/UASTC supercompressed stream cannot be sampled directly; requires a transcoder, temporary memory, and load time; final GPU size depends on the target format |
| **Uncompressed RGBA8** | 32 bpp | LDR RGBA | Native | Exact and simple representation with universal support | 4–36 times larger than typical compressed texture formats; high bandwidth and cache usage |

BC/S3TC sizes are confirmed by the [WebGL S3TC specification][webgl-s3tc]
and [Microsoft documentation][ms-bc]. BC6H and BC7 use a 128-bit 4×4 block,
which is 8 bpp ([BC6H][ms-bc6h], [BC7][ms-bc7]). ETC2/EAC uses 8- or 16-byte
4×4 blocks depending on the channel count ([Khronos ETC][webgl-etc]). Every
ASTC block occupies 128 bits, while its footprint sets the rate from 8.00 to
0.89 bpp ([ASTC specification][astc-spec]). PVRTC1 provides 2 and 4 bpp rates;
its WebGL extension is now deprecated ([Khronos PVRTC][webgl-pvrtc]).

## Comparison on the current WIC texture

This comparison covers **size only**, not quality at equal distortion. A
meaningful rate-distortion conclusion requires encoding every competing format
at multiple quality profiles and measuring all of them with the same metrics.

Base image: `1100 × 734`, 807,400 pixels, 11 mip levels.

| Full mip-chain representation | Bytes | Bits per base-image pixel | Note |
| --- | ---: | ---: | --- |
| Embedded BPAL base inside BPLM | 215,328 | 2.134 | Level 0 only, 16×16 blocks, 4 local and 256 shared colors |
| **Current BPLM file** | **320,450** | **3.175** | All 11 levels; the mip chain added 48.8% to the embedded BPAL base |
| ASTC 12×12 | 122,080 | 1.210 | Theoretical block size; quality was not compared |
| ASTC 8×8 | 271,520 | 2.690 | Theoretical block size; quality was not compared |
| ASTC 6×6 | 484,176 | 4.797 | Theoretical block size; quality was not compared |
| BC1 / ETC2 RGB | 540,440 | 5.355 | 8 bytes for every 4×4 block |
| BC3 / BC7 / ETC2 RGBA | 1,080,880 | 10.710 | 16 bytes for every 4×4 block |
| **Current BPAL GPU atlases** | **1,328,128** | **13.160** | `MAX_TEXTURE_SIZE = 16384`; indices are unpacked into 8/32-bit texels |
| RGBA8 | 4,304,352 | 42.649 | Exact sum of pixels across 11 levels, excluding API alignment |

Why a 3.175 bpp BPLM file becomes 13.160 bpp on the GPU:

- a local index occupies a complete 8-bit atlas texel even when the file needs
  only 1–4 bits;
- a shared-palette index is stored in an RGBA8 texel, occupying 32 bits instead
  of 3–12 packed bits;
- the shared palette is also uploaded as RGBA8;
- the final row of each atlas may contain a small amount of padding.

Even in this form, the GPU atlases for this texture are approximately 3.24
times smaller than a complete RGBA8 mip chain, but they are larger than BC7 and
substantially larger than BC1/ETC2 RGB. This reveals the largest optimization
opportunity in the current implementation: file packing is already efficient,
but the GPU representation is not.

## Sampling cost

For a regular texel, the current BPAL shader performs:

1. one read of the pixel's local index;
2. one read of the corresponding shared-palette index from the block palette;
3. one read of the final RGB value from the shared palette.

In direct mip mode, the first two steps are combined, leaving two reads. Manual
filtering repeats this path:

| BPAL mode | Reconstructed texels | Maximum atlas texture reads for a regular level |
| --- | ---: | ---: |
| Nearest | 1 | 3 |
| Bilinear | 4 | 12 |
| Trilinear | 8 | 24 |
| 8× anisotropic + trilinear | up to 64 | up to 192 |

This is an upper bound derived from the current shader structure; actual cost
depends on the compiler, texture cache, selected mip levels, and direct mode.
With BCn/ETC2/ASTC, the shader performs a regular texture sample while decode,
bilinear/trilinear filtering, and anisotropic filtering are handled by the GPU
texture unit. BPAL may therefore win in transmission size while losing in
texture bandwidth, instruction count, and texture-cache pressure.

A small shared palette may cache well. On the other hand, reads from the pixel
atlas, block-palette atlas, and shared-palette atlas create three independent
access streams, while a standard block codec reads one local 64/128-bit block.

## BPAL/BPLM advantages

### Format and compression ratio

- Rate is independently controlled by block size, local color count, shared
  palette size, and color format.
- The shared palette avoids storing similar endpoints repeatedly in every
  block.
- Double indexing is particularly effective for illustrations, stylized art,
  user interfaces, voxel/pixel-art-like materials, and textures with a
  recurring color gamut.
- The bitstream is tightly packed without intermediate byte alignment.
- Arbitrary image dimensions, including NPOT, are supported.
- BPLM does not duplicate the shared palette at every mip level.
- Direct mode avoids pointless local indexing when every block pixel can have
  its own shared-palette index.

### Quality controls

- The encoder provides RGB and OKLab, K-means/K-medians, ordered dithering, and
  Floyd–Steinberg dithering.
- The accuracy–diversity tradeoff can preserve rare but visually important
  colors.
- Automatic search builds a size/RMSE Pareto front instead of selecting one
  hard-coded profile.
- Block palettes can be visualized and inspected, making artifacts easier to
  explain than those produced by multi-mode BC7/ASTC blocks.

### Implementation and experimental portability

- The format does not depend on an S3TC/ASTC/ETC2 extension; ordinary WebGL
  textures and a programmable shader are sufficient.
- The CPU decoder is conceptually simple: two index lookups followed by an RGB
  read.
- BPLM demonstrates nearest, bilinear, trilinear, and limited anisotropic
  filtering without depending on a hardware compressed format.
- The same file structure yields the same decoded colors across GPUs when the
  shader and color conversions match.

## BPAL/BPLM disadvantages and risks

### Data limitations

- There is no alpha channel. This excludes foliage, decals, particles, UI
  atlases, hair, smoke, and many other common game textures.
- There is no HDR, no signed-channel support, no R/RG profiles, and no
  specialized normal-map metric.
- There is no explicit metadata for color primaries, transfer function,
  orientation, swizzle, or premultiplied alpha.
- A single RGB quantization model cannot replace specialized BC4/BC5/EAC R/RG
  formats or BC6H/ASTC HDR.

### Quality artifacts

- All colors are first restricted to one shared palette. Gradients,
  photographs, noise, roughness, and small color variations may need a large
  palette or exhibit banding.
- Every block is then restricted to a local subset. Discontinuities and
  rectangular patterns may appear at block boundaries.
- A larger block reduces overhead but leaves fewer colors for a larger area;
  increasing the local palette raises bpp.
- Floyd–Steinberg error intentionally does not cross block boundaries, so it
  cannot completely hide local-palette transitions.
- Every BPLM mip level is tied to the base-level palette. A color that becomes
  important only after downsampling may be represented poorly when shared
  palette construction did not account for the full mip chain.

### GPU performance

- There is no hardware decode path or conventional compressed-texture
  filtering.
- One BPAL sample requires several dependent texture reads. Each next address
  is calculated from the previous read, limiting parallelism.
- Bilinear, trilinear, and anisotropic filtering multiply the number of
  programmatically reconstructed texels.
- The current GPU atlases do not retain the file's dense bit packing.
- Three atlases consume multiple texture units and create separate cache
  working sets.
- Maximum BPAL size is constrained not only by source dimensions but also by
  whether the linear index arrays fit into the permitted 2D atlas dimensions.

### Format and ecosystem

- There is no native support in WebGL, Vulkan, Direct3D, Metal, game engines,
  editors, or content pipelines.
- There is no standard container for cubemaps, texture arrays, 3D textures,
  animation, metadata, or a level index.
- BPLM places the base level before smaller mips. Unlike KTX2, which orders
  levels to support sending small mips first, BPLM cannot efficiently start
  with a low-resolution image without reading the preceding data.
- Format/shader compatibility is entirely the application's responsibility.
- There is not yet a large independent benchmark corpus with equal-rate
  SSIM/PSNR/LPIPS comparisons, so size alone cannot establish whether 2 bpp
  BPAL is better or worse than 2 bpp ASTC/PVRTC/Basis.

## Where BPAL fits best

Good candidates:

- opaque albedo/emissive textures with a limited or recurring palette;
- stylized art, maps, diagrams, alpha-free UI, and pixel/voxel art;
- texture collections where download/storage savings matter more than fragment
  shader cost;
- research into shared and local palette models;
- software rendering or platforms where the application fully controls the
  representation and decoder.

Poor candidates in the current implementation:

- alpha textures such as foliage, decals, particles, and font/UI atlases;
- HDR environment maps and lightmaps;
- normal maps, where angular error matters, and one-/two-channel data maps;
- high-frequency noise, film grain, and photographs with smooth gradients;
- fill-rate-bound scenes with trilinear or anisotropic filtering;
- universal game assets that must load through standard APIs without a custom
  shader.

## Highest-priority improvements

1. **Add alpha and channel profiles.** At minimum: RGB+A, R, RG, and signed RG.
   Optimize angular error rather than RGB RMSE for normal maps.
2. **Preserve density on the GPU.** Evaluate packed index textures,
   `R8UI`/`R16UI` in WebGL2, multiple indices per texel, and a more compact
   block-palette atlas. Measure both byte savings and the additional cost of
   bit extraction.
3. **Add a fast runtime path.** Consider transcoding BPAL/BPLM into BC/ETC2/ASTC
   at load time. This gives up the unique shader decoder but enables native
   filtering and a predictable GPU footprint.
4. **Build the shared palette with the mip chain in mind.** Color weights must
   include all levels; otherwise the base image monopolizes the palette budget.
5. **Redesign BPLM for streaming.** Add a level index with offsets/lengths and
   store small mips first, or permit an independent level order.
6. **Add metadata and resource types.** Color space, orientation, swizzle,
   cubemaps, arrays, and 3D textures. A practical option is to define BPAL as a
   vendor/transcodable KTX2 payload instead of growing the custom container in
   every direction.
7. **Run a fair rate-distortion benchmark.** Use one corpus, identical mips,
   several rates, PSNR/SSIM/LPIPS, alpha-weighted error, angular normal-map
   error, encode time, load/transcode time, GPU bytes, and GPU frame time.

## Recommended selection matrix

| Task | Practical first choice | BPAL/BPLM role |
| --- | --- | --- |
| High-quality desktop albedo | BC7 | Experimental alternative for recurring palettes and a strict download budget |
| Desktop normal map | BC5 | Not suitable yet without an RG/angular profile |
| HDR environment/lightmap | BC6H or ASTC HDR | Not suitable yet |
| Modern mobile | ASTC 6×6/8×8, selected by quality | May produce a smaller file but requires an expensive shader path |
| Mobile fallback | ETC2/EAC | Useful when the extension is unavailable and a custom shader is acceptable |
| One asset for Web/different GPUs | KTX2 + Basis Universal | BPLM's closest strategic competitor |
| Opaque stylized/paletted texture | Compare BPAL with ASTC/Basis on a corpus | BPAL's strongest use case |
| Minimum runtime cost | Native BC/ETC2/ASTC | BPAL loses until a transcode/native path is available |

## Methodological limitations

- This study compares specifications and the current repository implementation,
  not the results of a shared encoder benchmark.
- bpp is not a quality metric. Two equally sized formats may have different
  PSNR/SSIM values and different artifact types.
- Theoretical BC/ETC2/ASTC sizes for the WIC texture are calculated from block
  sizes, rounding every mip up to a complete block; the image was not actually
  encoded by those encoders.
- BPAL GPU figures refer to the current WebGL atlas layout and a texture limit
  of 16384. A different packing scheme will change the result.
- Format support depends on the API, GPU, driver, and WebGL extensions and must
  be detected at runtime.

## Sources

Local specification and implementation:

- [BPAL and encoder description](./BLOCK_PALETTE_README.md)
- [BPAL v3](./BLOCK_PALETTE_FORMAT.md)
- [BPLM v1](./BPLM_FORMAT.md)
- [Mip and GPU atlas construction](./src/decoders/bpal-texture.js)
- [BPAL mip sampler shader](./src/shaders/cube-bpal-sampler.frag.glsl)
- [BPLM encoder/decoder](./src/palette/bplm-format.js)

Official external sources:

- [Microsoft: Block Compression][ms-bc]
- [Microsoft: BC6H][ms-bc6h]
- [Microsoft: BC7][ms-bc7]
- [Khronos: WebGL S3TC][webgl-s3tc]
- [Khronos: WebGL RGTC / BC4–BC5][webgl-rgtc]
- [Khronos: WebGL BPTC / BC6H–BC7][webgl-bptc]
- [Khronos: WebGL ETC2/EAC][webgl-etc]
- [Khronos: ASTC specification][astc-spec]
- [Khronos: WebGL ASTC][webgl-astc]
- [Khronos: WebGL PVRTC][webgl-pvrtc]
- [Khronos: KTX 2.0 specification][ktx2]
- [Khronos: KTX overview][ktx-overview]
- [Basis Universal reference project][basis]
- [Imagination Technologies: image compression vs texture compression][img-texture-compression]

[ms-bc]: https://learn.microsoft.com/en-us/windows/uwp/graphics-concepts/texture-block-compression
[ms-bc6h]: https://learn.microsoft.com/en-us/windows/uwp/graphics-concepts/bc6h-format
[ms-bc7]: https://learn.microsoft.com/en-us/windows/win32/direct3d11/bc7-format
[webgl-s3tc]: https://registry.khronos.org/webgl/extensions/WEBGL_compressed_texture_s3tc/
[webgl-rgtc]: https://registry.khronos.org/webgl/extensions/EXT_texture_compression_rgtc/
[webgl-bptc]: https://registry.khronos.org/webgl/extensions/EXT_texture_compression_bptc/
[webgl-etc]: https://registry.khronos.org/webgl/extensions/WEBGL_compressed_texture_etc/
[astc-spec]: https://registry.khronos.org/OpenGL/extensions/KHR/KHR_texture_compression_astc_hdr.txt
[webgl-astc]: https://registry.khronos.org/webgl/extensions/WEBGL_compressed_texture_astc/
[webgl-pvrtc]: https://registry.khronos.org/webgl/extensions/WEBGL_compressed_texture_pvrtc/
[ktx2]: https://github.khronos.org/KTX-Specification/ktxspec.v2.html
[ktx-overview]: https://www.khronos.org/ktx/
[basis]: https://github.com/BinomialLLC/basis_universal
[img-texture-compression]: https://docs.imgtec.com/performance-guides/graphics-recommendations/html/topics/texture-compression.html
