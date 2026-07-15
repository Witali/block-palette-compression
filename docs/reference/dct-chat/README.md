# DCT chat source artifacts

This directory preserves source artifacts attached to the
[shared ChatGPT conversation](https://chatgpt.com/share/6a576088-76fc-83ed-9cf7-2d59e1693c69)
used as the starting point for the DCT compression page.

## Preserved source

`dctbs_converter_with_edge_dictionary.html` is the final, self-contained
converter attached to the conversation. It is intentionally stored unchanged.

- Size: 93,559 bytes
- SHA-256: `59F8F55129A77A4B3B432AD39C4446F3A9A57F21B93BC144845CDFAC2A80A1A2`
- Format: DCTBS2 with fixed-size DCT records, YCbCr 4:2:2 MCU modes,
  automatic quantization search, and the inline edge-residual dictionary

Production code lives under `src/dct/` and is adapted from this file to the
repository's style, localization, testing, and bounded random-access
requirements.

## Historical attachments

The shared conversation also references these earlier generated artifacts.
Their old sandbox URLs are no longer downloadable from the shared page, so the
names are recorded here for provenance:

- `dct24_scaled_codec.zip`, `jpeg_to_dct24s.c`, `dct24s.frag`, `viewer.html`,
  `FORMAT.md`, and `README.md`
- `dct24_converter.html`
- `dctbs_converter_32_24_16.html`
- `dctbs_converter_equal_bpp.html`
- `dctbs_converter_equal_bpp_improved.html`
- `dctbs_converter_auto_quant.html`
- `dctbs_converter_auto_quant_more_modes.html`
- `dctbs_fragment_shaders.zip` and the individual DCTBS fragment shaders

The preserved final converter supersedes the historical HTML variants.
