#!/usr/bin/env python3
"""Compare the native CPU and CUDA BPAL encoders on the same PPM image."""

from __future__ import annotations

import argparse
import math
import re
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="binary RGB PPM (P6) input")
    parser.add_argument(
        "--build-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "build-cuda",
        help="directory containing bpal5enc, bpal5cudaenc, and bpal5dec",
    )
    parser.add_argument("--preset", default="3", help="quality preset passed to both encoders")
    parser.add_argument("--refine", type=int, default=4, help="refinement passes")
    parser.add_argument("--device", type=int, default=0, help="CUDA device ordinal")
    parser.add_argument("--runs", type=int, default=5, help="measured runs per encoder")
    parser.add_argument("--warmup", type=int, default=1, help="unmeasured runs per encoder")
    return parser.parse_args()


def executable(build_dir: Path, name: str) -> Path:
    suffix = ".exe" if sys.platform == "win32" else ""
    path = (build_dir / f"{name}{suffix}").resolve()
    if not path.is_file():
        raise FileNotFoundError(f"executable not found: {path}")
    return path


def read_ppm(path: Path) -> tuple[int, int, bytes]:
    data = path.read_bytes()
    position = 0

    def token() -> bytes:
        nonlocal position
        while position < len(data):
            if data[position] == ord("#"):
                end = data.find(b"\n", position)
                position = len(data) if end < 0 else end + 1
            elif data[position] in b" \t\r\n":
                position += 1
            else:
                break
        start = position
        while position < len(data) and data[position] not in b" \t\r\n#":
            position += 1
        return data[start:position]

    if token() != b"P6":
        raise ValueError(f"{path} is not a binary RGB PPM (P6)")
    width = int(token())
    height = int(token())
    if int(token()) != 255:
        raise ValueError(f"{path} must use an 8-bit maximum value of 255")
    if position >= len(data) or data[position] not in b" \t\r\n":
        raise ValueError(f"invalid PPM header in {path}")
    if data[position : position + 2] == b"\r\n":
        position += 2
    else:
        position += 1
    pixels = data[position:]
    expected = width * height * 3
    if len(pixels) != expected:
        raise ValueError(f"{path} contains {len(pixels)} RGB bytes; expected {expected}")
    return width, height, pixels


def run(command: list[str]) -> tuple[float, str]:
    started = time.perf_counter()
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    if result.returncode != 0:
        details = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}\n{details}")
    return elapsed_ms, result.stdout


def quality(reference: bytes, candidate: bytes) -> tuple[float, float]:
    if len(reference) != len(candidate):
        raise ValueError("decoded image size differs from the source")
    squared_error = sum((source - decoded) ** 2 for source, decoded in zip(reference, candidate))
    mse = squared_error / len(reference)
    psnr = math.inf if mse == 0.0 else 10.0 * math.log10(255.0 * 255.0 / mse)
    return mse, psnr


def main() -> int:
    args = parse_args()
    if args.runs < 1 or args.warmup < 0:
        raise ValueError("--runs must be positive and --warmup cannot be negative")

    source = args.source.resolve()
    build_dir = args.build_dir.resolve()
    cpu_encoder = executable(build_dir, "bpal5enc")
    cuda_encoder = executable(build_dir, "bpal5cudaenc")
    decoder = executable(build_dir, "bpal5dec")
    width, height, source_pixels = read_ppm(source)

    results: dict[str, dict[str, object]] = {}
    with tempfile.TemporaryDirectory(prefix="bpal5-cuda-benchmark-") as temporary:
        work_dir = Path(temporary)
        variants = {
            "CPU": [str(cpu_encoder)],
            "CUDA": [str(cuda_encoder)],
        }
        for label, prefix in variants.items():
            encoded = work_dir / f"{label.lower()}.bpal"
            decoded = work_dir / f"{label.lower()}.ppm"
            command = prefix + [
                str(source),
                str(encoded),
                "--preset",
                str(args.preset),
                "--refine",
                str(args.refine),
            ]
            if label == "CUDA":
                command += ["--device", str(args.device)]

            for _ in range(args.warmup):
                run(command)
            measured = [run(command) for _ in range(args.runs)]
            timings = [elapsed for elapsed, _ in measured]
            run([str(decoder), str(encoded), str(decoded)])
            decoded_width, decoded_height, decoded_pixels = read_ppm(decoded)
            if (decoded_width, decoded_height) != (width, height):
                raise ValueError(f"{label} decoder returned different dimensions")
            mse, psnr = quality(source_pixels, decoded_pixels)
            results[label] = {
                "timings": timings,
                "size": encoded.stat().st_size,
                "mse": mse,
                "psnr": psnr,
            }
            if label == "CUDA":
                cuda_stage_timings = {
                    "CPU clustering": [],
                    "CPU sample grouping": [],
                    "CUDA setup": [],
                    "GPU palette building": [],
                    "GPU initial blocks": [],
                    "GPU refinement": [],
                    "GPU total": [],
                }
                stage_pattern = re.compile(
                    r"CPU init [0-9.]+ ms \(clusters ([0-9.]+), samples ([0-9.]+)\), "
                    r"CUDA setup ([0-9.]+) ms, GPU ([0-9.]+) ms "
                    r"\(palettes ([0-9.]+), initial blocks ([0-9.]+), refine ([0-9.]+)\)"
                )
                for _, output in measured:
                    match = stage_pattern.search(output)
                    if match is None:
                        raise RuntimeError("could not parse the CUDA stage timings")
                    values = (
                        match.group(1),
                        match.group(2),
                        match.group(3),
                        match.group(5),
                        match.group(6),
                        match.group(7),
                        match.group(4),
                    )
                    for stage, value in zip(cuda_stage_timings, values):
                        cuda_stage_timings[stage].append(float(value))
                results[label]["cuda_stage_timings"] = cuda_stage_timings

    print(f"Image: {source} ({width}x{height})")
    print(f"Settings: preset {args.preset}, refinement {args.refine}, {args.runs} measured runs")
    print()
    print("Encoder  Mean ms  Best ms  Stddev ms  Size bytes       MSE    PSNR dB")
    print("-------  -------  -------  ---------  ----------  --------  ---------")
    for label in ("CPU", "CUDA"):
        result = results[label]
        timings = result["timings"]
        assert isinstance(timings, list)
        print(
            f"{label:<7}  {statistics.mean(timings):7.3f}  {min(timings):7.3f}  "
            f"{statistics.pstdev(timings):9.3f}  {result['size']:10d}  "
            f"{result['mse']:8.4f}  {result['psnr']:9.4f}"
        )
    cpu_mean = statistics.mean(results["CPU"]["timings"])
    cuda_mean = statistics.mean(results["CUDA"]["timings"])
    cuda_stages = results["CUDA"]["cuda_stage_timings"]
    print()
    print(f"CUDA wall-clock speedup: {cpu_mean / cuda_mean:.3f}x")
    print("CUDA stages (mean):")
    for stage, timings in cuda_stages.items():
        print(f"  {stage:<24} {statistics.mean(timings):8.3f} ms")
    print("  CPU preparation overlaps CUDA setup; stage times do not sum to wall time.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
