from __future__ import annotations

import unittest

import numpy as np

from tools.cuda_astc_texture_benchmark import (
    allocate_sample_quotas,
    bd_rate,
    normal_angular_stats,
    stratified_pick,
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

    def test_default_sample_allocation_is_100_45_55(self) -> None:
        available = {"dtd": 5640, "kylberg": 240, "ambientcg": 55}
        self.assertEqual(
            allocate_sample_quotas(available, 200),
            {"dtd": 100, "kylberg": 45, "ambientcg": 55},
        )

    def test_stratified_pick_round_robins_classes(self) -> None:
        images = [
            {
                "id": f"dtd/{image_class}/{index}",
                "dataset": "dtd",
                "imageClass": "texture",
                "contentClass": image_class,
            }
            for image_class in ("a", "b", "c")
            for index in range(3)
        ]
        selected = stratified_pick(images, 6)
        counts = {image_class: 0 for image_class in ("a", "b", "c")}
        for image in selected:
            counts[image["contentClass"]] += 1
        self.assertEqual(counts, {"a": 2, "b": 2, "c": 2})


if __name__ == "__main__":
    unittest.main()
