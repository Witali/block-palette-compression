"""Deterministic image metrics used by the texture codec benchmark."""

from __future__ import annotations

import math

import numpy as np


def rgb_error(reference: np.ndarray, candidate: np.ndarray) -> tuple[float, float, int]:
    """Return RGB MSE, squared-error sum, and scalar sample count."""
    reference_rgb, candidate_rgb = _validated_rgb_pair(reference, candidate)
    difference = reference_rgb.astype(np.float64) - candidate_rgb.astype(np.float64)
    squared_error = float(np.square(difference).sum(dtype=np.float64))
    sample_count = int(difference.size)
    return squared_error / sample_count, squared_error, sample_count


def psnr_rgb(reference: np.ndarray, candidate: np.ndarray) -> float:
    """Compute RGB PSNR in the stored unsigned 8-bit domain."""
    mse, _, _ = rgb_error(reference, candidate)
    return math.inf if mse == 0 else 10.0 * math.log10((255.0 * 255.0) / mse)


def ssim_luma(reference: np.ndarray, candidate: np.ndarray) -> float:
    """Compute luminance SSIM with an 11x11 Gaussian window (sigma 1.5)."""
    reference_rgb, candidate_rgb = _validated_rgb_pair(reference, candidate)
    reference_luma = _luma(reference_rgb)
    candidate_luma = _luma(candidate_rgb)

    if min(reference_luma.shape) < 11:
        raise ValueError("SSIM requires images at least 11x11 pixels")

    mu_reference = _gaussian_valid(reference_luma)
    mu_candidate = _gaussian_valid(candidate_luma)
    mu_reference_sq = mu_reference * mu_reference
    mu_candidate_sq = mu_candidate * mu_candidate
    mu_cross = mu_reference * mu_candidate

    variance_reference = _gaussian_valid(reference_luma * reference_luma) - mu_reference_sq
    variance_candidate = _gaussian_valid(candidate_luma * candidate_luma) - mu_candidate_sq
    covariance = _gaussian_valid(reference_luma * candidate_luma) - mu_cross

    variance_reference = np.maximum(variance_reference, 0.0)
    variance_candidate = np.maximum(variance_candidate, 0.0)

    c1 = (0.01 * 255.0) ** 2
    c2 = (0.03 * 255.0) ** 2
    numerator = (2.0 * mu_cross + c1) * (2.0 * covariance + c2)
    denominator = (mu_reference_sq + mu_candidate_sq + c1) * (
        variance_reference + variance_candidate + c2
    )
    return float(np.mean(numerator / denominator, dtype=np.float64))


def _validated_rgb_pair(
    reference: np.ndarray, candidate: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    if reference.shape != candidate.shape:
        raise ValueError(f"Image shapes differ: {reference.shape} vs {candidate.shape}")

    if reference.ndim != 3 or reference.shape[2] < 3:
        raise ValueError("Metrics require HxWx3 or HxWx4 images")

    if reference.dtype != np.uint8 or candidate.dtype != np.uint8:
        raise ValueError("Metrics require uint8 images")

    return reference[:, :, :3], candidate[:, :, :3]


def _luma(rgb: np.ndarray) -> np.ndarray:
    values = rgb.astype(np.float32)
    return values[:, :, 0] * 0.2126 + values[:, :, 1] * 0.7152 + values[:, :, 2] * 0.0722


def _gaussian_valid(values: np.ndarray) -> np.ndarray:
    radius = 5
    coordinates = np.arange(-radius, radius + 1, dtype=np.float32)
    kernel = np.exp(-(coordinates * coordinates) / (2.0 * 1.5 * 1.5))
    kernel /= kernel.sum()

    height, width = values.shape
    horizontal = np.zeros((height, width - radius * 2), dtype=np.float32)
    for index, weight in enumerate(kernel):
        horizontal += values[:, index : index + horizontal.shape[1]] * weight

    vertical = np.zeros((height - radius * 2, horizontal.shape[1]), dtype=np.float32)
    for index, weight in enumerate(kernel):
        vertical += horizontal[index : index + vertical.shape[0], :] * weight

    return vertical
