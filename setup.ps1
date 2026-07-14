<#
.SYNOPSIS
Downloads and prepares the project dependencies on Windows.

.DESCRIPTION
Checks that Node.js is available and installs the pinned local CUDA developer
toolchain under tools/cuda. CUDA packages are downloaded from NVIDIA,
SHA-256-verified, and extracted without administrator rights.

.PARAMETER SkipCuda
Only validate the browser-development prerequisite and skip CUDA setup.

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
.\setup.ps1 -NoUserEnvironment
#>
[CmdletBinding()]
param(
    [switch]$SkipCuda,
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
