from __future__ import annotations

import unittest

import numpy as np

from tools.cuda_astc_texture_benchmark import (
    bd_rate,
    normal_angular_stats,
)


class CudaAstcTextureBenchmarkTests(unittest.TestCase):
    def test_identical_curves_have_zero_bd_rate(self) -> None:
        curve = [
            {"payloadBpp": rate, "psnrRgb": quality}
            for rate, quality in [(1.5, 30.0), (2.0, 32.0), (4.0, 36.0), (8.0, 40.0)]
        ]
        self.assertAlmostEqual(bd_rate(curve, curve), 0.0, places=9)

    def test_identical_normal_maps_have_zero_angular_error(self) -> None:
        normal = np.full((16, 16, 3), [128, 128, 255], dtype=np.uint8)
        result = normal_angular_stats(normal, normal.copy())
        self.assertAlmostEqual(result["normalAngleMean"], 0.0, places=6)
        self.assertAlmostEqual(result["normalAngleP95"], 0.0, places=6)


if __name__ == "__main__":
    unittest.main()
