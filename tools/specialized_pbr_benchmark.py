#!/usr/bin/env python3
"""Benchmark BPAL scalar8 palette storage against RGB BPAL."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import subprocess
import time
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SCALAR_CLASSES = {
    "ambient-occlusion",
    "displacement",
    "metalness",
    "opacity",
    "roughness",
}
PROFILE_TARGET = re.compile(r"bpal-cuda-find-(?P<target>[0-9_]+)$")
REJECTED_NORMAL_BD_RATE = 9.797528853749471


def main() -> int:
    args = parse_args()
    baseline = load_baseline(args.baseline_records)
    output_records = load_output(args.output_records)
    tasks = [
        record
        for record in baseline
        if record["dataset"] == "ambientcg"
        and record["codec"].startswith("BPAL")
        and record["imageClass"] in SCALAR_CLASSES
    ]
    args.output_records.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output_records.parent / "current"
    temporary.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    completed = 0
    with args.output_records.open("a", encoding="utf-8") as stream:
        for baseline_record in tasks:
            key = (baseline_record["imageId"], baseline_record["profileId"])
            if key not in output_records:
                record = run_one(baseline_record, args, temporary)
                stream.write(json.dumps(record, separators=(",", ":")) + "\n")
                stream.flush()
                output_records[key] = record
            completed += 1
            if completed % args.progress_every == 0 or completed == len(tasks):
                elapsed = time.perf_counter() - started
                print(f"[{completed}/{len(tasks)}] {elapsed:.1f}s", flush=True)

    selected = [output_records[(record["imageId"], record["profileId"])] for record in tasks]
    report = build_report(tasks, selected)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(render_report(report), encoding="utf-8")
    args.summary.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Report: {args.report}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-records", type=Path, required=True)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--encoder", type=Path, required=True)
    parser.add_argument("--decoder", type=Path, required=True)
    parser.add_argument(
        "--output-records",
        type=Path,
        default=ROOT / "benchmark/work/specialized-pbr/records.jsonl",
    )
    parser.add_argument(
        "--summary",
        type=Path,
        default=ROOT / "benchmark/work/specialized-pbr/summary.json",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=ROOT / "benchmark/results/specialized-pbr-modes.md",
    )
    parser.add_argument("--progress-every", type=int, default=8)
    return parser.parse_args()


def load_baseline(path: Path) -> list[dict[str, Any]]:
    records: dict[tuple[str, str], dict[str, Any]] = {}
    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            record = json.loads(line)
            if record.get("benchmarkVersion") == 1:
                records[(record["imageId"], record["profileId"])] = record
    return list(records.values())


def load_output(path: Path) -> dict[tuple[str, str], dict[str, Any]]:
    if not path.is_file():
        return {}
    records = {}
    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            record = json.loads(line)
            records[(record["imageId"], record["profileId"])] = record
    return records


def run_one(
    baseline: dict[str, Any], args: argparse.Namespace, temporary: Path
) -> dict[str, Any]:
    file_id = hashlib.sha256(baseline["imageId"].encode("utf-8")).hexdigest()[:20]
    source_path = args.source_dir / f"{file_id}.png"
    if not source_path.is_file():
        raise RuntimeError(f"Missing normalized source: {source_path}")
    settings = baseline["effectiveSettings"]
    channel_mode = "scalar"
    artifact = temporary / "texture.bpal"
    decoded_path = temporary / "decoded.ppm"
    command = [
        args.encoder,
        source_path,
        artifact,
        "--block",
        str(settings["blockSize"]),
        "--local",
        str(settings["localColorCount"]),
        "--global",
        str(settings["globalColorCount"]),
        "--palettes",
        str(settings["paletteCount"]),
        "--refine",
        "4",
        "--device",
        "0",
        f"--{channel_mode}",
    ]
    if settings["paletteColorBits"] == 16:
        command.append("--rgb565")
    encode_ms = run(command)
    decode_ms = run([args.decoder, artifact, decoded_path])
    source = load_rgb(source_path)
    decoded = load_rgb(decoded_path)
    pixel_count = int(source.shape[0] * source.shape[1])
    result = {
        "imageId": baseline["imageId"],
        "imageClass": baseline["imageClass"],
        "contentClass": baseline["contentClass"],
        "profileId": baseline["profileId"],
        "channelMode": channel_mode,
        "payloadBytes": artifact.stat().st_size - 14,
        "payloadBpp": (artifact.stat().st_size - 14) * 8.0 / pixel_count,
        "encodeMilliseconds": encode_ms,
        "decodeMilliseconds": decode_ms,
        "baselinePayloadBpp": baseline["payloadBpp"],
        "settings": settings,
    }
    difference = source[:, :, 0].astype(np.float64) - decoded[:, :, 0].astype(np.float64)
    squared_error = float(np.square(difference).sum(dtype=np.float64))
    result["scalarSquaredError"] = squared_error
    result["scalarSampleCount"] = pixel_count
    result["psnrScalar"] = psnr(squared_error / pixel_count)
    result["baselineScalarSquaredError"] = baseline["scalarSquaredError"]
    result["baselineScalarSampleCount"] = baseline["scalarSampleCount"]
    return result


def run(command: list[Path | str]) -> float:
    started = time.perf_counter()
    completed = subprocess.run(
        [str(part) for part in command],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    elapsed = (time.perf_counter() - started) * 1000.0
    if completed.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(map(str, command))}\n{completed.stdout}")
    return elapsed


def load_rgb(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        return np.ascontiguousarray(np.asarray(image.convert("RGB"), dtype=np.uint8))


def psnr(mse: float) -> float | None:
    return None if mse == 0.0 else 10.0 * math.log10(65025.0 / mse)


def build_report(
    baseline: list[dict[str, Any]], specialized: list[dict[str, Any]]
) -> dict[str, Any]:
    scalar_rows = aggregate_scalar(baseline, specialized)
    return {
        "imageCount": len({record["imageId"] for record in specialized}),
        "recordCount": len(specialized),
        "scalar": {
            "rows": scalar_rows,
            "bdRatePercent": bd_rate(
                [(row["specializedBpp"], row["specializedPsnr"]) for row in scalar_rows],
                [(row["baselineBpp"], row["baselinePsnr"]) for row in scalar_rows],
            ),
        },
        "rejectedNormalExperiment": {
            "imageCount": 12,
            "recordCount": 96,
            "bdRatePercent": REJECTED_NORMAL_BD_RATE,
            "reason": "Worse rate at equal angular error",
        },
    }


def target_key(profile_id: str) -> float:
    match = PROFILE_TARGET.fullmatch(profile_id)
    if match is None:
        raise ValueError(profile_id)
    return float(match.group("target").replace("_", "."))


def aggregate_scalar(
    baseline: list[dict[str, Any]], specialized: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    rows = []
    for profile in sorted({r["profileId"] for r in specialized}, key=target_key):
        spec = [r for r in specialized if r["profileId"] == profile and r["channelMode"] == "scalar"]
        base = [
            r for r in baseline
            if r["profileId"] == profile and r["imageClass"] in SCALAR_CLASSES
        ]
        if not spec:
            continue
        spec_error = sum(r["scalarSquaredError"] for r in spec)
        spec_samples = sum(r["scalarSampleCount"] for r in spec)
        base_error = sum(r["scalarSquaredError"] for r in base)
        base_samples = sum(r["scalarSampleCount"] for r in base)
        rows.append({
            "target": target_key(profile),
            "baselineBpp": sum(r["payloadBpp"] for r in base) / len(base),
            "specializedBpp": sum(r["payloadBpp"] for r in spec) / len(spec),
            "baselinePsnr": psnr(base_error / base_samples),
            "specializedPsnr": psnr(spec_error / spec_samples),
        })
    return rows


def bd_rate(first: list[tuple[float, float]], second: list[tuple[float, float]]) -> float | None:
    first = pareto(first)
    second = pareto(second)
    if len(first) < 4 or len(second) < 4:
        return None
    quality_min = max(min(q for _, q in first), min(q for _, q in second))
    quality_max = min(max(q for _, q in first), max(q for _, q in second))
    if quality_max <= quality_min:
        return None
    first_poly = np.polyfit([q for _, q in first], [math.log(r) for r, q in first], 3)
    second_poly = np.polyfit([q for _, q in second], [math.log(r) for r, q in second], 3)
    span = quality_max - quality_min
    first_integral = np.polyint(first_poly)
    second_integral = np.polyint(second_poly)
    first_average = float(np.diff(np.polyval(first_integral, [quality_min, quality_max]))[0] / span)
    second_average = float(np.diff(np.polyval(second_integral, [quality_min, quality_max]))[0] / span)
    return (math.exp(first_average - second_average) - 1.0) * 100.0


def pareto(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    result = []
    best = -math.inf
    for rate, quality in sorted(points):
        if quality > best:
            result.append((rate, quality))
            best = quality
    return result


def render_report(report: dict[str, Any]) -> str:
    lines = [
        "# Specialized BPAL PBR channel modes",
        "",
        f"Compared {report['imageCount']} scalar maps from the pinned ambientCG corpus "
        f"({report['recordCount']} retained encodes).",
        "",
        "The specialized encodes reuse each baseline `--find-settings` structural choice. This isolates the channel "
        "representation: scalar palette entries use 8 bits. Block selectors and pixel indices are unchanged.",
        "",
        f"Scalar BD-rate versus RGB BPAL at equal scalar PSNR: **{report['scalar']['bdRatePercent']:.2f}%**.",
        "",
        "## Scalar maps",
        "",
        "| Target | RGB BPAL bpp | Scalar8 bpp | RGB PSNR | Scalar8 PSNR |",
        "|---:|---:|---:|---:|---:|",
    ]
    for row in report["scalar"]["rows"]:
        lines.append(
            f"| {row['target']:g} | {row['baselineBpp']:.3f} | {row['specializedBpp']:.3f} | "
            f"{row['baselinePsnr']:.3f} | {row['specializedPsnr']:.3f} |"
        )
    lines += [
        "",
        "## Rejected normal-map experiment",
        "",
        f"A separate {report['rejectedNormalExperiment']['recordCount']}-encode experiment on "
        f"{report['rejectedNormalExperiment']['imageCount']} NormalGL maps stored XY8 and reconstructed Z. "
        f"It produced **+{report['rejectedNormalExperiment']['bdRatePercent']:.2f}% BD-rate** at equal angular "
        "error, so that format and its implementation were removed.",
        "",
        "## Decode constraints",
        "",
        "Scalar mode preserves deterministic O(1) random pixel access. A decoder reads the block selector, local "
        "color index, pixel index, and one independent palette entry, then replicates one byte. No neighboring "
        "block or variable-length stream is referenced.",
        "",
    ]
    return "\n".join(lines)


if __name__ == "__main__":
    raise SystemExit(main())
