#!/usr/bin/env python3
"""Benchmark lossless, independently addressable BPAL palette records."""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN_ROOT = ROOT.parents[1] if ROOT.parent.name == ".tmp" else ROOT
TARGETS = ("1.5", "2", "2.5", "3", "4", "5", "6", "8")
PROFILE_IDS = {target: f"bpal-cuda-find-{target.replace('.', '_')}" for target in TARGETS}
SETTINGS_RE = re.compile(
    r"block (?P<block>\d+), local (?P<local>\d+), "
    r"(?P<palettes>\d+) x (?P<global>\d+) shared colors, RGB(?P<rgb>888|565)"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sample-per-dataset", type=int, default=20)
    parser.add_argument("--device", type=int, default=0)
    parser.add_argument(
        "--records",
        type=Path,
        default=MAIN_ROOT / "benchmark/work/cuda-astc-textures/records.jsonl",
    )
    parser.add_argument(
        "--source-dir",
        type=Path,
        default=MAIN_ROOT / "benchmark/work/cuda-astc-textures/sources",
    )
    parser.add_argument(
        "--encoder",
        type=Path,
        default=ROOT / "native/bpal5_simd/build-local/bpal5cudaenc.exe",
    )
    parser.add_argument(
        "--decoder",
        type=Path,
        default=ROOT / "native/bpal5_simd/build-local/bpal5dec.exe",
    )
    parser.add_argument(
        "--work-dir",
        type=Path,
        default=ROOT / "benchmark/work/local-palette-packing",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=ROOT / "benchmark/results/local-palette-packing.md",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    for path in (args.records, args.encoder, args.decoder):
        if not path.is_file():
            raise SystemExit(f"Required input is missing: {path}")
    images, prior = load_images(args.records)
    selected = select_stratified(images, args.sample_per_dataset)
    args.work_dir.mkdir(parents=True, exist_ok=True)
    artifact = args.work_dir / "texture.bpal"
    legacy_artifact = args.work_dir / "texture-legacy.bpal"
    packed_ppm = args.work_dir / "packed.ppm"
    legacy_ppm = args.work_dir / "legacy.ppm"
    rows: list[dict[str, object]] = []
    started = time.perf_counter()

    print(f"Selected {len(selected)} images; {len(selected) * len(TARGETS)} encodes", flush=True)
    for image_index, image in enumerate(selected, start=1):
        file_id = hashlib.sha256(str(image["imageId"]).encode("utf-8")).hexdigest()[:20]
        source = args.source_dir / f"{file_id}.png"
        if not source.is_file():
            raise SystemExit(f"Normalized source is missing: {source}")
        for target in TARGETS:
            command = [
                str(args.encoder), str(source), str(artifact),
                "--preset", target, "--find-settings", "--device", str(args.device),
            ]
            output = run(command)
            match = SETTINGS_RE.search(output)
            if match is None:
                raise RuntimeError(f"Could not parse encoder settings:\n{output}")
            packed_bytes = artifact.read_bytes()
            legacy_bytes, palette = make_legacy_file(packed_bytes)
            legacy_artifact.write_bytes(legacy_bytes)
            run([str(args.decoder), str(artifact), str(packed_ppm)])
            run([str(args.decoder), str(legacy_artifact), str(legacy_ppm)])
            if packed_ppm.read_bytes() != legacy_ppm.read_bytes():
                raise RuntimeError(f"Decoded pixels differ for {image['imageId']} at {target} bpp")

            previous = prior.get((image["imageId"], PROFILE_IDS[target]))
            current_settings = {
                "blockSize": int(match.group("block")),
                "localColorCount": int(match.group("local")),
                "paletteCount": int(match.group("palettes")),
                "globalColorCount": int(match.group("global")),
                "paletteColorBits": 16 if match.group("rgb") == "565" else 24,
            }
            settings_match = previous is not None and all(
                previous["effectiveSettings"].get(key) == value
                for key, value in current_settings.items()
            )
            rows.append({
                "dataset": image["dataset"],
                "imageId": image["imageId"],
                "target": target,
                "pixelCount": image["pixelCount"],
                "packedBytes": len(packed_bytes),
                "legacyBytes": len(legacy_bytes),
                "savedBytes": len(legacy_bytes) - len(packed_bytes),
                "packedPalettes": palette["packed"],
                "paletteCount": palette["paletteCount"],
                "deltaRecordCount": palette["deltaRecordCount"],
                "settingsMatch": settings_match,
                "psnrRgb": previous.get("psnrRgb") if previous else None,
            })

        elapsed = time.perf_counter() - started
        print(
            f"[{image_index}/{len(selected)}] {image['dataset']} {image['imageId']} "
            f"({elapsed:.1f}s)",
            flush=True,
        )

    summary = build_summary(selected, rows)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(render_report(summary), encoding="utf-8")
    (args.work_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Report: {args.report}", flush=True)
    return 0


def load_images(path: Path) -> tuple[list[dict[str, object]], dict[tuple[str, str], dict]]:
    images: dict[str, dict[str, object]] = {}
    records: dict[tuple[str, str], dict] = {}
    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            if not line.strip():
                continue
            record = json.loads(line)
            if not record["profileId"].startswith("bpal-cuda-find-"):
                continue
            records[(record["imageId"], record["profileId"])] = record
            images[record["imageId"]] = {
                "imageId": record["imageId"],
                "dataset": record["dataset"],
                "imageClass": record["imageClass"],
                "contentClass": record["contentClass"],
                "sourceSha256": record["sourceSha256"],
                "pixelCount": record["pixelCount"],
            }
    return list(images.values()), records


def select_stratified(images: list[dict[str, object]], per_dataset: int) -> list[dict[str, object]]:
    selected: list[dict[str, object]] = []
    for dataset in ("dtd", "kylberg", "ambientcg"):
        subset = [image for image in images if image["dataset"] == dataset]
        key = "imageClass" if dataset == "ambientcg" else "contentClass"
        groups: dict[str, list[dict[str, object]]] = collections.defaultdict(list)
        for image in subset:
            groups[str(image[key])].append(image)
        for group in groups.values():
            group.sort(key=lambda image: hashlib.sha256(str(image["imageId"]).encode()).digest())
        ordered_groups = sorted(groups.items())
        while len([image for image in selected if image["dataset"] == dataset]) < min(per_dataset, len(subset)):
            progressed = False
            for _, group in ordered_groups:
                if group:
                    selected.append(group.pop(0))
                    progressed = True
                    if len([image for image in selected if image["dataset"] == dataset]) >= min(per_dataset, len(subset)):
                        break
            if not progressed:
                break
    return selected


def make_legacy_file(data: bytes) -> tuple[bytes, dict[str, object]]:
    if len(data) < 14 or data[:4] != b"BPAL":
        raise ValueError("Invalid BPAL file")
    meta = parse_header(data)
    if not meta["packed"]:
        return data, {
            "packed": False,
            "paletteCount": meta["paletteCount"],
            "deltaRecordCount": 0,
        }

    section_size = int.from_bytes(data[14:18], "big")
    directory = 18
    records_base = directory + meta["paletteCount"] * 4
    section_end = 14 + section_size
    raw = bytearray()
    delta_count = 0
    for palette_index in range(meta["paletteCount"]):
        record = records_base + int.from_bytes(
            data[directory + palette_index * 4:directory + palette_index * 4 + 4], "big"
        )
        if data[record] == 0:
            stride = meta["paletteColorBits"] // 8
            raw.extend(data[record + 1:record + 1 + meta["globalColorCount"] * stride])
            continue
        delta_count += 1
        widths = (data[record] & 15, data[record + 1] >> 4, data[record + 1] & 15)
        bases = data[record + 2:record + 5]
        bit_offset = (record + 5) * 8
        for _ in range(meta["globalColorCount"]):
            channels = []
            for base, width in zip(bases, widths):
                channels.append(base + read_bits(data, bit_offset, width))
                bit_offset += width
            if meta["paletteColorBits"] == 24:
                raw.extend(channels)
            else:
                value = pack_rgb565(*channels)
                raw.extend((value >> 8, value & 255))
    header = bytearray(data[:14])
    header[13] &= 0xFE
    legacy = bytes(header + raw + data[section_end:])
    return legacy, {
        "packed": True,
        "paletteCount": meta["paletteCount"],
        "deltaRecordCount": delta_count,
    }


def parse_header(data: bytes) -> dict[str, int | bool]:
    global_bits = read_bits(data, 89, 4) + 1
    palette_bits = read_bits(data, 105, 3)
    return {
        "globalColorCount": 1 << global_bits,
        "paletteCount": 1 << palette_bits,
        "paletteColorBits": 24 if read_bits(data, 93, 1) else 16,
        "packed": bool(read_bits(data, 108, 4) & 1),
    }


def read_bits(data: bytes, offset: int, count: int) -> int:
    value = 0
    for bit in range(count):
        position = offset + bit
        value = value * 2 + ((data[position // 8] >> (7 - position % 8)) & 1)
    return value


def pack_rgb565(red: int, green: int, blue: int) -> int:
    red5 = (red * 31 + 127) // 255
    green6 = (green * 63 + 127) // 255
    blue5 = (blue * 31 + 127) // 255
    return red5 << 11 | green6 << 5 | blue5


def run(command: list[str]) -> str:
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
    if completed.returncode != 0:
        raise RuntimeError(f"Command failed ({completed.returncode}): {' '.join(command)}\n{completed.stdout}")
    return completed.stdout


def build_summary(images: list[dict[str, object]], rows: list[dict[str, object]]) -> dict[str, object]:
    groups = []
    for label, subset in [("all", rows)] + [
        (dataset, [row for row in rows if row["dataset"] == dataset])
        for dataset in ("dtd", "kylberg", "ambientcg")
    ]:
        groups.append(aggregate(label, subset))
    targets = [aggregate(target, [row for row in rows if row["target"] == target]) for target in TARGETS]
    return {
        "schemaVersion": 1,
        "method": "lossless per-palette raw or base+fixed-width RGB residual records with uint32 directory",
        "imageCount": len(images),
        "recordCount": len(rows),
        "decodedEqualityChecks": len(rows),
        "settingsMatchCount": sum(bool(row["settingsMatch"]) for row in rows),
        "groups": groups,
        "targets": targets,
    }


def aggregate(label: str, rows: list[dict[str, object]]) -> dict[str, object]:
    packed = sum(int(row["packedBytes"]) for row in rows)
    legacy = sum(int(row["legacyBytes"]) for row in rows)
    pixels = sum(int(row["pixelCount"]) for row in rows)
    return {
        "label": label,
        "records": len(rows),
        "legacyBytes": legacy,
        "packedBytes": packed,
        "savedBytes": legacy - packed,
        "savingPercent": (legacy - packed) * 100.0 / legacy if legacy else 0.0,
        "legacyBpp": legacy * 8.0 / pixels if pixels else 0.0,
        "packedBpp": packed * 8.0 / pixels if pixels else 0.0,
        "packedRecordCount": sum(bool(row["packedPalettes"]) for row in rows),
        "deltaPaletteCount": sum(int(row["deltaRecordCount"]) for row in rows),
    }


def render_report(summary: dict[str, object]) -> str:
    lines = [
        "# GPU-friendly local palette packing benchmark",
        "",
        "## Result",
        "",
        f"The benchmark used **{summary['imageCount']} textures** and **{summary['recordCount']} encoded operating points**.",
        "Palette packing is lossless: every packed output was decoded alongside its byte-equivalent legacy representation.",
        f"All **{summary['decodedEqualityChecks']} decoded pixel buffers were byte-identical**.",
        "",
        "| Subset | Records | Legacy bytes | Packed bytes | Saved | File reduction |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in summary["groups"]:
        lines.append(
            f"| {row['label']} | {row['records']} | {row['legacyBytes']:,} | "
            f"{row['packedBytes']:,} | {row['savedBytes']:,} | {row['savingPercent']:.3f}% |"
        )
    lines.extend([
        "",
        "## By target rate",
        "",
        "| Target | Legacy bpp | Packed bpp | File reduction | Packed files | Delta palettes |",
        "| ---: | ---: | ---: | ---: | ---: | ---: |",
    ])
    for row in summary["targets"]:
        lines.append(
            f"| {row['label']} | {row['legacyBpp']:.4f} | {row['packedBpp']:.4f} | "
            f"{row['savingPercent']:.3f}% | {row['packedRecordCount']}/{row['records']} | "
            f"{row['deltaPaletteCount']} |"
        )
    lines.extend([
        "",
        "## Decoder constraints",
        "",
        "- No entropy stream or dependency on a previous palette/block is used.",
        "- Every palette has a 32-bit directory offset and an independent byte-aligned record.",
        "- Each record is either raw RGB565/RGB888 or one RGB base plus three fixed residual widths.",
        "- A pixel lookup reads one selector, one local index, one global index, one directory entry, and one palette record.",
        "- Reconstruction uses only integer shifts, masks, additions, and bounded bit reads.",
        "- The encoder keeps the legacy palette representation whenever directory/record metadata would increase the file.",
        "",
        "## Methodology",
        "",
        "- 20 stratified images from each of DTD, Kylberg, and ambientCG.",
        "- All eight CUDA `--find-settings` targets from 1.5 through 8 bpp.",
        "- Full file size includes the 14-byte BPAL header and all packing metadata.",
        f"- Existing CUDA settings were reproduced for {summary['settingsMatchCount']}/{summary['recordCount']} records.",
        "- Quality is unchanged by construction and by byte-identical decoded output, so PSNR delta is exactly 0 dB.",
        "",
    ])
    return "\n".join(lines)


if __name__ == "__main__":
    sys.exit(main())
