#!/usr/bin/env python3
"""Prepare deterministic large center crops from the texture corpora."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path

from PIL import Image


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selection-manifest", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--crop-size", type=int, default=512)
    parser.add_argument("--dtd-count", type=int, default=100)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    previous = json.loads(args.selection_manifest.read_text(encoding="utf-8"))
    selected = [
        item for item in previous["images"]
        if item["dataset"] in {"ambientcg", "kylberg"}
    ]
    selected.extend(select_dtd(args.source_root, args.crop_size, args.dtd_count))
    selected.sort(key=lambda item: item["id"])
    args.output_dir.mkdir(parents=True, exist_ok=True)

    images = []
    for index, item in enumerate(selected, 1):
        image_id = item["id"]
        source = source_path(args.source_root, image_id)
        file_id = hashlib.sha256(image_id.encode("utf-8")).hexdigest()[:20]
        raw_path = args.output_dir / f"{file_id}.rgb"
        png_path = args.output_dir / f"{file_id}.png"

        with Image.open(source) as image:
            rgb = image.convert("RGB")
            if rgb.width < args.crop_size or rgb.height < args.crop_size:
                raise ValueError(f"{source} is smaller than {args.crop_size}x{args.crop_size}")
            left = (rgb.width - args.crop_size) // 2
            top = (rgb.height - args.crop_size) // 2
            crop = rgb.crop((left, top, left + args.crop_size, top + args.crop_size))
            raw_path.write_bytes(crop.tobytes())
            crop.save(png_path, optimize=False)

        images.append({
            **{key: item[key] for key in ("id", "dataset", "imageClass", "contentClass")},
            "width": args.crop_size,
            "height": args.crop_size,
            "file": raw_path.name,
            "png": png_path.name,
        })
        if index % 25 == 0:
            print(f"{index}/{len(selected)}")

    dataset_counts = {
        name: sum(item["dataset"] == name for item in images)
        for name in ("ambientcg", "dtd", "kylberg")
    }
    manifest = {
        "schemaVersion": 1,
        "crop": "center",
        "cropSize": args.crop_size,
        "imageCount": len(images),
        "datasetCounts": dataset_counts,
        "images": images,
    }
    (args.output_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Prepared {len(images)} center crops in {args.output_dir}")


def select_dtd(source_root: Path, crop_size: int, count: int) -> list[dict[str, object]]:
    dtd_root = source_root / "dtd-r1.0.1" / "dtd" / "images"
    by_class: dict[str, list[dict[str, object]]] = defaultdict(list)
    for source in dtd_root.rglob("*.jpg"):
        with Image.open(source) as image:
            if image.width < crop_size or image.height < crop_size:
                continue
        relative = source.relative_to(dtd_root).as_posix()
        image_id = f"dtd/{relative}"
        by_class[source.parent.name].append({
            "id": image_id,
            "dataset": "dtd",
            "imageClass": "texture",
            "contentClass": source.parent.name,
        })

    for group in by_class.values():
        group.sort(key=lambda item: hashlib.sha256(str(item["id"]).encode("utf-8")).digest())

    selected = []
    classes = sorted(by_class)
    round_index = 0
    while len(selected) < count:
        added = False
        for content_class in classes:
            group = by_class[content_class]
            if round_index < len(group):
                selected.append(group[round_index])
                added = True
                if len(selected) == count:
                    break
        if not added:
            raise RuntimeError(f"Only {len(selected)} DTD images satisfy the crop size")
        round_index += 1
    return selected


def source_path(source_root: Path, image_id: str) -> Path:
    parts = image_id.split("/")
    if parts[0] == "ambientcg":
        return source_root / "ambientcg-2k-png" / Path(*parts[1:])
    if parts[0] == "dtd":
        return source_root / "dtd-r1.0.1" / "dtd" / "images" / Path(*parts[1:])
    if parts[0] == "kylberg":
        return source_root / "kylberg-v1-small" / Path(*parts[1:])
    raise ValueError(f"Unknown texture dataset in {image_id}")


if __name__ == "__main__":
    main()
