# DCT grouped-exponent benchmark (200 textures)

Date: 2026-07-15

## Result

Grouped binary exponents improve pooled RGB PSNR at the same DCTBS2 record
size in every supported rate. The production encoder now uses two equal AC
groups at 0.75, 1, and 2 bpp and three front-loaded AC groups at 1.5, 3, 4.5,
and 6 bpp. The legacy coding remains decodable.

The final comparison used the same deterministic 200-image sample as the CUDA
ASTC benchmark: 55 ambientCG maps, 100 DTD textures, and 45 Kylberg textures.
Each source was normalized to RGB8 using the existing benchmark rules, then a
128x128 center crop was evaluated. This covers 3,276,800 pixels and 9,830,400
RGB channel samples. Center crops were used because the JavaScript reference
encoder is deliberately scalar; this report does not claim a full-resolution
200-image run.

For every image, coding, and rate, qualities 85, 92, 97, and 100 were encoded
and decoded. The result with the lowest exact RGB squared error was retained.
PSNR below is pooled from the summed error and sample count, not averaged in
dB. Header and payload sizes are identical between the compared codings.

| Nominal bpp | Legacy PSNR | Grouped PSNR | Gain | Images improved | Selected grouping |
|---:|---:|---:|---:|---:|:---|
| 0.75 | 24.4732 dB | 24.5814 dB | +0.1082 dB | 160/200 | 2 equal groups |
| 1 | 25.2518 dB | 25.5138 dB | +0.2620 dB | 198/200 | 2 equal groups |
| 1.5 | 26.5695 dB | 26.9379 dB | +0.3684 dB | 199/200 | 3 front-loaded groups |
| 2 | 27.4637 dB | 27.9132 dB | +0.4495 dB | 187/200 | 2 equal groups |
| 3 | 29.6016 dB | 30.0776 dB | +0.4759 dB | 198/200 | 3 front-loaded groups |
| 4.5 | 31.9967 dB | 32.8164 dB | +0.8197 dB | 197/200 | 3 front-loaded groups |
| 6 | 34.0136 dB | 35.2380 dB | +1.2244 dB | 193/200 | 3 front-loaded groups |

## Profile screening

The first pass evaluated all profiles at quality 97 on 64x64 center crops from
all 200 images. Values are pooled RGB PSNR in dB.

| Coefficient coding | 0.75 | 1 | 1.5 | 2 | 3 | 4.5 | 6 |
|:---|---:|---:|---:|---:|---:|---:|---:|
| Legacy: 6-bit AC, one exponent | 24.5896 | 25.3739 | 26.6680 | 27.5275 | 29.5881 | 31.6876 | 33.1830 |
| 5-bit AC, 2 equal groups | **24.6941** | **25.6410** | 27.0017 | 27.9586 | 29.9895 | 32.3988 | 34.2632 |
| 5-bit AC, 3 equal groups | 24.5496 | 25.6338 | 27.0117 | 27.9397 | 30.0510 | 32.5840 | 34.6621 |
| 5-bit AC, 4 equal groups | 24.5007 | 25.4947 | 26.9335 | 27.9526 | 29.8597 | 32.4916 | 34.8212 |
| 5-bit AC, 3 front-loaded groups | 24.5503 | 25.6379 | **27.0190** | **27.9616** | **30.0662** | **32.6689** | 34.8736 |
| 5-bit AC, quarter/half groups | 24.5491 | 25.6355 | 27.0156 | 27.9522 | 30.0617 | 32.6295 | 34.7391 |
| 5-bit AC, fixed 8/24 boundaries | 24.5416 | 25.6251 | 27.0119 | 27.9592 | 30.0286 | 32.6554 | **34.8979** |
| 6-bit AC, 3 equal groups | 24.1119 | 25.0540 | 26.4707 | 27.4669 | 29.1350 | 31.5887 | 33.7881 |

The 6-bit grouped control usually lost because exponent overhead removed AC
coefficients. Five-bit mantissas recovered that space and consistently won.
The fixed 8/24 profile was only marginally ahead at 6 bpp in the screening
pass and was statistically tied with the simpler front-loaded profile in the
larger final pass (35.2375 versus 35.2380 dB), so it was not retained.

## Dataset consistency

The table shows the final selected coding's PSNR gain over legacy for each
dataset.

| Nominal bpp | ambientCG (55) | DTD (100) | Kylberg (45) |
|---:|---:|---:|---:|
| 0.75 | +0.0120 dB | +0.0900 dB | +0.2427 dB |
| 1 | +0.1792 dB | +0.2736 dB | +0.3040 dB |
| 1.5 | +0.1985 dB | +0.3715 dB | +0.5449 dB |
| 2 | +0.3153 dB | +0.4752 dB | +0.5269 dB |
| 3 | +0.3032 dB | +0.5218 dB | +0.6203 dB |
| 4.5 | +0.4671 dB | +0.9453 dB | +1.2897 dB |
| 6 | +0.6152 dB | +1.6241 dB | +2.1912 dB |

## Format and decoder cost

Legacy component records store a four-bit scan profile, a shared three-bit
binary scale index, a signed 10-bit DC value, and signed 6-bit AC values. A
grouped record keeps the DC scale in the component header, stores two or three
three-bit AC scale indices, and uses signed 5-bit AC mantissas. Every scale is
still exactly `1 << exponent`.

Group membership is fixed by the file-level coding flag and the AC ordinal in
the selected scan. No variable-length coding, prediction chain, dictionary
lookup, or data-dependent loop is added. Fixed MCU offsets are unchanged, so
random pixel access still reads one MCU and, for split high-rate luma, one
selected 8x8 Y record. The CUDA decoder performs bounded bit reads and
power-of-two scaling only.

## Reproduction

The tracked tools are:

- `tools/prepare_dct_exponent_corpus.py` for deterministic RGB crop materialization;
- `tools/dct_exponent_benchmark.js` for exact encode/decode/error measurement;
- `tools/summarize_dct_exponent_benchmark.js` for the aggregate tables.

The implementation was verified with the complete JavaScript test suite, a
fresh NVCC build, and the bidirectional JavaScript/CUDA compatibility test for
all seven rates, direct pixel sampling, direct JPEG DCT import, and legacy
record decoding.
