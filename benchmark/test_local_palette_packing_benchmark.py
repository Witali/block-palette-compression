from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tools.local_palette_packing_benchmark import (
    BENCHMARK_VERSION,
    is_reusable_record,
    load_resume_records,
    select_images,
)


class LocalPalettePackingBenchmarkTests(unittest.TestCase):
    def test_default_selection_uses_the_complete_200_image_matrix(self) -> None:
        images = []
        for dataset, count in (("dtd", 100), ("kylberg", 45), ("ambientcg", 55)):
            for index in range(count):
                images.append(
                    {
                        "imageId": f"{dataset}/{index:03d}",
                        "dataset": dataset,
                        "imageClass": f"map-{index % 7}",
                        "contentClass": f"class-{index % 11}",
                    }
                )

        selected = select_images(images, None)

        self.assertEqual(len(selected), 200)
        self.assertEqual(sum(image["dataset"] == "dtd" for image in selected), 100)
        self.assertEqual(sum(image["dataset"] == "kylberg" for image in selected), 45)
        self.assertEqual(sum(image["dataset"] == "ambientcg" for image in selected), 55)
        self.assertEqual(
            [image["imageId"] for image in selected],
            [image["imageId"] for image in select_images(images, None)],
        )

    def test_resume_requires_matching_source_and_verified_results(self) -> None:
        image = {"sourceSha256": "abc", "pixelCount": 64}
        row = {
            "benchmarkVersion": BENCHMARK_VERSION,
            "sourceSha256": "abc",
            "pixelCount": 64,
            "settingsMatch": True,
            "decodedIdentical": True,
            "savedBytes": 0,
        }

        self.assertTrue(is_reusable_record(row, image))
        self.assertFalse(is_reusable_record({**row, "sourceSha256": "def"}, image))
        self.assertFalse(is_reusable_record({**row, "decodedIdentical": False}, image))
        self.assertFalse(is_reusable_record({**row, "savedBytes": -1}, image))

    def test_resume_loader_keeps_latest_complete_key(self) -> None:
        rows = [
            {"imageId": "dtd/a", "target": "2", "savedBytes": 1},
            {"imageId": "dtd/a", "target": "2", "savedBytes": 2},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "records.jsonl"
            path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            loaded = load_resume_records(path)

        self.assertEqual(loaded[("dtd/a", "2")]["savedBytes"], 2)


if __name__ == "__main__":
    unittest.main()
