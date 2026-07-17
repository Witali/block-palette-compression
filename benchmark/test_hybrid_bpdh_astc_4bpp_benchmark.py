from __future__ import annotations

import unittest

from tools.hybrid_bpdh_astc_4bpp_benchmark import (
    aggregate_records,
    allocate_sample_quotas,
    interpolate_operating_point,
    make_bpdh_settings,
    select_bpdh_records,
)


class HybridBpdhAstcBenchmarkTests(unittest.TestCase):
    def test_default_sample_allocation_matches_the_texture_corpus(self) -> None:
        available = {"dtd": 5640, "kylberg": 240, "ambientcg": 55}
        self.assertEqual(
            allocate_sample_quotas(available, 200),
            {"dtd": 100, "kylberg": 45, "ambientcg": 55},
        )

    def test_bpdh_selection_uses_lowest_error_candidate_within_budget(self) -> None:
        records = [
            self.bpdh_record("image-a", "too-large", 4.1, 10.0, False),
            self.bpdh_record("image-a", "smaller", 3.2, 30.0, True),
            self.bpdh_record("image-a", "better", 3.9, 20.0, True),
        ]
        selected = select_bpdh_records(records, 4.0)
        self.assertEqual([record["profileId"] for record in selected], ["better"])

    def test_astc_interpolation_is_linear_in_log_rate(self) -> None:
        points = [
            {
                "profileId": "low",
                "payloadBpp": 2.0,
                "psnrRgb": 30.0,
                "ssimLumaMean": 0.8,
            },
            {
                "profileId": "high",
                "payloadBpp": 8.0,
                "psnrRgb": 40.0,
                "ssimLumaMean": 1.0,
            },
        ]
        result = interpolate_operating_point(points, 4.0)
        self.assertIsNotNone(result)
        assert result is not None
        self.assertAlmostEqual(result["psnrRgb"], 35.0)
        self.assertAlmostEqual(result["ssimLumaMean"], 0.9)

    def test_bpdh_aggregate_pools_error_and_mode_counts(self) -> None:
        records = [
            self.full_record(100.0, 3, 1),
            self.full_record(300.0, 1, 3),
        ]
        aggregate = aggregate_records(records)
        self.assertEqual(aggregate["bpalBlocks"], 4)
        self.assertEqual(aggregate["dctBlocks"], 4)
        self.assertAlmostEqual(aggregate["bpalBlockPercent"], 50.0)
        self.assertEqual(aggregate["mixedImageCount"], 2)

    def test_bpdh_settings_cap_palette_count_to_available_blocks(self) -> None:
        profile = {
            "localColorCount": 8,
            "globalColorCount": 32,
            "paletteCount": 16,
            "paletteColorBits": 24,
        }
        settings = make_bpdh_settings(profile, 17, 17, 4.0)
        self.assertEqual(settings["bpal"]["paletteCount"], 4)
        self.assertEqual(settings["targetBitsPerPixel"], 4.0)

    @staticmethod
    def bpdh_record(
        image_id: str,
        profile_id: str,
        payload_bpp: float,
        squared_error: float,
        within_target: bool,
    ) -> dict[str, object]:
        return {
            "codec": "BPDH",
            "imageId": image_id,
            "profileId": profile_id,
            "payloadBpp": payload_bpp,
            "payloadBytes": int(payload_bpp * 100),
            "squaredErrorRgb": squared_error,
            "withinTarget": within_target,
        }

    @staticmethod
    def full_record(squared_error: float, bpal_blocks: int, dct_blocks: int) -> dict[str, object]:
        return {
            "codec": "BPDH",
            "pixelCount": 16,
            "rgbSampleCount": 48,
            "squaredErrorRgb": squared_error,
            "payloadBytes": 8,
            "artifactBytes": 10,
            "ssimLuma": 0.9,
            "encodeMilliseconds": 1.0,
            "decodeMilliseconds": 1.0,
            "bpalBlocks": bpal_blocks,
            "dctBlocks": dct_blocks,
        }


if __name__ == "__main__":
    unittest.main()
