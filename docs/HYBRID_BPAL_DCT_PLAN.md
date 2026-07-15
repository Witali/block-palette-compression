# Hybrid BPAL/DCT compression research plan

## Objective

Test whether a codec that selects BPAL or transform coding per spatial coding
unit can move the RGB PSNR rate-distortion frontier above both pure BPAL and
pure DCT coding.

The comparison must be made at the same final payload size. Selecting the
lower-error reconstruction without charging for its mode map, palettes,
quantization tables, and coefficient stream is useful as an oracle experiment,
but it is not evidence that a hybrid file format is better.

## Recommended first design

Use one binary mode per `16x16` coding unit:

1. **BPAL mode**: one regular `16x16` BPAL block using the image's shared
   palettes.
2. **DCT mode**: one JPEG-like 4:2:0 MCU containing four `8x8` luma transforms
   and one `8x8` transform for each chroma component.

This alignment has three useful properties:

- it preserves the efficient `16x16 / 8 local colors` BPAL family already
  covered by the benchmark;
- it matches the natural `16x16` extent of a 4:2:0 DCT MCU;
- an uncompressed binary mode map costs only one bit per 256 pixels, or
  `0.00390625 bpp` before edge padding.

Starting with a raw mode map is preferable to adding run-length or arithmetic
coding immediately. Its rate is already small, it has predictable cost, and it
keeps decoding and random row access simple. Map compression can be measured
later if selected modes form large connected regions.

The expected division of work is:

- BPAL for flat regions, reused colors, graphics, text-like edges, and sharp
  chroma transitions;
- DCT for photographic detail, smooth gradients, and blocks whose energy is
  concentrated in low spatial frequencies.

These are hypotheses, not encoder rules. The production mode decision should
come from measured rate and decoded RGB error, rather than a gradient or
unique-color threshold.

## Why DCT is not a mode by itself

A DCT only changes representation. Compression also requires a color
transform, coefficient quantization, coefficient ordering, and an entropy or
fixed-rate code.

For the first implementation, use the following deliberately narrow DCT
profile:

- 8-bit YCbCr;
- 4:2:0 chroma sampling aligned to each `16x16` coding unit;
- `8x8` DCT and zig-zag coefficient order;
- one image-level quantization scale, with a small enumerated set of candidate
  scales during encoding;
- fixed Huffman tables initially, so a block's rate remains stable while mode
  decisions change;
- absolute DC coefficients in the first implementation; prediction can be
  tested later with explicit restart points at row or tile boundaries.

RGB PSNR must be calculated after inverse transform, chroma upsampling, YCbCr
to RGB conversion, rounding, and clamping. A coefficient-domain error or luma
error is not an adequate substitute for the project's stored-byte RGB metric.

The existing `src/decoders/gpu-jpeg.js` implementation already provides a
JPEG parser, coefficient layout, zig-zag order, and an IDCT shader. Its IDCT
math can be reused for the experiment. Its standard JPEG entropy parser cannot
directly represent a sparse set of DCT blocks interleaved with BPAL blocks, so
the hybrid stream needs its own container and block traversal.

## Rate-distortion mode selection

For coding unit `b`, candidate mode `m`, and Lagrange multiplier `lambda`, use:

```text
J(b, m) = D_rgb(b, m) + lambda * (R_payload(b, m) + R_mode(b, m))
```

where:

- `D_rgb` is the total squared error over the real RGB pixels in the unit;
- `R_payload` is the number of coded BPAL or DCT bits attributable to the unit;
- `R_mode` is one raw mode bit in the first implementation.

Image-global costs must also be charged:

```text
R_total = R_header + R_palettes + R_quant_tables + R_code_tables
        + R_mode_map + sum(R_payload)
```

The encoder should binary-search `lambda` to approach a target bpp, serialize
the result, and accept only candidates whose actual byte length is within the
budget. Near the target, a small dynamic-programming or local-swap pass can
replace the Lagrangian choice if exact budget use materially improves quality.

The BPAL and DCT choices are globally coupled:

- BPAL palette quality depends on which blocks use BPAL;
- adaptive coefficient codes depend on which blocks use DCT;
- a large palette may not be worth its overhead when few blocks select BPAL.

Use alternating optimization:

1. Build BPAL palettes from all coding units and freeze the initial DCT tables.
2. Generate BPAL and DCT candidate reconstructions and exact per-unit RGB SSE.
3. Select modes using the rate-distortion cost.
4. Rebuild the palettes from only the BPAL-assigned units.
5. Regenerate affected BPAL candidates and select modes again.
6. Stop when the mode map is stable or after a small fixed iteration count.

Adaptive DCT Huffman tables can be added after the fixed-table version works.
When added, refit them between iterations and charge the serialized table size.

For every target rate, also encode pure BPAL and pure DCT candidates and choose
the best final file among all three. This prevents hybrid signaling overhead
from reducing quality on images that strongly prefer one codec.

## BPAL rate example

For a full BPAL block with size `S`, local color count `L`, shared-palette
count `P`, and colors per shared palette `G`, the block-local rate is:

```text
log2(P) + L * log2(G) + S^2 * log2(L) bits
```

For the benchmarked `S=16`, `L=8`, `P=64`, `G=32` family, this is:

```text
6 + 8 * 5 + 256 * 3 = 814 bits per block
814 / 256 = 3.1796875 bpp
```

The image-level shared palette and hybrid mode map are additional costs. This
fixed BPAL block rate makes its candidate easy to compare against the actual
variable number of bits used by one DCT MCU.

## Experimental container

Do not reinterpret BPAL v5 reserved bits. A BPAL v5 payload assumes that every
image block has a selector, local table, and pixel indices, so embedding a
complete BPAL stream would continue paying for DCT-selected blocks.

Use a separate experimental container, provisionally called `BPDH` (Block
Palette/DCT Hybrid), with these logical sections:

1. versioned header with image dimensions, coding-unit size, BPAL parameters,
   DCT profile, and section byte lengths;
2. explicit shared BPAL palettes;
3. DCT quantization and, later, entropy tables;
4. one raw mode bit per `16x16` coding unit in raster order;
5. BPAL records only for units whose mode bit selects BPAL;
6. DCT coefficient records only for units whose mode bit selects DCT.

The two sparse payloads remain in the same raster order as their matching mode
bits, so a streaming decoder can advance each payload without storing a
per-block offset. Optional offsets at row or tile boundaries can be introduced
only if partial decode or random access becomes a requirement.

Images whose dimensions are not multiples of 16 should use edge replication
for transform input, while distortion and PSNR include only real pixels.

## Decoder path

The simplest research decoder should reconstruct a complete RGB image on the
CPU. This makes the bitstream and quality experiment independent of GPU timing.

For WebGL, a practical first path is:

1. parse the two sparse streams on the CPU;
2. decode all DCT units into an RGB texture;
3. upload the BPAL palette/index atlases and the mode map;
4. select the DCT texture or BPAL reconstruction in a lightweight composite
   shader.

The current JPEG shader evaluates a full two-dimensional IDCT for output
samples. Reusing it is acceptable for correctness experiments, but a production
decoder should use a separable two-pass IDCT or CPU/WASM IDCT before judging
decode performance.

## Experiment sequence

### 1. Oracle crossover

Add DCT candidates to the existing deterministic corpus and, for every
`16x16` unit, record:

- BPAL RGB SSE;
- DCT RGB SSE and serialized bits;
- the winning mode;
- source features such as unique colors, variance, gradient energy, and DCT AC
  energy for later analysis only.

Report the PSNR of the lower-error block envelope, explicitly ignoring sparse
container cost. This is an upper bound on hybrid quality and answers the first
question: do the two reconstruction families make different errors on the same
images? If almost every block chooses one family, a hybrid format is unlikely
to justify its complexity.

### 2. Real sparse stream

Implement the raw mode map, sparse BPAL records, fixed-table DCT records, and a
reference decoder. Measure actual bytes and run the rate-distortion selector.
This is the first result that can demonstrate a same-rate PSNR improvement.

### 3. Joint optimization

Rebuild shared palettes after mode assignment, search the existing BPAL
parameter families, enumerate DCT quantization scales, and binary-search
`lambda` for target rates.

Only after this stage should the project test adaptive coefficient tables,
compressed mode maps, or feature-based candidate pruning.

### 4. Optional residual mode

If binary selection shows complementary errors but leaves structured BPAL
banding, add a third candidate: BPAL reconstruction plus a quantized low-
frequency DCT residual. It must compete in the same rate-distortion search and
pay for both its BPAL record and residual coefficients. It should not be part
of the first bitstream version.

## Benchmark requirements

Evaluate at least `2`, `3`, `4`, and `6 bpp` using exact payload bytes. For each
rate and image, report:

- RGB PSNR from pooled stored-byte RGB MSE;
- luma SSIM as a secondary metric;
- BPAL/DCT mode fraction;
- header, palette, table, mode-map, BPAL, and DCT byte counts;
- encode and decode time;
- pure BPAL and pure DCT results at no greater payload bpp.

Use both photographic images and texture/material/graphics classes. Aggregate
PSNR must pool squared error rather than average per-image dB.

The first meaningful success criterion is that the serialized hybrid Pareto
frontier exceeds both pure parent frontiers at matched rate on a heterogeneous
corpus. A useful engineering gate is at least `0.2 dB` aggregate RGB PSNR gain
at one or more target rates without relying on a small hand-picked subset.

## Main risks

- **Palette feedback:** removing DCT-selected blocks can improve or destabilize
  the palettes used by the remaining BPAL blocks.
- **Chroma loss:** 4:2:0 can reduce RGB PSNR on colored edges; the hypothesis is
  that BPAL will win those units, but this must be measured.
- **Entropy coupling:** an estimated DCT rate can be wrong after the selected
  coefficient population changes. Fixed tables avoid this in the first pass.
- **Tiny BPAL population:** palette overhead can dominate when few units select
  BPAL. The global search must retain pure DCT and smaller-palette candidates.
- **Decoder cost:** higher PSNR does not imply efficient GPU sampling. Storage,
  GPU memory, and sampling cost remain separate metrics.
- **Oracle overstatement:** choosing between two complete decoded images does
  not account for the cost of storing sparse records from both codecs.

## Decision

Proceed first with the `16x16` binary BPAL/DCT experiment and a raw mode map.
Do not begin by modifying BPAL v5, designing a learned classifier, or adding a
residual mode. The oracle crossover and then the real sparse-rate benchmark
will determine whether the additional format and decoder complexity buys
measurable PSNR.
