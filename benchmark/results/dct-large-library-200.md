# Large-texture DCT prototype-library benchmark

Generated: 2026-07-15T14:29:18.294Z

Corpus: 200 deterministic 512x512 center crops (ambientcg 55, dtd 100, kylberg 45).

The comparison uses identical fixed MCU payloads. Prototype records and the sidecar index stream are intentionally excluded from the selection criterion; their cost can be amortized or evaluated separately.

The sidecar mode keeps existing DCT profiles unchanged. It stores directly addressed per-block library indices outside the MCU records: 5 bits for 16 prototypes plus raw mode, or 6 bits for 32 prototypes plus raw mode.

| Payload bpp | Mode | PSNR RGB | Delta vs baseline | Referenced Y blocks | Mean uses / prototype / image |
| ---: | :--- | ---: | ---: | ---: | ---: |
| 0.75 | Baseline | 25.146 dB | +0.000 dB | 0.00% | 0.0 |
| 0.75 | Header library K=3 | 25.197 dB | +0.052 dB | 73.97% | 252.5 |
| 0.75 | Sidecar library K=32 | 25.315 dB | +0.169 dB | 83.22% | 26.6 |
| 0.75 | Spectral-split sidecar K=32 (25%) | 25.390 dB | +0.245 dB | 54.01% | 17.3 |
| 1 | Baseline | 26.045 dB | +0.000 dB | 0.00% | 0.0 |
| 1 | Header library K=3 | 26.100 dB | +0.054 dB | 75.72% | 258.4 |
| 1 | Sidecar library K=32 | 26.213 dB | +0.168 dB | 84.27% | 27.0 |
| 1 | Spectral-split sidecar K=32 (25%) | 26.263 dB | +0.218 dB | 60.17% | 19.3 |
| 1.5 | Baseline | 27.474 dB | +0.000 dB | 0.00% | 0.0 |
| 1.5 | Header library K=3 | 27.512 dB | +0.039 dB | 74.42% | 254.0 |
| 1.5 | Sidecar library K=32 | 27.595 dB | +0.121 dB | 83.80% | 26.8 |
| 1.5 | Spectral-split sidecar K=32 (25%) | 27.660 dB | +0.187 dB | 48.49% | 15.5 |
| 2 | Baseline | 28.511 dB | +0.000 dB | 0.00% | 0.0 |
| 2 | Header library K=3 | 28.570 dB | +0.059 dB | 74.21% | 253.3 |
| 2 | Sidecar library K=32 | 28.675 dB | +0.164 dB | 84.77% | 27.1 |
| 2 | Spectral-split sidecar K=32 (25%) | 28.695 dB | +0.183 dB | 48.42% | 15.5 |
| 3 | Baseline | 30.725 dB | +0.000 dB | 0.00% | 0.0 |
| 3 | Header library K=3 | 30.778 dB | +0.053 dB | 72.22% | 986.0 |
| 3 | Sidecar library K=32 | 30.900 dB | +0.175 dB | 77.49% | 99.2 |
| 3 | Spectral-split sidecar K=32 (25%) | 31.004 dB | +0.280 dB | 49.31% | 63.1 |
| 4.5 | Baseline | 33.549 dB | +0.000 dB | 0.00% | 0.0 |
| 4.5 | Header library K=3 | 33.608 dB | +0.059 dB | 70.47% | 962.2 |
| 4.5 | Sidecar library K=32 | 33.725 dB | +0.176 dB | 77.81% | 99.6 |
| 4.5 | Spectral-split sidecar K=32 (25%) | 33.769 dB | +0.219 dB | 37.01% | 47.4 |
| 6 | Baseline | 35.849 dB | +0.000 dB | 0.00% | 0.0 |
| 6 | Header library K=3 | 35.943 dB | +0.094 dB | 70.16% | 957.9 |
| 6 | Sidecar library K=32 | 36.099 dB | +0.250 dB | 77.75% | 99.5 |
| 6 | Spectral-split sidecar K=32 (25%) | 36.069 dB | +0.220 dB | 35.44% | 45.4 |

## Selected profile

For each payload, select the higher-PSNR result between the regular K=32 sidecar library and the 25% spectral-split K=32 sidecar library. The existing baseline and three-entry header library remain independent formats.

| Payload bpp | Selected library mode | PSNR delta | Referenced Y blocks |
| ---: | :--- | ---: | ---: |
| 0.75 | Spectral-split sidecar K=32 (25%) | +0.245 dB | 54.01% |
| 1 | Spectral-split sidecar K=32 (25%) | +0.218 dB | 60.17% |
| 1.5 | Spectral-split sidecar K=32 (25%) | +0.187 dB | 48.49% |
| 2 | Spectral-split sidecar K=32 (25%) | +0.183 dB | 48.42% |
| 3 | Spectral-split sidecar K=32 (25%) | +0.280 dB | 49.31% |
| 4.5 | Spectral-split sidecar K=32 (25%) | +0.219 dB | 37.01% |
| 6 | Sidecar library K=32 | +0.250 dB | 77.75% |

## Prototype-count pilot

A balanced 12-image pilot compared 3, 8, 16, and 32 sidecar prototypes before the full run. K=32 was the best regular sidecar size at every sampled rate. Its PSNR gains over baseline were +0.125, +0.142, and +0.332 dB at 1, 3, and 6 bpp, versus +0.088, +0.107, and +0.283 dB for K=16. The full 200-image run therefore uses K=32.

## Reproduction

```text
python tools/prepare_dct_large_texture_corpus.py --selection-manifest .tmp/dct-exponent-corpus-128/manifest.json --source-root .benchmark-corpus --output-dir .tmp/dct-library-corpus-512 --crop-size 512 --dtd-count 100
node tools/dct_large_library_benchmark.js --corpus .tmp/dct-library-corpus-512 --baseline .tmp/dct-exponent-final.json --records .tmp/dct-large-full.jsonl --modes baseline,header3,sidecar32,sidecar32q --candidate-count 4 --cluster-samples 4096
node tools/summarize_dct_large_library_benchmark.js --records .tmp/dct-large-full.jsonl --output .tmp/dct-large-library-200.json --report benchmark/results/dct-large-library-200.md
```
