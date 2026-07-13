"""Unit tests for the unified texture benchmark metrics."""

import math
import unittest

import numpy as np

from benchmark.metrics import psnr_rgb, rgb_error, ssim_luma
from tools.texture_codec_benchmark import (
    BPAL_REFINEMENT_PASSES,
    PROFILES,
    expected_effective_settings,
)


class MetricTests(unittest.TestCase):
    def test_identical_images_have_perfect_scores(self) -> None:
        image = np.arange(16 * 16 * 4, dtype=np.uint8).reshape((16, 16, 4))
        self.assertTrue(math.isinf(psnr_rgb(image, image.copy())))
        self.assertAlmostEqual(ssim_luma(image, image.copy()), 1.0, places=6)

    def test_rgb_error_ignores_alpha(self) -> None:
        reference = np.zeros((2, 2, 4), dtype=np.uint8)
        candidate = reference.copy()
        candidate[:, :, 3] = 255
        mse, squared_error, count = rgb_error(reference, candidate)
        self.assertEqual(mse, 0.0)
        self.assertEqual(squared_error, 0.0)
        self.assertEqual(count, 12)

    def test_known_constant_error_has_expected_psnr(self) -> None:
        reference = np.zeros((8, 8, 3), dtype=np.uint8)
        candidate = np.full((8, 8, 3), 10, dtype=np.uint8)
        expected = 10.0 * math.log10((255.0 * 255.0) / 100.0)
        self.assertAlmostEqual(psnr_rgb(reference, candidate), expected, places=12)

    def test_shape_mismatch_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "Image shapes differ"):
            psnr_rgb(
                np.zeros((8, 8, 3), dtype=np.uint8),
                np.zeros((8, 9, 3), dtype=np.uint8),
            )

    def test_every_bpal_profile_pins_refinement_settings(self) -> None:
        bpal_profiles = [
            profile for profile in PROFILES
            if profile["adapter"] in {"bpal", "bpal-native"}
        ]

        self.assertTrue(bpal_profiles)
        for profile in bpal_profiles:
            settings = expected_effective_settings(profile)
            self.assertIsNotNone(settings)
            self.assertEqual(settings["refinementPasses"], BPAL_REFINEMENT_PASSES)

    def test_native_bpal_comparison_covers_single_64_and_128_palettes(self) -> None:
        native_palette_counts = {
            profile["settings"]["paletteCount"]
            for profile in PROFILES
            if profile["adapter"] == "bpal-native"
        }

        self.assertEqual(native_palette_counts, {1, 64, 128})


if __name__ == "__main__":
    unittest.main()
