# Clustered DCT prototype library benchmark

Generated: 2026-07-15T13:23:17.508Z

Corpus: 200 deterministic 128x128 center crops (ambientcg 55, dtd 100, kylberg 45).

Each Y, Cb, and Cr component is clustered independently. A component record stores a quantized residual and a prototype reference. Library sizes 1-3 place the reference in two previously unused header bits and retain the complete baseline coefficient budget. Size 4 is a control mode that replaces the final AC mantissa with a wider reference.

The file-bpp column includes the 64-byte DCTBS2 header and the per-image prototype library. The same-payload delta treats the library as an external or amortized resource. The same-total delta compares against the baseline at the same complete file rate by interpolation without extrapolation.

| Components | Library entries | Reference | Payload bpp | File bpp | PSNR RGB | Delta at same payload | Delta at same total size |
| :--- | ---: | :--- | ---: | ---: | ---: | ---: | ---: |
| all | 1 | header | 0.75 | 0.8086 | 24.609 dB | +0.028 dB | -0.088 dB |
| all | 1 | header | 1.00 | 1.0625 | 25.541 dB | +0.027 dB | -0.081 dB |
| all | 1 | header | 1.50 | 1.5703 | 26.965 dB | +0.027 dB | -0.060 dB |
| all | 1 | header | 2.00 | 2.0781 | 27.947 dB | +0.034 dB | -0.090 dB |
| all | 1 | header | 3.00 | 3.0703 | 30.106 dB | +0.028 dB | -0.059 dB |
| all | 1 | header | 4.50 | 4.5820 | 32.855 dB | +0.038 dB | -0.056 dB |
| all | 1 | header | 6.00 | 6.0938 | 35.297 dB | +0.059 dB | n/a |
| all | 2 | header | 0.75 | 0.8203 | 24.647 dB | +0.065 dB | -0.099 dB |
| all | 2 | header | 1.00 | 1.0781 | 25.572 dB | +0.058 dB | -0.102 dB |
| all | 2 | header | 1.50 | 1.5938 | 26.993 dB | +0.055 dB | -0.083 dB |
| all | 2 | header | 2.00 | 2.1094 | 27.984 dB | +0.071 dB | -0.133 dB |
| all | 2 | header | 3.00 | 3.0938 | 30.144 dB | +0.066 dB | -0.073 dB |
| all | 2 | header | 4.50 | 4.6172 | 32.898 dB | +0.082 dB | -0.077 dB |
| all | 2 | header | 6.00 | 6.1406 | 35.365 dB | +0.127 dB | n/a |
| all | 3 | header | 0.75 | 0.8320 | 24.681 dB | +0.099 dB | -0.112 dB |
| all | 3 | header | 1.00 | 1.0938 | 25.601 dB | +0.087 dB | -0.125 dB |
| all | 3 | header | 1.50 | 1.6172 | 27.018 dB | +0.080 dB | -0.109 dB |
| all | 3 | header | 2.00 | 2.1406 | 28.016 dB | +0.103 dB | -0.181 dB |
| all | 3 | header | 3.00 | 3.1172 | 30.182 dB | +0.104 dB | -0.086 dB |
| all | 3 | header | 4.50 | 4.6523 | 32.944 dB | +0.127 dB | -0.096 dB |
| all | 3 | header | 6.00 | 6.1875 | 35.428 dB | +0.190 dB | n/a |
| all | 4 | tail | 0.75 | 0.8438 | 24.569 dB | -0.012 dB | -0.271 dB |
| all | 4 | tail | 1.00 | 1.1094 | 25.513 dB | -0.001 dB | -0.264 dB |
| all | 4 | tail | 1.50 | 1.6406 | 26.951 dB | +0.013 dB | -0.225 dB |
| all | 4 | tail | 2.00 | 2.1719 | 27.971 dB | +0.058 dB | -0.304 dB |
| all | 4 | tail | 3.00 | 3.1406 | 29.980 dB | -0.097 dB | -0.339 dB |
| all | 4 | tail | 4.50 | 4.6875 | 32.764 dB | -0.052 dB | -0.339 dB |
| all | 4 | tail | 6.00 | 6.2344 | 35.284 dB | +0.046 dB | n/a |
| y | 1 | header | 0.75 | 0.8027 | 24.605 dB | +0.024 dB | -0.067 dB |
| y | 1 | header | 1.00 | 1.0547 | 25.538 dB | +0.024 dB | -0.057 dB |
| y | 1 | header | 1.50 | 1.5586 | 26.962 dB | +0.024 dB | -0.037 dB |
| y | 1 | header | 2.00 | 2.0625 | 27.943 dB | +0.030 dB | -0.052 dB |
| y | 1 | header | 3.00 | 3.0547 | 30.100 dB | +0.023 dB | -0.030 dB |
| y | 1 | header | 4.50 | 4.5586 | 32.847 dB | +0.031 dB | -0.020 dB |
| y | 1 | header | 6.00 | 6.0625 | 35.285 dB | +0.047 dB | n/a |
| y | 2 | header | 0.75 | 0.8086 | 24.636 dB | +0.055 dB | -0.061 dB |
| y | 2 | header | 1.00 | 1.0625 | 25.567 dB | +0.053 dB | -0.055 dB |
| y | 2 | header | 1.50 | 1.5703 | 26.986 dB | +0.048 dB | -0.039 dB |
| y | 2 | header | 2.00 | 2.0781 | 27.978 dB | +0.065 dB | -0.059 dB |
| y | 2 | header | 3.00 | 3.0625 | 30.134 dB | +0.057 dB | -0.013 dB |
| y | 2 | header | 4.50 | 4.5703 | 32.884 dB | +0.068 dB | -0.005 dB |
| y | 2 | header | 6.00 | 6.0781 | 35.344 dB | +0.106 dB | n/a |
| y | 3 | header | 0.75 | 0.8145 | 24.667 dB | +0.086 dB | -0.054 dB |
| y | 3 | header | 1.00 | 1.0703 | 25.593 dB | +0.079 dB | -0.054 dB |
| y | 3 | header | 1.50 | 1.5820 | 27.008 dB | +0.070 dB | -0.043 dB |
| y | 3 | header | 2.00 | 2.0938 | 28.007 dB | +0.094 dB | -0.070 dB |
| y | 3 | header | 3.00 | 3.0703 | 30.167 dB | +0.090 dB | +0.003 dB |
| y | 3 | header | 4.50 | 4.5820 | 32.923 dB | +0.107 dB | +0.012 dB |
| y | 3 | header | 6.00 | 6.0938 | 35.398 dB | +0.160 dB | n/a |
| y | 4 | tail | 0.75 | 0.8203 | 24.530 dB | -0.051 dB | -0.215 dB |
| y | 4 | tail | 1.00 | 1.0781 | 25.498 dB | -0.016 dB | -0.176 dB |
| y | 4 | tail | 1.50 | 1.5938 | 26.936 dB | -0.002 dB | -0.140 dB |
| y | 4 | tail | 2.00 | 2.1094 | 27.958 dB | +0.045 dB | -0.159 dB |
| y | 4 | tail | 3.00 | 3.0781 | 29.960 dB | -0.117 dB | -0.222 dB |
| y | 4 | tail | 4.50 | 4.5938 | 32.735 dB | -0.081 dB | -0.197 dB |
| y | 4 | tail | 6.00 | 6.1094 | 35.241 dB | +0.003 dB | n/a |

## Result

The selected implementation is the three-entry Y-only library. It keeps every baseline coefficient, improves same-payload PSNR at every measured rate, and reduces standalone rate-distortion cost at 3 bpp (+0.003 dB, +0.039% estimated size) and 4.5 bpp (+0.012 dB, +0.145% estimated size). The page therefore exposes it only for 3 bpp and higher. Lower rates retain the baseline format because their small records do not amortize the library header on 128x128 crops.

The four-entry tail-reference control is not selected: losing one AC coefficient outweighs the larger codebook on most profiles.


## Baseline

| Payload bpp | File bpp | PSNR RGB |
| ---: | ---: | ---: |
| 0.75 | 0.7813 | 24.581 dB |
| 1.00 | 1.0313 | 25.514 dB |
| 1.50 | 1.5313 | 26.938 dB |
| 2.00 | 2.0313 | 27.913 dB |
| 3.00 | 3.0313 | 30.078 dB |
| 4.50 | 4.5313 | 32.816 dB |
| 6.00 | 6.0313 | 35.238 dB |

## Interpretation

A positive same-payload delta means the clustered prototype improves coefficient prediction when the library is already resident or reused. A positive same-total delta is required for a smaller standalone file at equal PSNR. The 6 bpp rows have no same-total comparison because the library moves them beyond the measured baseline range.

## Reproduction

```text
node tools/dct_library_benchmark.js --baseline .tmp/dct-exponent-final.json --corpus .tmp/dct-exponent-corpus-128 --records .tmp/dct-library-200.jsonl --output .tmp/dct-library-200.json --report benchmark/results/dct-prototype-library-200.md --library-sizes 1,2,3,4 --component-profiles all,y
```
