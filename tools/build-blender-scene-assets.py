"""Build a browser-ready Blender scene and BPAL/DCTBS2/ASTC texture set."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("blend_file", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument("--blender", type=Path, required=True, help="Path to blender.exe")
    parser.add_argument("--node", default="node", help="Node.js executable")
    parser.add_argument("--max-dimension", type=int, default=1024)
    return parser.parse_args()


def texture_id(file_name: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", Path(file_name).stem.lower()).strip("-")
    return value or "texture"


def export_scene(blender: Path, blend_file: Path, output_directory: Path) -> None:
    command = [
        str(blender),
        "--background",
        str(blend_file),
        "--python",
        str(ROOT / "tools" / "export-blender-scene.py"),
        "--",
        str(output_directory),
    ]
    subprocess.run(command, check=True)
    for required_file in ("scene.gltf", "material-textures.json"):
        if not (output_directory / required_file).is_file():
            raise RuntimeError(f"Blender export did not create {required_file}")


def prepare_texture_jobs(
    blend_file: Path,
    output_directory: Path,
    temporary_directory: Path,
    max_dimension: int,
) -> dict:
    texture_directory = blend_file.parent / "textures"
    if not texture_directory.is_dir():
        raise FileNotFoundError(f"Texture directory does not exist: {texture_directory}")

    mapping = json.loads(
        (output_directory / "material-textures.json").read_text(encoding="utf-8")
    )
    jobs = []
    identifiers: set[str] = set()

    for source_path in sorted(texture_directory.iterdir(), key=lambda path: path.name.casefold()):
        if not source_path.is_file():
            continue
        with Image.open(source_path) as opened:
            image = ImageOps.exif_transpose(opened)
            source_width, source_height = image.size
            rgba = image.convert("RGBA")
            has_alpha = "A" in image.getbands() and rgba.getchannel("A").getextrema()[0] < 255
            if max(rgba.size) > max_dimension:
                rgba.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)

            identifier = texture_id(source_path.name)
            if identifier in identifiers:
                raise ValueError(f"Texture identifier collision: {identifier}")
            identifiers.add(identifier)
            raw_path = temporary_directory / f"{identifier}.rgba"
            raw_path.write_bytes(rgba.tobytes())
            jobs.append({
                "id": identifier,
                "source": source_path.name,
                "sourceWidth": source_width,
                "sourceHeight": source_height,
                "width": rgba.width,
                "height": rgba.height,
                "hasAlpha": has_alpha,
                "rgba": str(raw_path),
            })

    return {
        "scene": mapping["scene"],
        "source": blend_file.name,
        "maxDimension": max_dimension,
        "materials": mapping["materials"],
        "textures": jobs,
    }


def main() -> None:
    arguments = parse_arguments()
    blend_file = arguments.blend_file.resolve()
    output_directory = arguments.output_directory.resolve()
    blender = arguments.blender.resolve()

    if arguments.max_dimension < 64:
        raise ValueError("--max-dimension must be at least 64")
    if not blend_file.is_file():
        raise FileNotFoundError(blend_file)
    if not blender.is_file():
        raise FileNotFoundError(blender)

    output_directory.mkdir(parents=True, exist_ok=True)
    export_scene(blender, blend_file, output_directory)
    texture_output = output_directory / "textures"
    texture_output.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="bpal-scene-") as temporary:
        temporary_directory = Path(temporary)
        jobs = prepare_texture_jobs(
            blend_file,
            output_directory,
            temporary_directory,
            arguments.max_dimension,
        )
        job_path = temporary_directory / "jobs.json"
        job_path.write_text(json.dumps(jobs, ensure_ascii=False), encoding="utf-8")
        subprocess.run([
            arguments.node,
            str(ROOT / "tools" / "encode-scene-textures.mjs"),
            str(job_path),
            str(texture_output),
        ], check=True)

    print(f"Scene assets are ready in {output_directory}")


if __name__ == "__main__":
    main()
