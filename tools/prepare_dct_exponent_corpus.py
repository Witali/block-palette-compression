#!/usr/bin/env python3
"""Prepare deterministic RGB8 center crops for the DCT exponent benchmark."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--records", type=Path, required=True)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--crop-size", type=int, default=128)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    unique: dict[str, dict[str, object]] = {}

    with args.records.open("r", encoding="utf-8") as stream:
        for line in stream:
            record = json.loads(line)
            unique.setdefault(
                record["imageId"],
                {
                    "id": record["imageId"],
                    "dataset": record["dataset"],
                    "imageClass": record["imageClass"],
                    "contentClass": record["contentClass"],
                },
            )

    images = []
    for image_id, metadata in sorted(unique.items()):
        file_id = hashlib.sha256(image_id.encode("utf-8")).hexdigest()[:20]
        source_path = args.source_dir / f"{file_id}.png"
        raw_path = args.output_dir / f"{file_id}.rgb"

        with Image.open(source_path) as image:
            rgb = image.convert("RGB")
            if rgb.width < args.crop_size or rgb.height < args.crop_size:
                raise ValueError(f"{source_path} is smaller than the requested crop")
            left = (rgb.width - args.crop_size) // 2
            top = (rgb.height - args.crop_size) // 2
            crop = rgb.crop((left, top, left + args.crop_size, top + args.crop_size))
            raw_path.write_bytes(crop.tobytes())

        images.append(
            {
                **metadata,
                "width": args.crop_size,
                "height": args.crop_size,
                "file": raw_path.name,
            }
        )

    manifest = {
        "schemaVersion": 1,
        "crop": "center",
        "cropSize": args.crop_size,
        "imageCount": len(images),
        "images": images,
    }
    (args.output_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Prepared {len(images)} center crops in {args.output_dir}")


if __name__ == "__main__":
    main()
