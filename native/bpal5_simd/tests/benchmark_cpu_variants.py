#!/usr/bin/env python3
"""Compare two CPU encoder builds with alternating runs and verify exact output."""

from __future__ import annotations

import argparse
import hashlib
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="input image accepted by the encoders")
    parser.add_argument("reference", type=Path, help="reference bpal5enc executable")
    parser.add_argument("candidate", type=Path, help="candidate bpal5enc executable")
    parser.add_argument("--preset", default="5", help="quality preset")
    parser.add_argument("--refine", type=int, default=4, help="refinement passes")
    parser.add_argument("--threads", type=int, default=4, help="worker threads")
    parser.add_argument(
        "--reference-threads",
        type=int,
        help="worker threads for the reference executable (default: --threads value)",
    )
    parser.add_argument(
        "--reference-no-threads",
        action="store_true",
        help="do not pass --threads to an older reference executable",
    )
    parser.add_argument("--runs", type=int, default=15, help="measured runs per encoder")
    parser.add_argument("--warmup", type=int, default=2, help="unmeasured runs per encoder")
    return parser.parse_args()


def run(command: list[str]) -> float:
    started = time.perf_counter()
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    if result.returncode != 0:
        details = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}\n{details}")
    return elapsed_ms


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(
    executable: Path,
    source: Path,
    output: Path,
    args: argparse.Namespace,
    thread_count: int | None,
) -> list[str]:
    result = [
        str(executable),
        str(source),
        str(output),
        "--preset",
        str(args.preset),
        "--refine",
        str(args.refine),
    ]
    if thread_count is not None:
        result += ["--threads", str(thread_count)]
    return result


def main() -> int:
    args = parse_args()
    if args.runs < 1 or args.warmup < 0:
        raise ValueError("--runs must be positive and --warmup cannot be negative")
    if args.threads < 1 or (args.reference_threads is not None and args.reference_threads < 1):
        raise ValueError("thread counts must be positive")

    source = args.source.resolve()
    executables = {
        "Reference": args.reference.resolve(),
        "Candidate": args.candidate.resolve(),
    }
    if not source.is_file():
        raise FileNotFoundError(f"source not found: {source}")
    for executable in executables.values():
        if not executable.is_file():
            raise FileNotFoundError(f"executable not found: {executable}")

    timings = {label: [] for label in executables}
    with tempfile.TemporaryDirectory(prefix="bpal5-cpu-variants-") as temporary:
        work_dir = Path(temporary)
        outputs = {label: work_dir / f"{label.lower()}.bpal" for label in executables}
        commands = {
            label: command(
                executable,
                source,
                outputs[label],
                args,
                thread_count=(
                    args.threads
                    if label == "Candidate"
                    else None
                    if args.reference_no_threads
                    else args.reference_threads
                    if args.reference_threads is not None
                    else args.threads
                ),
            )
            for label, executable in executables.items()
        }
        for label in executables:
            for _ in range(args.warmup):
                run(commands[label])

        labels = list(executables)
        for iteration in range(args.runs):
            order = labels if iteration % 2 == 0 else list(reversed(labels))
            for label in order:
                timings[label].append(run(commands[label]))

        hashes = {label: digest(output) for label, output in outputs.items()}
        if len(set(hashes.values())) != 1:
            raise RuntimeError(f"encoded files differ: {hashes}")

    print(f"Image: {source}")
    print(
        f"Settings: preset {args.preset}, refinement {args.refine}, {args.threads} threads, "
        f"{args.runs} alternating runs"
    )
    print("Output: byte-identical (SHA-256 " + next(iter(hashes.values())) + ")")
    print()
    print("Encoder    Mean ms  Median ms  Best ms  Stddev ms")
    print("---------  -------  ---------  -------  ---------")
    for label in executables:
        values = timings[label]
        print(
            f"{label:<9}  {statistics.mean(values):7.3f}  {statistics.median(values):9.3f}  "
            f"{min(values):7.3f}  {statistics.pstdev(values):9.3f}"
        )
    reference_median = statistics.median(timings["Reference"])
    candidate_median = statistics.median(timings["Candidate"])
    print()
    print(f"Candidate median speedup: {reference_median / candidate_median:.4f}x")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
