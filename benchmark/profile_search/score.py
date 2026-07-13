"""Validate RGB MSE, calculate SSIM, and select full-corpus profile winners."""

from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor, as_completed
import json
from pathlib import Path
import sys
from typing import Any

import numpy as np


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from benchmark.metrics import rgb_error, ssim_luma


WORK = ROOT / "benchmark" / "work"
OUTPUT = WORK / "bpal-profile-search" / "full"
REPORT_PATH = OUTPUT / "report.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=int, default=8, help="Concurrent metric processes")
    return parser.parse_args()


def score(task: tuple[int, int, float, str, str, int, int]) -> tuple[int, int, float]:
    profile_index, image_index, expected_mse, output_id, source_id, width, height = task
    shape = (height, width, 4)
    source = np.frombuffer(
        (WORK / "sources" / source_id / "source.rgba").read_bytes(), dtype=np.uint8
    ).reshape(shape)
    candidate = np.frombuffer(
        (OUTPUT / output_id / f"{source_id}.rgba").read_bytes(), dtype=np.uint8
    ).reshape(shape)
    mse, _, _ = rgb_error(source, candidate)
    if abs(mse - expected_mse) > 1e-12:
        raise RuntimeError(f"{output_id}/{source_id}: MSE {mse} != {expected_mse}")
    return profile_index, image_index, ssim_luma(source, candidate)


def winner_summary(profile: dict[str, Any]) -> dict[str, Any]:
    return {
        "outputId": profile["outputId"],
        "targetBpp": profile["targetBpp"],
        "payloadBpp": profile["payloadBpp"],
        "settings": profile["settings"],
        "aggregateMseRgb": profile["aggregateMseRgb"],
        "aggregatePsnrRgb": profile["aggregatePsnrRgb"],
        "aggregateSsimLuma": profile["aggregateSsimLuma"],
    }


def main() -> None:
    args = parse_args()
    if args.jobs < 1 or args.jobs > 64:
        raise SystemExit("--jobs must be from 1 to 64")
    report = json.loads(REPORT_PATH.read_text(encoding="utf-8"))
    width = int(report["width"])
    height = int(report["height"])
    tasks = []
    for profile_index, profile in enumerate(report["profiles"]):
        for image_index, image in enumerate(profile["images"]):
            tasks.append(
                (
                    profile_index,
                    image_index,
                    image["mseRgb"],
                    profile["outputId"],
                    image["sourceId"],
                    width,
                    height,
                )
            )

    completed = 0
    with ProcessPoolExecutor(max_workers=args.jobs) as executor:
        futures = [executor.submit(score, task) for task in tasks]
        for future in as_completed(futures):
            profile_index, image_index, ssim = future.result()
            profile = report["profiles"][profile_index]
            image = profile["images"][image_index]
            image["ssimLuma"] = ssim
            completed += 1
            print(
                f"[{completed}/{len(tasks)}] {profile['outputId']} {image['sourceId']}: "
                f"SSIM {ssim:.9f}",
                flush=True,
            )

    for profile in report["profiles"]:
        profile["aggregateSsimLuma"] = sum(
            image["ssimLuma"] for image in profile["images"]
        ) / len(profile["images"])

    targets = sorted({float(profile["targetBpp"]) for profile in report["profiles"]})
    psnr_winners: dict[str, Any] = {}
    ssim_winners: dict[str, Any] = {}
    for target in targets:
        candidates = [
            profile for profile in report["profiles"] if float(profile["targetBpp"]) == target
        ]
        psnr_winners[str(target)] = winner_summary(
            max(candidates, key=lambda profile: profile["aggregatePsnrRgb"])
        )
        ssim_winners[str(target)] = winner_summary(
            max(candidates, key=lambda profile: profile["aggregateSsimLuma"])
        )

    report["ssim"] = "BT.709 luminance, 11x11 Gaussian window, sigma 1.5"
    report["metricProcesses"] = args.jobs
    report["psnrWinnersByTarget"] = psnr_winners
    report["ssimWinnersByTarget"] = ssim_winners
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print("\nPSNR winners", flush=True)
    for target, winner in psnr_winners.items():
        print(
            f"{target} bpp: {winner['outputId']}, {winner['payloadBpp']:.6f} actual, "
            f"{winner['aggregatePsnrRgb']:.3f} dB, SSIM {winner['aggregateSsimLuma']:.6f}",
            flush=True,
        )


if __name__ == "__main__":
    main()
