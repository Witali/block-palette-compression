<#
.SYNOPSIS
Downloads and prepares the project dependencies on Windows.

.DESCRIPTION
Checks that Node.js is available and installs the pinned local CUDA developer
toolchain under tools/cuda. It also downloads the original Barcelona Pavilion
scene into the Git-ignored .tmp directory. CUDA packages are downloaded from
NVIDIA, SHA-256-verified, and extracted without administrator rights.

.PARAMETER SkipCuda
Skip CUDA setup after checking Node.js and preparing the source scene.

.PARAMETER SkipBarcelonaScene
Do not download and extract the original Barcelona Pavilion Blender scene.

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
