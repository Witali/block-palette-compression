"""Export the active Blender scene as texture-free glTF for the web viewer.

Run through Blender, for example:

    blender --background scene.blend --python tools/export-blender-scene.py -- output-dir

The exporter keeps material names and UV coordinates, but removes ordinary image
references from the resulting glTF. Runtime BPAL, DCTBS2, or ASTC textures are
assigned by the scene viewer from the generated material-textures.json mapping.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

import bpy


SCENE_NAME = "barcelona-pavilion"
EXTRA_BUMP_TEXTURES = {
    "pavet": "Mies-BCN_M081bump.jpg",
}
BUMPMAP_MATERIALS = {"water"}
PARTICLE_LIMITS = {
    "lotus_scattering_plane": 72,
    "pebbles_scatter": 2400,
    "tree_scatter_plane": 48,
}
MESH_DECIMATION = {
    "tree_scatter": 0.055,
}


def command_line_arguments() -> list[str]:
    if "--" not in sys.argv:
        raise SystemExit("Expected an output directory after --")
    return sys.argv[sys.argv.index("--") + 1 :]


def texture_id(file_name: str) -> str:
    stem = Path(file_name).stem.lower()
    value = re.sub(r"[^a-z0-9]+", "-", stem).strip("-")
    return value or "texture"


def image_file_name(image: bpy.types.Image | None) -> str | None:
    if image is None or image.source != "FILE":
        return None
    path = Path(bpy.path.abspath(image.filepath))
    return path.name if path.is_file() else None


def first_image_file(material: bpy.types.Material) -> str | None:
    if material.node_tree is None:
        return None
    for node in material.node_tree.nodes:
        if node.type == "TEX_IMAGE":
            file_name = image_file_name(node.image)
            if file_name:
                return file_name
    return None


def source_texture_directory() -> Path:
    blend_path = Path(bpy.data.filepath)
    return blend_path.parent / "textures"


def build_material_mapping() -> dict[str, dict[str, str]]:
    texture_directory = source_texture_directory()
    mapping: dict[str, dict[str, str]] = {}

    for material in bpy.data.materials:
        file_name = first_image_file(material)
        roles: dict[str, str] = {}
        if file_name:
            role = "bump" if material.name.casefold() in BUMPMAP_MATERIALS else "baseColor"
            roles[role] = texture_id(file_name)

        extra_bump = EXTRA_BUMP_TEXTURES.get(material.name.casefold())
        if extra_bump and (texture_directory / extra_bump).is_file():
            roles["bump"] = texture_id(extra_bump)

        if roles:
            mapping[material.name] = roles

    return mapping


def optimize_scene_for_web() -> None:
    for object_name, maximum_count in PARTICLE_LIMITS.items():
        scene_object = bpy.data.objects.get(object_name)
        if scene_object is None:
            continue
        for particle_system in scene_object.particle_systems:
            particle_system.settings.count = min(particle_system.settings.count, maximum_count)

    for object_name, ratio in MESH_DECIMATION.items():
        scene_object = bpy.data.objects.get(object_name)
        if scene_object is None or scene_object.type != "MESH":
            continue
        modifier = scene_object.modifiers.new(name="Web viewer LOD", type="DECIMATE")
        modifier.ratio = ratio
        modifier.use_collapse_triangulate = True
        dependency_graph = bpy.context.evaluated_depsgraph_get()
        evaluated = scene_object.evaluated_get(dependency_graph)
        optimized_mesh = bpy.data.meshes.new_from_object(
            evaluated,
            preserve_all_data_layers=True,
            depsgraph=dependency_graph,
        )
        scene_object.modifiers.remove(modifier)
        scene_object.data = optimized_mesh


def configure_principled_materials(mapping: dict[str, dict[str, str]]) -> None:
    """Replace complex Cycles graphs with portable PBR materials for glTF.

    The temporary base-color image connections force Blender to retain the UV
    attributes used by the source scene. They are stripped from the final glTF.
    """

    for material in bpy.data.materials:
        source_image = None
        if material.node_tree is not None:
            for node in material.node_tree.nodes:
                if node.type == "TEX_IMAGE" and image_file_name(node.image):
                    source_image = node.image
                    break

        material.use_nodes = True
        tree = material.node_tree
        tree.nodes.clear()
        output = tree.nodes.new("ShaderNodeOutputMaterial")
        principled = tree.nodes.new("ShaderNodeBsdfPrincipled")
        output.location = (320, 0)
        principled.location = (0, 0)
        tree.links.new(principled.outputs["BSDF"], output.inputs["Surface"])

        diffuse = tuple(float(value) for value in material.diffuse_color)
        principled.inputs["Base Color"].default_value = diffuse
        principled.inputs["Roughness"].default_value = 0.52
        name = material.name.casefold()

        if "metal" in name:
            principled.inputs["Metallic"].default_value = 0.88
            principled.inputs["Roughness"].default_value = 0.22
        elif "glossy" in name:
            principled.inputs["Roughness"].default_value = 0.18
        elif "glass" in name or name == "water":
            principled.inputs["Roughness"].default_value = 0.12
            principled.inputs["Alpha"].default_value = 0.38 if "glass" in name else 0.72

        if source_image is not None:
            image_node = tree.nodes.new("ShaderNodeTexImage")
            image_node.image = source_image
            image_node.interpolation = "Linear"
            tree.links.new(image_node.outputs["Color"], principled.inputs["Base Color"])
            if source_image.channels == 4:
                tree.links.new(image_node.outputs["Alpha"], principled.inputs["Alpha"])

        roles = mapping.get(material.name, {})
        for role, identifier in roles.items():
            material[f"bpal_{role}"] = identifier


def strip_image_references(gltf_path: Path) -> None:
    document = json.loads(gltf_path.read_text(encoding="utf-8"))
    document.pop("images", None)
    document.pop("textures", None)
    document.pop("samplers", None)

    for material in document.get("materials", []):
        pbr = material.get("pbrMetallicRoughness", {})
        pbr.pop("baseColorTexture", None)
        pbr.pop("metallicRoughnessTexture", None)
        material.pop("normalTexture", None)
        material.pop("occlusionTexture", None)
        material.pop("emissiveTexture", None)

    extras = document.setdefault("extras", {})
    extras.update({
        "source": Path(bpy.data.filepath).name,
        "texturePipeline": ["BPAL", "DCTBS2", "ASTC"],
    })
    gltf_path.write_text(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def export_scene(output_directory: Path) -> None:
    output_directory.mkdir(parents=True, exist_ok=True)
    optimize_scene_for_web()
    mapping = build_material_mapping()
    configure_principled_materials(mapping)
    gltf_path = output_directory / "scene.gltf"

    bpy.ops.export_scene.gltf(
        filepath=str(gltf_path),
        export_format="GLTF_SEPARATE",
        export_texture_dir="exported-images",
        export_image_format="AUTO",
        export_keep_originals=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        use_active_scene=True,
        use_visible=True,
        use_renderable=True,
        export_extras=True,
        export_yup=True,
        export_apply=True,
        export_animations=False,
        export_morph=False,
        export_gpu_instances=True,
    )
    strip_image_references(gltf_path)
    shutil.rmtree(output_directory / "exported-images", ignore_errors=True)

    mapping_path = output_directory / "material-textures.json"
    mapping_path.write_text(
        json.dumps({"scene": SCENE_NAME, "materials": mapping}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    print(
        f"Exported {len(bpy.data.objects)} objects, {len(bpy.data.materials)} materials, "
        f"and {len(mapping)} texture assignments to {output_directory}"
    )


def main() -> None:
    arguments = command_line_arguments()
    if len(arguments) != 1:
        raise SystemExit("Usage: -- output-directory")
    export_scene(Path(arguments[0]).resolve())


if __name__ == "__main__":
    main()
