#!/usr/bin/env python3
"""Run one rate-distortion benchmark across BPAL, BC, and ASTC codecs."""

from __future__ import annotations

import argparse
import csv
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
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, __version__ as PILLOW_VERSION


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from benchmark.metrics import psnr_rgb, rgb_error, ssim_luma  # noqa: E402


PROFILES: list[dict[str, Any]] = [
    {
        "id": "bpal-2.1",
        "codec": "BPAL",
        "adapter": "bpal",
        "label": "BPAL 16x16 / 4 / 32",
        "nominalBpp": 2.078125,
        "settings": {
            "blockSize": 16,
            "localColorCount": 4,
            "globalColorCount": 32,
            "paletteColorBits": 24,
        },
    },
    {
        "id": "bpal-2.4",
        "codec": "BPAL",
        "adapter": "bpal",
        "label": "BPAL 8x8 / 4 / 64",
        "nominalBpp": 2.375,
        "settings": {
            "blockSize": 8,
            "localColorCount": 4,
            "globalColorCount": 64,
            "paletteColorBits": 24,
        },
    },
    {
        "id": "astc-8x8",
        "codec": "ASTC",
        "adapter": "astc",
        "label": "ASTC 8x8 medium",
        "nominalBpp": 2.0,
        "block": [8, 8],
    },
    {
        "id": "astc-6x6",
        "codec": "ASTC",
        "adapter": "astc",
        "label": "ASTC 6x6 medium",
        "nominalBpp": 128.0 / 36.0,
        "block": [6, 6],
    },
    {
        "id": "bpal-v5-sp1",
        "codec": "BPAL",
        "adapter": "bpal",
        "label": "BPAL v5 16x16 / 8 local / 1 palette x 32 colors",
        "nominalBpp": 3.0 + 40.0 / 256.0,
        "settings": {
            "blockSize": 16,
            "localColorCount": 8,
            "globalColorCount": 32,
            "paletteCount": 1,
            "paletteColorBits": 24,
        },
    },
    {
        "id": "bpal-v5-mp32",
        "codec": "BPAL",
        "adapter": "bpal",
        "label": "BPAL v5 16x16 / 8 local / 32 palettes x 32 colors",
        "default": False,
        "nominalBpp": 3.0 + 40.0 / 256.0 + 5.0 / 256.0,
        "settings": {
            "blockSize": 16,
            "localColorCount": 8,
            "globalColorCount": 32,
            "paletteCount": 32,
            "paletteColorBits": 24,
        },
    },
    {
        "id": "bpal-v5-mp64",
        "codec": "BPAL",
        "adapter": "bpal",
        "label": "BPAL v5 16x16 / 8 local / 64 palettes x 32 colors",
        "nominalBpp": 3.0 + 40.0 / 256.0 + 6.0 / 256.0,
        "settings": {
            "blockSize": 16,
            "localColorCount": 8,
            "globalColorCount": 32,
            "paletteCount": 64,
            "paletteColorBits": 24,
        },
    },
    {
        "id": "bpal-v5-mp128",
        "codec": "BPAL",
        "adapter": "bpal",
        "label": "BPAL v5 16x16 / 8 local / 128 palettes x 32 colors",
        "nominalBpp": 3.0 + 40.0 / 256.0 + 7.0 / 256.0,
        "settings": {
            "blockSize": 16,
            "localColorCount": 8,
            "globalColorCount": 32,
            "paletteCount": 128,
            "paletteColorBits": 24,
        },
    },
    {
        "id": "bpal-4",
        "codec": "BPAL",
        "adapter": "bpal",
        "label": "BPAL 8x8 / 8 / 256",
        "nominalBpp": 4.0,
        "settings": {
            "blockSize": 8,
            "localColorCount": 8,
            "globalColorCount": 256,
            "paletteColorBits": 24,
        },
    },
    {
        "id": "bc1",
        "codec": "BC1",
        "adapter": "texconv",
        "label": "BC1 uniform RGB",
        "nominalBpp": 4.0,
        "format": "BC1_UNORM",
        "blockBytes": 8,
    },
    {
        "id": "astc-5x5",
        "codec": "ASTC",
        "adapter": "astc",
        "label": "ASTC 5x5 medium",
        "nominalBpp": 5.12,
        "block": [5, 5],
    },
    {
        "id": "bpal-6",
        "codec": "BPAL",
        "adapter": "bpal",
        "label": "BPAL 8x8 / 16 / 256",
        "nominalBpp": 6.0,
        "settings": {
            "blockSize": 8,
            "localColorCount": 16,
            "globalColorCount": 256,
            "paletteColorBits": 24,
        },
    },
    {
        "id": "astc-4x4",
        "codec": "ASTC",
        "adapter": "astc",
        "label": "ASTC 4x4 medium",
        "nominalBpp": 8.0,
        "block": [4, 4],
    },
    {
        "id": "bc7",
        "codec": "BC7",
        "adapter": "texconv",
        "label": "BC7 max CPU",
        "nominalBpp": 8.0,
        "format": "BC7_UNORM",
        "blockBytes": 16,
    },
]


def main() -> int:
    args = parse_args()
    manifest_path = resolve_path(args.corpus)
    output_dir = resolve_path(args.output_dir)
    work_dir = resolve_path(args.work_dir)
    selected_profiles = select_profiles(args.profiles)
    images = load_manifest(manifest_path, args.images)
    tools = resolve_tools(args, selected_profiles)
    resumed_records = load_resumed_records(args.resume)

    output_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)

    print(f"Corpus: {len(images)} images", flush=True)
    print(f"Profiles: {len(selected_profiles)}", flush=True)

    records: list[dict[str, Any]] = []

    for image_index, image_entry in enumerate(images, start=1):
        source = load_source(image_entry)
        image_entry["normalizedSha256"] = hashlib.sha256(source.tobytes()).hexdigest()
        image_entry["benchmarkWidth"] = int(source.shape[1])
        image_entry["benchmarkHeight"] = int(source.shape[0])
        source_dir = work_dir / "sources" / image_entry["id"]
        source_dir.mkdir(parents=True, exist_ok=True)
        source_png = source_dir / "source.png"
        source_raw = source_dir / "source.rgba"
        Image.fromarray(source, mode="RGBA").save(source_png, optimize=False)
        source_raw.write_bytes(source.tobytes())

        height, width, _ = source.shape
        print(
            f"[{image_index}/{len(images)}] {image_entry['id']} ({width}x{height})",
            flush=True,
        )

        for profile_index, profile in enumerate(selected_profiles, start=1):
            print(
                f"  [{profile_index}/{len(selected_profiles)}] {profile['label']}",
                flush=True,
            )
            resumed = resumed_records.get((image_entry["id"], profile["id"]))
            if resumed:
                if resumed.get("width") != width or resumed.get("height") != height:
                    raise SystemExit(
                        f"Resume record dimensions differ for {image_entry['id']} / {profile['id']}"
                    )
                previous_hash = resumed.get("sourceSha256")
                if previous_hash and previous_hash != image_entry["normalizedSha256"]:
                    raise SystemExit(
                        f"Resume source hash differs for {image_entry['id']} / {profile['id']}"
                    )
                record = {
                    **resumed,
                    "profile": profile["label"],
                    "codec": profile["codec"],
                    "nominalBpp": profile["nominalBpp"],
                    "sourceSha256": image_entry["normalizedSha256"],
                }
                print("    reused from previous report", flush=True)
            else:
                record = run_profile(
                    profile,
                    image_entry,
                    source,
                    source_png,
                    source_raw,
                    work_dir,
                    tools,
                )
            records.append(record)
            print(
                "    "
                f"{record['payloadBpp']:.3f} bpp, "
                f"PSNR {record['psnrRgb']:.3f} dB, "
                f"SSIM {record['ssimLuma']:.6f}",
                flush=True,
            )

    aggregates = aggregate_records(records)
    report = build_report(manifest_path, selected_profiles, images, tools, records, aggregates)
    write_reports(output_dir, report)

    print(f"Reports written to {output_dir}", flush=True)
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", default="benchmark/corpus-clic.json")
    parser.add_argument("--output-dir", default="benchmark/results/latest")
    parser.add_argument("--work-dir", default="benchmark/work")
    parser.add_argument(
        "--resume",
        help="Reuse matching image/profile records from a previous benchmark JSON report.",
    )
    parser.add_argument(
        "--profiles",
        help="Comma-separated profile IDs. Default: all profiles.",
    )
    parser.add_argument(
        "--images",
        help="Comma-separated corpus image IDs. Default: all images.",
    )
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--texconv", default=".benchmark-tools/texconv.exe")
    parser.add_argument(
        "--astcenc",
        default=".benchmark-tools/astcenc-5.6.0/bin/astcenc-avx2.exe",
    )
    return parser.parse_args()


def load_resumed_records(path_text: str | None) -> dict[tuple[str, str], dict[str, Any]]:
    if not path_text:
        return {}

    path = resolve_path(path_text)
    if not path.is_file():
        raise SystemExit(f"Resume report does not exist: {path}")

    report = json.loads(path.read_text(encoding="utf-8"))
    records = report.get("records")
    if not isinstance(records, list):
        raise SystemExit(f"Resume report contains no records: {path}")

    result: dict[tuple[str, str], dict[str, Any]] = {}
    for record in records:
        if not isinstance(record, dict):
            raise SystemExit(f"Invalid record in resume report: {path}")
        key = (record.get("imageId"), record.get("profileId"))
        if not all(isinstance(value, str) for value in key):
            raise SystemExit(f"Invalid record key in resume report: {path}")
        result[key] = record
    return result


def select_profiles(profile_text: str | None) -> list[dict[str, Any]]:
    if not profile_text:
        return [profile for profile in PROFILES if profile.get("default", True)]

    requested = [value.strip() for value in profile_text.split(",") if value.strip()]
    by_id = {profile["id"]: profile for profile in PROFILES}
    unknown = [profile_id for profile_id in requested if profile_id not in by_id]

    if unknown:
        raise SystemExit(f"Unknown benchmark profiles: {', '.join(unknown)}")

    return [by_id[profile_id] for profile_id in requested]


def load_manifest(path: Path, image_text: str | None) -> list[dict[str, Any]]:
    document = json.loads(path.read_text(encoding="utf-8"))
    images = document.get("images", [])

    if not isinstance(images, list):
        raise SystemExit(f"Corpus images must be an array: {path}")

    selection = document.get("selection")
    if selection is not None:
        images = [*images, *expand_selection(selection)]

    if not isinstance(images, list) or not images:
        raise SystemExit(f"Corpus manifest contains no images: {path}")

    requested = None
    if image_text:
        requested = {value.strip() for value in image_text.split(",") if value.strip()}

    selected: list[dict[str, Any]] = []
    known_ids: set[str] = set()

    for entry in images:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            raise SystemExit(f"Invalid corpus entry in {path}")

        known_ids.add(entry["id"])
        if requested is not None and entry["id"] not in requested:
            continue

        source_path = resolve_path(entry.get("path", ""))
        if not source_path.is_file():
            raise SystemExit(f"Corpus image does not exist: {source_path}")

        if entry.get("transfer") not in {"srgb", "linear"}:
            raise SystemExit(f"Invalid transfer for corpus image {entry['id']}")

        selected.append({**entry, "resolvedPath": source_path})

    if requested:
        unknown = requested - known_ids
        if unknown:
            raise SystemExit(f"Unknown corpus image IDs: {', '.join(sorted(unknown))}")

    if not selected:
        raise SystemExit("No corpus images selected")

    return selected


def expand_selection(selection: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(selection, dict):
        raise SystemExit("Corpus selection must be an object")

    root = resolve_path(selection.get("root", ""))
    pattern = selection.get("glob", "**/*.png")
    count = selection.get("count")
    strategy = selection.get("strategy")
    minimum_size = selection.get("minimumSize")

    if not root.is_dir():
        raise SystemExit(
            f"Benchmark corpus directory does not exist: {root}. "
            "Run tools/setup-texture-benchmark-corpus.ps1 first."
        )

    if not isinstance(count, int) or count < 1:
        raise SystemExit("Corpus selection count must be a positive integer")

    if strategy != "sha256-path":
        raise SystemExit(f"Unsupported corpus selection strategy: {strategy}")

    candidates = [candidate for candidate in root.glob(pattern) if candidate.is_file()]
    if minimum_size is not None:
        if (
            not isinstance(minimum_size, list)
            or len(minimum_size) != 2
            or not all(isinstance(value, int) and value > 0 for value in minimum_size)
        ):
            raise SystemExit("Corpus minimumSize must contain two positive integers")

        minimum_width, minimum_height = minimum_size
        eligible = []
        for candidate in candidates:
            with Image.open(candidate) as image:
                if image.width >= minimum_width and image.height >= minimum_height:
                    eligible.append(candidate)
        candidates = eligible

    candidates.sort(
        key=lambda candidate: hashlib.sha256(
            candidate.relative_to(root).as_posix().encode("utf-8")
        ).hexdigest()
    )

    if len(candidates) < count:
        raise SystemExit(
            f"Corpus selection requires {count} files but found {len(candidates)} under {root}"
        )

    entries: list[dict[str, Any]] = []
    for index, candidate in enumerate(candidates[:count], start=1):
        entries.append(
            {
                "id": f"clic-{index:02d}-{candidate.stem}",
                "path": relative_to_root(candidate),
                "class": selection.get("class", "unknown"),
                "transfer": selection.get("transfer", "srgb"),
                "preprocess": selection.get("preprocess"),
            }
        )
    return entries


def resolve_tools(
    args: argparse.Namespace, profiles: list[dict[str, Any]]
) -> dict[str, Path]:
    adapters = {profile["adapter"] for profile in profiles}
    tools: dict[str, Path] = {}

    if "bpal" in adapters:
        if not args.node:
            raise SystemExit("Node.js is required for BPAL benchmark profiles")
        tools["node"] = require_executable(Path(args.node), "Node.js")

    if "texconv" in adapters:
        tools["texconv"] = require_executable(resolve_path(args.texconv), "texconv")

    if "astc" in adapters:
        tools["astcenc"] = require_executable(resolve_path(args.astcenc), "astcenc")

    return tools


def require_executable(path: Path, name: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_file():
        raise SystemExit(
            f"{name} was not found at {resolved}. "
            "Run tools/setup-texture-benchmark.ps1 or pass an explicit path."
        )
    return resolved


def load_source(entry: dict[str, Any]) -> np.ndarray:
    with Image.open(entry["resolvedPath"]) as image:
        image = apply_preprocess(image, entry.get("preprocess"), entry["id"])
        rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)

    alpha_min = int(rgba[:, :, 3].min())
    alpha_max = int(rgba[:, :, 3].max())
    if alpha_min != 255 or alpha_max != 255:
        raise SystemExit(
            f"Corpus image {entry['id']} is not opaque; BPAL cannot represent alpha"
        )

    return np.ascontiguousarray(rgba)


def apply_preprocess(
    image: Image.Image, settings: dict[str, Any] | None, image_id: str
) -> Image.Image:
    if not settings:
        return image

    crop = settings.get("centerCrop")
    if not isinstance(crop, list) or len(crop) != 2:
        raise SystemExit(f"Invalid centerCrop for corpus image {image_id}")

    crop_width, crop_height = crop
    if not isinstance(crop_width, int) or not isinstance(crop_height, int):
        raise SystemExit(f"Invalid centerCrop dimensions for corpus image {image_id}")

    if image.width < crop_width or image.height < crop_height:
        raise SystemExit(
            f"Corpus image {image_id} is {image.width}x{image.height}; "
            f"cannot take a {crop_width}x{crop_height} center crop"
        )

    left = (image.width - crop_width) // 2
    top = (image.height - crop_height) // 2
    return image.crop((left, top, left + crop_width, top + crop_height))


def run_profile(
    profile: dict[str, Any],
    image_entry: dict[str, Any],
    source: np.ndarray,
    source_png: Path,
    source_raw: Path,
    work_dir: Path,
    tools: dict[str, Path],
) -> dict[str, Any]:
    case_dir = work_dir / "cases" / image_entry["id"] / profile["id"]
    case_dir.mkdir(parents=True, exist_ok=True)

    if profile["adapter"] == "bpal":
        encoded = run_bpal(profile, source, source_raw, case_dir, tools["node"])
    elif profile["adapter"] == "texconv":
        encoded = run_texconv(profile, source, source_png, case_dir, tools["texconv"])
    elif profile["adapter"] == "astc":
        encoded = run_astc(profile, source, source_png, case_dir, tools["astcenc"])
    else:
        raise RuntimeError(f"Unsupported adapter: {profile['adapter']}")

    candidate = encoded.pop("pixels")
    mse, squared_error, sample_count = rgb_error(source, candidate)
    pixel_count = source.shape[0] * source.shape[1]

    return {
        "imageId": image_entry["id"],
        "imageClass": image_entry.get("class", "unknown"),
        "transfer": image_entry["transfer"],
        "sourceSha256": image_entry["normalizedSha256"],
        "width": int(source.shape[1]),
        "height": int(source.shape[0]),
        "pixelCount": pixel_count,
        "profileId": profile["id"],
        "codec": profile["codec"],
        "profile": profile["label"],
        "nominalBpp": profile["nominalBpp"],
        "artifactBytes": encoded["artifactBytes"],
        "payloadBytes": encoded["payloadBytes"],
        "containerBytes": encoded["artifactBytes"] - encoded["payloadBytes"],
        "fileBpp": encoded["artifactBytes"] * 8.0 / pixel_count,
        "payloadBpp": encoded["payloadBytes"] * 8.0 / pixel_count,
        "psnrRgb": psnr_rgb(source, candidate),
        "ssimLuma": ssim_luma(source, candidate),
        "mseRgb": mse,
        "squaredErrorRgb": squared_error,
        "rgbSampleCount": sample_count,
        "encodeMilliseconds": encoded["encodeMilliseconds"],
        "decodeMilliseconds": encoded["decodeMilliseconds"],
        "artifact": relative_to_root(encoded["artifact"]),
        "effectiveSettings": encoded.get("effectiveSettings"),
    }


def run_bpal(
    profile: dict[str, Any],
    source: np.ndarray,
    source_raw: Path,
    case_dir: Path,
    node: Path,
) -> dict[str, Any]:
    height, width, _ = source.shape
    artifact = case_dir / "texture.bpal"
    metadata_path = case_dir / "metadata.json"
    decoded_path = case_dir / "decoded.rgba"
    settings = {
        **profile["settings"],
        "paletteMode": "explicit",
        "colorSpace": "rgb",
        "clusteringMethod": "k-means",
        "dithering": "none",
        "diversity": 0,
    }
    adapter = ROOT / "tools" / "benchmark_bpal_adapter.js"

    encode_ms = run_command(
        [
            node,
            adapter,
            "encode",
            source_raw,
            str(width),
            str(height),
            json.dumps(settings, separators=(",", ":")),
            artifact,
            metadata_path,
        ]
    )
    decode_ms = run_command([node, adapter, "decode", artifact, decoded_path])
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    decoded = np.frombuffer(decoded_path.read_bytes(), dtype=np.uint8).reshape(source.shape)

    return {
        "artifact": artifact,
        "artifactBytes": artifact.stat().st_size,
        "payloadBytes": int(metadata["payloadBytes"]),
        "encodeMilliseconds": encode_ms,
        "decodeMilliseconds": decode_ms,
        "effectiveSettings": settings,
        "pixels": decoded,
    }


def run_texconv(
    profile: dict[str, Any],
    source: np.ndarray,
    source_png: Path,
    case_dir: Path,
    texconv: Path,
) -> dict[str, Any]:
    encode_dir = case_dir / "encoded"
    decode_dir = case_dir / "decoded"
    encode_dir.mkdir(parents=True, exist_ok=True)
    decode_dir.mkdir(parents=True, exist_ok=True)
    artifact = encode_dir / f"{source_png.stem}.dds"
    decoded_path = decode_dir / f"{source_png.stem}.png"
    unlink_if_present(artifact)
    unlink_if_present(decoded_path)

    bc_flags = "u"
    command: list[os.PathLike[str] | str] = [
        texconv,
        "-nologo",
        "-y",
        "-m",
        "1",
        "-f",
        profile["format"],
        "-bc",
        "x" if profile["codec"] == "BC7" else bc_flags,
    ]
    if profile["codec"] == "BC7":
        command.append("-nogpu")
    command.extend(["-o", encode_dir, source_png])

    encode_ms = run_command(command)
    artifact = require_generated_file(artifact)
    decode_ms = run_command(
        [
            texconv,
            "-nologo",
            "-y",
            "-m",
            "1",
            "-f",
            "R8G8B8A8_UNORM",
            "-ft",
            "png",
            "-o",
            decode_dir,
            artifact,
        ]
    )
    decoded_path = require_generated_file(decoded_path)
    decoded = load_decoded(decoded_path, source.shape)
    height, width, _ = source.shape
    payload_bytes = math.ceil(width / 4) * math.ceil(height / 4) * profile["blockBytes"]

    return {
        "artifact": artifact,
        "artifactBytes": artifact.stat().st_size,
        "payloadBytes": payload_bytes,
        "encodeMilliseconds": encode_ms,
        "decodeMilliseconds": decode_ms,
        "pixels": decoded,
    }


def run_astc(
    profile: dict[str, Any],
    source: np.ndarray,
    source_png: Path,
    case_dir: Path,
    astcenc: Path,
) -> dict[str, Any]:
    artifact = case_dir / "texture.astc"
    decoded_path = case_dir / "decoded.png"
    unlink_if_present(artifact)
    unlink_if_present(decoded_path)
    block_width, block_height = profile["block"]
    block_text = f"{block_width}x{block_height}"

    encode_ms = run_command(
        [astcenc, "-cl", source_png, artifact, block_text, "-medium", "-silent"]
    )
    decode_ms = run_command([astcenc, "-dl", artifact, decoded_path, "-silent"])
    decoded = load_decoded(decoded_path, source.shape)
    height, width, _ = source.shape
    payload_bytes = math.ceil(width / block_width) * math.ceil(height / block_height) * 16

    if artifact.stat().st_size != payload_bytes + 16:
        raise RuntimeError(
            f"Unexpected ASTC file size for {artifact}: "
            f"{artifact.stat().st_size} vs expected {payload_bytes + 16}"
        )

    return {
        "artifact": artifact,
        "artifactBytes": artifact.stat().st_size,
        "payloadBytes": payload_bytes,
        "encodeMilliseconds": encode_ms,
        "decodeMilliseconds": decode_ms,
        "pixels": decoded,
    }


def run_command(arguments: list[os.PathLike[str] | str]) -> float:
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

    return elapsed_ms


def load_decoded(path: Path, expected_shape: tuple[int, ...]) -> np.ndarray:
    with Image.open(path) as image:
        decoded = np.asarray(image.convert("RGBA"), dtype=np.uint8)

    if decoded.shape != expected_shape:
        raise RuntimeError(f"Decoded image shape differs: {decoded.shape} vs {expected_shape}")

    return np.ascontiguousarray(decoded)


def aggregate_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        groups[record["profileId"]].append(record)

    aggregates: list[dict[str, Any]] = []
    for profile_id, group in groups.items():
        first = group[0]
        pixel_count = sum(record["pixelCount"] for record in group)
        rgb_sample_count = sum(record["rgbSampleCount"] for record in group)
        squared_error = sum(record["squaredErrorRgb"] for record in group)
        mse = squared_error / rgb_sample_count
        aggregates.append(
            {
                "profileId": profile_id,
                "codec": first["codec"],
                "profile": first["profile"],
                "nominalBpp": first["nominalBpp"],
                "imageCount": len(group),
                "pixelCount": pixel_count,
                "artifactBytes": sum(record["artifactBytes"] for record in group),
                "payloadBytes": sum(record["payloadBytes"] for record in group),
                "fileBpp": sum(record["artifactBytes"] for record in group) * 8.0 / pixel_count,
                "payloadBpp": sum(record["payloadBytes"] for record in group) * 8.0 / pixel_count,
                "psnrRgb": math.inf if mse == 0 else 10.0 * math.log10(255.0**2 / mse),
                "ssimLuma": sum(
                    record["ssimLuma"] * record["pixelCount"] for record in group
                ) / pixel_count,
                "mseRgb": mse,
                "encodeMilliseconds": sum(record["encodeMilliseconds"] for record in group),
                "decodeMilliseconds": sum(record["decodeMilliseconds"] for record in group),
            }
        )

    aggregates.sort(key=lambda item: (item["payloadBpp"], item["profileId"]))
    return aggregates


def build_report(
    manifest_path: Path,
    profiles: list[dict[str, Any]],
    images: list[dict[str, Any]],
    tools: dict[str, Path],
    records: list[dict[str, Any]],
    aggregates: list[dict[str, Any]],
) -> dict[str, Any]:
    tool_info = {name: tool_description(name, path) for name, path in tools.items()}
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    return {
        "schemaVersion": 1,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "scope": {
            "mipLevels": 1,
            "channelsScored": "RGB",
            "pixelDomain": "stored uint8 values; no transfer conversion",
            "psnr": "RGB PSNR over all scalar RGB samples",
            "ssim": "BT.709 luminance, 11x11 Gaussian window, sigma 1.5",
            "timing": "cold process wall time including executable startup and file I/O",
        },
        "environment": {
            "platform": platform.platform(),
            "python": sys.version.split()[0],
            "numpy": np.__version__,
            "pillow": PILLOW_VERSION,
            "cpu": platform.processor(),
        },
        "tools": tool_info,
        "dataset": manifest.get("dataset"),
        "selection": manifest.get("selection"),
        "corpusManifest": relative_to_root(manifest_path),
        "images": [
            {
                key: (relative_to_root(value) if key == "resolvedPath" else value)
                for key, value in image.items()
            }
            for image in images
        ],
        "profiles": profiles,
        "aggregate": aggregates,
        "records": records,
    }


def tool_description(name: str, path: Path) -> dict[str, str]:
    if name == "node":
        version = capture_command([path, "--version"])
    elif name == "astcenc":
        version = capture_command([path, "-version"]).splitlines()[0]
    elif name == "texconv":
        version = capture_command([path, "--help"]).splitlines()[0]
    else:
        version = "unknown"
    return {"path": relative_to_root(path), "version": version.strip()}


def capture_command(arguments: list[os.PathLike[str] | str]) -> str:
    completed = subprocess.run(
        [str(argument) for argument in arguments],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"Could not query tool version: {completed.stdout}")
    return completed.stdout.strip()


def write_reports(output_dir: Path, report: dict[str, Any]) -> None:
    json_path = output_dir / "texture-codec-benchmark.json"
    csv_path = output_dir / "texture-codec-benchmark.csv"
    markdown_path = output_dir / "texture-codec-benchmark.md"

    json_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )

    fieldnames = [
        "imageId",
        "imageClass",
        "width",
        "height",
        "profileId",
        "codec",
        "nominalBpp",
        "fileBpp",
        "payloadBpp",
        "psnrRgb",
        "ssimLuma",
        "encodeMilliseconds",
        "decodeMilliseconds",
        "artifactBytes",
        "payloadBytes",
    ]
    with csv_path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(report["records"])

    markdown_path.write_text(render_markdown(report), encoding="utf-8")


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Texture codec benchmark results",
        "",
        f"Generated: `{report['generatedAt']}`.",
        "",
        "All profiles use the same normalized RGBA8 source pixels. Only RGB is scored; ",
        "the run contains mip level 0 only. PSNR is measured in the stored byte domain. ",
        "SSIM uses BT.709 luminance and an 11x11 Gaussian window with sigma 1.5.",
        "",
        "## Tools",
        "",
    ]
    for name, info in report["tools"].items():
        lines.append(f"- **{name}:** `{info['version']}`")

    dataset = report.get("dataset")
    if dataset:
        lines.extend(
            [
                "",
                "## Dataset",
                "",
                f"- **Source:** [{dataset['name']}]({dataset['homepage']})",
                f"- **Archive:** [official download]({dataset['download']})",
                f"- **SHA-256:** `{dataset['sha256']}`",
                f"- **License:** [official license text]({dataset['license']})",
            ]
        )

    lines.extend(
        [
            "",
            "## Aggregate rate-distortion",
            "",
            "| Profile | Payload bpp | File bpp | PSNR RGB (dB) | SSIM luma | Encode (ms) | Decode (ms) |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for row in report["aggregate"]:
        lines.append(
            f"| {row['profile']} | {row['payloadBpp']:.4f} | {row['fileBpp']:.4f} | "
            f"{row['psnrRgb']:.3f} | {row['ssimLuma']:.6f} | "
            f"{row['encodeMilliseconds']:.1f} | {row['decodeMilliseconds']:.1f} |"
        )

    comparisons = render_key_comparisons(report["aggregate"])
    if comparisons:
        lines.extend(["", "## Key comparisons", "", *comparisons])

    lines.extend(
        [
            "",
            "Aggregate PSNR is calculated from total squared RGB error, not by averaging dB. ",
            "Aggregate SSIM is weighted by source pixel count.",
            "",
            "## Per-image results",
            "",
            "| Image | Profile | Payload bpp | PSNR RGB (dB) | SSIM luma |",
            "| --- | --- | ---: | ---: | ---: |",
        ]
    )
    for row in report["records"]:
        lines.append(
            f"| {row['imageId']} | {row['profile']} | {row['payloadBpp']:.4f} | "
            f"{row['psnrRgb']:.3f} | {row['ssimLuma']:.6f} |"
        )

    lines.extend(
        [
            "",
            "## Limitations",
            "",
            "- This is a rate-distortion benchmark, not a GPU sampling benchmark.",
            "- Command timings are cold wall times and include process startup and file I/O.",
            "- BPAL, BC, and ASTC are optimized in the stored 8-bit value domain for this run.",
            "- The default corpus is an eight-image deterministic subset of CLIC 2020.",
            "- Alpha, HDR, normal-map angular error, and mip downsampling are not covered.",
            "",
        ]
    )
    return "\n".join(lines)


def render_key_comparisons(aggregate: list[dict[str, Any]]) -> list[str]:
    rows = {row["profileId"]: row for row in aggregate}
    comparisons: list[str] = []

    def add(winner_id: str, other_id: str) -> None:
        if winner_id not in rows or other_id not in rows:
            return
        winner = rows[winner_id]
        other = rows[other_id]
        comparisons.append(
            f"- **{winner['profile']} vs {other['profile']}:** "
            f"{winner['psnrRgb'] - other['psnrRgb']:+.3f} dB PSNR, "
            f"{winner['ssimLuma'] - other['ssimLuma']:+.6f} SSIM, "
            f"{winner['payloadBpp'] - other['payloadBpp']:+.4f} payload bpp."
        )

    add("astc-8x8", "bpal-2.1")
    add("bpal-v5-mp64", "bpal-v5-sp1")
    add("bpal-v5-mp128", "bpal-v5-mp64")
    add("bpal-v5-mp64", "bpal-v5-mp32")
    add("astc-6x6", "bpal-v5-mp64")
    add("bc1", "bpal-v5-mp64")
    add("bpal-4", "bc1")
    add("astc-6x6", "bpal-4")
    add("astc-5x5", "bpal-6")
    add("bc7", "astc-4x4")
    return comparisons


def resolve_path(value: str | os.PathLike[str]) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def relative_to_root(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path.resolve())


def unlink_if_present(path: Path) -> None:
    if path.is_file():
        path.unlink()


def require_generated_file(path: Path) -> Path:
    if path.is_file():
        return path

    matches = [candidate for candidate in path.parent.iterdir() if candidate.name.lower() == path.name.lower()]
    if len(matches) == 1 and matches[0].is_file():
        return matches[0]

    raise RuntimeError(f"Encoder did not generate expected file: {path}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Benchmark interrupted", file=sys.stderr)
        raise SystemExit(130)
