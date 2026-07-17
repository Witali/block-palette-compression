#!/usr/bin/env python3
"""Compare searched hybrid BPDH against ASTC at a four-bpp payload target."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import math
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from PIL import Image, __version__ as PILLOW_VERSION


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from benchmark.metrics import rgb_error, ssim_luma  # noqa: E402


BENCHMARK_VERSION = 1
ASTC_HEADER_BYTES = 16
EXPECTED_COUNTS = {"dtd": 5640, "kylberg": 240, "ambientcg": 55}
DEFAULT_SAMPLE_COUNT = 200
DEFAULT_SAMPLE_WEIGHTS = {"dtd": 100, "kylberg": 45, "ambientcg": 55}
DCT_QUALITIES = [35, 55, 70, 80, 85, 88, 90, 92, 94, 96, 98, 100]
ASTC_BLOCKS = [(8, 8), (8, 6), (8, 5), (6, 6), (6, 5)]
BPDH_PROFILES = [
    {
        "id": "l4-g16-p16-rgb888",
        "label": "L4 / G16 / P16 / RGB888",
        "localColorCount": 4,
        "globalColorCount": 16,
        "paletteCount": 16,
        "paletteColorBits": 24,
    },
    {
        "id": "l8-g32-p8-rgb888",
        "label": "L8 / G32 / P8 / RGB888",
        "localColorCount": 8,
        "globalColorCount": 32,
        "paletteCount": 8,
        "paletteColorBits": 24,
    },
    {
        "id": "l8-g32-p16-rgb565",
        "label": "L8 / G32 / P16 / RGB565",
        "localColorCount": 8,
        "globalColorCount": 32,
        "paletteCount": 16,
        "paletteColorBits": 16,
    },
    {
        "id": "l8-g32-p16-rgb888",
        "label": "L8 / G32 / P16 / RGB888",
        "localColorCount": 8,
        "globalColorCount": 32,
        "paletteCount": 16,
        "paletteColorBits": 24,
    },
    {
        "id": "l16-g64-p4-rgb888",
        "label": "L16 / G64 / P4 / RGB888",
        "localColorCount": 16,
        "globalColorCount": 64,
        "paletteCount": 4,
        "paletteColorBits": 24,
    },
]
STORAGE_FIELDS = [
    ("paletteBytes", "Shared BPAL palettes"),
    ("quantizationTableBytes", "DCT quantization tables"),
    ("modeMapBytes", "BPAL/DCT mode map"),
    ("bpalBytes", "Sparse BPAL records"),
    ("dctBytes", "Sparse DCT records"),
]


def main() -> int:
    args = parse_args()
    datasets = parse_csv(args.datasets)
    corpus_root = resolve_root_path(args.corpus_root)
    images = discover_corpus(corpus_root, datasets)
    if args.sample_count > 0:
        images = select_stratified_sample(images, args.sample_count)

    profiles = create_profiles()
    tools = resolve_tools(args)
    work_dir = resolve_root_path(args.work_dir)
    report_path = resolve_root_path(args.report)
    source_dir = work_dir / "sources"
    current_dir = work_dir / "current"
    records_path = work_dir / "records.jsonl"
    source_dir.mkdir(parents=True, exist_ok=True)
    current_dir.mkdir(parents=True, exist_ok=True)
    records = load_records(records_path)
    expected_keys = {(image["id"], profile["id"]) for image in images for profile in profiles}

    print(
        f"Corpus: {len(images)} images; profiles: {len(profiles)}; "
        f"planned records: {len(expected_keys)}",
        flush=True,
    )
    print(f"Resume: {sum(key in records for key in expected_keys)} records", flush=True)

    started = time.perf_counter()
    created = 0
    if not args.report_only:
        with records_path.open("a", encoding="utf-8") as record_stream:
            for image_index, image in enumerate(images, start=1):
                source, source_png, source_rgba, source_hash = prepare_source(
                    image, source_dir, args.crop_size
                )
                for profile in profiles:
                    key = (image["id"], profile["id"])
                    previous = records.get(key)
                    if reusable_record(previous, source_hash, args.target_bpp, args.crop_size):
                        continue

                    record = run_profile(
                        image,
                        profile,
                        source,
                        source_png,
                        source_rgba,
                        source_hash,
                        current_dir,
                        tools,
                        args,
                    )
                    records[key] = record
                    record_stream.write(json.dumps(record, separators=(",", ":")) + "\n")
                    record_stream.flush()
                    created += 1

                if image_index % args.progress_every == 0 or image_index == len(images):
                    elapsed = time.perf_counter() - started
                    done = sum(key in records for key in expected_keys)
                    rate = created / elapsed if elapsed > 0 else 0.0
                    remaining = (len(expected_keys) - done) / rate if rate > 0 else math.inf
                    print(
                        f"[{image_index}/{len(images)} images] {done}/{len(expected_keys)} records; "
                        f"elapsed {format_duration(elapsed)}; ETA {format_duration(remaining)}",
                        flush=True,
                    )

    missing = expected_keys - records.keys()
    if missing:
        raise SystemExit(f"Benchmark is incomplete; {len(missing)} records are missing")

    selected_records = [records[key] for key in sorted(expected_keys)]
    report = build_report(images, profiles, selected_records, tools, corpus_root, args)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(render_markdown(report), encoding="utf-8")
    (work_dir / "summary.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(f"Report: {report_path}", flush=True)
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus-root", default=".benchmark-corpus")
    parser.add_argument("--datasets", default="dtd,kylberg,ambientcg")
    parser.add_argument("--sample-count", type=int, default=DEFAULT_SAMPLE_COUNT)
    parser.add_argument("--crop-size", type=int, default=128)
    parser.add_argument("--target-bpp", type=float, default=4.0)
    parser.add_argument("--astc-quality", default="medium")
    parser.add_argument("--progress-every", type=int, default=10)
    parser.add_argument(
        "--work-dir",
        default="benchmark/work/hybrid-bpdh-astc-4bpp",
    )
    parser.add_argument(
        "--report",
        default="benchmark/results/hybrid-bpdh-astc-4bpp.md",
    )
    parser.add_argument("--report-only", action="store_true")
    parser.add_argument("--node", default="node")
    parser.add_argument("--bpdh-adapter", default="tools/benchmark_bpdh_adapter.js")
    parser.add_argument(
        "--astcenc",
        default=".benchmark-tools/astcenc-5.6.0/bin/astcenc-avx2.exe",
    )
    args = parser.parse_args()
    if args.sample_count < 0:
        parser.error("--sample-count must be nonnegative")
    if args.crop_size < 16:
        parser.error("--crop-size must be at least 16")
    if not math.isfinite(args.target_bpp) or args.target_bpp <= 0:
        parser.error("--target-bpp must be positive")
    if args.progress_every < 1:
        parser.error("--progress-every must be positive")
    return args


def parse_csv(value: str) -> list[str]:
    values = [item.strip() for item in value.split(",") if item.strip()]
    unknown = set(values) - EXPECTED_COUNTS.keys()
    if unknown:
        raise SystemExit(f"Unknown datasets: {', '.join(sorted(unknown))}")
    if not values:
        raise SystemExit("At least one dataset is required")
    return values


def discover_corpus(corpus_root: Path, selected_datasets: Iterable[str]) -> list[dict[str, Any]]:
    selected = set(selected_datasets)
    images: list[dict[str, Any]] = []

    if "dtd" in selected:
        root = corpus_root / "dtd-r1.0.1" / "dtd" / "images"
        for path in sorted(root.glob("*/*.jpg")):
            images.append(corpus_entry(path, "dtd", "texture", path.parent.name, root))

    if "kylberg" in selected:
        root = corpus_root / "kylberg-v1-small"
        for path in sorted(root.glob("*/*.png")):
            images.append(
                corpus_entry(path, "kylberg", "grayscale-texture", path.parent.name, root)
            )

    if "ambientcg" in selected:
        root = corpus_root / "ambientcg-2k-png"
        for path in sorted(root.glob("*/*_2K-PNG_*.png")):
            map_class = ambientcg_map_class(path)
            if map_class is not None:
                images.append(corpus_entry(path, "ambientcg", map_class, path.parent.name, root))

    counts = collections.Counter(image["dataset"] for image in images)
    for dataset in selected:
        if counts[dataset] != EXPECTED_COUNTS[dataset]:
            raise SystemExit(
                f"Expected {EXPECTED_COUNTS[dataset]} {dataset} images, found {counts[dataset]} "
                f"under {corpus_root}"
            )
    return sorted(images, key=lambda image: image["id"])


def corpus_entry(
    path: Path,
    dataset: str,
    image_class: str,
    content_class: str,
    dataset_root: Path,
) -> dict[str, Any]:
    relative = path.relative_to(dataset_root).as_posix()
    return {
        "id": f"{dataset}/{relative}",
        "dataset": dataset,
        "imageClass": image_class,
        "contentClass": content_class,
        "path": path,
    }


def ambientcg_map_class(path: Path) -> str | None:
    suffix = path.stem.split("_2K-PNG_", 1)[1]
    return {
        "AmbientOcclusion": "ambient-occlusion",
        "Color": "color",
        "Displacement": "displacement",
        "Metalness": "metalness",
        "NormalGL": "normal",
        "Opacity": "opacity",
        "Roughness": "roughness",
    }.get(suffix)


def select_stratified_sample(
    images: list[dict[str, Any]], sample_count: int
) -> list[dict[str, Any]]:
    if sample_count >= len(images):
        return images
    if sample_count < 1:
        return []
    available = collections.Counter(image["dataset"] for image in images)
    quotas = allocate_sample_quotas(available, sample_count)
    selected: list[dict[str, Any]] = []
    for dataset in sorted(quotas):
        selected.extend(
            stratified_pick(
                [image for image in images if image["dataset"] == dataset],
                quotas[dataset],
            )
        )
    return sorted(selected, key=lambda image: image["id"])


def allocate_sample_quotas(
    available: collections.Counter[str] | dict[str, int], sample_count: int
) -> dict[str, int]:
    datasets = [dataset for dataset in DEFAULT_SAMPLE_WEIGHTS if available.get(dataset, 0) > 0]
    weight_sum = sum(DEFAULT_SAMPLE_WEIGHTS[dataset] for dataset in datasets)
    raw = {
        dataset: sample_count * DEFAULT_SAMPLE_WEIGHTS[dataset] / weight_sum
        for dataset in datasets
    }
    quotas = {
        dataset: min(available[dataset], int(math.floor(raw[dataset])))
        for dataset in datasets
    }
    remaining = sample_count - sum(quotas.values())
    order = sorted(
        datasets,
        key=lambda dataset: (
            raw[dataset] - math.floor(raw[dataset]),
            DEFAULT_SAMPLE_WEIGHTS[dataset],
        ),
        reverse=True,
    )
    while remaining > 0:
        changed = False
        for dataset in order:
            if quotas[dataset] >= available[dataset]:
                continue
            quotas[dataset] += 1
            remaining -= 1
            changed = True
            if remaining == 0:
                break
        if not changed:
            break
    return quotas


def stratified_pick(images: list[dict[str, Any]], count: int) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for image in images:
        stratum = image["imageClass"] if image["dataset"] == "ambientcg" else image["contentClass"]
        groups[stratum].append(image)
    for group in groups.values():
        group.sort(key=lambda image: hashlib.sha256(image["id"].encode("utf-8")).hexdigest())

    selected: list[dict[str, Any]] = []
    positions = {name: 0 for name in groups}
    while len(selected) < count:
        changed = False
        for name in sorted(groups):
            position = positions[name]
            if position >= len(groups[name]):
                continue
            selected.append(groups[name][position])
            positions[name] += 1
            changed = True
            if len(selected) == count:
                break
        if not changed:
            break
    return selected


def create_profiles() -> list[dict[str, Any]]:
    profiles = [
        {
            "id": f"bpdh-{profile['id']}",
            "codec": "BPDH",
            "label": profile["label"],
            "bpal": profile,
        }
        for profile in BPDH_PROFILES
    ]
    profiles.extend(
        {
            "id": f"astc-{width}x{height}",
            "codec": "ASTC",
            "label": f"ASTC {width}x{height}",
            "block": [width, height],
            "theoreticalBpp": 128.0 / (width * height),
        }
        for width, height in ASTC_BLOCKS
    )
    return profiles


def resolve_tools(args: argparse.Namespace) -> dict[str, Path]:
    node = resolve_executable(args.node)
    adapter = require_file(resolve_root_path(args.bpdh_adapter))
    astcenc = require_file(resolve_root_path(args.astcenc))
    return {"node": node, "bpdhAdapter": adapter, "astcenc": astcenc}


def resolve_executable(value: str) -> Path:
    candidate = Path(value)
    if candidate.is_file():
        return candidate.resolve()
    discovered = shutil.which(value)
    if discovered is None:
        raise SystemExit(f"Executable not found: {value}")
    return Path(discovered).resolve()


def require_file(path: Path) -> Path:
    if not path.is_file():
        raise SystemExit(f"Required file does not exist: {path}")
    return path.resolve()


def prepare_source(
    image: dict[str, Any], source_dir: Path, crop_size: int
) -> tuple[np.ndarray, Path, Path, str]:
    source = load_center_crop(image["path"], crop_size)
    source_hash = hashlib.sha256(source.tobytes()).hexdigest()
    file_id = hashlib.sha256(image["id"].encode("utf-8")).hexdigest()[:20]
    png_path = source_dir / f"{file_id}.png"
    rgba_path = source_dir / f"{file_id}.rgba"
    Image.fromarray(source, mode="RGB").save(png_path, optimize=False)
    rgba = np.empty((crop_size, crop_size, 4), dtype=np.uint8)
    rgba[:, :, :3] = source
    rgba[:, :, 3] = 255
    rgba_path.write_bytes(rgba.tobytes())
    return source, png_path, rgba_path, source_hash


def load_center_crop(path: Path, crop_size: int) -> np.ndarray:
    with Image.open(path) as image:
        values = np.asarray(image)
        if values.dtype == np.uint16:
            scaled = ((values.astype(np.uint32) + 128) // 257).astype(np.uint8)
            if scaled.ndim == 2:
                rgb = np.repeat(scaled[:, :, None], 3, axis=2)
            else:
                rgb = scaled[:, :, :3]
        else:
            rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    if rgb.shape[0] < crop_size or rgb.shape[1] < crop_size:
        raise ValueError(f"{path} is smaller than {crop_size}x{crop_size}")
    top = (rgb.shape[0] - crop_size) // 2
    left = (rgb.shape[1] - crop_size) // 2
    return np.ascontiguousarray(rgb[top : top + crop_size, left : left + crop_size])


def reusable_record(
    record: dict[str, Any] | None,
    source_hash: str,
    target_bpp: float,
    crop_size: int,
) -> bool:
    return bool(
        record
        and record.get("benchmarkVersion") == BENCHMARK_VERSION
        and record.get("sourceSha256") == source_hash
        and record.get("targetBpp") == target_bpp
        and record.get("width") == crop_size
        and record.get("height") == crop_size
    )


def run_profile(
    image: dict[str, Any],
    profile: dict[str, Any],
    source: np.ndarray,
    source_png: Path,
    source_rgba: Path,
    source_hash: str,
    current_dir: Path,
    tools: dict[str, Path],
    args: argparse.Namespace,
) -> dict[str, Any]:
    clear_current(current_dir)
    if profile["codec"] == "BPDH":
        encoded = run_bpdh(profile, source_rgba, source.shape[1], source.shape[0], current_dir, tools, args)
    else:
        encoded = run_astc(profile, source_png, source.shape[1], source.shape[0], current_dir, tools, args)

    candidate = encoded.pop("pixels")
    mse, squared_error, sample_count = rgb_error(source, candidate)
    pixel_count = int(source.shape[0] * source.shape[1])
    return {
        "benchmarkVersion": BENCHMARK_VERSION,
        "imageId": image["id"],
        "dataset": image["dataset"],
        "imageClass": image["imageClass"],
        "contentClass": image["contentClass"],
        "profileId": profile["id"],
        "profileLabel": profile["label"],
        "codec": profile["codec"],
        "targetBpp": args.target_bpp,
        "width": source.shape[1],
        "height": source.shape[0],
        "pixelCount": pixel_count,
        "rgbSampleCount": sample_count,
        "squaredErrorRgb": squared_error,
        "psnrRgb": finite_psnr(mse),
        "ssimLuma": ssim_luma(source, candidate),
        "sourceSha256": source_hash,
        **encoded,
    }


def run_bpdh(
    profile: dict[str, Any],
    source_rgba: Path,
    width: int,
    height: int,
    current_dir: Path,
    tools: dict[str, Path],
    args: argparse.Namespace,
) -> dict[str, Any]:
    artifact = current_dir / "texture.bpdh"
    metadata_path = current_dir / "metadata.json"
    decoded_path = current_dir / "decoded.rgba"
    settings = make_bpdh_settings(profile["bpal"], width, height, args.target_bpp)
    encode_ms, _ = run_command(
        [
            tools["node"],
            tools["bpdhAdapter"],
            "encode",
            source_rgba,
            str(width),
            str(height),
            json.dumps(settings, separators=(",", ":")),
            artifact,
            metadata_path,
        ]
    )
    decode_ms, _ = run_command(
        [tools["node"], tools["bpdhAdapter"], "decode", artifact, decoded_path]
    )
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    decoded = np.frombuffer(decoded_path.read_bytes(), dtype=np.uint8)
    expected_values = width * height * 4
    if decoded.size != expected_values:
        raise RuntimeError(f"BPDH decoder returned {decoded.size} bytes; expected {expected_values}")
    pixels = decoded.reshape((height, width, 4))[:, :, :3].copy()
    if artifact.stat().st_size != metadata["fileBytes"]:
        raise RuntimeError("BPDH metadata does not match the serialized file size")
    return {
        "pixels": pixels,
        "artifactBytes": metadata["fileBytes"],
        "payloadBytes": metadata["payloadBytes"],
        "payloadBpp": metadata["payloadBitsPerPixel"],
        "withinTarget": metadata["withinTarget"],
        "bpalBlocks": metadata["bpalBlocks"],
        "dctBlocks": metadata["dctBlocks"],
        "dctQuality": metadata["dctQuality"],
        "storage": metadata["storage"],
        "effectiveSettings": settings,
        "encodeMilliseconds": encode_ms,
        "decodeMilliseconds": decode_ms,
    }


def make_bpdh_settings(
    bpal_profile: dict[str, Any], width: int, height: int, target_bpp: float
) -> dict[str, Any]:
    block_count = math.ceil(width / 16) * math.ceil(height / 16)
    palette_count = largest_power_of_two(min(bpal_profile["paletteCount"], block_count))
    return {
        "targetBitsPerPixel": target_bpp,
        "mode": "auto",
        "dctQualities": DCT_QUALITIES,
        "bpal": {
            "blockSize": 16,
            "localColorCount": bpal_profile["localColorCount"],
            "globalColorCount": bpal_profile["globalColorCount"],
            "paletteCount": palette_count,
            "paletteColorBits": bpal_profile["paletteColorBits"],
            "colorSpace": "rgb",
            "clusteringMethod": "k-means",
            "dithering": "none",
            "diversity": 0,
            "refinementPasses": 4,
        },
    }


def run_astc(
    profile: dict[str, Any],
    source_png: Path,
    width: int,
    height: int,
    current_dir: Path,
    tools: dict[str, Path],
    args: argparse.Namespace,
) -> dict[str, Any]:
    artifact = current_dir / "texture.astc"
    decoded_path = current_dir / "decoded.png"
    block_width, block_height = profile["block"]
    encode_ms, _ = run_command(
        [
            tools["astcenc"],
            "-cl",
            source_png,
            artifact,
            f"{block_width}x{block_height}",
            f"-{args.astc_quality}",
            "-silent",
        ]
    )
    decode_ms, _ = run_command(
        [tools["astcenc"], "-dl", artifact, decoded_path, "-silent"]
    )
    with Image.open(decoded_path) as image:
        pixels = np.ascontiguousarray(np.asarray(image.convert("RGB"), dtype=np.uint8))
    payload_bytes = math.ceil(width / block_width) * math.ceil(height / block_height) * 16
    if artifact.stat().st_size != payload_bytes + ASTC_HEADER_BYTES:
        raise RuntimeError("Unexpected ASTC artifact size")
    return {
        "pixels": pixels,
        "artifactBytes": artifact.stat().st_size,
        "payloadBytes": payload_bytes,
        "payloadBpp": payload_bytes * 8.0 / (width * height),
        "theoreticalBpp": profile["theoreticalBpp"],
        "block": profile["block"],
        "encodeMilliseconds": encode_ms,
        "decodeMilliseconds": decode_ms,
    }


def build_report(
    images: list[dict[str, Any]],
    profiles: list[dict[str, Any]],
    records: list[dict[str, Any]],
    tools: dict[str, Path],
    corpus_root: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    bpdh_records = select_bpdh_records(records, args.target_bpp)
    astc_profiles = [profile for profile in profiles if profile["codec"] == "ASTC"]
    astc_points = aggregate_astc_profiles(records, astc_profiles)
    bpdh = aggregate_records(bpdh_records)
    astc_at_target = interpolate_operating_point(astc_points, args.target_bpp)
    astc_at_bpdh_rate = interpolate_operating_point(astc_points, bpdh["payloadBpp"])
    if astc_at_target is None or astc_at_bpdh_rate is None:
        raise RuntimeError("ASTC operating points do not bracket the requested comparisons")

    by_dataset = {}
    for dataset in sorted({image["dataset"] for image in images}):
        selected_subset = [record for record in bpdh_records if record["dataset"] == dataset]
        astc_subset = [record for record in records if record["codec"] == "ASTC" and record["dataset"] == dataset]
        bpdh_group = aggregate_records(selected_subset)
        astc_group_points = aggregate_astc_profiles(astc_subset, astc_profiles)
        astc_target_group = interpolate_operating_point(astc_group_points, args.target_bpp)
        astc_rate_group = interpolate_operating_point(astc_group_points, bpdh_group["payloadBpp"])
        by_dataset[dataset] = {
            "imageCount": len(selected_subset),
            "bpdh": bpdh_group,
            "astcAtTarget": astc_target_group,
            "astcAtBpdhRate": astc_rate_group,
            "bpdhMinusAstcAtTargetDb": bpdh_group["psnrRgb"] - astc_target_group["psnrRgb"],
            "bpdhMinusAstcAtBpdhRateDb": bpdh_group["psnrRgb"] - astc_rate_group["psnrRgb"],
        }

    return {
        "schemaVersion": 1,
        "benchmarkVersion": BENCHMARK_VERSION,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "targetPayloadBpp": args.target_bpp,
        "corpus": {
            "imageCount": len(images),
            "crop": "center",
            "cropSize": args.crop_size,
            "datasetCounts": dict(collections.Counter(image["dataset"] for image in images)),
            "root": relative_or_absolute(corpus_root),
        },
        "method": {
            "bpdh": "best serialized auto-mode candidate per image within the payload budget",
            "bpdhProfiles": [profile["label"] for profile in BPDH_PROFILES],
            "dctQualities": DCT_QUALITIES,
            "astc": f"astcenc linear LDR -{args.astc_quality}",
            "astcInterpolation": "linear pooled metric versus log2(actual padded payload bpp)",
        },
        "bpdh": {
            **bpdh,
            "storage": storage_summary(bpdh_records),
            "profileDistribution": profile_distribution(bpdh_records),
        },
        "astcOperatingPoints": astc_points,
        "comparison": {
            "astcAtTarget": astc_at_target,
            "bpdhMinusAstcAtTargetDb": bpdh["psnrRgb"] - astc_at_target["psnrRgb"],
            "astcAtBpdhRate": astc_at_bpdh_rate,
            "bpdhMinusAstcAtBpdhRateDb": bpdh["psnrRgb"] - astc_at_bpdh_rate["psnrRgb"],
        },
        "byDataset": by_dataset,
        "tools": {
            "node": tool_info(tools["node"], ["--version"]),
            "astcenc": tool_info(tools["astcenc"], ["-version"]),
        },
        "environment": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "pillow": PILLOW_VERSION,
            "platform": platform.platform(),
        },
    }


def select_bpdh_records(records: list[dict[str, Any]], target_bpp: float) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for record in records:
        if record["codec"] == "BPDH":
            grouped[record["imageId"]].append(record)

    selected = []
    for image_id in sorted(grouped):
        eligible = [
            record
            for record in grouped[image_id]
            if record["withinTarget"] and record["payloadBpp"] <= target_bpp + 1e-12
        ]
        if not eligible:
            raise RuntimeError(f"No BPDH candidate met the target for {image_id}")
        selected.append(
            min(
                eligible,
                key=lambda record: (
                    record["squaredErrorRgb"],
                    record["payloadBytes"],
                    record["profileId"],
                ),
            )
        )
    return selected


def aggregate_astc_profiles(
    records: list[dict[str, Any]], profiles: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    points = []
    for profile in profiles:
        subset = [record for record in records if record["profileId"] == profile["id"]]
        if not subset:
            continue
        points.append(
            {
                **aggregate_records(subset),
                "profileId": profile["id"],
                "label": profile["label"],
                "block": profile["block"],
                "theoreticalBpp": profile["theoreticalBpp"],
            }
        )
    return sorted(points, key=lambda point: point["payloadBpp"])


def aggregate_records(records: list[dict[str, Any]]) -> dict[str, Any]:
    if not records:
        raise ValueError("Cannot aggregate an empty record list")
    pixel_count = sum(record["pixelCount"] for record in records)
    sample_count = sum(record["rgbSampleCount"] for record in records)
    squared_error = sum(record["squaredErrorRgb"] for record in records)
    mse = squared_error / sample_count
    result = {
        "imageCount": len(records),
        "pixelCount": pixel_count,
        "payloadBytes": sum(record["payloadBytes"] for record in records),
        "artifactBytes": sum(record["artifactBytes"] for record in records),
        "payloadBpp": sum(record["payloadBytes"] for record in records) * 8.0 / pixel_count,
        "fileBpp": sum(record["artifactBytes"] for record in records) * 8.0 / pixel_count,
        "psnrRgb": finite_psnr(mse),
        "ssimLumaMean": sum(record["ssimLuma"] for record in records) / len(records),
        "encodeMillisecondsMean": sum(record["encodeMilliseconds"] for record in records) / len(records),
        "decodeMillisecondsMean": sum(record["decodeMilliseconds"] for record in records) / len(records),
    }
    if all(record["codec"] == "BPDH" for record in records):
        bpal_blocks = sum(record["bpalBlocks"] for record in records)
        dct_blocks = sum(record["dctBlocks"] for record in records)
        total_blocks = bpal_blocks + dct_blocks
        result.update(
            {
                "bpalBlocks": bpal_blocks,
                "dctBlocks": dct_blocks,
                "bpalBlockPercent": 100.0 * bpal_blocks / total_blocks,
                "dctBlockPercent": 100.0 * dct_blocks / total_blocks,
                "mixedImageCount": sum(
                    record["bpalBlocks"] > 0 and record["dctBlocks"] > 0 for record in records
                ),
                "pureBpalImageCount": sum(record["dctBlocks"] == 0 for record in records),
                "pureDctImageCount": sum(record["bpalBlocks"] == 0 for record in records),
            }
        )
    return result


def interpolate_operating_point(
    points: list[dict[str, Any]], target_bpp: float
) -> dict[str, Any] | None:
    for point in points:
        if abs(point["payloadBpp"] - target_bpp) < 1e-12:
            return {
                "payloadBpp": target_bpp,
                "psnrRgb": point["psnrRgb"],
                "ssimLumaMean": point["ssimLumaMean"],
                "lowerProfileId": point["profileId"],
                "upperProfileId": point["profileId"],
            }
    for lower, upper in zip(points, points[1:]):
        if lower["payloadBpp"] <= target_bpp <= upper["payloadBpp"]:
            position = (math.log2(target_bpp) - math.log2(lower["payloadBpp"])) / (
                math.log2(upper["payloadBpp"]) - math.log2(lower["payloadBpp"])
            )
            return {
                "payloadBpp": target_bpp,
                "psnrRgb": interpolate_value(lower["psnrRgb"], upper["psnrRgb"], position),
                "ssimLumaMean": interpolate_value(
                    lower["ssimLumaMean"], upper["ssimLumaMean"], position
                ),
                "lowerProfileId": lower["profileId"],
                "upperProfileId": upper["profileId"],
            }
    return None


def interpolate_value(lower: float, upper: float, position: float) -> float:
    return lower + position * (upper - lower)


def storage_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
    totals = {
        field: sum(record["storage"][field] for record in records)
        for field, _ in STORAGE_FIELDS
    }
    payload_bytes = sum(record["payloadBytes"] for record in records)
    return {
        "payloadBytes": payload_bytes,
        "fields": {
            field: {
                "label": label,
                "totalBytes": totals[field],
                "meanBytesPerImage": totals[field] / len(records),
                "payloadPercent": 100.0 * totals[field] / payload_bytes,
            }
            for field, label in STORAGE_FIELDS
        },
    }


def profile_distribution(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    labels = {record["profileId"]: record["profileLabel"] for record in records}
    counts = collections.Counter(record["profileId"] for record in records)
    return [
        {"profileId": profile_id, "label": labels[profile_id], "imageCount": count}
        for profile_id, count in counts.most_common()
    ]


def render_markdown(report: dict[str, Any]) -> str:
    target = report["targetPayloadBpp"]
    bpdh = report["bpdh"]
    comparison = report["comparison"]
    astc_target = comparison["astcAtTarget"]
    astc_rate = comparison["astcAtBpdhRate"]
    datasets = ", ".join(
        f"{name} {count}" for name, count in report["corpus"]["datasetCounts"].items()
    )
    lines = [
        f"# Hybrid BPDH versus ASTC at a {target:g} bpp target",
        "",
        f"Generated: `{report['generatedAt']}`.",
        "",
        "## Methodology",
        "",
        f"- Corpus: {report['corpus']['imageCount']} deterministic "
        f"{report['corpus']['cropSize']}x{report['corpus']['cropSize']} center crops "
        f"({datasets}).",
        f"- BPDH searched {len(report['method']['bpdhProfiles'])} BPAL parameter families and "
        f"{len(report['method']['dctQualities'])} DCT quality values per image. The selected "
        f"serialized candidate has the lowest exact stored-byte RGB error at no more than "
        f"{target:g} payload bpp.",
        "- ASTC was encoded and decoded at every measured block footprint with "
        f"`{report['method']['astc']}`. ASTC has no standard 2D footprint at exactly 4.0 bpp, "
        "so exact-rate values interpolate pooled quality between neighboring measured points.",
        "- Payload bpp excludes the BPDH and ASTC container headers but includes real byte "
        "rounding and block-grid padding. RGB PSNR pools squared error over all images; luma "
        "SSIM is the arithmetic mean of per-image values.",
        "",
        "## Result",
        "",
        "| Codec / comparison | Payload bpp | RGB PSNR | Mean luma SSIM |",
        "|:---|---:|---:|---:|",
        f"| BPDH, {target:g} bpp limit | {bpdh['payloadBpp']:.4f} measured | "
        f"{bpdh['psnrRgb']:.3f} dB | {bpdh['ssimLumaMean']:.6f} |",
        f"| ASTC at {target:g} bpp | {target:.4f} interpolated | "
        f"{astc_target['psnrRgb']:.3f} dB | {astc_target['ssimLumaMean']:.6f} |",
        f"| BPDH - ASTC at the {target:g} bpp target | - | "
        f"**{comparison['bpdhMinusAstcAtTargetDb']:+.3f} dB** | "
        f"{bpdh['ssimLumaMean'] - astc_target['ssimLumaMean']:+.6f} |",
        f"| ASTC at BPDH's measured {bpdh['payloadBpp']:.4f} bpp | "
        f"{bpdh['payloadBpp']:.4f} interpolated | {astc_rate['psnrRgb']:.3f} dB | "
        f"{astc_rate['ssimLumaMean']:.6f} |",
        f"| BPDH - rate-matched ASTC | - | "
        f"**{comparison['bpdhMinusAstcAtBpdhRateDb']:+.3f} dB** | "
        f"{bpdh['ssimLumaMean'] - astc_rate['ssimLumaMean']:+.6f} |",
        "",
        f"BPDH used {bpdh['payloadBpp']:.4f} bpp of its {target:g} bpp allowance. The target "
        "comparison therefore does not credit BPDH for unused bytes; the rate-matched row "
        "separately compares both codecs at BPDH's measured aggregate rate.",
        "",
        "## Measured ASTC operating points",
        "",
        "| Footprint | Theoretical bpp | Measured payload bpp | RGB PSNR | Mean luma SSIM |",
        "|:---:|---:|---:|---:|---:|",
    ]
    for point in report["astcOperatingPoints"]:
        lines.append(
            f"| {point['block'][0]}x{point['block'][1]} | {point['theoreticalBpp']:.4f} | "
            f"{point['payloadBpp']:.4f} | {point['psnrRgb']:.3f} dB | "
            f"{point['ssimLumaMean']:.6f} |"
        )

    lines.extend(
        [
            "",
            "## BPDH mode usage",
            "",
            "| Metric | Result |",
            "|:---|---:|",
            f"| BPAL coding units | {bpdh['bpalBlocks']:,} ({bpdh['bpalBlockPercent']:.2f}%) |",
            f"| DCT coding units | {bpdh['dctBlocks']:,} ({bpdh['dctBlockPercent']:.2f}%) |",
            f"| Mixed BPAL+DCT images | {bpdh['mixedImageCount']} / {bpdh['imageCount']} |",
            f"| Pure BPAL images | {bpdh['pureBpalImageCount']} / {bpdh['imageCount']} |",
            f"| Pure DCT images | {bpdh['pureDctImageCount']} / {bpdh['imageCount']} |",
            "",
            "## Dataset consistency",
            "",
            "| Dataset | Images | BPDH bpp | BPDH PSNR | BPDH - ASTC at 4 bpp | "
            "BPDH - rate-matched ASTC |",
            "|:---|---:|---:|---:|---:|---:|",
        ]
    )
    for dataset, group in report["byDataset"].items():
        lines.append(
            f"| {dataset} | {group['imageCount']} | {group['bpdh']['payloadBpp']:.4f} | "
            f"{group['bpdh']['psnrRgb']:.3f} dB | "
            f"{group['bpdhMinusAstcAtTargetDb']:+.3f} dB | "
            f"{group['bpdhMinusAstcAtBpdhRateDb']:+.3f} dB |"
        )

    lines.extend(
        [
            "",
            "## BPDH payload composition",
            "",
            "| Section | Mean bytes / image | Share of payload |",
            "|:---|---:|---:|",
        ]
    )
    for field, _ in STORAGE_FIELDS:
        item = bpdh["storage"]["fields"][field]
        lines.append(
            f"| {item['label']} | {item['meanBytesPerImage']:.1f} | "
            f"{item['payloadPercent']:.2f}% |"
        )

    lines.extend(
        [
            "",
            "## Selected BPDH parameter families",
            "",
            "| BPAL family searched inside BPDH | Selected images |",
            "|:---|---:|",
        ]
    )
    for item in bpdh["profileDistribution"]:
        lines.append(f"| {item['label']} | {item['imageCount']} |")

    lines.extend(
        [
            "",
            "## Process timings",
            "",
            "Timings include process startup and file I/O and are included only as a "
            "reproducibility diagnostic, not as a runtime decoder comparison.",
            "",
            f"- BPDH selected-candidate encode: {bpdh['encodeMillisecondsMean']:.1f} ms/image; "
            f"decode: {bpdh['decodeMillisecondsMean']:.1f} ms/image.",
        ]
    )
    for point in report["astcOperatingPoints"]:
        if point["profileId"] == astc_target["lowerProfileId"]:
            lines.append(
                f"- {point['label']} encode: {point['encodeMillisecondsMean']:.1f} ms/image; "
                f"decode: {point['decodeMillisecondsMean']:.1f} ms/image."
            )
        if (
            point["profileId"] == astc_target["upperProfileId"]
            and astc_target["upperProfileId"] != astc_target["lowerProfileId"]
        ):
            lines.append(
                f"- {point['label']} encode: {point['encodeMillisecondsMean']:.1f} ms/image; "
                f"decode: {point['decodeMillisecondsMean']:.1f} ms/image."
            )

    lines.extend(["", "## Tools", ""])
    for name, info in report["tools"].items():
        lines.append(f"- **{name}:** `{info['version']}` (`{info['path']}`)")

    lines.extend(
        [
            "",
            "## Limitations",
            "",
            "- The exact 4 bpp ASTC result is an interpolation because ASTC exposes only "
            "discrete standard block footprints; both bracketing bitstreams were actually "
            "encoded and decoded.",
            "- Results use 128x128 center crops and linear-LDR RGB error. They do not cover "
            "alpha, HDR, mip chains, texture filtering, or normal-map angular error.",
            "- BPDH is the project's research JS encoder with fixed searched parameter "
            "families. A broader joint palette search may move its frontier.",
            "- Encoder and decoder process timings are not comparable implementation-speed "
            "measurements: BPDH is JavaScript while astcenc is optimized native code.",
            "",
            "## Reproduction",
            "",
            "```text",
            "python tools/hybrid_bpdh_astc_4bpp_benchmark.py "
            "--corpus-root .benchmark-corpus "
            "--astcenc .benchmark-tools/astcenc-5.6.0/bin/astcenc-avx2.exe",
            "```",
            "",
        ]
    )
    return "\n".join(lines)


def load_records(path: Path) -> dict[tuple[str, str], dict[str, Any]]:
    records: dict[tuple[str, str], dict[str, Any]] = {}
    if not path.is_file():
        return records
    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            if line.strip():
                record = json.loads(line)
                records[(record["imageId"], record["profileId"])] = record
    return records


def run_command(arguments: list[os.PathLike[str] | str]) -> tuple[float, str]:
    command = [str(argument) for argument in arguments]
    started = time.perf_counter()
    completed = subprocess.run(
        command,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    if completed.returncode != 0:
        raise RuntimeError(
            f"Command failed ({completed.returncode}): {' '.join(command)}\n{completed.stdout}"
        )
    return elapsed_ms, completed.stdout


def tool_info(path: Path, version_arguments: list[str]) -> dict[str, str]:
    _, output = run_command([path, *version_arguments])
    return {
        "path": relative_or_absolute(path),
        "version": output.strip().splitlines()[0],
    }


def clear_current(path: Path) -> None:
    for name in ("texture.bpdh", "metadata.json", "decoded.rgba", "texture.astc", "decoded.png"):
        candidate = path / name
        if candidate.exists():
            candidate.unlink()


def largest_power_of_two(value: int) -> int:
    return 1 << max(0, int(math.floor(math.log2(max(1, value)))))


def finite_psnr(mse: float) -> float | None:
    return None if mse == 0 else 10.0 * math.log10(255.0 * 255.0 / mse)


def resolve_root_path(value: str | os.PathLike[str]) -> Path:
    path = Path(value)
    return path.resolve() if path.is_absolute() else (ROOT / path).resolve()


def relative_or_absolute(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path.resolve())


def format_duration(seconds: float) -> str:
    if not math.isfinite(seconds):
        return "unknown"
    seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {seconds:02d}s"
    if minutes:
        return f"{minutes}m {seconds:02d}s"
    return f"{seconds}s"


if __name__ == "__main__":
    raise SystemExit(main())
