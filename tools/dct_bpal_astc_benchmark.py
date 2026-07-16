#!/usr/bin/env python3
"""Compare DCTBS2, BPAL, and ASTC on one prepared RGB crop corpus."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import math
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
BPAL_HEADER_BYTES = 14
ASTC_HEADER_BYTES = 16
DCT_HEADER_BYTES = 64
DCT_MODES = ["0.75", "1", "1.5", "2", "3", "4.5", "6", "7.5", "9"]
DCT_CODING = {
    "0.75": "grouped-5-equal-2",
    "1": "grouped-5-equal-2",
    "1.5": "grouped-5-front",
    "2": "grouped-5-equal-2",
    "3": "grouped-5-front",
    "4.5": "grouped-5-front",
    "6": "grouped-5-front",
    "7.5": "grouped-5-front",
    "9": "grouped-5-front",
}
BPAL_TARGETS = ["1.5", "2", "2.5", "3", "4", "5", "6", "8"]
ASTC_BLOCKS = [(12, 12), (12, 10), (10, 10), (10, 8), (8, 8), (8, 6), (8, 5), (6, 5), (5, 5), (5, 4)]
SETTINGS_RE = re.compile(
    r"block (?P<block>\d+), local (?P<local>\d+), "
    r"(?P<palettes>\d+) x (?P<global>\d+) shared colors, RGB(?P<rgb>565|888)"
)
SELECTED_BPP_RE = re.compile(r"Selected (?P<bpp>[0-9.]+) bpp for target")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--dct-summary", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--bpal5cudaenc", type=Path, required=True)
    parser.add_argument("--bpal5dec", type=Path, required=True)
    parser.add_argument("--astcenc", type=Path, required=True)
    parser.add_argument("--device", type=int, default=0)
    parser.add_argument("--astc-quality", default="medium")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--progress-every", type=int, default=10)
    parser.add_argument("--report-only", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest_path = args.manifest.resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    images = manifest["images"][: args.limit]
    profiles = make_profiles()
    tools = {
        "bpal5cudaenc": require_file(args.bpal5cudaenc),
        "bpal5dec": require_file(args.bpal5dec),
        "astcenc": require_file(args.astcenc),
    }
    args.work_dir.mkdir(parents=True, exist_ok=True)
    current = args.work_dir / "current"
    current.mkdir(parents=True, exist_ok=True)
    records_path = args.work_dir / "records.jsonl"
    external_records = load_records(records_path)
    expected = {
        (image["id"], profile["id"])
        for image in images
        for profile in profiles
        if profile["codec"] != "DCTBS2"
    }

    print(
        f"Corpus: {len(images)} images; external records: {len(expected)}; "
        f"resume: {sum(key in external_records for key in expected)}",
        flush=True,
    )
    started = time.perf_counter()
    completed = 0
    if not args.report_only:
        with records_path.open("a", encoding="utf-8") as stream:
            for image_index, image in enumerate(images, start=1):
                source_path = manifest_path.parent / image["png"]
                source = load_rgb(source_path)
                for profile in profiles:
                    if profile["codec"] == "DCTBS2":
                        continue
                    key = (image["id"], profile["id"])
                    if key in external_records:
                        continue
                    clear_current(current)
                    encoded = (
                        run_bpal(profile, source_path, current, tools, args)
                        if profile["codec"] == "BPAL"
                        else run_astc(profile, source_path, current, tools, args)
                    )
                    record = score_record(image, profile, source, encoded)
                    external_records[key] = record
                    stream.write(json.dumps(record, separators=(",", ":")) + "\n")
                    stream.flush()
                    completed += 1

                if image_index % args.progress_every == 0 or image_index == len(images):
                    elapsed = time.perf_counter() - started
                    done = sum(key in external_records for key in expected)
                    rate = completed / elapsed if elapsed > 0 else 0.0
                    eta = (len(expected) - done) / rate if rate > 0 else math.inf
                    print(
                        f"[{image_index}/{len(images)}] {done}/{len(expected)}; "
                        f"elapsed {format_duration(elapsed)}; ETA {format_duration(eta)}",
                        flush=True,
                    )

    missing = expected - external_records.keys()
    if missing:
        raise RuntimeError(f"Benchmark is incomplete: {len(missing)} external records missing")

    dct_records = load_dct_records(args.dct_summary, images)
    records = dct_records + [external_records[key] for key in sorted(expected)]
    report = build_report(manifest, images, profiles, records, tools, args)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(render_markdown(report), encoding="utf-8")
    (args.work_dir / "summary.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(f"Report: {args.report}", flush=True)
    return 0


def make_profiles() -> list[dict[str, Any]]:
    profiles = [
        {
            "id": f"dct-{mode.replace('.', '_')}",
            "codec": "DCTBS2",
            "label": f"DCTBS2 {mode} bpp",
            "targetBpp": float(mode),
            "preset": mode,
        }
        for mode in DCT_MODES
    ]
    profiles.extend(
        {
            "id": f"bpal-{target.replace('.', '_')}",
            "codec": "BPAL",
            "label": f"BPAL find {target} bpp",
            "targetBpp": float(target),
            "target": target,
        }
        for target in BPAL_TARGETS
    )
    profiles.extend(
        {
            "id": f"astc-{width}x{height}",
            "codec": "ASTC",
            "label": f"ASTC {width}x{height}",
            "targetBpp": 128.0 / (width * height),
            "block": [width, height],
        }
        for width, height in ASTC_BLOCKS
    )
    return profiles


def load_dct_records(path: Path, images: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summary = json.loads(path.read_text(encoding="utf-8"))
    allowed = {image["id"] for image in images}
    selected = []
    for record in summary["records"]:
        preset = record["preset"]
        if record["imageId"] not in allowed or record["coefficientCoding"] != DCT_CODING[preset]:
            continue
        pixel_count = record["width"] * record["height"]
        selected.append(
            {
                "imageId": record["imageId"],
                "dataset": record["dataset"],
                "imageClass": record["imageClass"],
                "profileId": f"dct-{preset.replace('.', '_')}",
                "codec": "DCTBS2",
                "targetBpp": float(preset),
                "pixelCount": pixel_count,
                "artifactBytes": record["encodedBytes"],
                "payloadBytes": record["encodedBytes"] - DCT_HEADER_BYTES,
                "squaredErrorRgb": record["squaredErrorRgb"],
                "rgbSampleCount": record["rgbSampleCount"],
                "quality": record["quality"],
            }
        )
    expected = len(images) * len(DCT_MODES)
    if len(selected) != expected:
        raise RuntimeError(f"Expected {expected} DCT records, found {len(selected)}")
    return selected


def run_bpal(
    profile: dict[str, Any], source: Path, current: Path, tools: dict[str, Path], args: argparse.Namespace
) -> dict[str, Any]:
    artifact = current / "texture.bpal"
    decoded = current / "decoded.ppm"
    encode_ms, output = run_command(
        [
            tools["bpal5cudaenc"], source, artifact, "--preset", profile["target"],
            "--find-settings", "--device", str(args.device),
        ]
    )
    decode_ms, _ = run_command([tools["bpal5dec"], artifact, decoded])
    settings = SETTINGS_RE.search(output)
    selected_bpp = SELECTED_BPP_RE.search(output)
    if settings is None or selected_bpp is None:
        raise RuntimeError(f"Could not parse BPAL output:\n{output}")
    return {
        "pixels": load_rgb(decoded),
        "artifactBytes": artifact.stat().st_size,
        "payloadBytes": artifact.stat().st_size - BPAL_HEADER_BYTES,
        "encodeMilliseconds": encode_ms,
        "decodeMilliseconds": decode_ms,
        "effectiveSettings": {
            "selectedEstimatedBpp": float(selected_bpp.group("bpp")),
            "blockSize": int(settings.group("block")),
            "localColorCount": int(settings.group("local")),
            "paletteCount": int(settings.group("palettes")),
            "globalColorCount": int(settings.group("global")),
            "paletteColorBits": 16 if settings.group("rgb") == "565" else 24,
        },
    }


def run_astc(
    profile: dict[str, Any], source: Path, current: Path, tools: dict[str, Path], args: argparse.Namespace
) -> dict[str, Any]:
    artifact = current / "texture.astc"
    decoded = current / "decoded.png"
    width, height = profile["block"]
    encode_ms, _ = run_command(
        [tools["astcenc"], "-cl", source, artifact, f"{width}x{height}", f"-{args.astc_quality}", "-silent"]
    )
    decode_ms, _ = run_command([tools["astcenc"], "-dl", artifact, decoded, "-silent"])
    pixels = load_rgb(decoded)
    payload_bytes = math.ceil(pixels.shape[1] / width) * math.ceil(pixels.shape[0] / height) * 16
    if artifact.stat().st_size != payload_bytes + ASTC_HEADER_BYTES:
        raise RuntimeError("Unexpected ASTC artifact size")
    return {
        "pixels": pixels,
        "artifactBytes": artifact.stat().st_size,
        "payloadBytes": payload_bytes,
        "encodeMilliseconds": encode_ms,
        "decodeMilliseconds": decode_ms,
        "effectiveSettings": {"block": profile["block"], "quality": args.astc_quality},
    }


def score_record(
    image: dict[str, Any], profile: dict[str, Any], source: np.ndarray, encoded: dict[str, Any]
) -> dict[str, Any]:
    difference = source.astype(np.int16) - encoded.pop("pixels").astype(np.int16)
    squared_error = int(np.square(difference.astype(np.int32)).sum(dtype=np.int64))
    pixel_count = source.shape[0] * source.shape[1]
    return {
        "imageId": image["id"],
        "dataset": image["dataset"],
        "imageClass": image["imageClass"],
        "profileId": profile["id"],
        "codec": profile["codec"],
        "targetBpp": profile["targetBpp"],
        "pixelCount": pixel_count,
        "squaredErrorRgb": squared_error,
        "rgbSampleCount": pixel_count * 3,
        **encoded,
    }


def build_report(
    manifest: dict[str, Any],
    images: list[dict[str, Any]],
    profiles: list[dict[str, Any]],
    records: list[dict[str, Any]],
    tools: dict[str, Path],
    args: argparse.Namespace,
) -> dict[str, Any]:
    aggregate = aggregate_records(profiles, records)
    by_dataset = {}
    for dataset in sorted({image["dataset"] for image in images}):
        dataset_aggregate = aggregate_records(
            profiles,
            [record for record in records if record["dataset"] == dataset],
        )
        by_dataset[dataset] = {
            "aggregate": dataset_aggregate,
            "exactRates": exact_rate_rows(dataset_aggregate),
            "bdRate": {
                "dctVsBpalPercent": bd_rate(
                    codec_curve(dataset_aggregate, "DCTBS2"),
                    codec_curve(dataset_aggregate, "BPAL"),
                ),
                "dctVsAstcPercent": bd_rate(
                    codec_curve(dataset_aggregate, "DCTBS2"),
                    codec_curve(dataset_aggregate, "ASTC"),
                ),
            },
        }
    exact = exact_rate_rows(aggregate)
    return {
        "schemaVersion": 1,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "corpus": {
            "imageCount": len(images),
            "datasetCounts": dict(collections.Counter(image["dataset"] for image in images)),
            "crop": manifest["crop"],
            "cropSize": manifest["cropSize"],
        },
        "method": {
            "dct": "best exact RGB error per image among quality 85, 92, 97, 100",
            "bpal": "bpal5cudaenc --find-settings per image",
            "astc": f"astcenc linear LDR -{args.astc_quality}",
            "exactRateInterpolation": "linear pooled PSNR versus log2(payload bpp), no extrapolation",
        },
        "profiles": profiles,
        "aggregate": aggregate,
        "exactRates": exact,
        "byDataset": by_dataset,
        "bdRate": {
            "dctVsBpalPercent": bd_rate(codec_curve(aggregate, "DCTBS2"), codec_curve(aggregate, "BPAL")),
            "dctVsAstcPercent": bd_rate(codec_curve(aggregate, "DCTBS2"), codec_curve(aggregate, "ASTC")),
        },
        "tools": {name: tool_version(name, path) for name, path in tools.items()},
    }


def aggregate_records(profiles: list[dict[str, Any]], records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for profile in profiles:
        subset = [record for record in records if record["profileId"] == profile["id"]]
        if not subset:
            continue
        pixel_count = sum(record["pixelCount"] for record in subset)
        sample_count = sum(record["rgbSampleCount"] for record in subset)
        squared_error = sum(record["squaredErrorRgb"] for record in subset)
        mse = squared_error / sample_count
        output.append(
            {
                "profileId": profile["id"],
                "codec": profile["codec"],
                "label": profile["label"],
                "targetBpp": profile["targetBpp"],
                "imageCount": len(subset),
                "payloadBpp": sum(record["payloadBytes"] for record in subset) * 8.0 / pixel_count,
                "fileBpp": sum(record["artifactBytes"] for record in subset) * 8.0 / pixel_count,
                "psnrRgb": finite_psnr(mse),
            }
        )
    return output


def exact_rate_rows(aggregate: list[dict[str, Any]]) -> list[dict[str, Any]]:
    curves = {codec: codec_curve(aggregate, codec) for codec in ("DCTBS2", "BPAL", "ASTC")}
    rows = []
    for target in map(float, DCT_MODES):
        row: dict[str, Any] = {"targetBpp": target}
        for codec, curve in curves.items():
            row[codec] = interpolate_psnr(curve, target)
        rows.append(row)
    return rows


def codec_curve(aggregate: list[dict[str, Any]], codec: str) -> list[tuple[float, float]]:
    points = sorted(
        (row["payloadBpp"], row["psnrRgb"])
        for row in aggregate
        if row["codec"] == codec and row["psnrRgb"] is not None
    )
    result = []
    best = -math.inf
    for rate, quality in points:
        if quality > best:
            result.append((rate, quality))
            best = quality
    return result


def interpolate_psnr(curve: list[tuple[float, float]], target: float) -> float | None:
    for rate, quality in curve:
        if abs(rate - target) < 1e-9:
            return quality
    for left, right in zip(curve, curve[1:]):
        if left[0] <= target <= right[0]:
            position = (math.log2(target) - math.log2(left[0])) / (math.log2(right[0]) - math.log2(left[0]))
            return left[1] + position * (right[1] - left[1])
    return None


def bd_rate(first: list[tuple[float, float]], second: list[tuple[float, float]]) -> float | None:
    if len(first) < 4 or len(second) < 4:
        return None
    quality_min = max(min(point[1] for point in first), min(point[1] for point in second))
    quality_max = min(max(point[1] for point in first), max(point[1] for point in second))
    if quality_max <= quality_min:
        return None
    first_poly = np.polyfit([q for _, q in first], [math.log(r) for r, _ in first], 3)
    second_poly = np.polyfit([q for _, q in second], [math.log(r) for r, _ in second], 3)
    first_integral = np.polyint(first_poly)
    second_integral = np.polyint(second_poly)
    span = quality_max - quality_min
    first_average = (np.polyval(first_integral, quality_max) - np.polyval(first_integral, quality_min)) / span
    second_average = (np.polyval(second_integral, quality_max) - np.polyval(second_integral, quality_min)) / span
    return float((math.exp(first_average - second_average) - 1.0) * 100.0)


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# DCTBS2 versus BPAL and ASTC on 200 textures",
        "",
        f"Generated: `{report['generatedAt']}`.",
        "",
        "## Methodology",
        "",
        f"- Corpus: {report['corpus']['imageCount']} deterministic {report['corpus']['cropSize']}x{report['corpus']['cropSize']} "
        f"{report['corpus']['crop']} crops; " + ", ".join(f"{key} {value}" for key, value in report["corpus"]["datasetCounts"].items()) + ".",
        "- RGB PSNR is pooled from exact squared error in the stored uint8 domain.",
        "- Payload bpp excludes the DCTBS2, BPAL, and ASTC container headers.",
        f"- DCTBS2: {report['method']['dct']}.",
        f"- BPAL: {report['method']['bpal']}.",
        f"- ASTC: {report['method']['astc']}.",
        f"- Exact-rate estimates use {report['method']['exactRateInterpolation']}.",
        "",
        "## Exact payload-bpp comparison",
        "",
        "Interpolated values are marked `~`; unavailable values are below the codec's supported rate range.",
        "",
        "| Payload bpp | DCTBS2 PSNR | BPAL PSNR | DCT - BPAL | ASTC PSNR | DCT - ASTC |",
        "| ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in report["exactRates"]:
        dct = row["DCTBS2"]
        bpal = row["BPAL"]
        astc = row["ASTC"]
        lines.append(
            f"| {row['targetBpp']:g} | {format_psnr(dct)} | {format_psnr(bpal, approximate=True)} | "
            f"{format_delta(dct, bpal)} | {format_psnr(astc, approximate=True)} | {format_delta(dct, astc)} |"
        )
    lines.extend(
        [
            "",
            "## Measured operating points",
            "",
            "| Codec | Profile | Target/theoretical bpp | Measured payload bpp | Pooled RGB PSNR |",
            "|:---|:---|---:|---:|---:|",
        ]
    )
    for row in report["aggregate"]:
        lines.append(
            f"| {row['codec']} | {row['label']} | {row['targetBpp']:.4f} | "
            f"{row['payloadBpp']:.4f} | {format_psnr(row['psnrRgb'])} |"
        )
    lines.extend(
        [
            "",
            "## Bjontegaard delta rate",
            "",
            "Positive values mean DCTBS2 needs more payload rate for equal pooled PSNR.",
            "",
            f"- DCTBS2 versus BPAL: **{format_percent(report['bdRate']['dctVsBpalPercent'])}**.",
            f"- DCTBS2 versus ASTC: **{format_percent(report['bdRate']['dctVsAstcPercent'])}**.",
            "",
            "## Dataset consistency",
            "",
            "The 3 bpp columns use the same exact-rate interpolation as the aggregate table.",
            "",
            "| Dataset | DCT vs BPAL BD-rate | DCT vs ASTC BD-rate | DCT 3 bpp | BPAL 3 bpp | ASTC 3 bpp |",
            "|:---|---:|---:|---:|---:|---:|",
        ]
    )
    for dataset, group in report["byDataset"].items():
        exact_three = next(row for row in group["exactRates"] if row["targetBpp"] == 3.0)
        lines.append(
            f"| {dataset} | {format_percent(group['bdRate']['dctVsBpalPercent'])} | "
            f"{format_percent(group['bdRate']['dctVsAstcPercent'])} | "
            f"{format_psnr(exact_three['DCTBS2'])} | {format_psnr(exact_three['BPAL'], approximate=True)} | "
            f"{format_psnr(exact_three['ASTC'], approximate=True)} |"
        )
    lines.extend(
        [
            "",
            "## Limitations",
            "",
            "- BPAL has no encoder presets below 1.5 bpp; no BPAL values are extrapolated there.",
            "- The minimum measured ASTC rate is its 12x12 block including block-grid padding; no ASTC value is extrapolated below it.",
            "- Exact-rate BPAL and ASTC values are rate-distortion interpolation, not additional bitstreams encoded at an impossible block size.",
            "- These are 128x128 crop results, not a full-resolution timing benchmark.",
            "- Alpha, HDR, mip chains, texture filtering, and normal-map angular error are outside this comparison.",
            "",
            "## Tools",
            "",
        ]
    )
    for name, version in report["tools"].items():
        lines.append(f"- **{name}:** `{version}`")
    lines.append("")
    return "\n".join(lines)


def load_records(path: Path) -> dict[tuple[str, str], dict[str, Any]]:
    records = {}
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
        raise RuntimeError(f"Command failed ({completed.returncode}): {' '.join(command)}\n{completed.stdout}")
    return elapsed_ms, completed.stdout


def tool_version(name: str, path: Path) -> str:
    arguments = [path, "-version"] if name == "astcenc" else [path, "--version"]
    _, output = run_command(arguments)
    return output.strip().splitlines()[0]


def load_rgb(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        return np.ascontiguousarray(np.asarray(image.convert("RGB"), dtype=np.uint8))


def require_file(path: Path) -> Path:
    resolved = path.resolve()
    if not resolved.is_file():
        raise FileNotFoundError(resolved)
    return resolved


def clear_current(path: Path) -> None:
    for name in ("texture.bpal", "texture.astc", "decoded.ppm", "decoded.png"):
        candidate = path / name
        if candidate.exists():
            candidate.unlink()


def finite_psnr(mse: float) -> float | None:
    return None if mse == 0 else 10.0 * math.log10(255.0 * 255.0 / mse)


def format_psnr(value: float | None, approximate: bool = False) -> str:
    if value is None:
        return "n/a"
    prefix = "~" if approximate else ""
    return f"{prefix}{value:.3f} dB"


def format_delta(first: float | None, second: float | None) -> str:
    return "n/a" if first is None or second is None else f"{first - second:+.3f} dB"


def format_percent(value: float | None) -> str:
    return "n/a" if value is None else f"{value:+.2f}%"


def format_duration(seconds: float) -> str:
    if not math.isfinite(seconds):
        return "unknown"
    seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours}h {minutes:02d}m" if hours else f"{minutes}m {seconds:02d}s"


if __name__ == "__main__":
    raise SystemExit(main())
