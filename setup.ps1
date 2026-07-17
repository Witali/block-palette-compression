<#
.SYNOPSIS
Downloads and prepares the project dependencies on Windows.

.DESCRIPTION
Checks that Node.js is available and installs the pinned local CUDA developer
toolchain under tools/cuda. It also downloads the original Barcelona Pavilion
scene and a portable Blender into the Git-ignored .tmp directory, then builds
all browser and Direct3D scene texture formats. CUDA packages are downloaded
from NVIDIA, SHA-256-verified, and extracted without administrator rights.

.PARAMETER SkipCuda
Skip CUDA setup after checking Node.js and building the scene assets.

.PARAMETER SkipBarcelonaScene
Do not download or build the Barcelona Pavilion scene and texture assets.

.PARAMETER BlenderPath
Use this Blender executable instead of the pinned portable Blender.

.PARAMETER ScenePythonPath
Use this Python executable for scene assets. Pillow is installed under .tmp
when it is not already available.

.PARAMETER NoUserEnvironment
Do not persist CUDA_PATH or add the local CUDA bin directory to the user PATH.

.PARAMETER CudaRelease
NVIDIA redistributable manifest release. The default is 13.3.1.

.PARAMETER CudaToolkitVersion
Directory and environment-variable version for the CUDA release. The default
is 13.3.

.EXAMPLE
.\setup.ps1

.EXAMPLE
.\setup.ps1 -SkipCuda

.EXAMPLE
.\setup.ps1 -SkipBarcelonaScene

.EXAMPLE
.\setup.ps1 -NoUserEnvironment
#>
[CmdletBinding()]
param(
    [switch]$SkipCuda,
    [switch]$SkipBarcelonaScene,
    [switch]$NoUserEnvironment,
    [string]$BlenderPath = "",
    [string]$ScenePythonPath = "",
    [string]$CudaRelease = "13.3.1",
    [string]$CudaToolkitVersion = "13.3"
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

if (-not [Environment]::Is64BitOperatingSystem) {
    throw "This project setup supports only 64-bit Windows."
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $node) {
    throw "Node.js is required. Install it from https://nodejs.org/ and rerun setup.ps1."
}

$nodeVersion = (& $node.Source --version).Trim()
Write-Host "Node.js $nodeVersion found at $($node.Source)"

if (-not $SkipBarcelonaScene) {
    $sceneUri = "https://download.blender.org/demo/test/pabellon_barcelona_v1.scene_.zip"
    $blenderVersion = "4.5.11"
    $blenderUri = "https://download.blender.org/release/Blender4.5/blender-$blenderVersion-windows-x64.zip"
    $temporaryDirectory = Join-Path $PSScriptRoot ".tmp"
    $sceneDirectory = Join-Path $temporaryDirectory "barcelona-source"
    $sceneArchivePath = Join-Path $temporaryDirectory "pabellon_barcelona_v1.scene_.zip"
    $blendPath = Join-Path $sceneDirectory "3d\pavillon_barcelone_v1.2.blend"
    $textureDirectory = Join-Path $sceneDirectory "3d\textures"

    if ((Test-Path -LiteralPath $blendPath) -and (Test-Path -LiteralPath $textureDirectory -PathType Container)) {
        Write-Host "Barcelona Pavilion source scene is ready at $blendPath"
    } else {
        New-Item -ItemType Directory -Force -Path $temporaryDirectory, $sceneDirectory | Out-Null
        try {
            Write-Host "Downloading the Barcelona Pavilion source scene"
            Invoke-WebRequest -Uri $sceneUri -OutFile $sceneArchivePath -UseBasicParsing
            Write-Host "Extracting the Barcelona Pavilion source scene"
            Expand-Archive -LiteralPath $sceneArchivePath -DestinationPath $sceneDirectory -Force
        } finally {
            Remove-Item -LiteralPath $sceneArchivePath -Force -ErrorAction SilentlyContinue
        }

        if (-not (Test-Path -LiteralPath $blendPath)) {
            throw "Barcelona Pavilion archive did not contain the expected Blender file: $blendPath"
        }
        if (-not (Test-Path -LiteralPath $textureDirectory -PathType Container)) {
            throw "Barcelona Pavilion archive did not contain the expected texture directory: $textureDirectory"
        }
        Write-Host "Barcelona Pavilion source scene is ready at $blendPath"
    }

    if ($BlenderPath) {
        $sceneBlender = (Resolve-Path -LiteralPath $BlenderPath).Path
    } else {
        $blenderRuntimeDirectory = Join-Path $temporaryDirectory "blender-runtime"
        $blenderDirectory = Join-Path $blenderRuntimeDirectory "blender-$blenderVersion-windows-x64"
        $sceneBlender = Join-Path $blenderDirectory "blender.exe"
        if (-not (Test-Path -LiteralPath $sceneBlender)) {
            $blenderArchivePath = Join-Path $temporaryDirectory "blender-$blenderVersion-windows-x64.zip"
            New-Item -ItemType Directory -Force -Path $blenderRuntimeDirectory | Out-Null
            try {
                Write-Host "Downloading portable Blender $blenderVersion"
                Invoke-WebRequest -Uri $blenderUri -OutFile $blenderArchivePath -UseBasicParsing
                Write-Host "Extracting portable Blender $blenderVersion"
                Expand-Archive -LiteralPath $blenderArchivePath -DestinationPath $blenderRuntimeDirectory -Force
            } finally {
                Remove-Item -LiteralPath $blenderArchivePath -Force -ErrorAction SilentlyContinue
            }
        }
    }
    if (-not (Test-Path -LiteralPath $sceneBlender)) {
        throw "Blender executable is missing: $sceneBlender"
    }

    if ($ScenePythonPath) {
        $scenePython = (Resolve-Path -LiteralPath $ScenePythonPath).Path
    } elseif (-not $BlenderPath) {
        $scenePython = Join-Path $blenderDirectory "4.5\python\bin\python.exe"
    } else {
        $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($null -eq $pythonCommand) {
            throw "Python is required with -BlenderPath; pass -ScenePythonPath explicitly."
        }
        $scenePython = $pythonCommand.Source
    }
    if (-not (Test-Path -LiteralPath $scenePython)) {
        throw "Scene asset Python executable is missing: $scenePython"
    }

    $scenePackages = Join-Path $temporaryDirectory "scene-python-packages"
    New-Item -ItemType Directory -Force -Path $scenePackages | Out-Null
    $previousPythonPath = $env:PYTHONPATH
    try {
        $env:PYTHONPATH = if ($previousPythonPath) { "$scenePackages;$previousPythonPath" } else { $scenePackages }
        & $scenePython -c "import PIL" 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Installing Pillow for the scene asset builder"
            & $scenePython -m pip install --disable-pip-version-check --target $scenePackages "Pillow==12.2.0"
            if ($LASTEXITCODE -ne 0) {
                throw "Pillow installation failed with exit code $LASTEXITCODE"
            }
        }

        Write-Host "Building Barcelona Pavilion geometry and BC1/BC7, BPAL, DCTBS2, and ASTC textures"
        & $scenePython `
            (Join-Path $PSScriptRoot "tools\build-blender-scene-assets.py") `
            $blendPath `
            (Join-Path $PSScriptRoot "assets\scenes\barcelona") `
            --blender $sceneBlender `
            --node $node.Source `
            --max-dimension 1024
        if ($LASTEXITCODE -ne 0) {
            throw "Barcelona Pavilion web asset build failed with exit code $LASTEXITCODE"
        }

        & $node.Source (Join-Path $PSScriptRoot "tools\build-win32-scene-assets.mjs")
        if ($LASTEXITCODE -ne 0) {
            throw "Barcelona Pavilion Direct3D asset build failed with exit code $LASTEXITCODE"
        }
    } finally {
        $env:PYTHONPATH = $previousPythonPath
    }
}

if ($SkipCuda) {
    Write-Host "CUDA setup skipped. Browser dependencies are ready."
    return
}

$cudaSetup = Join-Path $PSScriptRoot "tools\setup-local-cuda.ps1"
if (-not (Test-Path -LiteralPath $cudaSetup)) {
    throw "CUDA setup helper is missing: $cudaSetup"
}

& $cudaSetup `
    -Release $CudaRelease `
    -ToolkitVersion $CudaToolkitVersion `
    -NoUserEnvironment:$NoUserEnvironment

Write-Host "Project dependency setup completed."
