#!/usr/bin/env python3
"""Compare CUDA BPAL settings search against ASTC on the texture corpus."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import math
import os
import platform
import re
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

from benchmark.metrics import rgb_error  # noqa: E402


BENCHMARK_VERSION = 1
BPAL_HEADER_BYTES = 14
NORMAL_HISTOGRAM_STEP = 0.25
RATE_PAIRS = [
    {"target": "1.5", "astcBlock": [10, 8]},
    {"target": "2", "astcBlock": [8, 8]},
    {"target": "2.5", "astcBlock": [8, 6]},
    {"target": "3", "astcBlock": [8, 5]},
    {"target": "4", "astcBlock": [6, 5]},
    {"target": "5", "astcBlock": [5, 5]},
    {"target": "6", "astcBlock": [5, 4]},
    {"target": "8", "astcBlock": [4, 4]},
]
SCALAR_CLASSES = {
    "ambient-occlusion",
    "displacement",
    "metalness",
    "opacity",
    "roughness",
}
EXPECTED_COUNTS = {"dtd": 5640, "kylberg": 240, "ambientcg": 55}
ENCODED_SETTINGS_RE = re.compile(
    r"block (?P<block>\d+), local (?P<local>\d+), "
    r"(?P<palettes>\d+) x (?P<global>\d+) shared colors, "
    r"RGB(?P<rgb>565|888)"
)
SELECTED_BPP_RE = re.compile(r"Selected (?P<bpp>[0-9.]+) bpp for target")


def main() -> int:
    args = parse_args()
    selected_datasets = parse_csv(args.datasets)
    selected_targets = parse_csv(args.targets)
    validate_choices(selected_datasets, selected_targets)
    images = discover_corpus(selected_datasets)
    if args.limit_per_dataset is not None:
        images = limit_per_dataset(images, args.limit_per_dataset)
    profiles = create_profiles(selected_targets)
    tools = resolve_tools(args)
    work_dir = resolve_path(args.work_dir)
    source_dir = work_dir / "sources"
    temporary_dir = work_dir / "current"
    records_path = work_dir / "records.jsonl"
    report_path = resolve_path(args.report)
    work_dir.mkdir(parents=True, exist_ok=True)
    source_dir.mkdir(parents=True, exist_ok=True)
    temporary_dir.mkdir(parents=True, exist_ok=True)
    records = load_records(records_path)
    expected_keys = {(image["id"], profile["id"]) for image in images for profile in profiles}

    print(
        f"Corpus: {len(images)} images; profiles: {len(profiles)}; "
        f"planned records: {len(expected_keys)}",
        flush=True,
    )
    print(f"Resume: {sum(key in records for key in expected_keys)} records", flush=True)

    completed = 0
    started = time.perf_counter()
    if not args.report_only:
        with records_path.open("a", encoding="utf-8") as record_stream:
            for image_index, image in enumerate(images, start=1):
                source, normalized_path, source_hash = load_normalized_source(image, source_dir)
                for profile in profiles:
                    key = (image["id"], profile["id"])
                    previous = records.get(key)
                    if (
                        previous is not None
                        and previous.get("benchmarkVersion") == BENCHMARK_VERSION
                        and previous.get("sourceSha256") == source_hash
                    ):
                        completed += 1
                        continue

                    record = run_profile(
                        image,
                        profile,
                        source,
                        normalized_path,
                        source_hash,
                        temporary_dir,
                        tools,
                        args,
                    )
                    records[key] = record
                    record_stream.write(json.dumps(record, separators=(",", ":")) + "\n")
                    record_stream.flush()
                    completed += 1

                if image_index % args.progress_every == 0 or image_index == len(images):
                    elapsed = time.perf_counter() - started
                    done = sum(key in records for key in expected_keys)
                    rate = completed / elapsed if elapsed > 0 else 0.0
                    remaining = (len(expected_keys) - done) / rate if rate > 0 else math.inf
                    eta = "unknown" if not math.isfinite(remaining) else format_duration(remaining)
                    print(
                        f"[{image_index}/{len(images)} images] {done}/{len(expected_keys)} records; "
                        f"elapsed {format_duration(elapsed)}; ETA {eta}",
                        flush=True,
                    )

    missing = sorted(expected_keys - records.keys())
    if missing:
        raise SystemExit(f"Benchmark is incomplete; {len(missing)} records are missing")

    selected_records = [records[key] for key in sorted(expected_keys)]
    report = build_report(images, profiles, selected_records, tools, args)
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
    parser.add_argument("--datasets", default="dtd,kylberg,ambientcg")
    parser.add_argument("--targets", default=",".join(pair["target"] for pair in RATE_PAIRS))
    parser.add_argument("--device", type=int, default=0)
    parser.add_argument("--astc-quality", default="medium")
    parser.add_argument("--work-dir", default="benchmark/work/cuda-astc-textures")
    parser.add_argument("--report", default="benchmark/results/cuda-astc-textures.md")
    parser.add_argument("--limit-per-dataset", type=int)
    parser.add_argument("--progress-every", type=int, default=10)
    parser.add_argument("--report-only", action="store_true")
    parser.add_argument("--keep-artifacts", action="store_true")
    parser.add_argument(
        "--bpal5cudaenc",
        default="native/bpal5_simd/build-cuda/bpal5cudaenc.exe",
    )
    parser.add_argument("--bpal5dec", default="native/bpal5_simd/build-cuda/bpal5dec.exe")
    parser.add_argument(
        "--astcenc",
        default=".benchmark-tools/astcenc-5.6.0/bin/astcenc-avx2.exe",
    )
    args = parser.parse_args()
    if args.limit_per_dataset is not None and args.limit_per_dataset < 1:
        parser.error("--limit-per-dataset must be positive")
    if args.progress_every < 1:
        parser.error("--progress-every must be positive")
    if args.device < 0:
        parser.error("--device must be non-negative")
    return args


def parse_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def validate_choices(datasets: list[str], targets: list[str]) -> None:
    unknown_datasets = set(datasets) - EXPECTED_COUNTS.keys()
    known_targets = {pair["target"] for pair in RATE_PAIRS}
    unknown_targets = set(targets) - known_targets
    if unknown_datasets:
        raise SystemExit(f"Unknown datasets: {', '.join(sorted(unknown_datasets))}")
    if unknown_targets:
        raise SystemExit(f"Unknown targets: {', '.join(sorted(unknown_targets))}")
    if not datasets or not targets:
        raise SystemExit("At least one dataset and target are required")


def discover_corpus(selected_datasets: Iterable[str]) -> list[dict[str, Any]]:
    selected = set(selected_datasets)
    images: list[dict[str, Any]] = []

    if "dtd" in selected:
        root = ROOT / ".benchmark-corpus" / "dtd-r1.0.1" / "dtd" / "images"
        for path in sorted(root.glob("*/*.jpg")):
            images.append(
                corpus_entry(
                    path,
                    "dtd",
                    "texture",
                    path.parent.name,
                    root,
                )
            )

    if "kylberg" in selected:
        root = ROOT / ".benchmark-corpus" / "kylberg-v1-small"
        for path in sorted(root.glob("*/*.png")):
            images.append(
                corpus_entry(
                    path,
                    "kylberg",
                    "grayscale-texture",
                    path.parent.name,
                    root,
                )
            )

    if "ambientcg" in selected:
        root = ROOT / ".benchmark-corpus" / "ambientcg-2k-png"
        for path in sorted(root.glob("*/*_2K-PNG_*.png")):
            map_class = ambientcg_map_class(path)
            if map_class is None:
                continue
            images.append(
                corpus_entry(
                    path,
                    "ambientcg",
                    map_class,
                    path.parent.name,
                    root,
                )
            )

    counts = collections.Counter(image["dataset"] for image in images)
    for dataset in selected:
        expected = EXPECTED_COUNTS[dataset]
        if counts[dataset] != expected:
            raise SystemExit(
                f"Expected {expected} {dataset} images, found {counts[dataset]}. "
                "Run tools/setup-texture-datasets.ps1."
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
    mapping = {
        "AmbientOcclusion": "ambient-occlusion",
        "Color": "color",
        "Displacement": "displacement",
        "Metalness": "metalness",
        "NormalGL": "normal",
        "Opacity": "opacity",
        "Roughness": "roughness",
    }
    return mapping.get(suffix)


def limit_per_dataset(images: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    counts: collections.Counter[str] = collections.Counter()
    selected = []
    for image in images:
        if counts[image["dataset"]] >= limit:
            continue
        selected.append(image)
        counts[image["dataset"]] += 1
    return selected


def create_profiles(selected_targets: Iterable[str]) -> list[dict[str, Any]]:
    selected = set(selected_targets)
    profiles = []
    for pair in RATE_PAIRS:
        if pair["target"] not in selected:
            continue
        target_id = pair["target"].replace(".", "_")
        block_width, block_height = pair["astcBlock"]
        profiles.extend(
            [
                {
                    "id": f"bpal-cuda-find-{target_id}",
                    "codec": "BPAL CUDA --find-settings",
                    "targetBpp": float(pair["target"]),
                    "target": pair["target"],
                    "adapter": "bpal-cuda",
                    "label": f"BPAL CUDA find {pair['target']} bpp",
                },
                {
                    "id": f"astc-{block_width}x{block_height}",
                    "codec": "ASTC",
                    "targetBpp": 128.0 / (block_width * block_height),
                    "pairedTarget": float(pair["target"]),
                    "adapter": "astc",
                    "block": [block_width, block_height],
                    "label": f"ASTC {block_width}x{block_height}",
                },
            ]
        )
    return profiles


def resolve_tools(args: argparse.Namespace) -> dict[str, Path]:
    tools = {
        "bpal5cudaenc": require_file(resolve_path(args.bpal5cudaenc)),
        "bpal5dec": require_file(resolve_path(args.bpal5dec)),
        "astcenc": require_file(resolve_path(args.astcenc)),
    }
    return tools


def require_file(path: Path) -> Path:
    if not path.is_file():
        raise SystemExit(f"Required tool does not exist: {path}")
    return path.resolve()


def load_normalized_source(
    image_entry: dict[str, Any], source_dir: Path
) -> tuple[np.ndarray, Path, str]:
    source = load_source_rgb8(image_entry["path"])
    source_hash = hashlib.sha256(source.tobytes()).hexdigest()
    file_id = hashlib.sha256(image_entry["id"].encode("utf-8")).hexdigest()[:20]
    normalized_path = source_dir / f"{file_id}.png"
    if not normalized_path.is_file():
        Image.fromarray(source, mode="RGB").save(normalized_path, optimize=False)
    return source, normalized_path, source_hash


def load_source_rgb8(path: Path) -> np.ndarray:
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
    return np.ascontiguousarray(rgb)


def run_profile(
    image_entry: dict[str, Any],
    profile: dict[str, Any],
    source: np.ndarray,
    normalized_path: Path,
    source_hash: str,
    temporary_dir: Path,
    tools: dict[str, Path],
    args: argparse.Namespace,
) -> dict[str, Any]:
    clear_temporary_files(temporary_dir)
    if profile["adapter"] == "bpal-cuda":
        encoded = run_bpal_cuda(profile, normalized_path, temporary_dir, tools, args)
    else:
        encoded = run_astc(profile, normalized_path, temporary_dir, tools, args)

    candidate = encoded.pop("pixels")
    mse, squared_error, sample_count = rgb_error(source, candidate)
    pixel_count = int(source.shape[0] * source.shape[1])
    record: dict[str, Any] = {
        "benchmarkVersion": BENCHMARK_VERSION,
        "imageId": image_entry["id"],
        "dataset": image_entry["dataset"],
        "imageClass": image_entry["imageClass"],
        "contentClass": image_entry["contentClass"],
        "sourceSha256": source_hash,
        "width": int(source.shape[1]),
        "height": int(source.shape[0]),
        "pixelCount": pixel_count,
        "profileId": profile["id"],
        "codec": profile["codec"],
        "targetBpp": profile["targetBpp"],
        "artifactBytes": encoded["artifactBytes"],
        "payloadBytes": encoded["payloadBytes"],
        "fileBpp": encoded["artifactBytes"] * 8.0 / pixel_count,
        "payloadBpp": encoded["payloadBytes"] * 8.0 / pixel_count,
        "mseRgb": mse,
        "squaredErrorRgb": squared_error,
        "rgbSampleCount": sample_count,
        "psnrRgb": finite_psnr(mse),
        "encodeMilliseconds": encoded["encodeMilliseconds"],
        "decodeMilliseconds": encoded["decodeMilliseconds"],
        "effectiveSettings": encoded.get("effectiveSettings"),
    }

    if image_entry["imageClass"] in SCALAR_CLASSES:
        difference = source[:, :, 0].astype(np.float64) - candidate[:, :, 0].astype(np.float64)
        scalar_squared_error = float(np.square(difference).sum(dtype=np.float64))
        scalar_mse = scalar_squared_error / pixel_count
        record.update(
            {
                "scalarSquaredError": scalar_squared_error,
                "scalarSampleCount": pixel_count,
                "psnrScalar": finite_psnr(scalar_mse),
            }
        )

    if image_entry["imageClass"] == "normal":
        normal = normal_angular_stats(source, candidate)
        record.update(normal)

    if not args.keep_artifacts:
        clear_temporary_files(temporary_dir)
    return record


def run_bpal_cuda(
    profile: dict[str, Any],
    source_path: Path,
    temporary_dir: Path,
    tools: dict[str, Path],
    args: argparse.Namespace,
) -> dict[str, Any]:
    artifact = temporary_dir / "texture.bpal"
    decoded_path = temporary_dir / "decoded.ppm"
    command = [
        tools["bpal5cudaenc"],
        source_path,
        artifact,
        "--preset",
        profile["target"],
        "--find-settings",
        "--device",
        str(args.device),
    ]
    encode_ms, output = run_command(command)
    decode_ms, _ = run_command([tools["bpal5dec"], artifact, decoded_path])
    settings_match = ENCODED_SETTINGS_RE.search(output)
    selected_match = SELECTED_BPP_RE.search(output)
    if settings_match is None or selected_match is None:
        raise RuntimeError(f"Could not parse CUDA settings output:\n{output}")
    decoded = load_decoded(decoded_path)
    artifact_bytes = artifact.stat().st_size
    if artifact_bytes < BPAL_HEADER_BYTES:
        raise RuntimeError(f"BPAL artifact is too small: {artifact}")
    return {
        "artifactBytes": artifact_bytes,
        "payloadBytes": artifact_bytes - BPAL_HEADER_BYTES,
        "encodeMilliseconds": encode_ms,
        "decodeMilliseconds": decode_ms,
        "effectiveSettings": {
            "requestedTargetBpp": float(profile["target"]),
            "selectedEstimatedBpp": float(selected_match.group("bpp")),
            "blockSize": int(settings_match.group("block")),
            "localColorCount": int(settings_match.group("local")),
            "paletteCount": int(settings_match.group("palettes")),
            "globalColorCount": int(settings_match.group("global")),
            "paletteColorBits": 16 if settings_match.group("rgb") == "565" else 24,
            "findSettings": True,
        },
        "pixels": decoded,
    }


def run_astc(
    profile: dict[str, Any],
    source_path: Path,
    temporary_dir: Path,
    tools: dict[str, Path],
    args: argparse.Namespace,
) -> dict[str, Any]:
    artifact = temporary_dir / "texture.astc"
    decoded_path = temporary_dir / "decoded.png"
    block_width, block_height = profile["block"]
    encode_ms, _ = run_command(
        [
            tools["astcenc"],
            "-cl",
            source_path,
            artifact,
            f"{block_width}x{block_height}",
            f"-{args.astc_quality}",
            "-silent",
        ]
    )
    decode_ms, _ = run_command([tools["astcenc"], "-dl", artifact, decoded_path, "-silent"])
    decoded = load_decoded(decoded_path)
    width, height = decoded.shape[1], decoded.shape[0]
    payload_bytes = math.ceil(width / block_width) * math.ceil(height / block_height) * 16
    artifact_bytes = artifact.stat().st_size
    if artifact_bytes != payload_bytes + 16:
        raise RuntimeError(
            f"Unexpected ASTC size: {artifact_bytes}; expected {payload_bytes + 16}"
        )
    return {
        "artifactBytes": artifact_bytes,
        "payloadBytes": payload_bytes,
        "encodeMilliseconds": encode_ms,
        "decodeMilliseconds": decode_ms,
        "effectiveSettings": {
            "block": profile["block"],
            "quality": args.astc_quality,
            "profile": "linear LDR",
        },
        "pixels": decoded,
    }


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


def load_decoded(path: Path) -> np.ndarray:
    if not path.is_file():
        raise RuntimeError(f"Decoder did not create {path}")
    with Image.open(path) as image:
        decoded = np.asarray(image.convert("RGB"), dtype=np.uint8)
    return np.ascontiguousarray(decoded)


def clear_temporary_files(path: Path) -> None:
    for name in ("texture.bpal", "texture.astc", "decoded.ppm", "decoded.png"):
        candidate = path / name
        if candidate.exists():
            candidate.unlink()


def finite_psnr(mse: float) -> float | None:
    return None if mse == 0 else 10.0 * math.log10((255.0 * 255.0) / mse)


def normal_angular_stats(reference: np.ndarray, candidate: np.ndarray) -> dict[str, Any]:
    reference_vectors = reference.astype(np.float32) / 127.5 - 1.0
    candidate_vectors = candidate.astype(np.float32) / 127.5 - 1.0
    reference_norms = np.linalg.norm(reference_vectors, axis=2, keepdims=True)
    candidate_norms = np.linalg.norm(candidate_vectors, axis=2, keepdims=True)
    reference_vectors /= np.maximum(reference_norms, 1e-8)
    candidate_vectors /= np.maximum(candidate_norms, 1e-8)
    dots = np.clip(np.sum(reference_vectors * candidate_vectors, axis=2), -1.0, 1.0)
    angles = np.degrees(np.arccos(dots)).astype(np.float64)
    bins = np.arange(0.0, 180.0 + NORMAL_HISTOGRAM_STEP, NORMAL_HISTOGRAM_STEP)
    histogram, _ = np.histogram(angles, bins=bins)
    return {
        "normalAngleSum": float(angles.sum(dtype=np.float64)),
        "normalAngleCount": int(angles.size),
        "normalAngleMean": float(angles.mean(dtype=np.float64)),
        "normalAngleP95": float(np.percentile(angles, 95)),
        "normalAngleHistogram": histogram.tolist(),
    }


def load_records(path: Path) -> dict[tuple[str, str], dict[str, Any]]:
    records: dict[tuple[str, str], dict[str, Any]] = {}
    if not path.is_file():
        return records
    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as error:
                raise SystemExit(f"Invalid JSONL record at {path}:{line_number}: {error}") from error
            records[(record["imageId"], record["profileId"])] = record
    return records


def build_report(
    images: list[dict[str, Any]],
    profiles: list[dict[str, Any]],
    records: list[dict[str, Any]],
    tools: dict[str, Path],
    args: argparse.Namespace,
) -> dict[str, Any]:
    groups: list[dict[str, Any]] = []
    groups.append(build_group("all", "All downloaded texture datasets", records, profiles))
    for dataset in ("dtd", "kylberg", "ambientcg"):
        subset = [record for record in records if record["dataset"] == dataset]
        if subset:
            groups.append(build_group(f"dataset:{dataset}", dataset, subset, profiles))
    pbr_classes = sorted(
        {record["imageClass"] for record in records if record["dataset"] == "ambientcg"}
    )
    for image_class in pbr_classes:
        subset = [
            record
            for record in records
            if record["dataset"] == "ambientcg" and record["imageClass"] == image_class
        ]
        groups.append(build_group(f"pbr:{image_class}", image_class, subset, profiles))

    settings = build_settings_distribution(records)
    return {
        "schemaVersion": 1,
        "benchmarkVersion": BENCHMARK_VERSION,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "corpus": {
            "imageCount": len(images),
            "datasetCounts": dict(collections.Counter(image["dataset"] for image in images)),
            "pbrMapCounts": dict(
                collections.Counter(
                    image["imageClass"] for image in images if image["dataset"] == "ambientcg"
                )
            ),
            "normalization": "RGB8; uint16 PNG values scaled by round(value / 257)",
        },
        "method": {
            "bpal": "bpal5cudaenc --preset BPP --find-settings --device N",
            "astc": f"astcenc linear LDR -{args.astc_quality}",
            "channelsScored": "RGB in stored uint8 domain",
            "normalMetric": "angular error after vector reconstruction and normalization",
            "mipLevels": 1,
        },
        "environment": {
            "platform": platform.platform(),
            "python": sys.version.split()[0],
            "numpy": np.__version__,
            "pillow": PILLOW_VERSION,
            "cpu": platform.processor(),
        },
        "tools": {name: tool_info(name, path) for name, path in tools.items()},
        "profiles": profiles,
        "groups": groups,
        "settingsDistribution": settings,
    }


def build_group(
    group_id: str,
    label: str,
    records: list[dict[str, Any]],
    profiles: list[dict[str, Any]],
) -> dict[str, Any]:
    aggregate = []
    for profile in profiles:
        subset = [record for record in records if record["profileId"] == profile["id"]]
        if subset:
            aggregate.append(aggregate_records(profile, subset))
    bpal_curve = [row for row in aggregate if row["codec"].startswith("BPAL")]
    astc_curve = [row for row in aggregate if row["codec"] == "ASTC"]
    return {
        "id": group_id,
        "label": label,
        "imageCount": len({record["imageId"] for record in records}),
        "aggregate": aggregate,
        "bdRatePercent": bd_rate(bpal_curve, astc_curve),
    }


def aggregate_records(profile: dict[str, Any], records: list[dict[str, Any]]) -> dict[str, Any]:
    pixel_count = sum(record["pixelCount"] for record in records)
    squared_error = sum(record["squaredErrorRgb"] for record in records)
    sample_count = sum(record["rgbSampleCount"] for record in records)
    mse = squared_error / sample_count
    row: dict[str, Any] = {
        "profileId": profile["id"],
        "codec": profile["codec"],
        "label": profile["label"],
        "targetBpp": profile["targetBpp"],
        "imageCount": len(records),
        "pixelCount": pixel_count,
        "payloadBytes": sum(record["payloadBytes"] for record in records),
        "artifactBytes": sum(record["artifactBytes"] for record in records),
        "payloadBpp": sum(record["payloadBytes"] for record in records) * 8.0 / pixel_count,
        "fileBpp": sum(record["artifactBytes"] for record in records) * 8.0 / pixel_count,
        "mseRgb": mse,
        "psnrRgb": finite_psnr(mse),
        "encodeMilliseconds": sum(record["encodeMilliseconds"] for record in records),
        "decodeMilliseconds": sum(record["decodeMilliseconds"] for record in records),
    }
    scalar_records = [record for record in records if "scalarSquaredError" in record]
    if scalar_records:
        scalar_error = sum(record["scalarSquaredError"] for record in scalar_records)
        scalar_count = sum(record["scalarSampleCount"] for record in scalar_records)
        row["psnrScalar"] = finite_psnr(scalar_error / scalar_count)
    normal_records = [record for record in records if "normalAngleHistogram" in record]
    if normal_records:
        angle_count = sum(record["normalAngleCount"] for record in normal_records)
        angle_sum = sum(record["normalAngleSum"] for record in normal_records)
        histogram = np.sum(
            np.asarray([record["normalAngleHistogram"] for record in normal_records], dtype=np.int64),
            axis=0,
        )
        row["normalAngleMean"] = angle_sum / angle_count
        row["normalAngleP95"] = histogram_percentile(histogram, 0.95)
    return row


def histogram_percentile(histogram: np.ndarray, percentile: float) -> float:
    threshold = int(math.ceil(int(histogram.sum()) * percentile))
    index = int(np.searchsorted(np.cumsum(histogram), threshold, side="left"))
    return (index + 1) * NORMAL_HISTOGRAM_STEP


def bd_rate(
    bpal_curve: list[dict[str, Any]], astc_curve: list[dict[str, Any]]
) -> float | None:
    first = pareto_curve(bpal_curve)
    second = pareto_curve(astc_curve)
    if len(first) < 4 or len(second) < 4:
        return None
    quality_min = max(min(point[1] for point in first), min(point[1] for point in second))
    quality_max = min(max(point[1] for point in first), max(point[1] for point in second))
    if quality_max <= quality_min:
        return None
    first_poly = np.polyfit(
        [quality for _, quality in first],
        [math.log(rate) for rate, _ in first],
        3,
    )
    second_poly = np.polyfit(
        [quality for _, quality in second],
        [math.log(rate) for rate, _ in second],
        3,
    )
    first_integral = np.polyint(first_poly)
    second_integral = np.polyint(second_poly)
    span = quality_max - quality_min
    first_average = (np.polyval(first_integral, quality_max) - np.polyval(first_integral, quality_min)) / span
    second_average = (np.polyval(second_integral, quality_max) - np.polyval(second_integral, quality_min)) / span
    return float((math.exp(first_average - second_average) - 1.0) * 100.0)


def pareto_curve(rows: list[dict[str, Any]]) -> list[tuple[float, float]]:
    points = sorted(
        (row["payloadBpp"], row["psnrRgb"])
        for row in rows
        if row["payloadBpp"] > 0 and row["psnrRgb"] is not None
    )
    result = []
    best_quality = -math.inf
    for rate, quality in points:
        if quality > best_quality:
            result.append((rate, quality))
            best_quality = quality
    return result


def build_settings_distribution(records: list[dict[str, Any]]) -> dict[str, Any]:
    counters: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    for record in records:
        settings = record.get("effectiveSettings") or {}
        if not settings.get("findSettings"):
            continue
        key = (
            f"B{settings['blockSize']}/L{settings['localColorCount']}/"
            f"P{settings['paletteCount']}xG{settings['globalColorCount']}/"
            f"RGB{settings['paletteColorBits']}"
        )
        counters[record["profileId"]][key] += 1
    return {
        profile_id: [{"settings": key, "count": count} for key, count in counter.most_common()]
        for profile_id, counter in counters.items()
    }


def tool_info(name: str, path: Path) -> dict[str, str]:
    arguments = [path, "-version"] if name == "astcenc" else [path, "--version"]
    _, output = run_command(arguments)
    return {"path": relative_to_root(path), "version": output.strip().splitlines()[0]}


def render_markdown(report: dict[str, Any]) -> str:
    all_group = next(group for group in report["groups"] if group["id"] == "all")
    rows = {row["profileId"]: row for row in all_group["aggregate"]}
    lines = [
        "# CUDA BPAL settings search versus ASTC on texture datasets",
        "",
        f"Generated: `{report['generatedAt']}`.",
        "",
        "## Conclusion",
        "",
    ]
    bd = all_group["bdRatePercent"]
    if bd is None:
        lines.append("The aggregate curves do not have enough overlap for a BD-rate result.")
    elif bd < 0:
        lines.append(
            f"Across the overlapping aggregate PSNR range, CUDA BPAL with per-image "
            f"`--find-settings` uses **{-bd:.2f}% less payload rate** than ASTC `-medium` "
            "according to the Bjontegaard delta-rate calculation."
        )
    else:
        lines.append(
            f"Across the overlapping aggregate PSNR range, CUDA BPAL with per-image "
            f"`--find-settings` uses **{bd:.2f}% more payload rate** than ASTC `-medium` "
            "according to the Bjontegaard delta-rate calculation."
        )

    lines.extend(
        [
            "",
            "## Methodology",
            "",
            f"- Corpus: {report['corpus']['imageCount']:,} images: "
            + ", ".join(
                f"{name} {count:,}" for name, count in report["corpus"]["datasetCounts"].items()
            )
            + ".",
            "- ambientCG previews and duplicate DirectX normal maps were excluded; NormalGL was retained.",
            "- Every input was normalized once to RGB8. Sixteen-bit displacement maps were scaled by `round(value / 257)`.",
            "- BPAL used the CUDA encoder with `--find-settings` independently for every image and target bitrate.",
            f"- ASTC used linear LDR mode and `-{report['method']['astc'].split('-')[-1]}` quality.",
            "- PSNR is calculated from pooled RGB squared error in the stored uint8 domain.",
            "- Payload bpp excludes the 14-byte BPAL and 16-byte ASTC headers.",
            "- Only mip level 0 was tested.",
            "",
            "## Aggregate rate-distortion",
            "",
            "| Codec | Target/pair | Payload bpp | File bpp | RGB PSNR | Encode time | Decode time |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for pair in RATE_PAIRS:
        target_id = pair["target"].replace(".", "_")
        for profile_id in (
            f"bpal-cuda-find-{target_id}",
            f"astc-{pair['astcBlock'][0]}x{pair['astcBlock'][1]}",
        ):
            if profile_id not in rows:
                continue
            row = rows[profile_id]
            lines.append(
                f"| {row['label']} | {row['targetBpp']:.3f} | {row['payloadBpp']:.4f} | "
                f"{row['fileBpp']:.4f} | {format_psnr(row['psnrRgb'])} | "
                f"{format_duration(row['encodeMilliseconds'] / 1000)} | "
                f"{format_duration(row['decodeMilliseconds'] / 1000)} |"
            )

    lines.extend(
        [
            "",
            "## Paired operating points",
            "",
            "| BPAL target | ASTC block | BPAL bpp | ASTC bpp | BPAL PSNR | ASTC PSNR | PSNR delta |",
            "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for pair in RATE_PAIRS:
        target_id = pair["target"].replace(".", "_")
        bpal = rows.get(f"bpal-cuda-find-{target_id}")
        astc = rows.get(f"astc-{pair['astcBlock'][0]}x{pair['astcBlock'][1]}")
        if bpal is None or astc is None:
            continue
        delta = None if bpal["psnrRgb"] is None or astc["psnrRgb"] is None else bpal["psnrRgb"] - astc["psnrRgb"]
        lines.append(
            f"| {pair['target']} | {pair['astcBlock'][0]}x{pair['astcBlock'][1]} | "
            f"{bpal['payloadBpp']:.4f} | {astc['payloadBpp']:.4f} | "
            f"{format_psnr(bpal['psnrRgb'])} | {format_psnr(astc['psnrRgb'])} | "
            f"{format_delta(delta)} |"
        )

    lines.extend(
        [
            "",
            "## Bjontegaard delta rate by subset",
            "",
            "Negative values favor BPAL; positive values favor ASTC.",
            "",
            "| Subset | Images | BPAL delta rate vs ASTC |",
            "| --- | ---: | ---: |",
        ]
    )
    for group in report["groups"]:
        if group["id"].startswith("pbr:"):
            continue
        lines.append(
            f"| {group['label']} | {group['imageCount']:,} | {format_percent(group['bdRatePercent'])} |"
        )

    pbr_groups = [group for group in report["groups"] if group["id"].startswith("pbr:")]
    if pbr_groups:
        lines.extend(
            [
                "",
                "## PBR map classes",
                "",
                "| Map class | Images | BPAL delta rate vs ASTC |",
                "| --- | ---: | ---: |",
            ]
        )
        for group in pbr_groups:
            lines.append(
                f"| {group['label']} | {group['imageCount']:,} | {format_percent(group['bdRatePercent'])} |"
            )

    normal_group = next((group for group in pbr_groups if group["id"] == "pbr:normal"), None)
    if normal_group:
        normal_rows = {row["profileId"]: row for row in normal_group["aggregate"]}
        lines.extend(
            [
                "",
                "## Normal-map angular error",
                "",
                "| BPAL target | ASTC block | BPAL mean | ASTC mean | BPAL p95 | ASTC p95 |",
                "| ---: | ---: | ---: | ---: | ---: | ---: |",
            ]
        )
        for pair in RATE_PAIRS:
            target_id = pair["target"].replace(".", "_")
            bpal = normal_rows.get(f"bpal-cuda-find-{target_id}")
            astc = normal_rows.get(f"astc-{pair['astcBlock'][0]}x{pair['astcBlock'][1]}")
            if bpal is None or astc is None:
                continue
            lines.append(
                f"| {pair['target']} | {pair['astcBlock'][0]}x{pair['astcBlock'][1]} | "
                f"{bpal['normalAngleMean']:.3f}° | {astc['normalAngleMean']:.3f}° | "
                f"{bpal['normalAngleP95']:.3f}° | {astc['normalAngleP95']:.3f}° |"
            )

    lines.extend(
        [
            "",
            "## Most frequently selected BPAL settings",
            "",
            "This table verifies that the CUDA encoder searched and selected settings per image.",
            "",
            "| Target | Settings | Images |",
            "| ---: | --- | ---: |",
        ]
    )
    for pair in RATE_PAIRS:
        profile_id = f"bpal-cuda-find-{pair['target'].replace('.', '_')}"
        choices = report["settingsDistribution"].get(profile_id, [])[:5]
        for choice in choices:
            lines.append(f"| {pair['target']} | `{choice['settings']}` | {choice['count']:,} |")

    lines.extend(
        [
            "",
            "## Tools",
            "",
        ]
    )
    for name, info in report["tools"].items():
        lines.append(f"- **{name}:** `{info['version']}` (`{info['path']}`)")
    lines.extend(
        [
            "",
            "## Limitations",
            "",
            "- ASTC encoding ran on the CPU; BPAL settings search and refinement ran on CUDA.",
            "- Timing includes process startup and file I/O and is not a GPU sampling benchmark.",
            "- RGB PSNR is not perceptually linear. Normal maps additionally use angular error.",
            "- Alpha, HDR, mip-chain generation, and runtime texture filtering were not tested.",
            "",
        ]
    )
    return "\n".join(lines)


def format_psnr(value: float | None) -> str:
    return "∞" if value is None else f"{value:.3f} dB"


def format_delta(value: float | None) -> str:
    return "n/a" if value is None else f"{value:+.3f} dB"


def format_percent(value: float | None) -> str:
    return "n/a" if value is None else f"{value:+.2f}%"


def format_duration(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {seconds:02d}s"
    if minutes:
        return f"{minutes}m {seconds:02d}s"
    return f"{seconds}s"


def resolve_path(value: str | os.PathLike[str]) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def relative_to_root(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path.resolve())


if __name__ == "__main__":
    raise SystemExit(main())
